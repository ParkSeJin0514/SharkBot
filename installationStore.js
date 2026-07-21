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

function dynamoStore() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    // Slack 설치 객체에 undefined 필드가 있어 저장 실패하는 것 방지
    marshallOptions: { removeUndefinedValues: true },
  });
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
