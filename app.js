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
  storeCompanyTeam,
  fetchCompanyTeam,
  storeUserByEmail,
  fetchUserByEmail,
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

// 고객사 디렉터리 (샘플) — 회사 선택 시 소속 직원(요청자) 드롭다운을 채운다.
// TODO: 실서비스에선 Zendesk organizations/users API 또는 별도 설정에서 로드.
const COMPANY_DIRECTORY = {
  '스마일민정': [
    { name: '김민정', email: 'sj.park+kmj@smileshark.kr' },
    { name: '박세진', email: 'bjtanker0514+psj@gmail.com' },
  ],
  '스마일정빈': [
    { name: '장정빈', email: 'sj.park+jjb@smileshark.kr' },
    { name: '김기수', email: 'bjtanker0514+kgs@gmail.com' },
  ],
  '스마일수현': [
    { name: '김수현', email: 'sj.park+ksh@smileshark.kr' },
    { name: '강호성', email: 'bjtanker0514+ghs@gmail.com' },
  ],
};

// Zendesk 커스텀 필드 ID
const ZD_FIELD = {
  form: 60399135006617,       // 양식 (드롭다운)
  techArea: 60399171700889,  // 기술 분야 (드롭다운)
  company: 60399237780249,   // 회사명 (드롭다운)
  supportPlan: 60399187106201, // AWS 서포트 플랜 (드롭다운)
  customerEmail: 60399189427993, // 고객사 이메일 (텍스트)
  awsAccount: 60399202141337, // AWS Account ID (텍스트)
};

// 드롭다운 한글 표시명 → Zendesk 옵션 태그
const FORM_TAG = {
  '기술문의': 'form_tech', '비용문의': 'form_cost', '샤크몬 문의': 'form_sharkmon',
  '내부문서요청': 'form_doc', '인시던트': 'form_incident', '미팅협의': 'form_meeting',
};
const AREA_TAG = { AWS: 'area_aws', Datadog: 'area_datadog', NHN: 'area_nhn' };
const PLAN_TAG = {
  Basic: 'plan_basic', Developer: 'plan_developer', Business: 'plan_business',
  'Enterprise On-Ramp': 'plan_onramp', Enterprise: 'plan_enterprise',
};
const COMPANY_TAG = { '스마일민정': 'co_minjeong', '스마일정빈': 'co_jeongbin', '스마일수현': 'co_suhyeon' };
// 태그 → 회사 표시명 (역방향, 라우팅 로그용)
const TAG_COMPANY = Object.fromEntries(Object.entries(COMPANY_TAG).map(([k, v]) => [v, k]));

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
    let map = await fetchTicketMapping(ticket_id);
    // 봇 매핑이 없으면(상담사가 Zendesk에서 직접 만든 티켓) 커스텀 필드로 라우팅 시도.
    if (!map) {
      try {
        const routed = await routeAgentTicket(ticket_id);
        if (routed) {
          map = routed;
          // 다음 답변부터는 빠르게 회신하도록 매핑을 캐시.
          await storeTicketMapping(ticket_id, routed);
        }
      } catch (e) {
        console.error('상담사-먼저 티켓 라우팅 실패:', e);
      }
    }
    if (!map) return res.status(200).send('no mapping'); // 라우팅 대상 미상

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
    let commentAuthorId = null;
    try {
      const latest = await fetchLatestPublicComment(ticket_id);
      if (latest) {
        commentText = latest.body || comment;
        attachments = latest.attachments || [];
        commentAuthorId = latest.author_id;
      }
    } catch (e) {
      console.error('최근 코멘트 조회 실패(페이로드 텍스트로 대체):', e);
    }

    // 요청자(고객) 본인 명의로 달린 코멘트면 → 고객 답장이므로 되돌려보내지 않음 (echo 방지)
    try {
      const requesterId = await fetchTicketRequesterId(ticket_id);
      if (requesterId && commentAuthorId && requesterId === commentAuthorId) {
        return res.status(200).send('skipped (requester comment)');
      }
    } catch (e) {
      console.error('요청자 조회 실패(echo 방지 판단 불가):', e);
    }

    const web = new WebClient(botToken);
    // 게시 대상: 고객사 지원 채널(map.channelId) 우선. 없으면(구 매핑) 요청자 DM으로 폴백.
    let channelId = map.channelId;
    if (!channelId) {
      const im = await web.conversations.open({ users: map.userId });
      channelId = im.channel?.id || map.userId;
    }
    // 이 티켓의 스레드가 이미 있으면 그 스레드에 이어붙이고, 없으면 이번 메시지를 스레드 루트로.
    let threadTs = map.threadTs || undefined;
    // 슬랙에 이 티켓 스레드가 아직 없다 = 상담사가 Zendesk에서 새로 만든 티켓(첫 등장)
    const isNewTicket = !threadTs;

    const headerText = isNewTicket
      ? `📩 *스마일샤크 담당자가 새 티켓을 보냈어요. (#${ticket_id})*` + (subject ? `\n_${subject}_` : '')
      : `💬 *티켓 #${ticket_id} 에 담당자 답변이 등록되었어요.*` + (subject ? `\n_${subject}_` : '');
    const notifyText = isNewTicket
      ? `📩 새 티켓이 도착했습니다. (#${ticket_id})`
      : `💬 티켓 #${ticket_id} 에 담당자 답변이 등록되었습니다.`;

    const posted = await web.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: notifyText,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: headerText },
        },
        { type: 'section', text: { type: 'mrkdwn', text: commentText ? truncate(commentText, 2800) : '(내용 없음)' } },
        replyButton(ticket_id),
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text:
                `🔗 <https://${ZENDESK_SUBDOMAIN}.zendesk.com/hc/requests/${ticket_id}|티켓 #${ticket_id} 진행상황 보기>   ·   ` +
                `상태: ${STATUS_LABEL[status] || status || '-'}   ·   \`/zendesk-status\` 로 전체 확인`,
            },
          ],
        },
      ],
    });

    // 스레드가 없던 티켓(상담사-먼저 첫 답변 등)이면 방금 만든 메시지를 스레드 루트로 저장.
    if (!threadTs && posted?.ts) {
      threadTs = posted.ts;
      try {
        await storeTicketMapping(ticket_id, {
          teamId: map.teamId,
          enterpriseId: map.enterpriseId,
          isEnterpriseInstall: map.isEnterpriseInstall,
          userId: map.userId,
          channelId,
          threadTs,
        });
      } catch (e) {
        console.error('스레드 루트 저장 실패:', e);
      }
    }

    // 담당자 첨부(사진 등)를 같은 채널·스레드에 이미지로 업로드 (files:write + 채널 멤버 필요)
    if (attachments.length) {
      await ensureBotInChannel(web, channelId);
      await uploadZendeskAttachmentsToSlack(web, channelId, attachments, threadTs);
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
      view: buildTicketModal({ channelId: body.channel_id }),
    });
  } catch (error) {
    logger.error('모달 열기 실패:', error);
  }
});

// ── 1-0. 회사 선택 변경 → 그 회사 직원(요청자) 드롭다운 갱신 ──
app.action('company_action', async ({ ack, body, client, logger }) => {
  await ack();
  const selected = body.actions?.[0]?.selected_option?.value;
  let channelId = '';
  try { channelId = JSON.parse(body.view.private_metadata || '{}').channelId || ''; } catch { /* noop */ }
  try {
    await client.views.update({
      view_id: body.view.id,
      hash: body.view.hash,
      view: buildTicketModal({ company: selected, channelId }),
    });
  } catch (error) {
    logger.error('회사 선택 모달 갱신 실패:', error);
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

// ── 1-1b. 답장 모달 제출 → 즉시 ack, 실제 처리는 비동기 워커로 (3초 제약 회피) ──
app.view('reply_modal', async ({ ack, body, view, logger }) => {
  await ack(); // 모달 즉시 닫기 (Slack 3초 제약)
  const payload = {
    __replyWorker: true,
    ticketId: view.private_metadata,
    text: view.state.values.reply_text.value.value,
    files: parseAttachments(view.state.values.reply_attachments?.files),
    userId: body.user.id,
    teamId: body.team?.id,
    enterpriseId: body.enterprise?.id,
    isEnterpriseInstall: Boolean(body.is_enterprise_install),
  };
  try {
    if (isLambda) {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: 'Event', // 비동기
          Payload: Buffer.from(JSON.stringify(payload)),
        })
      );
    } else {
      await handleReplyWorker(payload);
    }
  } catch (e) {
    logger.error('답장 워커 호출 실패:', e);
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
  // /zendesk가 실행된 채널 = 이 고객사의 지원 채널 (담당자 답변·답장 라우팅 대상)
  let originChannel = '';
  try { originChannel = JSON.parse(view.private_metadata || '{}').channelId || ''; } catch { /* noop */ }
  const v = view.state.values;
  const company = v.company?.company_action?.selected_option?.value || '';
  const requesterEmail = v.requester?.value?.selected_option?.value || '';
  // 요청자 이름: 디렉터리에서 조회 (없으면 이메일 앞부분으로 폴백)
  const member = (COMPANY_DIRECTORY[company] || []).find((m) => m.email === requesterEmail);
  const requesterName = member?.name || (requesterEmail ? requesterEmail.split('@')[0] : '');

  const form = {
    formType: v.form_type.value.selected_option.value,
    techArea: v.tech_area?.value?.selected_option?.value || '',
    company,
    requesterEmail,
    requesterName,
    subject: v.subject.value.value,
    ccEmails: parseEmails(v.cc?.value?.value || ''),
    awsAccount: v.aws_account?.value?.value || '',
    supportPlan: v.support_plan?.value?.selected_option?.value || '',
    urgency: v.urgency.value.selected_option.value, // high | normal | low
    description: v.description.value.value,
    // 사진/파일 첨부 (file_input) — 다운로드에 필요한 정보만 추림
    files: parseAttachments(v.attachments?.files),
  };

  // 회사·요청자 미선택 방지 (드롭다운 필수지만 안전장치)
  if (!company || !requesterEmail) {
    await ack({
      response_action: 'errors',
      errors: { company: '회사와 요청자를 모두 선택해 주세요.' },
    });
    return;
  }
  await ack(); // 모달 즉시 닫기 (Slack 3초 제약)

  // 첨부 업로드·Zendesk 생성·채널 게시는 느릴 수 있으므로 비동기 워커로 넘긴다.
  const payload = {
    __ticketWorker: true,
    form,
    userId,
    originChannel,
    teamId: body.team?.id,
    enterpriseId: body.enterprise?.id,
    isEnterpriseInstall: Boolean(body.is_enterprise_install),
  };
  try {
    if (isLambda) {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: 'Event', // 비동기
          Payload: Buffer.from(JSON.stringify(payload)),
        })
      );
    } else {
      await handleTicketWorker(payload);
    }
  } catch (e) {
    logger.error('티켓 워커 호출 실패:', e);
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

  // 티켓 본문 = 고객 문의 내용만 (양식·계정 등 메타데이터는 본문에 넣지 않음)
  const publicBody = form.description;

  if (!zendeskEnabled) {
    console.log('[DEV] Zendesk 미연동 — 티켓 생성 생략:', { subject });
    return null;
  }

  // 폼 값을 Zendesk 커스텀 필드로 정식 매핑 (드롭다운은 태그, 텍스트는 값 그대로)
  const custom_fields = [
    { id: ZD_FIELD.form, value: FORM_TAG[form.formType] },
    { id: ZD_FIELD.techArea, value: AREA_TAG[form.techArea] },
    { id: ZD_FIELD.company, value: COMPANY_TAG[form.company] },
    { id: ZD_FIELD.supportPlan, value: PLAN_TAG[form.supportPlan] },
    { id: ZD_FIELD.customerEmail, value: form.requesterEmail },
    { id: ZD_FIELD.awsAccount, value: form.awsAccount },
  ].filter((f) => f.value); // 빈 값 제외 (드롭다운 옵션 태그는 티켓 태그로도 자동 반영됨)

  const payload = {
    ticket: {
      subject,
      comment: { body: publicBody, public: true, ...(uploadToken ? { uploads: [uploadToken] } : {}) },
      priority: form.urgency, // high | normal | low
      tags: ['sharkton'],
      custom_fields,
      // 요청자 = 이메일 기준. 기존 사용자면 매칭(이 name은 무시·실제 이름 유지),
      // 신규 사용자면 Zendesk가 이름을 요구하므로 디렉터리의 이름(폴백: 이메일 앞부분)을 사용.
      ...(form.requesterEmail
        ? { requester: { email: form.requesterEmail, name: form.requesterName || form.requesterEmail.split('@')[0] || form.requesterEmail } }
        : {}),
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

// ── 헬퍼: 고객이 첨부한 파일(Slack)을 채널 스레드에도 다시 올려 대화 로그 완성 ──
// 모달 file_input 파일은 채널에 안 보이므로, Zendesk 업로드와 별개로 스레드에 재게시한다.
async function uploadSlackFilesToThread(web, dest, threadTs, files, botToken) {
  if (!files?.length) return;
  // 업로드 대상 채널 확정: 사용자 ID면 DM 채널 오픈, 채널이면 봇 참여(파일 업로드는 멤버 필요)
  let channelId = dest;
  if (dest && dest[0] === 'U') {
    try {
      const im = await web.conversations.open({ users: dest });
      channelId = im.channel?.id || dest;
    } catch (e) { /* noop */ }
  } else {
    await ensureBotInChannel(web, dest);
  }
  for (const f of files) {
    if (!f.url) continue;
    try {
      const dl = await fetch(f.url, { headers: { Authorization: `Bearer ${botToken}` } });
      if (!dl.ok) { console.error(`Slack 파일 다운로드 실패 ${dl.status}: ${f.name}`); continue; }
      const buf = Buffer.from(await dl.arrayBuffer());
      await web.files.uploadV2({ channel_id: channelId, thread_ts: threadTs, file: buf, filename: f.name || 'attachment' });
    } catch (e) {
      console.error(`첨부 스레드 업로드 실패: ${f.name}`, e?.data?.error || e);
    }
  }
}

// ── 헬퍼: 티켓 요청자(고객) 사용자 ID 조회 ─────────────────
async function fetchTicketRequesterId(ticketId) {
  if (!zendeskEnabled) return null;
  const res = await fetch(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`,
    { headers: { Authorization: `Basic ${zendeskAuth()}` } }
  );
  if (!res.ok) throw new Error(`Zendesk ticket ${res.status}`);
  const data = await res.json();
  return data.ticket?.requester_id || null;
}

// ── 헬퍼: 티켓 상세(커스텀 필드·요청자) 조회 ─────────────────
async function fetchTicketDetail(ticketId) {
  if (!zendeskEnabled) return null;
  const res = await fetch(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`,
    { headers: { Authorization: `Basic ${zendeskAuth()}` } }
  );
  if (!res.ok) throw new Error(`Zendesk ticket ${res.status}`);
  const data = await res.json();
  return data.ticket || null;
}

// ── 헬퍼: Zendesk 사용자 이메일 조회 ─────────────────────────
async function fetchZendeskUserEmail(userId) {
  if (!zendeskEnabled || !userId) return null;
  const res = await fetch(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${userId}.json`,
    { headers: { Authorization: `Basic ${zendeskAuth()}` } }
  );
  if (!res.ok) throw new Error(`Zendesk user ${res.status}`);
  const data = await res.json();
  return data.user?.email || null;
}

// ── 헬퍼: 이메일로 Zendesk 사용자 ID 조회 (답장 명의 매칭용) ──
async function findZendeskUserByEmail(email) {
  if (!zendeskEnabled || !email) return null;
  const res = await fetch(
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Basic ${zendeskAuth()}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const u = (data.users || []).find((x) => (x.email || '').toLowerCase() === email.toLowerCase());
  return u?.id || null;
}

// ── 헬퍼: 상담사-먼저 티켓 → Slack 라우팅 대상 해석 ──────────
// 봇 매핑이 없는(상담사가 Zendesk에서 직접 만든) 티켓을 커스텀 필드로 라우팅한다.
//   1순위(MSP 표준): 회사 태그 → 그 고객사 지원 채널 (개인 매칭 불필요)
//   2순위(폴백): 고객사/요청자 이메일 → 이메일 매핑(과거 /zendesk 기록)으로 개인 DM
// 반환: { teamId, enterpriseId, isEnterpriseInstall, channelId?, userId? } | null
async function routeAgentTicket(ticketId) {
  if (!zendeskEnabled) return null;
  const ticket = await fetchTicketDetail(ticketId);
  if (!ticket) return null;

  const fields = ticket.custom_fields || [];
  const fieldValue = (id) => fields.find((f) => Number(f.id) === Number(id))?.value || null;
  const companyTag = fieldValue(ZD_FIELD.company);

  // 1순위: 회사 → 지원 채널
  if (companyTag) {
    const reg = await fetchCompanyTeam(companyTag);
    if (reg?.teamId && reg?.channelId) {
      return {
        teamId: reg.teamId,
        enterpriseId: reg.enterpriseId,
        isEnterpriseInstall: reg.isEnterpriseInstall,
        channelId: reg.channelId,
      };
    }
  }

  // 2순위: 이메일 → 개인 DM (지원 채널이 없는 고객사 대비)
  let email = fieldValue(ZD_FIELD.customerEmail);
  if (!email && ticket.requester_id) {
    try { email = await fetchZendeskUserEmail(ticket.requester_id); } catch (e) { /* noop */ }
  }
  if (email) {
    const byEmail = await fetchUserByEmail(email);
    if (byEmail?.userId) {
      return {
        teamId: byEmail.teamId,
        enterpriseId: byEmail.enterpriseId,
        isEnterpriseInstall: byEmail.isEnterpriseInstall,
        userId: byEmail.userId,
      };
    }
  }

  return null;
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
async function uploadZendeskAttachmentsToSlack(web, channelId, attachments, threadTs) {
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
        thread_ts: threadTs,
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
async function addZendeskComment(ticketId, text, slackUserId, uploadToken, authorEmail) {
  if (!zendeskEnabled) {
    console.log('[DEV] Zendesk 미연동 — 코멘트 생략:', { ticketId, text });
    return;
  }
  // 명의: 채널에서 버튼 누른 사람(authorEmail) → Zendesk 유저 우선, 실패 시 티켓 요청자로 폴백.
  // 요청자 명의면 마커 불필요 + 담당자→고객 웹훅 echo 자동 방지(end-user role).
  let authorId = null;
  if (authorEmail) {
    try { authorId = await findZendeskUserByEmail(authorEmail); } catch (e) { /* noop */ }
  }
  if (!authorId) {
    try {
      authorId = await fetchTicketRequesterId(ticketId);
    } catch (e) {
      console.error('요청자 조회 실패(명의 지정 없이 진행):', e);
    }
  }
  const payload = {
    ticket: {
      comment: {
        body: text,
        public: true,
        ...(authorId ? { author_id: authorId } : {}),
        ...(uploadToken ? { uploads: [uploadToken] } : {}),
      },
    },
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

// ── 헬퍼: 봇을 채널에 참여시킨다 (파일 업로드는 채널 멤버여야 가능) ──
// 공개 채널은 자동 참여, DM/비공개(초대 필요)는 조용히 무시.
async function ensureBotInChannel(web, channelId) {
  if (!channelId || channelId[0] === 'D' || channelId[0] === 'U') return; // DM/사용자
  try {
    await web.conversations.join({ channel: channelId });
  } catch (e) {
    // already_in_channel 이면 정상, method_not_supported_for_channel_type/비공개면 초대 필요
    const err = e?.data?.error;
    if (err && err !== 'already_in_channel') {
      console.error(`채널 자동 참여 실패(${channelId}): ${err} — 비공개 채널이면 봇 초대 필요`);
    }
  }
}

// ── 헬퍼: 비동기 워커 (티켓 생성 → 첨부 업로드 + Zendesk 생성 + 채널 스레드 게시 + 매핑) ──
async function handleTicketWorker(event) {
  const { form, userId, originChannel, teamId, enterpriseId, isEnterpriseInstall } = event;
  let web = null;
  try {
    const installation = await installationStore.fetchInstallation({ teamId, enterpriseId, isEnterpriseInstall });
    const botToken = installation?.bot?.token;
    web = new WebClient(botToken);

    console.log(
      `📨 문의 접수 | Slack ID: ${userId} | 요청자: ${form.requesterEmail} | 회사: ${form.company} | 양식: ${form.formType}`
    );

    // 첨부파일: Slack에서 다운로드 → Zendesk 업로드 → 업로드 토큰 확보
    let uploadToken = null;
    if (form.files?.length) {
      try {
        uploadToken = await uploadFilesToZendesk(form.files, botToken);
      } catch (e) {
        console.error('첨부파일 업로드 실패(첨부 없이 티켓 생성 진행):', e);
      }
    }

    const ticket = await createZendeskTicket(form, uploadToken);

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
    // 고객이 진행상황을 직접 볼 수 있는 Zendesk 요청 페이지 링크 (Help Center 기준)
    if (ticket && zendeskEnabled) {
      confirmBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🔗 <https://${ZENDESK_SUBDOMAIN}.zendesk.com/hc/requests/${ticket.id}|티켓 #${ticket.id} 진행상황 보기>   ·   Slack에서 \`/zendesk-status\` 로도 확인`,
          },
        ],
      });
    }
    if (ticket) confirmBlocks.push(replyButton(ticket.id));

    // 접수 메시지를 지원 채널에 게시해 이 티켓의 "스레드 루트"로 삼는다.
    // 파일 업로드가 뒤따를 수 있으므로 먼저 채널에 참여. 실패 시 요청자 DM으로 폴백.
    let postChannel = originChannel || userId;
    let threadTs = null;
    await ensureBotInChannel(web, postChannel);
    try {
      const posted = await web.chat.postMessage({
        channel: postChannel,
        text: `✅ 문의가 접수되었습니다. ${idText}`,
        blocks: confirmBlocks,
      });
      threadTs = posted.ts;
    } catch (e) {
      console.error('지원 채널 게시 실패(요청자 DM으로 폴백):', e?.data?.error || e);
      postChannel = userId;
      try {
        const posted = await web.chat.postMessage({
          channel: postChannel,
          text: `✅ 문의가 접수되었습니다. ${idText}`,
          blocks: confirmBlocks,
        });
        threadTs = posted.ts;
      } catch (e2) {
        console.error('DM 폴백 게시도 실패:', e2?.data?.error || e2);
      }
    }

    // 고객이 첨부한 사진을 접수 스레드에도 표시 (Zendesk뿐 아니라 채널에도)
    if (form.files?.length && threadTs) {
      await uploadSlackFilesToThread(web, postChannel, threadTs, form.files, botToken);
    }

    // 양방향 동기화: 티켓 ↔ {채널·스레드·요청자} 매핑 저장 (웹훅/답장 회신 대상)
    if (ticket) {
      const meta = { teamId, enterpriseId, isEnterpriseInstall };
      try {
        await storeTicketMapping(ticket.id, { ...meta, userId, channelId: postChannel, threadTs });
      } catch (e) {
        console.error('티켓 매핑 저장 실패(회신 동기화 불가):', e);
      }
      // 회사 → 지원 채널 레지스트리 자동 채움 (상담사-먼저 티켓 라우팅용)
      try {
        const companyTag = COMPANY_TAG[form.company];
        if (companyTag) await storeCompanyTeam(companyTag, { ...meta, channelId: originChannel });
      } catch (e) {
        console.error('회사→채널 매핑 저장 실패:', e);
      }
      // 이메일→사용자 매핑(개인 DM 폴백 라우팅용)
      try {
        if (form.requesterEmail) await storeUserByEmail(form.requesterEmail, { ...meta, userId });
      } catch (e) {
        console.error('이메일→사용자 매핑 저장 실패:', e);
      }
    }
  } catch (e) {
    console.error('티켓 생성 실패:', e);
    try {
      if (web) await web.chat.postMessage({ channel: userId, text: '⚠️ 문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    } catch { /* noop */ }
  }
  return { ok: true };
}

// ── 헬퍼: 비동기 워커 (답장 → 첨부 업로드 + 코멘트 등록 + 확인 DM) ──
async function handleReplyWorker(event) {
  const { ticketId, text, files, userId, teamId, enterpriseId, isEnterpriseInstall } = event;
  let web = null;
  // 이 티켓의 채널·스레드(있으면 그 스레드에 답장 반영, 없으면 DM 폴백)
  let dest = userId;
  let threadTs;
  try {
    const map = await fetchTicketMapping(ticketId);
    if (map?.channelId) { dest = map.channelId; threadTs = map.threadTs || undefined; }
  } catch (e) { /* noop: DM 폴백 */ }

  try {
    const installation = await installationStore.fetchInstallation({ teamId, enterpriseId, isEnterpriseInstall });
    const botToken = installation?.bot?.token;
    web = new WebClient(botToken);

    let uploadToken = null;
    if (files?.length) {
      try {
        uploadToken = await uploadFilesToZendesk(files, botToken);
      } catch (e) {
        console.error('답장 첨부 업로드 실패(첨부 없이 코멘트 진행):', e);
      }
    }
    // 고객 답장은 항상 "티켓 요청자(고객) 명의"로 등록 → 방향(고객→담당자) 보장 + echo 방지.
    await addZendeskComment(ticketId, text, userId, uploadToken);

    // 채널 스레드에 답장 내용을 노출해 대화 로그를 일원화 (DM이면 스레드 없이 게시)
    await web.chat.postMessage({
      channel: dest,
      thread_ts: threadTs,
      text: `💬 티켓 #${ticketId} 답장 전달됨`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `💬 *답장을 전달했어요.*\n> ${truncate(text || '', 2800)}` } },
      ],
    });

    // 고객이 첨부한 사진도 같은 스레드에 표시 (Zendesk뿐 아니라 채널에도)
    if (files?.length) {
      await uploadSlackFilesToThread(web, dest, threadTs, files, botToken);
    }
  } catch (e) {
    console.error('답장 처리 실패:', e);
    try {
      if (web) await web.chat.postMessage({ channel: dest, thread_ts: threadTs, text: `⚠️ 티켓 #${ticketId} 답장 전송 중 오류가 발생했습니다.` });
    } catch {}
  }
  return { ok: true };
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

function selectInput(
  block_id,
  label,
  opts,
  { optional = false, placeholder = '선택', hint, actionId = 'value', dispatch = false, initialValue } = {}
) {
  const element = {
    type: 'static_select',
    action_id: actionId,
    placeholder: { type: 'plain_text', text: placeholder },
    options: opts,
  };
  // views.update로 재렌더 시 이전 선택값 유지
  if (initialValue !== undefined) {
    const match = opts.find((o) => o.value === initialValue);
    if (match) element.initial_option = match;
  }
  const block = {
    type: 'input',
    block_id,
    optional,
    label: { type: 'plain_text', text: label },
    element,
  };
  if (dispatch) block.dispatch_action = true; // 선택 변경 시 block_actions 발생
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
      // filetypes 미지정 = 모든 파일 형식 허용 (사진·pdf뿐 아니라 md·xlsx·csv·docx·zip 등).
      // 특정 슬러그로 제한하면 목록 밖 형식이 막히고, 잘못된 슬러그는 모달을 못 열게 하므로 제한 없음.
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
// state.company 선택 시 그 회사 소속 직원(요청자) 드롭다운을 동적으로 노출.
function buildTicketModal(state = {}) {
  const { company, channelId } = state;

  const blocks = [
    selectInput('form_type', '양식', options([
      ['기술문의'], ['비용문의'], ['샤크몬 문의'], ['내부문서요청'], ['인시던트'], ['미팅협의'],
    ])),
    selectInput('tech_area', '기술 분야', options([
      ['AWS'], ['Datadog'], ['NHN'],
    ]), { optional: true, hint: '기술문의인 경우 선택하세요' }),
    // 회사 선택: 변경 시 dispatch → 요청자 목록 갱신
    selectInput('company', '회사', options(Object.keys(COMPANY_DIRECTORY).map((c) => [c])), {
      actionId: 'company_action', dispatch: true, initialValue: company, placeholder: '회사 선택',
    }),
  ];

  // 회사를 고르면 그 회사 직원(요청자) 드롭다운 표시
  if (company && COMPANY_DIRECTORY[company]) {
    blocks.push(
      selectInput('requester', '요청자', options(
        COMPANY_DIRECTORY[company].map((m) => [`${m.name} (${m.email})`, m.email])
      ), { placeholder: '요청자 선택' })
    );
  }

  blocks.push(
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
    fileInputBlock('attachments', '사진/파일 첨부')
  );

  return {
    type: 'modal',
    callback_id: 'ticket_modal',
    // /zendesk가 실행된 채널을 보관 → 접수·담당자 답변·답장을 이 채널의 스레드로 라우팅
    private_metadata: JSON.stringify({ channelId: channelId || '' }),
    title: { type: 'plain_text', text: '젠데스크 문의' },
    submit: { type: 'plain_text', text: '문의 접수' },
    close: { type: 'plain_text', text: '취소' },
    blocks,
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
  if (event && event.__ticketWorker) {
    return handleTicketWorker(event);
  }
  if (event && event.__replyWorker) {
    return handleReplyWorker(event);
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
