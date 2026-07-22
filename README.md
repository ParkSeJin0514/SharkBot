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
| **`/zendesk`** | 문의 폼(모달) 작성 → Zendesk 티켓 자동 생성(사진 첨부 포함), 티켓 번호 회신 | ✅ 배포 |
| **`/zendesk-status`** | 요청자(Slack 이메일) 기준으로 본인 티켓 목록·상태 조회 + **각 티켓에 `💬 답장` 버튼** | ✅ 배포 |
| **답장(티켓 이어쓰기)** | `💬 답장` 버튼 → 모달(**사진 첨부 가능**) → 새 티켓 없이 **같은 티켓에 공개 코멘트 추가** | ✅ 배포 |
| **사진/파일 첨부** | 모달 `file_input`(png/jpg/gif/pdf) → Zendesk 티켓에 첨부 | ✅ 배포 |
| **양방향 동기화(담당자→고객)** | 담당자가 Zendesk에서 공개 답변하면 고객 Slack DM으로 자동 회신 (텍스트 + **첨부 사진**) | ⏸️ 코드 완료 / 설정 대기(Zendesk 권한 + `files:write` 재설치) |
| **`/ask`** | AWS 사용법·개념 질문에 Bedrock 기반 AI가 한국어로 답변 | ⏸️ 코드 완료 / SCP 대기 |

> ⚠️ **실동작 전제 — Zendesk 연동**: 위 `/zendesk`·`/zendesk-status`·답장·첨부는 **코드·배포 완료** 상태이며, 실제로 티켓이 생성/조회되려면 Lambda에 **`ZENDESK_SUBDOMAIN`·`ZENDESK_EMAIL`·`ZENDESK_API_TOKEN`** 3개가 설정돼야 한다. 미설정 시 **개발 모드**로 동작(모달은 열리지만 실제 Zendesk 반영 없음, `/zendesk-status`는 "개발 모드" 안내). 설정 방법은 [DEPLOYMENT.md](../Progress/DEPLOYMENT.md) Step 4.

### `/zendesk` 문의 폼 필드
양식 · 기술 분야(AWS/Datadog/NHN) · 요청자 이메일 · 회사명 · 참조(CC) · 제목 · AWS 계정 ID · AWS 서포트 플랜 · 긴급도 · 문의 내용 · 사진/파일 첨부
- **요청자(requester)**: 입력한 **이메일**로 Zendesk가 매칭 — 기존 사용자면 그 사용자에 연결(이름 자동), 없으면 이메일로 신규 생성. 형식 오류 시 모달에 인라인 에러 표시
- **참조(CC)**: 입력한 이메일들을 Zendesk `collaborators`(참조자)로 등록
- **제목(subject)**: 고객이 입력한 제목에 `[회사명]` 접두어 → `[회사명] 사용자입력제목` (트리아지용)
- **사진/파일 첨부**: `file_input`(최대 5개) → Slack에서 다운로드 → Zendesk `uploads.json` → 티켓 코멘트에 첨부 (`files:read` 스코프 필요)
- 폼 값은 티켓 **본문 + 태그**로 전달 (Zendesk 커스텀 필드 ID 확보 시 정식 매핑 예정)

### 티켓 이어쓰기 (답장) — 고객 → 담당자
- **진입점 3곳**: 접수 확인 DM · 담당자 답변 알림 · `/zendesk-status` 목록의 각 티켓(accessory 버튼) — 모두 같은 `reply_ticket` 액션 재사용
- **`💬 답장`** 버튼 → 모달 입력(**사진/파일 첨부 가능**) → `PUT /api/v2/tickets/{id}` 로 **같은 티켓에 공개 코멘트(+`uploads`) 추가**
- 버튼 `value`·모달 `private_metadata`에 `ticket_id`를 실어 식별 → 새 티켓 발급·매핑 조회 불필요
- 기존 인터랙티비티만 사용해 **새 커맨드·재설치 불필요**

### 양방향 동기화 (담당자 → 고객) — 코드 준비 / 파킹
1. `/zendesk` 티켓 생성 시 `티켓 ID ↔ Slack 사용자` 매핑을 DynamoDB에 저장 (기존 테이블 재사용)
2. Zendesk 트리거가 **담당자 공개 답변** 시 웹훅(`/zendesk/webhook`) 호출 (ticket_id 전달)
3. Lambda가 **Zendesk 코멘트 API로 최근 공개 코멘트(텍스트+첨부) 조회** → 봇 토큰으로 고객 DM에 텍스트 게시
4. 첨부(사진)는 Zendesk에서 다운로드 → **Slack `files.uploadV2`로 DM에 이미지 업로드**
- 웹훅은 커스텀 헤더 시크릿으로 검증, 담당자(agent/admin) 답변만 전달(echo 방지)
- **파킹**: 활성화하려면 ① Zendesk 웹훅·트리거 설정(**관리자 권한**) + ② `files:write` 스코프 추가 후 **재설치**
- 첨부 URL은 인증이 필요해 링크만으론 고객이 못 봄 → **Slack 재업로드**로 실제 이미지 표시
- 위 "티켓 이어쓰기"(고객→담당자)와 합쳐 **완전 양방향(텍스트+사진)** 완성

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
| `files:read` | 고객 첨부 다운로드(→ Zendesk 업로드) |
| `files:write` | 담당자 첨부를 고객 Slack DM에 업로드 (양방향 동기화용, 파킹) |

## 문서

- 배포 절차 (AWS 콘솔): [../Progress/DEPLOYMENT.md](../Progress/DEPLOYMENT.md)
- 기능별 설계·진행 현황: [../Progress/](../Progress/) (`00-overview.md` ~ `04-*.md`)
