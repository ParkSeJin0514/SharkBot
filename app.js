import 'dotenv/config';
import bolt from '@slack/bolt';
import express from 'express';
import { WebClient } from '@slack/web-api';
import serverlessHttp from 'serverless-http';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  installationStore,
  storeMode,
  storeTicketMapping,
  fetchTicketMapping,
} from './installationStore.js';

const { App, ExpressReceiver } = bolt;

// ── 환경 변수 ──────────────────────────────────────────────
const {
  SLACK_SIGNING_SECRET,
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_STATE_SECRET,
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN,
  ZENDESK_WEBHOOK_TOKEN, // 인바운드 웹훅(양방향 동기화) 검증용 공유 시크릿
} = process.env;

// Zendesk 미설정 시 티켓 생성은 건너뛰고 콘솔에만 출력(개발 편의용)
const zendeskEnabled = Boolean(ZENDESK_SUBDOMAIN && ZENDESK_EMAIL && ZENDESK_API_TOKEN);

// 긴급도 값(=Zendesk priority) → 한국어 표시
const URGENCY_LABEL = { high: '높음', normal: '중간', low: '낮음' };

// Zendesk 상태 → 한국어 표시
const STATUS_LABEL = {
  new: '🆕 신규',
  open: '🔧 처리중',
  pending: '⏳ 고객확인대기',
  hold: '⏸️ 보류',
  solved: '✅ 해결됨',
  closed: '📁 종료',
};

// ── 실행 환경 / Bedrock ─────────────────────────────────────
const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const REGION = process.env.AWS_REGION || 'ap-northeast-2';
// 콘솔 Bedrock에서 액세스 허용된 모델 ID로 설정 (예: apac.anthropic.claude-... 인퍼런스 프로파일)
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0';
const bedrock = new BedrockRuntimeClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

const ASK_SYSTEM_PROMPT = [
  '당신은 스마일샤크(AWS MSP)의 고객 지원 어시스턴트입니다.',
  'AWS 사용법·개념 질문에 한국어로 정확하고 간결하게 답하세요.',
  '가능하면 관련 AWS 서비스명과 근거를 함께 제시하고, 확실하지 않으면 추측하지 말고',
  '"정확한 확인이 필요하면 /zendesk 로 문의 티켓을 남겨 주세요"라고 안내하세요.',
].join(' ');

// ── HTTP + OAuth 리시버 (멀티테넌트) ────────────────────────
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  clientId: SLACK_CLIENT_ID,
  clientSecret: SLACK_CLIENT_SECRET,
  stateSecret: SLACK_STATE_SECRET,
  scopes: ['commands', 'chat:write', 'chat:write.public', 'users:read', 'users:read.email', 'im:write', 'files:read', 'files:write'],
  installationStore,
  processBeforeResponse: isLambda, // FaaS(Lambda)에서만 true
  installerOptions: {
    installPath: '/slack/install',
    redirectUriPath: '/slack/oauth_redirect',
  },
});

const app = new App({ receiver, processBeforeResponse: isLambda });

// ── 양방향 동기화: Zendesk 웹훅 수신 → 고객 Slack DM 회신 (기능 A) ──
// Zendesk 트리거가 담당자 "공개 댓글" 등록 시 이 엔드포인트로 JSON을 POST한다.
// 페이로드 예: { ticket_id, comment, author_role, status, subject }
receiver.app.post('/zendesk/webhook', express.json(), async (req, res) => {
  // 1) 공유 시크릿 검증 (Zendesk 웹훅 커스텀 헤더 X-Sharkbot-Token)
  const token = req.get('x-sharkbot-token');
  if (!ZENDESK_WEBHOOK_TOKEN || token !== ZENDESK_WEBHOOK_TOKEN) {
    return res.status(401).send('unauthorized');
  }

  const { ticket_id, comment, author_role, status, subject } = req.body || {};
  if (!ticket_id) return res.status(400).send('missing ticket_id');

  // 2) 담당자(agent/admin) 답변만 전달 — 고객 본인 코멘트 echo 방지
  if (author_role && !['agent', 'admin'].includes(String(author_role).toLowerCase())) {
    return res.status(200).send('skipped (non-agent)');
  }

  try {
    const map = await fetchTicketMapping(ticket_id);
    if (!map) return res.status(200).send('no mapping'); // 봇 외 경로로 생성된 티켓

    const installation = await installationStore.fetchInstallation({
      teamId: map.teamId,
      enterpriseId: map.enterpriseId,
      isEnterpriseInstall: map.isEnterpriseInstall,
    });
    const botToken = installation?.bot?.token;
    if (!botToken) return res.status(200).send('no bot token');

    // 트리거 페이로드는 첨부를 안 실어주므로, 최근 공개 코멘트를 Zendesk API로 조회해
    // 텍스트 + 첨부(content_url)를 확보한다. (실패 시 페이로드 텍스트로 폴백)
    let commentText = comment;
    let attachments = [];
    try {
      const latest = await fetchLatestPublicComment(ticket_id);
      if (latest) {
        commentText = latest.body || comment;
        attachments = latest.attachments || [];
      }
    } catch (e) {
      console.error('최근 코멘트 조회 실패(페이로드 텍스트로 대체):', e);
    }

    const web = new WebClient(botToken);
    // 첨부 업로드(files.uploadV2)에는 DM 채널 ID가 필요 → IM 채널 오픈
    const im = await web.conversations.open({ users: map.userId });
    const channelId = im.channel?.id || map.userId;

    await web.chat.postMessage({
      channel: channelId,
      text: `💬 티켓 #${ticket_id} 에 담당자 답변이 등록되었습니다.`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `💬 *티켓 #${ticket_id} 에 담당자 답변이 등록되었어요.*` + (subject ? `\n_${subject}_` : ''),
          },
        },
        { type: 'section', text: { type: 'mrkdwn', text: commentText ? truncate(commentText, 2800) : '(내용 없음)' } },
        replyButton(ticket_id),
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `상태: ${STATUS_LABEL[status] || status || '-'}   ·   \`/zendesk-status\` 로 전체 확인` },
          ],
        },
      ],
    });

    // 담당자 첨부(사진 등)를 고객 Slack DM에 이미지로 업로드 (files:write 필요)
    if (attachments.length) {
      await uploadZendeskAttachmentsToSlack(web, channelId, attachments);
    }
    return res.status(200).send('ok');
  } catch (e) {
    // Zendesk 재시도 폭주 방지를 위해 200 반환하고 로그로 추적
    console.error('Zendesk 웹훅 처리 실패:', e);
    return res.status(200).send('error-logged');
  }
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

// ── 1-1. 답장 버튼 → 답장 모달 열기 (새 티켓 없이 기존 티켓에 이어쓰기) ──
app.action('reply_ticket', async ({ ack, body, client, logger }) => {
  await ack();
  const ticketId = body.actions?.[0]?.value;
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'reply_modal',
        private_metadata: String(ticketId), // 어느 티켓에 답장인지 보관
        title: { type: 'plain_text', text: `티켓 #${ticketId} 답장` },
        submit: { type: 'plain_text', text: '전송' },
        close: { type: 'plain_text', text: '취소' },
        blocks: [
          textInput('reply_text', '답장 내용', {
            multiline: true,
            max: 3000,
            placeholder: '담당자에게 전달할 내용을 입력하세요',
          }),
          fileInputBlock('reply_attachments', '사진/파일 첨부'),
        ],
      },
    });
  } catch (error) {
    logger.error('답장 모달 열기 실패:', error);
  }
});

// ── 1-1b. 답장 모달 제출 → 기존 티켓에 공개 코멘트 추가 ──────
app.view('reply_modal', async ({ ack, body, view, client, context, logger }) => {
  await ack();
  const userId = body.user.id;
  const ticketId = view.private_metadata;
  const text = view.state.values.reply_text.value.value;
  const files = parseAttachments(view.state.values.reply_attachments?.files);
  try {
    let uploadToken = null;
    if (files.length) {
      try {
        uploadToken = await uploadFilesToZendesk(files, context.botToken);
      } catch (e) {
        logger.error('답장 첨부 업로드 실패(첨부 없이 코멘트 진행):', e);
      }
    }
    await addZendeskComment(ticketId, text, userId, uploadToken);
    await client.chat.postMessage({
      channel: userId,
      text: `✅ 티켓 *#${ticketId}* 에 답장을 전달했어요.`,
    });
  } catch (error) {
    logger.error('답장 코멘트 추가 실패:', error);
    await client.chat.postMessage({
      channel: userId,
      text: `⚠️ 티켓 #${ticketId} 답장 전송 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.`,
    });
  }
});

// ── 1-2. /ask → Bedrock 질의 (정적 지식) ────────────────────
// Slack 3초 제약: 즉시 ack → (Lambda) 비동기 self-invoke로 Bedrock 처리 후 response_url 게시
app.command('/ask', async ({ ack, command, respond, logger }) => {
  const question = (command.text || '').trim();
  if (!question) {
    await ack('사용법: `/ask 질문내용`  (예: `/ask S3 버킷 정책 설정 방법 알려줘`)');
    return;
  }
  await ack('🤔 답변을 생성하고 있어요...');
  try {
    if (isLambda) {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: 'Event', // 비동기
          Payload: Buffer.from(
            JSON.stringify({ __askWorker: true, text: question, response_url: command.response_url })
          ),
        })
      );
    } else {
      const answer = await askBedrock(question);
      await respond({ response_type: 'ephemeral', text: answer });
    }
  } catch (error) {
    logger.error('ask 처리 실패:', error);
    await respond({ response_type: 'ephemeral', text: `⚠️ 답변 처리 중 오류: ${error.message}` });
  }
});

// ── 1-3. /zendesk-status → 내 티켓 상태 조회 (기능 B) ───────
// 요청자(Slack 이메일)로 Zendesk를 검색해 본인 티켓 목록·상태를 반환.
app.command('/zendesk-status', async ({ ack, command, client, respond, logger }) => {
  await ack();
  try {
    if (!zendeskEnabled) {
      await respond({ response_type: 'ephemeral', text: '(개발 모드) Zendesk 미연동 상태라 조회할 수 없습니다.' });
      return;
    }
    const email = await resolveRequesterEmail(client, command.user_id);
    if (!email) {
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ Slack 프로필에 이메일이 없어 티켓을 조회할 수 없습니다. 프로필 이메일을 확인해 주세요.',
      });
      return;
    }
    const tickets = await listZendeskTickets(email);
    if (!tickets.length) {
      await respond({ response_type: 'ephemeral', text: `📭 *${email}* 로 조회된 티켓이 없습니다.` });
      return;
    }
    await respond({ response_type: 'ephemeral', text: `열린 티켓 ${tickets.length}건`, blocks: buildStatusBlocks(tickets, email) });
  } catch (error) {
    logger.error('상태 조회 실패:', error);
    await respond({ response_type: 'ephemeral', text: `⚠️ 티켓 조회 중 오류가 발생했습니다: ${error.message}` });
  }
});

// ── 2. 모달 제출 → Zendesk 티켓 생성 ────────────────────────
// NOTE: Slack 3초 제약. Zendesk 호출이 느릴 경우 별도 Lambda(async)/SQS로
//       분리하는 것을 권장. (DEPLOYMENT.md 참고)
app.view('ticket_modal', async ({ ack, body, view, client, context, logger }) => {
  const userId = body.user.id;
  const v = view.state.values;
  const form = {
    formType: v.form_type.value.selected_option.value,
    techArea: v.tech_area?.value?.selected_option?.value || '',
    requesterEmail: (v.requester_email.value.value || '').trim(),
    company: v.company.value.value,
    subject: v.subject.value.value,
    ccEmails: parseEmails(v.cc?.value?.value || ''),
    awsAccount: v.aws_account?.value?.value || '',
    supportPlan: v.support_plan?.value?.selected_option?.value || '',
    urgency: v.urgency.value.selected_option.value, // high | normal | low
    description: v.description.value.value,
    // 사진/파일 첨부 (file_input) — 다운로드에 필요한 정보만 추림
    files: parseAttachments(v.attachments?.files),
  };

  // 요청자 이메일 형식 검증 → 모달에 인라인 에러 표시 (ack 전에 처리)
  if (!isEmail(form.requesterEmail)) {
    await ack({
      response_action: 'errors',
      errors: { requester_email: '올바른 이메일 형식을 입력해 주세요. (예: user@company.com)' },
    });
    return;
  }
  await ack();

  try {
    logger.info(
      `📨 문의 접수 | Slack ID: ${userId} | 요청자: ${form.requesterEmail} | ` +
        `회사: ${form.company} | 양식: ${form.formType}`
    );

    // 첨부파일: Slack에서 다운로드 → Zendesk 업로드 → 업로드 토큰 확보
    let uploadToken = null;
    if (form.files.length) {
      try {
        uploadToken = await uploadFilesToZendesk(form.files, context.botToken);
      } catch (e) {
        logger.error('첨부파일 업로드 실패(첨부 없이 티켓 생성 진행):', e);
      }
    }

    const ticket = await createZendeskTicket(form, uploadToken);

    // 양방향 동기화: 티켓 ID ↔ Slack 사용자 매핑 저장 (웹훅 수신 시 회신 대상)
    if (ticket) {
      try {
        await storeTicketMapping(ticket.id, {
          teamId: body.team?.id,
          enterpriseId: body.enterprise?.id,
          isEnterpriseInstall: Boolean(body.is_enterprise_install),
          userId,
        });
      } catch (e) {
        logger.error('티켓 매핑 저장 실패(회신 동기화 불가):', e);
      }
    }

    const idText = ticket
      ? `티켓 *#${ticket.id}* 이(가) 생성되었습니다.`
      : '(개발 모드) Zendesk 미연동 상태라 티켓은 생성되지 않았습니다.';

    const confirmBlocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `✅ *문의가 접수되었습니다.*\n${idText}` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*양식:*\n${form.formType}${form.techArea ? ` (${form.techArea})` : ''}` },
          { type: 'mrkdwn', text: `*회사:*\n${form.company}` },
          { type: 'mrkdwn', text: `*요청자:*\n${form.requesterEmail}` },
          { type: 'mrkdwn', text: `*긴급도:*\n${URGENCY_LABEL[form.urgency] ?? form.urgency}` },
          { type: 'mrkdwn', text: `*AWS 계정 ID:*\n${form.awsAccount || '-'}` },
          { type: 'mrkdwn', text: `*서포트 플랜:*\n${form.supportPlan || '-'}` },
        ],
      },
    ];
    // 티켓이 실제 생성된 경우, 새 티켓 없이 같은 티켓에 이어서 답장할 수 있는 버튼 제공
    if (ticket) confirmBlocks.push(replyButton(ticket.id));

    await client.chat.postMessage({
      channel: userId,
      text: `✅ 문의가 접수되었습니다. ${idText}`,
      blocks: confirmBlocks,
    });
  } catch (error) {
    logger.error('티켓 생성 실패:', error);
    await client.chat.postMessage({
      channel: userId,
      text: '⚠️ 문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
});

// ── 헬퍼: 이메일 형식 검증 ──────────────────────────────────
function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || '').trim());
}

// ── 헬퍼: 참조(CC) 이메일 파싱 (쉼표/줄바꿈/공백/세미콜론 구분, 중복·형식오류 제거) ──
function parseEmails(raw) {
  return [
    ...new Set(
      (raw || '')
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter((s) => isEmail(s))
    ),
  ];
}

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
async function createZendeskTicket(form, uploadToken) {
  // 제목: 고객이 입력한 제목을 사용하되, 팀 트리아지용으로 [회사명] 접두어를 붙인다.
  const subject = `[${form.company}] ${form.subject}`;

  const bodyText = [
    form.description,
    '',
    '────────────',
    `양식: ${form.formType}`,
    `기술 분야: ${form.techArea || '-'}`,
    `요청자 이메일: ${form.requesterEmail}`,
    `회사명: ${form.company}`,
    `AWS 계정 ID: ${form.awsAccount || '-'}`,
    `AWS 서포트 플랜: ${form.supportPlan || '-'}`,
    `긴급도: ${URGENCY_LABEL[form.urgency] ?? form.urgency}`,
    `참조(CC): ${form.ccEmails?.length ? form.ccEmails.join(', ') : '-'}`,
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
      comment: { body: bodyText, ...(uploadToken ? { uploads: [uploadToken] } : {}) },
      priority: form.urgency, // high | normal | low
      tags,
      // 요청자 = 이메일 기준. 기존 사용자면 매칭(이름 자동), 없으면 이메일로 신규 생성.
      ...(form.requesterEmail ? { requester: { email: form.requesterEmail } } : {}),
      ...(form.ccEmails?.length ? { collaborators: form.ccEmails } : {}),
    },
  };

  const res = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${zendeskAuth()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zendesk API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.ticket;
}

// ── 헬퍼: Zendesk Basic 인증 헤더 값 ────────────────────────
function zendeskAuth() {
  return Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');
}

// ── 헬퍼: "이 티켓에 답장" 버튼 블록 ────────────────────────
function replyButton(ticketId) {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'reply_ticket',
        text: { type: 'plain_text', text: '💬 이 티켓에 답장' },
        value: String(ticketId),
      },
    ],
  };
}

// ── 헬퍼: 첨부파일 Slack 다운로드 → Zendesk 업로드 → 토큰 반환 ──
// 여러 파일을 같은 업로드 토큰에 이어붙여 하나의 토큰으로 반환한다.
async function uploadFilesToZendesk(files, botToken) {
  if (!files?.length || !zendeskEnabled) return null;
  let token;
  for (const f of files) {
    if (!f.url) continue;
    // 1) Slack에서 파일 다운로드 (봇 토큰 필요, files:read 스코프)
    const dl = await fetch(f.url, { headers: { Authorization: `Bearer ${botToken}` } });
    if (!dl.ok) throw new Error(`Slack 파일 다운로드 실패 ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    // 2) Zendesk 업로드 (token 파라미터로 여러 파일을 하나로 묶음)
    const q = new URLSearchParams({ filename: f.name || 'attachment' });
    if (token) q.set('token', token);
    const up = await fetch(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/uploads.json?${q.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${zendeskAuth()}`,
          'Content-Type': f.mimetype || 'application/octet-stream',
        },
        body: buf,
      }
    );
    if (!up.ok) throw new Error(`Zendesk 업로드 실패 ${up.status}: ${await up.text()}`);
    const data = await up.json();
    token = data.upload?.token;
  }
  return token || null;
}

// ── 헬퍼: 티켓의 최근 공개 코멘트(텍스트+첨부) 조회 (담당자→고객) ──
async function fetchLatestPublicComment(ticketId) {
  if (!zendeskEnabled) return null;
  const res = await fetch(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json`,
    { headers: { Authorization: `Basic ${zendeskAuth()}` } }
  );
  if (!res.ok) throw new Error(`Zendesk comments ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const publicComments = (data.comments || []).filter((c) => c.public);
  return publicComments[publicComments.length - 1] || null; // { body, attachments, ... }
}

// ── 헬퍼: Zendesk 첨부 → 고객 Slack DM에 이미지 업로드 (files:write 필요) ──
async function uploadZendeskAttachmentsToSlack(web, channelId, attachments) {
  for (const att of attachments) {
    try {
      const dl = await fetch(att.content_url, { headers: { Authorization: `Basic ${zendeskAuth()}` } });
      if (!dl.ok) {
        console.error(`Zendesk 첨부 다운로드 실패 ${dl.status}: ${att.file_name}`);
        continue;
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      await web.files.uploadV2({
        channel_id: channelId,
        file: buf,
        filename: att.file_name || 'attachment',
      });
    } catch (e) {
      console.error(`첨부 Slack 업로드 실패: ${att.file_name}`, e);
    }
  }
}

// ── 헬퍼: 기존 티켓에 공개 코멘트 추가 (고객 답장) ───────────
// 새 티켓을 만들지 않고 동일 티켓에 대화를 이어붙인다.
async function addZendeskComment(ticketId, text, slackUserId, uploadToken) {
  if (!zendeskEnabled) {
    console.log('[DEV] Zendesk 미연동 — 코멘트 생략:', { ticketId, text });
    return;
  }
  const body = `💬 [Slack 고객 답장]\n\n${text}\n\n— (Slack user: ${slackUserId})`;
  const payload = {
    ticket: { comment: { body, public: true, ...(uploadToken ? { uploads: [uploadToken] } : {}) } },
  };
  const res = await fetch(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`,
    {
      method: 'PUT',
      headers: { Authorization: `Basic ${zendeskAuth()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Zendesk comment ${res.status}: ${t}`);
  }
}

// ── 헬퍼: 요청자 이메일로 티켓 목록 조회 (기능 B) ───────────
async function listZendeskTickets(email, limit = 10) {
  const query = encodeURIComponent(`type:ticket requester:${email}`);
  const url =
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/search.json` +
    `?query=${query}&sort_by=created_at&sort_order=desc`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${zendeskAuth()}` } });
  if (!res.ok) throw new Error(`Zendesk search ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.results || []).slice(0, limit);
}

// ── 헬퍼: 티켓 상태 목록 → Slack 블록 ───────────────────────
function buildStatusBlocks(tickets, email) {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `📋 *${email}* 님의 최근 티켓 ${tickets.length}건` } },
    { type: 'divider' },
  ];
  for (const t of tickets) {
    const status = STATUS_LABEL[t.status] || t.status || '-';
    const created = (t.created_at || '').slice(0, 10);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*#${t.id}* · ${status}\n${t.subject || '(제목 없음)'}\n_생성일: ${created}_`,
      },
      // 목록에서 바로 이어쓰기 (reply_ticket 액션 재사용)
      accessory: {
        type: 'button',
        action_id: 'reply_ticket',
        text: { type: 'plain_text', text: '💬 답장' },
        value: String(t.id),
      },
    });
  }
  return blocks;
}

// ── 헬퍼: 문자열 길이 제한 ──────────────────────────────────
function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── 헬퍼: Bedrock 질의 ──────────────────────────────────────
async function askBedrock(question) {
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: ASK_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: question }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
    })
  );
  return res.output?.message?.content?.[0]?.text || '답변을 생성하지 못했습니다.';
}

// ── 헬퍼: 비동기 워커 (Bedrock 처리 후 response_url로 게시) ──
async function handleAskWorker(event) {
  try {
    const answer = await askBedrock(event.text);
    await postToResponseUrl(event.response_url, answer);
  } catch (e) {
    await postToResponseUrl(event.response_url, `⚠️ 답변 생성 중 오류가 발생했습니다: ${e.message}`);
  }
  return { ok: true };
}

async function postToResponseUrl(url, text) {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
  });
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

// ── 헬퍼: 파일 첨부(file_input) 블록 ────────────────────────
function fileInputBlock(block_id, label) {
  return {
    type: 'input',
    block_id,
    optional: true,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'file_input',
      action_id: 'files',
      // Slack이 인식하는 filetype 슬러그만 사용 (jpg가 jpeg 포함)
      filetypes: ['png', 'jpg', 'gif', 'pdf'],
      max_files: 5,
    },
  };
}

// ── 헬퍼: 첨부 파일 상태값 → 다운로드용 최소 정보 배열 ───────
function parseAttachments(fileState) {
  return (fileState?.files || []).map((f) => ({
    url: f.url_private_download || f.url_private,
    name: f.name,
    mimetype: f.mimetype,
  }));
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
      textInput('requester_email', '요청자 이메일', {
        placeholder: '요청자 이메일 주소',
      }),
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
      textInput('cc', '참조 (CC)', {
        optional: true,
        multiline: true,
        placeholder: '참조할 이메일 (여러 명이면 줄바꿈으로 구분)',
        hint: '입력한 이메일이 Zendesk 티켓 참조자로 등록됩니다',
      }),
      textInput('subject', '제목', { max: 150, placeholder: '문의 제목을 입력하세요' }),
      textInput('description', '문의 내용', { multiline: true, max: 3000, placeholder: '문의 상세 내용을 입력하세요' }),
      fileInputBlock('attachments', '사진/파일 첨부'),
    ],
  };
}

// ── 실행 ────────────────────────────────────────────────────
// Lambda: handler export / 로컬: HTTP 서버 직접 구동
const slackHandler = serverlessHttp(receiver.app);
export const handler = async (event, context) => {
  // 비동기 self-invoke(워커) 페이로드 처리
  if (event && event.__askWorker) {
    return handleAskWorker(event);
  }
  return slackHandler(event, context);
};

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const port = process.env.PORT || 3000;
  receiver.app.listen(port, () => {
    console.log(`⚡ SharkBot 로컬 실행 (HTTP :${port})`);
    console.log(`   설치 시작 URL: http://localhost:${port}/slack/install`);
    console.log(`   설치 저장소: ${storeMode}`);
    console.log(`   Zendesk 연동: ${zendeskEnabled ? 'ON' : 'OFF (개발 모드)'}`);
  });
}
