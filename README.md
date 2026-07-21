# SharkBot (기능 1: Zendesk 티켓 발행)

Slack `/zendesk` 명령 → 문의 폼(모달) → Zendesk 티켓 자동 생성.
여러 고객사 Slack에 배포하는 **HTTP + OAuth 멀티테넌트** 봇.

## 아키텍처
```
[고객사 Slack] ─ HTTPS ─► API Gateway ─► Lambda (Bolt, HTTP 모드)
                                            ├─ DynamoDB (고객사별 설치 토큰)
                                            └─ Zendesk API (티켓 생성)
```
- 고객이 `/slack/install`로 설치(OAuth) → 워크스페이스별 봇 토큰이 **DynamoDB**에 저장
- 요청이 오면 team_id로 해당 토큰을 조회해 응답 (멀티테넌트)

## 구성 파일
| 파일 | 역할 |
|---|---|
| `app.js` | Bolt 앱 (ExpressReceiver + OAuth), Lambda `handler` export |
| `installationStore.js` | 고객별 설치 토큰 저장소 (DynamoDB / 로컬은 메모리 폴백) |
| `manifest.json` | Slack 앱 설정 참고용 |

## 환경 변수 (`.env`)
```
SLACK_SIGNING_SECRET=      # Slack 앱 Basic Information → App Credentials
SLACK_CLIENT_ID=           # 동일
SLACK_CLIENT_SECRET=       # 동일
SLACK_STATE_SECRET=        # OAuth 보안용 임의의 랜덤 문자열 (직접 생성)
ZENDESK_SUBDOMAIN=         # abc.zendesk.com 이면 abc
ZENDESK_EMAIL=             # API 토큰 발급 상담원 이메일
ZENDESK_API_TOKEN=         # Zendesk Admin → Apps and integrations → APIs → Zendesk API
# INSTALL_TABLE=sharkbot-installations   # 있으면 DynamoDB, 없으면 메모리(로컬)
```
> `.env`는 로컬 개발용. 프로덕션(Lambda)에서는 콘솔 환경변수로 주입한다.

## 필요 권한 (OAuth 스코프)
| 스코프 | 용도 |
|---|---|
| `commands` | 슬래시 명령 `/zendesk` |
| `chat:write` / `chat:write.public` | 메시지 회신 |
| `users:read` / `users:read.email` | 요청자(고객) 이메일 매핑 |
| `im:write` | DM 회신 |

## 로컬 개발
HTTP 모드라 Slack이 접근하려면 공개 URL(ngrok 등)이 필요하다.
```bash
npm install
npm start          # 로컬 HTTP 서버 :3000 (설치 저장소=메모리)
```
- `npm start` → `http://localhost:3000/slack/install` 로 설치 (ngrok로 공개 후 Slack Request URL 등록 필요)
- `INSTALL_TABLE` 미설정 시 메모리 저장소(재시작 시 초기화)

## 프로덕션 배포 (AWS 콘솔)
Lambda + API Gateway + DynamoDB 구성. 상세 절차는 **[../Progress/DEPLOYMENT.md](../Progress/DEPLOYMENT.md)** 참고.

배포용 zip 생성:
```bash
rm -f sharkbot.zip
zip -r sharkbot.zip app.js installationStore.js package.json package-lock.json node_modules -x '*.DS_Store'
```
→ Lambda 콘솔 **Code → Upload from → .zip file** 로 업로드. (Handler: `app.handler`)

## 설치 & 테스트
1. `<InvokeURL>/slack/install` 접속 → 워크스페이스 설치 승인
   → DynamoDB `sharkbot-installations`에 토큰 저장
2. Slack에서 **`/zendesk`** → 폼 작성 → 제출 → Zendesk 티켓 생성 확인

## 문의 폼 필드
양식 · 기술 분야(AWS/Datadog/NHN) · 성명 · 회사명 · AWS 계정 ID · AWS 서포트 플랜 · 긴급도 · 문의 내용
- **요청자(requester)**: 성명 + Slack 이메일로 Zendesk 티켓에 매핑
- 현재 폼 값은 티켓 **본문 + 태그**로 전달 (Zendesk 커스텀 필드 ID 확보 시 정식 매핑 예정)

## 남은 하드닝 / TODO
- **3초 응답 제약**: Zendesk 호출이 느리면 제출 즉시 `ack` 후 티켓 생성을 비동기(별도 Lambda/SQS)로 분리
- 자격증명 콘솔 환경변수 → **Secrets Manager**
- Zendesk 커스텀 필드(양식·계정ID 등) 정식 매핑
