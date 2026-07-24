// 고객사별 Slack 설치 토큰 저장소 (멀티테넌트)
// - INSTALL_TABLE 환경변수가 있으면 DynamoDB 사용 (프로덕션)
// - 없으면 메모리 저장소로 폴백 (로컬 개발용, 재시작 시 초기화)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.INSTALL_TABLE;

// 설치/조회 키: enterprise 설치면 enterpriseId, 아니면 teamId
const idFromInstallation = (i) =>
  i.isEnterpriseInstall && i.enterprise ? i.enterprise.id : i.team.id;
const idFromQuery = (q) =>
  q.isEnterpriseInstall && q.enterpriseId ? q.enterpriseId : q.teamId;

// 티켓 매핑 키 (같은 테이블 재사용: id = "ticket:<ticketId>")
const ticketKey = (ticketId) => `ticket:${ticketId}`;

// 회사 태그 ↔ 워크스페이스 매핑 키 (같은 테이블 재사용: id = "company:<tag>")
const companyKey = (companyTag) => `company:${companyTag}`;

// 고객 이메일 ↔ Slack 사용자 매핑 키 (같은 테이블 재사용: id = "user:<email 소문자>")
const userEmailKey = (email) => `user:${String(email).trim().toLowerCase()}`;

// 공유 DynamoDB 문서 클라이언트 (TABLE 있을 때만 생성)
const ddb = TABLE
  ? DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      // Slack 설치 객체에 undefined 필드가 있어 저장 실패하는 것 방지
      marshallOptions: { removeUndefinedValues: true },
    })
  : null;

function dynamoStore() {
  return {
    storeInstallation: async (installation) => {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: { id: idFromInstallation(installation), installation },
        })
      );
    },
    fetchInstallation: async (query) => {
      const res = await ddb.send(
        new GetCommand({ TableName: TABLE, Key: { id: idFromQuery(query) } })
      );
      if (!res.Item) throw new Error('설치 정보를 찾을 수 없습니다');
      return res.Item.installation;
    },
    deleteInstallation: async (query) => {
      await ddb.send(
        new DeleteCommand({ TableName: TABLE, Key: { id: idFromQuery(query) } })
      );
    },
  };
}

function memoryStore() {
  const store = new Map();
  return {
    storeInstallation: async (installation) => {
      store.set(idFromInstallation(installation), installation);
    },
    fetchInstallation: async (query) => {
      const found = store.get(idFromQuery(query));
      if (!found) throw new Error('설치 정보를 찾을 수 없습니다 (memory)');
      return found;
    },
    deleteInstallation: async (query) => {
      store.delete(idFromQuery(query));
    },
  };
}

export const installationStore = TABLE ? dynamoStore() : memoryStore();
export const storeMode = TABLE ? 'dynamodb' : 'memory';

// ── 티켓 ↔ Slack 사용자 매핑 (양방향 동기화용) ──────────────
// 티켓 생성 시 저장 → Zendesk 웹훅 수신 시 조회해 해당 고객 Slack으로 회신
const ticketMemory = new Map();

// data: { teamId, enterpriseId?, isEnterpriseInstall?, userId }
export async function storeTicketMapping(ticketId, data) {
  if (ddb) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { id: ticketKey(ticketId), kind: 'ticket_map', ...data },
      })
    );
  } else {
    ticketMemory.set(String(ticketId), data);
  }
}

export async function fetchTicketMapping(ticketId) {
  if (ddb) {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: ticketKey(ticketId) } })
    );
    return res.Item || null;
  }
  return ticketMemory.get(String(ticketId)) || null;
}

// ── 회사(커스텀 필드 태그) ↔ 워크스페이스 매핑 (상담사-먼저 티켓 라우팅용) ──
// 고객이 /zendesk로 처음 티켓을 만들 때 자동 저장 → 이후 상담사가 직접 만든 티켓을
// 회사 커스텀 필드로 어느 워크스페이스에 보낼지 역조회한다. (고객사 많아도 무설정)
const companyMemory = new Map();

// data: { teamId, enterpriseId?, isEnterpriseInstall? }
export async function storeCompanyTeam(companyTag, data) {
  if (!companyTag) return;
  if (ddb) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { id: companyKey(companyTag), kind: 'company_team', ...data },
      })
    );
  } else {
    companyMemory.set(String(companyTag), data);
  }
}

export async function fetchCompanyTeam(companyTag) {
  if (!companyTag) return null;
  if (ddb) {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: companyKey(companyTag) } })
    );
    return res.Item || null;
  }
  return companyMemory.get(String(companyTag)) || null;
}

// ── 고객 이메일 ↔ Slack 사용자 매핑 (상담사-먼저 티켓 라우팅 1순위) ──
// 이메일 별칭(+alias) 때문에 users.lookupByEmail이 실패할 수 있으므로,
// 고객이 /zendesk로 티켓 만들 때 이메일→{teamId,userId}를 직접 기록해 정확히 라우팅한다.
const userEmailMemory = new Map();

// data: { teamId, enterpriseId?, isEnterpriseInstall?, userId }
export async function storeUserByEmail(email, data) {
  if (!email) return;
  if (ddb) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { id: userEmailKey(email), kind: 'user_email', ...data },
      })
    );
  } else {
    userEmailMemory.set(String(email).trim().toLowerCase(), data);
  }
}

export async function fetchUserByEmail(email) {
  if (!email) return null;
  if (ddb) {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { id: userEmailKey(email) } })
    );
    return res.Item || null;
  }
  return userEmailMemory.get(String(email).trim().toLowerCase()) || null;
}
