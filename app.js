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

// 긴급도 값(=Zendesk priority) → 한국어 표시
const URGENCY_LABEL = { high: '높음', normal: '중간', low: '낮음' };

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// ── 1. 슬래시 명령 → 문의 모달 열기 ─────────────────────────
app.command('/zendesk', async ({ ack, body, client, logger }) => {
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
  const form = {
    formType: v.form_type.value.selected_option.value,
    techArea: v.tech_area?.value?.selected_option?.value || '',
    name: v.name.value.value,
    company: v.company.value.value,
    awsAccount: v.aws_account?.value?.value || '',
    supportPlan: v.support_plan?.value?.selected_option?.value || '',
    urgency: v.urgency.value.selected_option.value, // high | normal | low
    description: v.description.value.value,
  };

  try {
    const slackEmail = (await resolveRequesterEmail(client, userId)) || undefined;
    logger.info(
      `📨 문의 접수 | Slack ID: ${userId} | 성명: ${form.name} | 회사: ${form.company} | ` +
        `이메일: ${slackEmail ?? '(없음)'} | 양식: ${form.formType}`
    );

    const ticket = await createZendeskTicket(form, { name: form.name, email: slackEmail });

    const idText = ticket
      ? `티켓 *#${ticket.id}* 이(가) 생성되었습니다.`
      : '(개발 모드) Zendesk 미연동 상태라 티켓은 생성되지 않았습니다.';

    await client.chat.postMessage({
      channel: userId,
      text: `✅ 문의가 접수되었습니다. ${idText}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `✅ *문의가 접수되었습니다.*\n${idText}` } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*양식:*\n${form.formType}${form.techArea ? ` (${form.techArea})` : ''}` },
            { type: 'mrkdwn', text: `*회사/성명:*\n${form.company} / ${form.name}` },
            { type: 'mrkdwn', text: `*긴급도:*\n${URGENCY_LABEL[form.urgency] ?? form.urgency}` },
            { type: 'mrkdwn', text: `*AWS 계정 ID:*\n${form.awsAccount || '-'}` },
            { type: 'mrkdwn', text: `*서포트 플랜:*\n${form.supportPlan || '-'}` },
          ],
        },
      ],
    });
  } catch (error) {
    logger.error('티켓 생성 실패:', error);
    await client.chat.postMessage({
      channel: userId,
      text: '⚠️ 문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
});

// ── 헬퍼: 요청자(고객) 이메일 조회 ──────────────────────────
async function resolveRequesterEmail(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    return info.user?.profile?.email || null;
  } catch {
    return null;
  }
}

// ── 헬퍼: Zendesk 티켓 생성 ─────────────────────────────────
async function createZendeskTicket(form, requester) {
  const subject = `[${form.company}] ${form.formType}${form.techArea ? `(${form.techArea})` : ''} - ${form.name}`;

  const bodyText = [
    form.description,
    '',
    '────────────',
    `양식: ${form.formType}`,
    `기술 분야: ${form.techArea || '-'}`,
    `성명: ${form.name}`,
    `회사명: ${form.company}`,
    `AWS 계정 ID: ${form.awsAccount || '-'}`,
    `AWS 서포트 플랜: ${form.supportPlan || '-'}`,
    `긴급도: ${URGENCY_LABEL[form.urgency] ?? form.urgency}`,
    '(Sharkton 봇에서 자동 생성)',
  ].join('\n');

  if (!zendeskEnabled) {
    console.log('[DEV] Zendesk 미연동 — 티켓 생성 생략:', { subject });
    return null;
  }

  // TODO: Zendesk 커스텀 필드(양식·계정ID 등)의 field ID를 확보하면
  //       custom_fields: [{ id, value }] 로 정식 매핑 예정. 현재는 본문+태그로 처리.
  const tags = ['sharkton', form.formType, form.techArea]
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, '_'));

  const payload = {
    ticket: {
      subject,
      comment: { body: bodyText },
      priority: form.urgency, // high | normal | low
      tags,
      ...(requester?.email ? { requester: { name: requester.name, email: requester.email } } : {}),
    },
  };

  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');
  const res = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zendesk API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.ticket;
}

// ── 헬퍼: static_select 옵션 생성 ───────────────────────────
function options(pairs) {
  return pairs.map(([text, value]) => ({
    text: { type: 'plain_text', text },
    value: value ?? text,
  }));
}

function selectInput(block_id, label, opts, { optional = false, placeholder = '선택', hint } = {}) {
  const block = {
    type: 'input',
    block_id,
    optional,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'static_select',
      action_id: 'value',
      placeholder: { type: 'plain_text', text: placeholder },
      options: opts,
    },
  };
  if (hint) block.hint = { type: 'plain_text', text: hint };
  return block;
}

function textInput(block_id, label, { optional = false, multiline = false, placeholder, hint, max } = {}) {
  const element = { type: 'plain_text_input', action_id: 'value', multiline };
  if (placeholder) element.placeholder = { type: 'plain_text', text: placeholder };
  if (max) element.max_length = max;
  const block = { type: 'input', block_id, optional, label: { type: 'plain_text', text: label }, element };
  if (hint) block.hint = { type: 'plain_text', text: hint };
  return block;
}

// ── 문의 모달 정의 (스마일샤크 Zendesk 양식 기준) ───────────
function buildTicketModal() {
  return {
    type: 'modal',
    callback_id: 'ticket_modal',
    title: { type: 'plain_text', text: '젠데스크 문의' },
    submit: { type: 'plain_text', text: '문의 접수' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      selectInput('form_type', '양식', options([
        ['기술문의'], ['비용문의'], ['샤크몬 문의'], ['내부문서요청'], ['인시던트'], ['미팅협의'],
      ])),
      selectInput('tech_area', '기술 분야', options([
        ['AWS'], ['Datadog'], ['NHN'],
      ]), { optional: true, hint: '기술문의인 경우 선택하세요' }),
      textInput('name', '성명', { placeholder: '고객사 담당자 성명' }),
      textInput('company', '회사명', { placeholder: '고객사 회사명' }),
      textInput('aws_account', 'AWS 계정 ID (Account Number)', {
        optional: true,
        multiline: true,
        placeholder: '작업 필요한 계정 ID (여러 개면 줄바꿈으로 구분)',
      }),
      selectInput('support_plan', 'AWS 서포트 플랜', options([
        ['Basic'], ['Developer'], ['Business'], ['Enterprise On-Ramp'], ['Enterprise'],
      ]), { optional: true }),
      selectInput('urgency', '긴급도', options([
        ['높음', 'high'], ['중간', 'normal'], ['낮음', 'low'],
      ])),
      textInput('description', '문의 내용', { multiline: true, max: 3000, placeholder: '문의 상세 내용을 입력하세요' }),
    ],
  };
}

// ── 실행 ────────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('⚡ Sharkton 봇이 실행되었습니다. (Socket Mode)');
  console.log(`   Zendesk 연동: ${zendeskEnabled ? 'ON' : 'OFF (개발 모드)'}`);
})();
