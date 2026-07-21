# SharkBot

고객사가 **자기 회사 Slack에서** AWS 콘솔·Zendesk 포털을 거치지 않고, 스마일샤크에 문의를 보내고 진행 상황까지 확인할 수 있게 하는 **멀티테넌트 Slack 봇**.

여러 고객사가 각자 워크스페이스에 설치(OAuth)해 사용하며, **HTTP + OAuth** 방식으로 AWS(Lambda)에 서버리스로 배포된다.

## 아키텍처

```
                    ┌───────────────────────────────────────────────┐
[고객사 A/B/C Slack] │  /zendesk         (티켓 발행 모달)              │
        │           │  /zendesk-status  (내 티켓 상태 조회)           │
        │  HTTPS    │  /ask             (AWS 질문 → AI 답변)          │
        └──────────►│  API Gateway ──► Lambda (Bolt, HTTP + OAuth)    │
                    │                     ├─ DynamoDB                 │
                    │                     │    · 고객사별 설치 토큰     │
                    │                     │    · 티켓 ↔ Slack 매핑     │
                    │                     ├─ Zendesk API (생성/검색)   │
                    │                     └─ Bedrock (AI 답변)         │
                    └───────────────────────────────────────────────┘

[담당자] Zendesk 공개답변 ─ 트리거 ─► 웹훅 POST /zendesk/webhook ─► Lambda ─► 고객 Slack DM 회신
```

- **설치**: 고객이 `/slack/install`로 OAuth 승인 → 워크스페이스별 봇 토큰을 **DynamoDB**에 저장
- **멀티테넌트**: 요청의 team_id로 해당 고객사 토큰을 조회해 응답 → 여러 고객사에 동시 배포
- **결정론적 분기**: 슬래시 커맨드로 요청 성격을 명시적으로 나눠(`/zendesk` 폼 vs `/ask` AI) 오분류를 원천 차단

## 기능

| 커맨드 / 흐름 | 설명 | 상태 |
|---|---|---|
| **`/zendesk`** | 문의 폼(모달) 작성 → Zendesk 티켓 자동 생성, 티켓 번호 회신 | ✅ 운영 |
| **`/zendesk-status`** | 요청자(Slack 이메일) 기준으로 본인 티켓 목록·상태 조회 (한글 상태 표기) | ✅ 배포 |
| **양방향 동기화** | 담당자가 Zendesk에서 공개 답변하면 고객 Slack DM으로 자동 회신 | ⏸️ 코드 완료 / 설정 대기 |
| **`/ask`** | AWS 사용법·개념 질문에 Bedrock 기반 AI가 한국어로 답변 | ⏸️ 코드 완료 / SCP 대기 |

### `/zendesk` 문의 폼 필드
양식 · 기술 분야(AWS/Datadog/NHN) · 요청자 이메일 · 회사명 · 참조(CC) · 제목 · AWS 계정 ID · AWS 서포트 플랜 · 긴급도 · 문의 내용
- **요청자(requester)**: 입력한 **이메일**로 Zendesk가 매칭 — 기존 사용자면 그 사용자에 연결(이름 자동), 없으면 이메일로 신규 생성. 형식 오류 시 모달에 인라인 에러 표시
- **참조(CC)**: 입력한 이메일들을 Zendesk `collaborators`(참조자)로 등록
- **제목(subject)**: 고객이 입력한 제목에 `[회사명]` 접두어 → `[회사명] 사용자입력제목` (트리아지용)
- 폼 값은 티켓 **본문 + 태그**로 전달 (Zendesk 커스텀 필드 ID 확보 시 정식 매핑 예정)

### 양방향 동기화 동작
1. `/zendesk` 티켓 생성 시 `티켓 ID ↔ Slack 사용자` 매핑을 DynamoDB에 저장 (기존 테이블 재사용)
2. Zendesk 트리거가 **담당자 공개 답변** 시 웹훅(`/zendesk/webhook`) 호출
3. Lambda가 매핑을 조회해 해당 고객 워크스페이스 봇 토큰으로 **Slack DM 회신**
- 웹훅은 커스텀 헤더 시크릿으로 검증, 담당자(agent/admin) 답변만 전달(고객 본인 코멘트 echo 방지)

## 구성 요소

| 구성 | 역할 |
|---|---|
| `app.js` | Bolt 앱 — ExpressReceiver(OAuth) + 슬래시 커맨드/모달/웹훅 라우트 + Lambda `handler` |
| `installationStore.js` | 고객사별 설치 토큰 + 티켓 매핑 저장 (DynamoDB / 로컬은 메모리 폴백) |
| `manifest.json` | Slack 앱 설정(커맨드·스코프) 정의 |
| API Gateway (HTTP API) | 공개 HTTPS 엔드포인트 → Lambda 프록시 |
| Lambda `sharkbot` | 실행 런타임 (Node.js 22.x, `app.handler`) |
| DynamoDB `sharkbot-installations` | 설치 토큰 + 티켓↔사용자 매핑 저장 |

**기술 스택**: Node.js · Slack Bolt(HTTP + OAuth) · AWS Lambda / API Gateway / DynamoDB · Zendesk API · Amazon Bedrock

## OAuth 스코프

| 스코프 | 용도 |
|---|---|
| `commands` | 슬래시 명령 (`/zendesk`, `/zendesk-status`, `/ask`) |
| `chat:write` / `chat:write.public` | 메시지·DM 회신 |
| `users:read` / `users:read.email` | 요청자(고객) 이메일 매핑 |
| `im:write` | DM 회신 |

## 문서

- 배포 절차 (AWS 콘솔): [../Progress/DEPLOYMENT.md](../Progress/DEPLOYMENT.md)
- 기능별 설계·진행 현황: [../Progress/](../Progress/) (`00-overview.md` ~ `04-*.md`)
