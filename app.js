import 'dotenv/config';
import bolt from '@slack/bolt';

const { App } = bolt;

// ── 환경 변수 ──────────────────────────────────────────────
const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN,
} = process.env;

// Zendesk 미설정 시 티켓 생성은 건너뛰고 콘솔에만 출력(개발 편의용)
const zendeskEnabled = Boolean(ZENDESK_SUBDOMAIN && ZENDESK_EMAIL && ZENDESK_API_TOKEN);

// 심각도 → Zendesk priority 매핑
const PRIORITY_MAP = {
  urgent: '긴급',
  high: '높음',
  normal: '보통',
  low: '낮음',
};

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// ── 1. 슬래시 명령 → 문의 모달 열기 ─────────────────────────
app.command('/sharkton', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildTicketModal(),
    });
  } catch (error) {
    logger.error('모달 열기 실패:', error);
  }
});

// ── 2. 모달 제출 → Zendesk 티켓 생성 ────────────────────────
app.view('ticket_modal', async ({ ack, body, view, client, logger }) => {
  await ack();

  const userId = body.user.id;
  const v = view.state.values;
  const subject = v.subject.value.value;
  const type = v.type.value.selected_option.value;
  const priority = v.priority.value.selected_option.value;
  const account = v.account?.value?.value || '';
  const description = v.description.value.value;

  try {
    const requester = await resolveRequester(client, userId);
    const ticket = await createZendeskTicket({
      subject,
      type,
      priority,
      account,
      description,
      requester,
    });

    const idText = ticket
      ? `티켓 *#${ticket.id}* 이(가) 생성되었습니다.`
      : '(개발 모드) Zendesk 미연동 상태라 티켓은 생성되지 않았습니다.';

    await client.chat.postMessage({
      channel: userId,
      text: `✅ 문의가 접수되었습니다. ${idText}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *문의가 접수되었습니다.*\n${idText}`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*제목:*\n${subject}` },
            { type: 'mrkdwn', text: `*유형:*\n${type}` },
            { type: 'mrkdwn', text: `*심각도:*\n${PRIORITY_MAP[priority] ?? priority}` },
            { type: 'mrkdwn', text: `*대상:*\n${account || '-'}` },
          ],
        },
      ],
    });
  } catch (error) {
    logger.error('티켓 생성 실패:', error);
    await client.chat.postMessage({
      channel: userId,
      text: `⚠️ 문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.`,
    });
  }
});

// ── 헬퍼: 요청자(고객) 이메일 조회 ──────────────────────────
async function resolveRequester(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    const profile = info.user?.profile ?? {};
    return {
      name: info.user?.real_name || profile.display_name || 'Slack User',
      email: profile.email || undefined,
    };
  } catch {
    return { name: 'Slack User', email: undefined };
  }
}

// ── 헬퍼: Zendesk 티켓 생성 ─────────────────────────────────
async function createZendeskTicket({ subject, type, priority, account, description, requester }) {
  if (!zendeskEnabled) {
    console.log('[DEV] Zendesk 미연동 — 티켓 생성 생략:', { subject, type, priority, account });
    return null;
  }

  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');
  const bodyText = [
    description,
    '',
    '────────────',
    `문의 유형: ${type}`,
    `대상 계정/리소스: ${account || '-'}`,
    '(Sharkton 봇에서 자동 생성)',
  ].join('\n');

  const payload = {
    ticket: {
      subject,
      comment: { body: bodyText },
      priority, // urgent | high | normal | low
      tags: ['sharkton', `type_${type}`],
      ...(requester?.email ? { requester: { name: requester.name, email: requester.email } } : {}),
    },
  };

  const res = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zendesk API ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.ticket;
}

// ── 문의 모달 정의 ──────────────────────────────────────────
function buildTicketModal() {
  return {
    type: 'modal',
    callback_id: 'ticket_modal',
    title: { type: 'plain_text', text: '스마일샤크 문의' },
    submit: { type: 'plain_text', text: '문의 접수' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: 'subject',
        label: { type: 'plain_text', text: '제목' },
        element: { type: 'plain_text_input', action_id: 'value', max_length: 150 },
      },
      {
        type: 'input',
        block_id: 'type',
        label: { type: 'plain_text', text: '문의 유형' },
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '선택' },
          options: [
            { text: { type: 'plain_text', text: '장애' }, value: '장애' },
            { text: { type: 'plain_text', text: '요청' }, value: '요청' },
            { text: { type: 'plain_text', text: '문의' }, value: '문의' },
            { text: { type: 'plain_text', text: '기타' }, value: '기타' },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'priority',
        label: { type: 'plain_text', text: '심각도' },
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: '선택' },
          options: [
            { text: { type: 'plain_text', text: '긴급' }, value: 'urgent' },
            { text: { type: 'plain_text', text: '높음' }, value: 'high' },
            { text: { type: 'plain_text', text: '보통' }, value: 'normal' },
            { text: { type: 'plain_text', text: '낮음' }, value: 'low' },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'account',
        optional: true,
        label: { type: 'plain_text', text: '대상 계정/리소스' },
        element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: '예: 계정 ID, 인스턴스 ID' } },
      },
      {
        type: 'input',
        block_id: 'description',
        label: { type: 'plain_text', text: '상세 내용' },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 3000 },
      },
    ],
  };
}

// ── 실행 ────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡ Sharkton 봇이 실행되었습니다. (Socket Mode)');
  console.log(`   Zendesk 연동: ${zendeskEnabled ? 'ON' : 'OFF (개발 모드)'}`);
})();
