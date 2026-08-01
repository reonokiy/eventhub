# EventHub

一个尽量精简的、多租户事件流服务：所有事件以 CloudEvents 1.0 写入 PostgreSQL，应用通过 REST 回放历史，通过 SSE 实时订阅。`LISTEN/NOTIFY` 只负责低延迟唤醒；数据库始终是唯一事实来源。

## 快速启动

需要 Docker Compose。默认 API 只绑定 `127.0.0.1:3000`，PostgreSQL 只绑定 `127.0.0.1:5433`，以避免意外暴露开发凭据并避开常见的本机 `5432`。

```bash
cp .env.example .env
docker compose up --build
```

启动后检查：

```bash
curl http://localhost:3000/health/ready
```

Compose 的 `NODE_ENV` 默认值是 `development`，以下固定凭证仅用于本地开发：

- API Key：`dev-api-key-change-me`
- Admin API Key：`dev-admin-api-key-change-me`
- HMAC connection ID：`00000000-0000-4000-8000-000000000002`
- HMAC secret：`dev-webhook-secret-change-me`

不得将 `.env.example` 或它复制出的开发 `.env` 作为生产部署配置。生产部署必须显式设置 `NODE_ENV=production`，并通过 Secret Manager 或部署环境传入三个不同、非开发值的 `BOOTSTRAP_API_KEY`、`ADMIN_API_KEY` 与 `BOOTSTRAP_WEBHOOK_SECRET`；任一值缺失或仍为内置开发值时，服务会在启动前失败。生产的 `BOOTSTRAP_API_KEY` 与 `ADMIN_API_KEY` 各自至少需要 32 个无空格可打印 ASCII 字符。`ADMIN_API_KEY` 必须是高熵、独立的服务端管理密钥，绝不能复用 bootstrap 或应用 Key，且不得以应用 Key 命名空间 `ehk_` 开头。如果还要在 Compose 外直接运行服务，请同步修改本机用的 `DATABASE_URL`。同时更换 `POSTGRES_USER` 和 `POSTGRES_PASSWORD`，并让 `COMPOSE_DATABASE_URL` 使用相同凭据；URL 中的保留字符只在 URL 变量里编码，`POSTGRES_PASSWORD` 保留原文。MVP 会将 Webhook secret 明文保存到数据库；生产环境应接入 Secret Manager 或应用层加密。

## 管理租户和应用 API Key

`/v1/admin` 是租户和应用凭据的管理入口。它只能使用服务端配置的独立管理密钥，不能使用任何应用 API Key：

```bash
export EVENTHUB_ADMIN_API_KEY='<ADMIN_API_KEY>'

# 创建租户；记录响应中的 id。
curl -sS -X POST http://localhost:3000/v1/admin/tenants \
  -H "Authorization: Bearer $EVENTHUB_ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"slug":"acme","name":"Acme"}'
```

为每个接入应用单独发放最小权限 Key。以下示例只允许消费事件：

```bash
export TENANT_ID='<上一步返回的租户 UUID>'

curl -sS -X POST "http://localhost:3000/v1/admin/tenants/$TENANT_ID/api-clients" \
  -H "Authorization: Bearer $EVENTHUB_ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"name":"billing-consumer","scopes":["events:read"]}'
```

管理 API 提供以下生命周期操作：

| 操作 | 接口 |
| --- | --- |
| 创建、列出租户 | `POST`、`GET /v1/admin/tenants` |
| 发放、列出应用 Key | `POST`、`GET /v1/admin/tenants/:tenantId/api-clients` |
| 撤销应用 Key | `POST /v1/admin/tenants/:tenantId/api-clients/:clientId/revoke` |
| 轮换应用 Key | `POST /v1/admin/tenants/:tenantId/api-clients/:clientId/rotate` |

应用 Key 只可拥有非空的 `events:read`、`events:write` scope 集合。生产者应只获授 `events:write`，消费者应只获授 `events:read`；仅当同一可信进程确实兼具两种职责时才同时授予两者。

发放和轮换响应中的 `api_key` 是唯一一次可取得明文 Key 的机会：立即保存到 Secret Manager 或部署密钥中。之后列表和撤销响应只包含安全元数据；数据库也只保存不可逆 hash 和安全识别用 prefix，无法重新读取原始 Key。普通应用 Key 无法调用管理接口，`ADMIN_API_KEY` 也不应用于发布或消费事件。

管理接口应只通过受控的运维网络、部署作业或 CI/CD 调用：在反向代理或入口层限制来源，避免向浏览器、客户端应用或日志暴露 `ADMIN_API_KEY`。轮换和撤销请求都要携带 `Content-Type: application/json` 与 body `{}`。本版本不提供租户删除；撤销或轮换 Key 不能删除事件数据。轮换永远不会恢复旧的明文 Key；它只会签发一个新的 Key，并可由管理员重新启用该应用 client。管理写操作目前没有幂等键；若创建、发放或轮换的成功响应丢失，先列表确认状态，尤其不要盲目重试轮换。

## 发布和读取事件

发布一个统一事件：

```bash
curl -i http://localhost:3000/v1/events \
  -H 'Authorization: Bearer dev-api-key-change-me' \
  -H 'Content-Type: application/cloudevents+json' \
  -H 'Idempotency-Key: order-42-created' \
  --data '{
    "specversion":"1.0",
    "id":"order-42-created",
    "source":"urn:example:orders",
    "type":"com.example.order.created.v1",
    "datacontenttype":"application/json",
    "eventhubstream":"orders",
    "data":{"order_id":"42"}
  }'
```

查询历史；`after` 是 exclusive cursor：

```bash
curl 'http://localhost:3000/v1/events?after=0&stream=orders' \
  -H 'Authorization: Bearer dev-api-key-change-me'
```

实时订阅并支持断线续传：

```bash
curl -N 'http://localhost:3000/v1/events/stream?after=0&stream=orders' \
  -H 'Authorization: Bearer dev-api-key-change-me' \
  -H 'Accept: text/event-stream'
```

客户端只应在业务处理成功后持久化最新 `eventhuboffset`，重连时放入 `Last-Event-ID` 或 `after`。投递语义是 at-least-once，消费者必须幂等。

## TypeScript SDK

应用可以从 `eventhub/sdk` 使用 `EventHubClient`。SDK 封装 `publish()`、`list()`、`subscribe()` 和 `consume()`；仍使用本规范定义的 CloudEvents、HTTP 错误和 SSE 行为。构造客户端时提供服务地址与该应用专属 Key，具体 TypeScript 参数和返回类型以包内声明为准。

```ts
import { EventHubClient } from "eventhub/sdk";
import { FileCursorStore } from "eventhub/sdk/node";

const publisher = new EventHubClient({
  baseUrl: process.env.EVENTHUB_URL!,
  apiKey: process.env.EVENTHUB_WRITE_KEY!,
});
const consumer = new EventHubClient({
  baseUrl: process.env.EVENTHUB_URL!,
  apiKey: process.env.EVENTHUB_READ_KEY!,
});

await publisher.publish(
  {
    specversion: "1.0",
    id: "order-42-created",
    source: "urn:example:orders",
    type: "com.example.order.created.v1",
    datacontenttype: "application/json",
    eventhubstream: "orders",
    data: { order_id: "42" },
  },
  { idempotencyKey: "order-42-created" },
);
const page = await consumer.list({ after: "0", stream: "orders", limit: 100 });

for await (const event of consumer.subscribe({ after: page.page.next_after, stream: "orders" })) {
  await handleEvent(event);
}

// 也可以使用 consume() 和 cursor store：仅当业务回调成功后才推进 cursor。
const cursors = new FileCursorStore("./var/eventhub.cursor");
await consumer.consume({
  cursorStore: cursors,
  stream: "orders",
  onEvent: handleEvent,
});
```

SDK 提供内存 cursor store 供测试，文件 cursor store 适合单个 Node.js 进程；生产消费者通常应把 cursor 与业务写入放在自己的数据库事务中。网络断线会从最后成功持久化的位置恢复，因此仍可能重复投递。若收到 `410 cursor_expired`，SDK 不会静默跳过数据；应用必须按 [投递规范](./spec/delivery-semantics.md#10-保留期和永久离线消费者) 选择恢复策略。

## 通用 HMAC Webhook

入口为 `POST /v1/webhooks/hmac/{connection_id}`。必需 header：

- `X-EventHub-Timestamp`：Unix 秒时间戳
- `X-EventHub-Signature`：`v1=<hex>`

JSON body 必须包含 `id`、`type`、`data`，可包含 `subject` 和 `time`。签名内容为 `timestamp + "." + connection_id + "." + raw_body`，算法为 HMAC-SHA256；把事件身份和类型放进已签名 body 可防止元数据被篡改。服务会先对原始 body 验签，再解析 JSON，并将事件写入与发布 API 相同的日志。

## 本地开发与验证

运行时基线是 Node.js 24 LTS、TypeScript、Fastify 5、Drizzle ORM（`node-postgres` 驱动）和 PostgreSQL 18。常规数据库读写使用 Drizzle；`LISTEN` 使用专用 `pg.PoolClient` 长连接，`NOTIFY` 仍由事件写入事务发出。

```bash
npm ci
npm run typecheck
npm run typecheck:test
npm test
npm run test:coverage
npm run build
```

`npm run test:coverage` 对 `.c8rc.json` 中定义的每个可执行 TypeScript 模块分别执行 statements、branches、functions 和 lines 四项 100% 门禁。进程入口、纯类型文件、Drizzle 声明式 schema 和 barrel export 不计入可执行覆盖率；具体边界以版本库中的 `.c8rc.json` 为准。

类型化表结构位于 `src/db/schema.ts`，但 `migrations/` 中的手写迁移仍是数据库结构、约束和 `eventhub_append_event()` 函数的权威来源；本项目不使用 `drizzle-kit push` 修改数据库。

数据库集成测试只读取专用变量，绝不会回退到普通 `DATABASE_URL`：

```bash
EVENTHUB_TEST_DATABASE_URL=postgres://eventhub:eventhub@localhost:5433/eventhub \
  npm run test:integration
```

## CI 与发布

所有 pull request 和分支 push 都会在 Node.js 24 与 PostgreSQL 18 上执行应用及测试类型检查、100% 覆盖率测试、TypeScript 构建和容器构建。

发布采用严格的 `vX.Y.Z` 标签，并要求标签版本与 `package.json`、`package-lock.json` 一致。例如发布当前 `0.1.0`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

标签流水线通过全部质量门禁后，将 `linux/amd64` 和 `linux/arm64` 镜像发布到 `ghcr.io/<owner>/<repository>`，附带 SBOM 与 provenance，并创建对应的 GitHub Release。本项目是私有应用包，不发布到 npm registry。

## 固定规范

实现契约位于 [`spec/README.md`](./spec/README.md)：

- [`spec/architecture.md`](./spec/architecture.md)：架构、事务、表模型、质量门禁和发布契约
- [`spec/event-format.md`](./spec/event-format.md)：CloudEvents 格式
- [`spec/api.md`](./spec/api.md)：REST、管理、Webhook 和 SSE API
- [`spec/delivery-semantics.md`](./spec/delivery-semantics.md)：顺序、重复、恢复和保留期
- [`spec/sdk.md`](./spec/sdk.md)：应用凭据使用与 TypeScript SDK

当前 MVP 有意不引入 Kafka、消费者组、服务端 ACK 或 exactly-once。后续数据量和吞吐达到瓶颈后，再考虑分区表或独立消息基础设施。
