# SharkBot

고객사가 **자기 회사 Slack에서** AWS 콘솔·Zendesk 포털을 거치지 않고 스마일샤크에 문의하고, AWS 비용·리소스까지 물어볼 수 있게 하는 **멀티테넌트 Slack 봇**.

- **`/zendesk`** — 문의를 Zendesk 티켓으로 발행하고 담당자와 **양방향**으로 대화 (진행 상황까지 Slack에서 확인)
- **`/ask`** — AWS 비용·리소스 질문을 **AI 에이전트**가 조회해 한국어로 답변

여러 고객사가 각자 워크스페이스에 OAuth로 설치해 쓰며, **서버리스(Lambda · API Gateway · DynamoDB)** 로 배포된다.

## 아키텍처

```
                     ┌──────────────── 서울 (ap-northeast-2) ─────────────────┐
[고객 A Slack]  ────►│  API Gateway ──► Lambda (SharkBot · Bolt, HTTP+OAuth)   │
[고객 B Slack]  ────►│                    ├─ DynamoDB                          │
[고객 C Slack]  ────►│                    │    · 고객사별 설치 토큰(멀티테넌트)  │
   /zendesk          │                    │    · 티켓 ↔ 슬랙(채널·스레드)        │
   /zendesk-status   │                    │    · 회사 → 슬랙 / 이메일 → 사용자   │
   답장 버튼         │                    ├─ Zendesk API (티켓·커스텀 필드)     │
   /ask              │                    └─ self-invoke 워커(비동기)           │
        ▲            │                         ├─ /zendesk: 티켓 생성·채널 게시  │
        │            │                         └─ /ask: team_id로 테넌트 라우팅┐│
        │            └──────────────────────────────────────────────────────┼─┘
        │ ① 담당자 답변/티켓→트리거→웹훅→슬랙 스레드 회신 (Zendesk)             │
        │                          ② ASK_TENANT_MAP[team_id] → 그 고객 에이전트 URL
    [Zendesk]                         (T0BL…A→tenant-a · …B→tenant-b · …C→…)  │
                                                                              ▼
                     ┌──────────────── 버지니아 (us-east-1) ──────────────────┐
                     │  tenant-a API GW ─► 에이전트 A (Strands+Bedrock, CID 5cff)
                     │  tenant-b API GW ─► 에이전트 B (              CID 3ae0)  │
                     │  tenant-c API GW ─► 에이전트 C (              CID 2q80)  │
                     │        │  질문 성격에 따라 도구 자동 선택                 │
                     │        ├ [비용]  Cognito JWT(CID) → 중앙 MCP 게이트웨이   │
                     │        │         → get_cost_summary                     │
                     │        │            → sharkton-tenant-map (CID→테넌트)   │
                     │        │            → sharkton-costs (테넌트별 비용)      │
                     │        ├ [가이드] 중앙 MCP → search_internal_guide       │
                     │        │         (Confluence · 공용 지식, 격리 불필요)    │
                     │        └ [리소스] 계정 로컬 boto3 (EC2/Lambda/S3 · RO)    │
                     │  → answer → 서울이 Slack response_url로 게시             │
                     └─────────────────────────────────────────────────────────┘
   (데모는 세 에이전트가 한 계정에 있고 API GW만 tenant별로 분리 = 실서비스 "계정별 배포"에 근접)
```
> `/zendesk`는 서울에서 자기완결. `/ask`는 서울이 **team_id로 고객사를 판별(`ASK_TENANT_MAP`)** 해 그 고객 전용 **버지니아 에이전트**로 넘긴다(AgentCore가 버지니아만 지원 → SCP 우회).
> **테넌트 격리 사슬**: `team_id`(어느 Slack) → 고객 에이전트 URL → 에이전트의 `CLIENT_ID`(JWT) → `sharkton-tenant-map`(CID→projectcode) → `sharkton-costs`(테넌트별 비용). A/B/C가 끝까지 안 섞인다.

- **설치**: 고객이 `/slack/install`로 OAuth 승인 → 워크스페이스별 봇 토큰을 **DynamoDB**에 저장
- **멀티테넌트**: 요청의 team_id로 해당 고객사 토큰을 조회해 응답 → 여러 고객사에 동시 배포
- **결정론적 분기**: 슬래시 커맨드로 요청 성격을 명시적으로 나눠(`/zendesk` 폼 vs `/ask` AI) 오분류를 원천 차단

## 기능

| 커맨드 / 흐름 | 설명 | 상태 |
|---|---|---|
| **`/zendesk`** | 문의 폼(모달) 작성 → Zendesk 티켓 자동 생성(커스텀 필드·사진 첨부 포함). 비동기 워커 처리 | ✅ 배포 |
| **`/zendesk-status`** | 요청자(Slack 이메일) 기준으로 본인 티켓 목록·상태 조회 + **각 티켓에 `💬 답장` 버튼** | ✅ 배포 |
| **답장(티켓 이어쓰기)** | `💬 답장` 버튼 → 모달(**사진 첨부 가능**) → 새 티켓 없이 **같은 티켓에 공개 코멘트 추가**(요청자 명의) | ✅ 배포 |
| **파일 첨부(전 형식)** | 모달 `file_input`(png/jpg/pdf·**md/xlsx/csv/docx/zip 등 전 형식**) → Zendesk 티켓 + **채널 스레드에도 표시** | ✅ 배포 |
| **양방향 동기화(담당자→고객)** | 담당자가 Zendesk에서 공개 답변/티켓 생성 → 그 **고객사 지원 채널 스레드**로 자동 회신 (텍스트 + **첨부 사진**) | ⚙️ 코드 완료 / 재설치·웹훅 설정 후 실동작 |
| **상담사-먼저 티켓 라우팅** | 상담사가 직접 만든 티켓을 **회사 커스텀 필드**로 그 고객사 채널에 라우팅 | ⚙️ 코드 완료 / 위와 동일 |
| **`/ask` (멀티테넌트)** | 질문을 **그 고객사 전용 버지니아 에이전트**로 라우팅(team_id 기준)해 비용(MCP 게이트웨이, **테넌트별 격리**)·리소스(로컬 boto3)·가이드(Confluence)를 조회해 한국어 답변. 서울은 판별·진입·게시만 | ✅ 데모 실동작 |

### `/zendesk` 문의 폼 필드
양식 · 기술 분야(AWS/Datadog/NHN) · **회사(드롭다운)** · **요청자(회사 선택 시 직원 드롭다운)** · 참조(CC) · 제목 · AWS 계정 ID · AWS 서포트 플랜 · 긴급도 · 문의 내용 · 사진/파일 첨부
- **회사 → 요청자 종속 드롭다운**: 회사 선택 시 그 회사 직원 목록이 동적 갱신(`views.update`). 선택한 직원 이메일이 Zendesk `requester`
- **참조(CC)**: 입력한 이메일들을 Zendesk `collaborators`(참조자)로 등록
- **제목(subject)**: 고객이 입력한 제목에 `[회사명]` 접두어 → `[회사명] 사용자입력제목` (트리아지용)
- **파일 첨부(전 형식)**: `file_input`(최대 5개, **형식 제한 없음** — 사진·pdf뿐 아니라 md/xlsx/csv/docx/zip 등) → Slack에서 다운로드 → Zendesk `uploads.json` 첨부 + **접수 스레드에도 재업로드**해 채널에서도 확인 (`files:read`·`files:write` 스코프)
- **커스텀 필드 정식 매핑**: 폼 값(양식·기술분야·회사·서포트 플랜·고객사 이메일·계정 ID)은 **Zendesk 커스텀 필드**로 전달. 드롭다운은 한글 표시명→옵션 태그로 변환(`app.js`의 `ZD_FIELD`+태그 맵). 본문엔 문의 내용만
- **진행상황 링크**: 접수·담당자 회신 메시지에 `🔗 티켓 진행상황 보기`(Zendesk 요청 페이지 `/hc/requests/<id>`) 링크 표시 — Help Center 활성화 시 고객이 직접 열람
- **3초 제약 회피**: 제출 즉시 모달을 닫고, 업로드·티켓 생성·채널 게시는 **비동기 self-invoke 워커**(`handleTicketWorker`)가 처리

### 티켓 이어쓰기 (답장) — 고객 → 담당자
- **진입점**: 접수 확인 · 담당자 답변 알림 · `/zendesk-status` 목록의 각 티켓 — 모두 같은 `reply_ticket` 액션 재사용
- **`💬 답장`** 버튼 → 모달 입력(**사진/파일 첨부 가능**) → `PUT /api/v2/tickets/{id}` 로 **같은 티켓에 공개 코멘트(+`uploads`) 추가**
- **요청자(고객) 명의로 고정**: 버튼 누른 사람이 아니라 **티켓 요청자** `author_id`로 등록 → 방향(고객→담당자) 보장 + 담당자→고객 웹훅 echo 자동 방지
- 버튼 `value`·모달 `private_metadata`에 `ticket_id`를 실어 식별 → 새 티켓 발급 불필요. 비동기 워커(`handleReplyWorker`) 처리

### 양방향 동기화 (담당자 → 고객) — 고객사 지원 채널 스레드
개인 DM 대신 **고객사 전용 지원 채널**로 라우팅(MSP 표준) → 개인 이메일 매칭 문제 회피, 팀 전체가 진행 확인.
1. `/zendesk` 티켓 생성 시 `티켓 ↔ {채널, 스레드}` + `회사 → 지원 채널` + `이메일 → 사용자` 매핑을 DynamoDB에 자동 저장(자동 채움)
2. Zendesk 트리거가 **담당자 공개 답변/티켓 생성** 시 웹훅(`/zendesk/webhook`) 호출
3. Lambda가 최근 공개 코멘트(텍스트+첨부) 조회 → 그 고객사 **지원 채널 스레드**에 게시. 봇 매핑이 없는(상담사-먼저) 티켓은 **회사 커스텀 필드**로 채널 해석(`routeAgentTicket`)
4. 첨부(사진)는 Zendesk에서 다운로드 → **Slack `files.uploadV2`로 같은 스레드에 업로드**. 파일 업로드는 봇이 채널 멤버여야 하므로 **채널마다 봇을 수동 `/invite`** 해 둔다
- **티켓 = 채널 안 스레드 1개**로 정리. 새 티켓 첫 등장이면 "📩 새 티켓", 이후는 "💬 담당자 답변". 두 메시지 모두 **진행상황 링크** 포함
- **고객 답장 첨부**도 같은 스레드에 재게시 → 고객이 보낸 파일이 Zendesk뿐 아니라 채널 스레드에도 표시(`uploadSlackFilesToThread`)
- 웹훅은 커스텀 헤더 시크릿(`X-Sharkbot-Token`)으로 검증, 담당자(agent/admin) 답변만 전달(echo 방지)
- **활성화 조건**: ① Zendesk 웹훅·트리거(관리자 권한) + ② `files:write` 추가 후 **재설치** + ③ 워커 self-invoke용 `lambda:InvokeFunction`
- **채널 참여**: 봇을 슬랙 채널에 **수동 `/invite @SharkBot`**(파일 업로드는 봇이 채널 멤버여야 가능). `ensureBotInChannel`의 `conversations.join`은 `channels:join` 스코프가 없어 `missing_scope`로 실패하지만, 이를 `already_in_channel`과 함께 **무해(benign)로 간주해 에러 로그를 남기지 않는다** — 초대만 돼 있으면 정상 동작하고, 봇이 진짜 채널에 없을 때만 `uploadV2`가 `not_in_channel`로 실제 실패를 알린다

### `/ask` — 멀티테넌트 라우팅 (서울 판별 → 고객사별 버지니아 에이전트)
AgentCore가 **버지니아(us-east-1)에서만 지원**되어, `/ask`의 두뇌는 버지니아에 두고 서울은 **어느 고객사인지 판별해 그 고객 에이전트로 넘기기만** 한다 (전체 흐름은 위 아키텍처 참고).

**테넌트 라우팅 (team_id → 고객 에이전트)**
- 서울 `/ask` 즉시 ack → 워커가 **`command.team_id`** 로 그 고객사를 판별. 코드: `resolveAgentUrl(teamId)` → `callAskAgent(question, teamId)` (`app.js`)
- 매핑은 env **`ASK_TENANT_MAP`**(JSON): `{"<team_id>":"<에이전트 URL 또는 projectcode>", ...}`
  - 값이 **전체 URL**이면 그대로 호출 (**B2** — 고객/테넌트마다 API Gateway가 따로)
  - 값이 **projectcode**면 `ASK_AGENT_BASE_URL`과 조합해 `…/tenant-x` (**B1** — 공용 API 1개 + 경로만 다름)
  - 매핑이 없으면 단일 **`ASK_AGENT_URL`** 폴백 → 그것도 없으면 로컬 Bedrock 폴백
- ⚠️ **`ASK_TENANT_MAP` 값 칸엔 JSON만** 넣는다(`{`로 시작). `키:`/`값:` 라벨이나 줄바꿈이 섞이면 파싱 실패 → 폴백으로 새어 엉뚱한 에이전트로 감(로그에 `ASK_TENANT_MAP 파싱 실패`)
- 답변은 Slack `response_url`로 게시(모델 `<thinking>` 제거)

**테넌트 격리 (비용이 고객별로 갈리는 원리)**
- 각 고객 에이전트 Lambda는 **자기 `CLIENT_ID`** 로 Cognito JWT 발급 → 중앙 MCP 게이트웨이의 `get_cost_summary` 호출
- 비용툴이 JWT의 client_id → **`sharkton-tenant-map`**(client_id→projectcode) → **`sharkton-costs`**(projectcode별 비용) 순으로 조회 → **테넌트별 비용** 반환
- **리소스**(`describe_resources`)는 그 계정 로컬 boto3(실제 Read-Only), **가이드**(`search_internal_guide`)는 Confluence 공용 지식(격리 불필요)

**운영 메모**
- **SCP 우회**: Bedrock이 버지니아 계정에서 실행되어 서울에서 막혔던 조직 SCP(`bedrock:*` 거부)를 우회
- **주의**: 에이전트 응답이 수 초라 **서울 Lambda 타임아웃 60초** 필요
- **테스트 팁**: "이번 달"은 월말 마감 전이면 "데이터 없음"이 정상 응답 → 데모는 **`/ask 지난달 비용`** 으로
- **역할 경계**: MCP 게이트웨이·비용/가이드 툴·`sharkton-*` 테이블 = 별도 담당(MCP), 서울 `/ask` 진입·라우팅 = SharkBot(본 저장소)
- **확장(향후)**: 현재는 `ASK_TENANT_MAP` 수동 관리(고객 3곳). 고객 증가 시 → **DynamoDB 라우팅 테이블** + 설치 링크 라벨로 team_id↔테넌트 자동 등록 + 인프라는 **StackSets/Terraform**으로 전환

## 구성 요소

| 구성 | 역할 |
|---|---|
| `app.js` | Bolt 앱 — ExpressReceiver(OAuth) + 슬래시 커맨드/모달/웹훅 라우트 + Lambda `handler` |
| `installationStore.js` | 설치 토큰 + 티켓↔채널·스레드 + 회사→채널 + 이메일→사용자 매핑 (DynamoDB / 로컬은 메모리 폴백) |
| `manifest.json` | Slack 앱 설정(커맨드·스코프) 정의 |
| API Gateway (HTTP API) | 공개 HTTPS 엔드포인트 → Lambda 프록시 |
| Lambda `sharkbot` | 실행 런타임 (Node.js 22.x, `app.handler`) + 비동기 self-invoke 워커 |
| DynamoDB `sharkbot-installations` | 설치 토큰 + 라우팅 매핑(티켓·회사·이메일) — 한 테이블 `id` 프리픽스로 구분 |

**기술 스택**: Node.js · Slack Bolt(HTTP + OAuth) · AWS Lambda / API Gateway / DynamoDB · Zendesk API · `/ask`는 **고객사별 버지니아 AgentCore 에이전트**(Bedrock·Strands·MCP)로 멀티테넌트 라우팅

### 주요 환경 변수 (`/ask` 관련)
| 변수 | 용도 |
|---|---|
| `ASK_TENANT_MAP` | **(핵심)** team_id → 고객 에이전트 URL(또는 projectcode) JSON 매핑. 값 칸엔 **JSON만** |
| `ASK_AGENT_BASE_URL` | B1(공용 API+경로) 방식일 때 projectcode와 조합할 베이스 URL. B2(전체 URL)면 불필요 |
| `ASK_AGENT_URL` | 매핑 없을 때 단일 폴백 에이전트 URL |
| `BEDROCK_MODEL_ID` | 로컬 Bedrock 폴백용(서울 SCP로 현재 비활성) |

## OAuth 스코프

| 스코프 | 용도 |
|---|---|
| `commands` | 슬래시 명령 (`/zendesk`, `/zendesk-status`, `/ask`) |
| `chat:write` / `chat:write.public` | 메시지·DM 회신 |
| `users:read` / `users:read.email` | 요청자(고객) 이메일 매핑 |
| `im:write` | DM 회신(폴백) |
| `files:read` | 고객 첨부 다운로드(→ Zendesk 업로드) |
| `files:write` | 담당자 첨부를 고객사 슬랙 채널에 업로드 (양방향 동기화용) |

## 문서

- 배포 절차 (AWS 콘솔): [../Progress/DEPLOYMENT.md](../Progress/DEPLOYMENT.md)
- 기능별 설계·진행 현황: [../Progress/](../Progress/) (`00-overview.md` ~ `04-*.md`)
