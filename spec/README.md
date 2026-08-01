# EventHub MVP 规范

状态：已批准，作为第一版实现契约  
规范版本：`0.1.0`  
默认事件保留期：30 天

## 1. 目标

EventHub 将不同平台产生的事件转换成统一的 CloudEvents 事件，通过一个多租户 API 提供历史回放和实时订阅。

第一版采用以下固定方案：

- 应用运行时采用 TypeScript、Fastify 和 Drizzle ORM（`node-postgres` 驱动）。常规持久化查询通过 Drizzle 执行；会话级 `LISTEN` 由专用 `pg.PoolClient` 管理。
- PostgreSQL `events` 表是事件的唯一事实来源（source of truth）。
- 事件外层使用 CloudEvents 1.0 structured JSON envelope。
- 每个租户使用单调递增的 `offset` 作为回放和订阅游标。
- PostgreSQL 内部 offset 使用 `bigint`；HTTP JSON 和 CloudEvents 中一律编码为十进制字符串，避免 JavaScript 数值精度丢失。
- 历史读取使用 REST，实时单向订阅使用 SSE。
- PostgreSQL `LISTEN/NOTIFY` 只用于唤醒 API 实例；通知丢失不能导致事件丢失。
- 投递语义为 at-least-once，消费者必须幂等。
- 平台 Webhook 在验签、去重和标准化后写入同一事件日志。

## 2. 规范用语

本文档中的“必须”“不得”表示实现契约；“应该”表示除非有明确理由，否则需要遵守；“可以”表示可选行为。

发生冲突时，规范优先级如下：

1. [api.md](./api.md) 中的线协议和状态码。
2. [event-format.md](./event-format.md) 中的事件格式和验证规则。
3. [delivery-semantics.md](./delivery-semantics.md) 中的游标、顺序、重复和恢复语义。
4. [architecture.md](./architecture.md) 中的组件和存储实现约束。

## 3. 文档索引

- [architecture.md](./architecture.md)：系统边界、组件、数据模型、写入事务、质量门禁和发布契约。
- [event-format.md](./event-format.md)：CloudEvents envelope、字段约束和平台映射。
- [api.md](./api.md)：应用与管理鉴权、租户/API Key 生命周期、发布、Webhook、历史查询、SSE 和错误格式。
- [delivery-semantics.md](./delivery-semantics.md)：顺序、at-least-once、重连、慢消费者和保留期。
- [sdk.md](./sdk.md)：TypeScript SDK、应用专属凭据和本地 cursor 持久化契约。

## 4. MVP 范围

第一版必须包含：

- API Key 鉴权和租户隔离。
- 通过受独立 `ADMIN_API_KEY` 保护的管理 API 创建/列出租户，并为每个应用发放、列出、撤销和轮换独立 API Key；应用 Key 按 `events:read`、`events:write` 最小授权。
- 单事件发布接口 `POST /v1/events`。
- 通用 HMAC Webhook 接口，以及可插拔的平台 Adapter。
- 持久化事件去重。
- 按租户分配稳定 `offset`。
- 带游标的历史事件查询。
- 带断线续传的 SSE 实时订阅。
- TypeScript SDK 的发布、历史读取、订阅、消费回调和 cursor store。
- `LISTEN/NOTIFY` 唤醒和数据库轮询兜底。
- 30 天默认保留策略，以及过期游标的 `410 Gone`。
- 基础健康检查和带 request ID 的结构化日志。

本地 Compose 的默认 `NODE_ENV` 是 `development`，其固定示例凭据绝不是生产配置。生产部署必须显式设置 `NODE_ENV=production`，从 Secret Manager 或部署环境提供非开发的 `BOOTSTRAP_API_KEY`、`ADMIN_API_KEY` 和 `BOOTSTRAP_WEBHOOK_SECRET`；服务必须拒绝缺失后回退到内置开发值的配置。生产 bootstrap/admin API Key 各至少为 32 个无空格可打印 ASCII 字符，且 admin Key 不得以应用 Key 前缀 `ehk_` 开头。

首个真实平台 Adapter 不影响核心协议；未识别的平台字段应保留在 `data` 中。

## 5. 非目标

第一版明确不实现：

- Kafka、NATS、Redis Streams 或其他独立消息基础设施。
- exactly-once 投递。
- 服务端消费者组、竞争消费、ACK 或 retry queue。
- WebSocket 双向协议。
- 跨租户的全局顺序。
- 按事件发生时间排序；规范顺序仅指入库 `offset`。
- 任意 JSONPath/SQL 过滤、事件转换 DSL 或 schema registry。
- 大型二进制事件；MVP 只接收 JSON 数据。
- PostgreSQL 表分区；达到数据量或清理压力阈值后再引入。
- 无限期保存事件或为离线消费者无限缓存。
- 通过管理 API 删除租户或删除事件；轮换只能签发新 Key，不能恢复旧的明文 Key。
- 租户级限流、SSE 连接配额和 Prometheus 指标端点；这些属于生产化阶段。

## 6. 固定默认值

| 项目 | 默认值 |
| --- | --- |
| API 前缀 | `/v1` |
| 事件保留期 | 默认且最少 30 天，按 `received_at` 计算 |
| 历史查询页大小 | 100，最大 1000 |
| SSE heartbeat | 15 秒 |
| SSE 客户端重试建议 | 3 秒 |
| 数据库兜底轮询 | 5 秒 |
| 数据库连接超时 | 5 秒 |
| 数据库查询超时 | 30 秒 |
| 数据库连接池 | 默认 10，最少 2；每实例独占 1 个连接用于 `LISTEN` |
| 通用 HMAC 时钟偏差 | 最多 5 分钟 |
| 最大事件 HTTP body | 1 MiB（1,048,576 bytes） |
| 慢消费者待发送缓存 | 每连接最多 1 MiB |

默认值可以通过部署配置调整，但改变协议可见行为时必须同步升级本规范。

## 7. 兼容性原则

- `/v1` 内允许增加可选字段，不得删除字段、改变已有字段含义或收紧已接受值。
- 破坏性 HTTP 协议变更必须使用新的主版本路径。
- 业务事件的破坏性变更必须发布新的 `type` 版本，例如从 `.v1` 升到 `.v2`。
- 消费者必须忽略不认识的 CloudEvents extension attribute 和响应 JSON 字段。

## 8. MVP 验收条件

实现只有在以下场景通过自动化测试后才算符合规范：

1. 并发写入同一租户时，已提交事件的 offset 严格递增且不重复。
2. 写入事务回滚后，不会留下可见事件或提前发出的通知。
3. 重复发布相同事件不会产生第二条事件。
4. API 实例重启、LISTEN 连接中断或漏收通知后，SSE 可以从 PostgreSQL 补齐事件。
5. SSE 客户端用最后 offset 重连时不漏事件，允许重复事件。
6. 过期游标返回包含可用边界的 `410 Gone`。
7. 不同租户无法读取、推送或推断对方的事件。
8. Webhook 签名错误、时间戳过期和重复 delivery 均按本规范处理。
9. 独立应用 Key 不能越过其 `events:read`/`events:write` 授权，且原始 Key 不会在创建后再次从数据库或 API 读出。
10. SDK 在业务回调失败时不推进 cursor；成功后从已保存的 cursor 重连不会漏掉事件，允许重复。
11. 管理 API 只能由独立 `ADMIN_API_KEY` 调用，且 `ADMIN_API_KEY` 不能调用事件接口；普通应用 Key 不能访问管理 API。创建和轮换只回显一次原始 Key，列表和撤销永不回显原始 Key 或 hash；轮换/撤销后旧 Key 不再可用，已建立 SSE 在下一次凭据复核后不得再发送业务事件。
