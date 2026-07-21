# SharkBot (MVP - 기능 1: Zendesk 티켓 발행)

Slack `/zendesk` 명령 → 문의 폼(모달) → Zendesk 티켓 자동 생성.

개발은 **Socket Mode**로 진행(공개 URL 불필요). 다수 고객 배포 단계에서 HTTP+OAuth로 전환.

## 사전 준비
- Node.js 18+ (확인: `node --version`)
- 테스트용 Slack 워크스페이스(관리자 권한)
- Zendesk API 토큰 (실제 티켓 생성용)

## 1) Slack 앱 생성 (매니페스트)
1. https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. 테스트 워크스페이스 선택
3. `manifest.json` 내용을 붙여넣고 생성
4. **Basic Information → App-Level Tokens → Generate Token**
   - Scope: `connections:write` → 생성된 `xapp-...` 토큰 복사 → `SLACK_APP_TOKEN`
5. **Install App**(워크스페이스에 설치) → **Bot User OAuth Token `xoxb-...`** 복사 → `SLACK_BOT_TOKEN`

> 매니페스트에 `socket_mode_enabled: true`, `interactivity`, 슬래시 명령 `/zendesk`, 필요한 스코프가 이미 포함되어 있습니다.
> **주의**: `xoxb`와 `xapp` 토큰은 반드시 **같은 앱**에서 발급받아야 합니다. (섞이면 `invalid_auth`)

## 2) Zendesk API 토큰 (선택, 실제 티켓 생성 시)
1. Zendesk **Admin Center → Apps and integrations → APIs → Zendesk API**
2. **Token access** 활성화 → 토큰 생성 → `ZENDESK_API_TOKEN`
3. 토큰 발급 상담원 이메일 → `ZENDESK_EMAIL`
4. 서브도메인 → `ZENDESK_SUBDOMAIN` (예: `abc.zendesk.com` 이면 `abc`)

## 3) 환경 변수 설정
```bash
cp .env.example .env   # (.env.example이 없다면 아래 항목을 직접 .env에 작성)
```
`.env` 항목:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ZENDESK_SUBDOMAIN=your-subdomain
ZENDESK_EMAIL=agent@example.com
ZENDESK_API_TOKEN=your-zendesk-api-token
```

## 4) 설치 & 실행
```bash
npm install
npm start
```
성공 시:
```
⚡ Sharkton 봇이 실행되었습니다. (Socket Mode)
   Zendesk 연동: ON
```

## 5) 테스트
- Slack에서 **`/zendesk`** 입력 → 문의 폼(모달) 표시
- 작성 후 "문의 접수" → 봇이 접수 확인 메시지를 DM으로 회신
- 실제 티켓 생성 + 티켓 번호 회신

## 문의 폼 필드
양식 · 기술 분야(AWS/Datadog/NHN) · 성명 · 회사명 · AWS 계정 ID · AWS 서포트 플랜 · 긴급도 · 문의 내용

- **요청자(requester)**: 성명 + Slack 이메일로 Zendesk 티켓에 매핑
- 현재는 폼 값을 티켓 **본문 + 태그**로 전달. (Zendesk 커스텀 필드 ID 확보 시 정식 매핑 예정)

## 필요 권한(OAuth 스코프)
| 스코프 | 용도 |
|---|---|
| `commands` | 슬래시 명령 |
| `chat:write` / `chat:write.public` | 메시지 회신 |
| `users:read` / `users:read.email` | 요청자(고객) 매핑 |
| `im:write` | DM 회신 |

## Slack 플랜
- 커스텀 앱이라 **무료 플랜에서도 동작** (Workflow Builder 미사용).
- 무료 플랜은 앱 설치 총 10개 제한.

## 다음 단계 (프로덕션 전환)
- Socket Mode → **HTTP 엔드포인트(API Gateway + Lambda)** 전환
- **OAuth 배포**(Public Distribution) → 고객 워크스페이스 설치용 URL / Slack Marketplace
- 자격증명 `.env` → **AWS Secrets Manager**
- 고객사 ↔ 워크스페이스 매핑(멀티테넌시)
- Zendesk 커스텀 필드 정식 매핑
