# 架构与存储规范

## 1. 总体架构

```text
平台 Webhook / 轮询 Connector / 可信应用
                    |
                    v
            Adapter / 发布 API
      （验签、去重、标准化、鉴权）
                    |
                    v
        PostgreSQL 不可变事件日志
                    |
          +---------+---------+
          |                   |
      历史 REST          NOTIFY 唤醒
                              |
                              v
                         SSE 订阅服务
                              |
                         下游应用程序
```

所有入口最终必须调用同一持久化写入路径。平台 Adapter 不得绕过统一验证、事件身份去重或 tenant offset 分配。

## 2. 组件职责

### 2.1 Ingestion API

- 验证 API Key、scope 和租户。
- 校验 CloudEvents envelope。
- 实现 `Idempotency-Key` 和事件身份去重。
- 在单个数据库事务中分配 offset、写入事件并调用 `pg_notify`。
- 只在数据库提交成功后返回成功。

### 2.2 Webhook Adapter

- 使用原始 HTTP body 验证平台签名。
- 提取平台稳定事件 ID、事件类型和发生时间。
- 将平台事件映射成 [event-format.md](./event-format.md) 定义的 envelope。
- 保留无法通用化的平台字段，不得静默丢弃业务数据。
- 将事件写入连接配置指定的租户和 stream。
- 无稳定事件 ID 时，使用规范化输入生成确定性 ID；不得每次重试生成随机 ID。

### 2.3 Event Store

- PostgreSQL `events` 是完整事件 payload、顺序和恢复状态的唯一事实来源。
- 已写入的事件不可更新；修正必须发布新事件。
- 删除只允许由保留策略执行，或由明确的合规删除流程执行。

### 2.4 Subscription Service

- 从 `events` 按 offset 查询并输出 SSE。
- 每个 API 实例必须从共享 `pg.Pool` 独占一个 `PoolClient` 执行 `LISTEN eventhub_events`；订阅存续期间不得释放该连接或将其用于普通 ORM 查询。
- 一个实例内应由单个 listener 将唤醒信号 fan-out 给本实例上的订阅。
- 通知到达、周期轮询和新连接 catch-up 都必须走同一数据库回查逻辑。
- SSE 必须保留建立连接时应用 Key 的 hash（不得保留明文），并在每个循环、每批读取和每个业务事件写出前重新查询该 hash 是否仍为 active 且具备 `events:read`。轮换或撤销后，已建立连接不得继续发送业务事件；空闲连接的跨实例失效延迟由 `SSE_POLL_INTERVAL_MS` 上界约束，数据库不可用时应关闭而不是继续投递。

### 2.5 Admin Management API

- 仅接受服务端配置的 `ADMIN_API_KEY`，并与 tenant application Key 的认证路径完全隔离。
- 创建和列出租户；为每个租户发放、列出、撤销和轮换 application Key。
- 发放和轮换只在成功响应中返回一次原始 Key；其余路径只处理安全元数据。
- 不得借管理 API 删除租户或删除事件。轮换可以为同一 client 签发新的 Key 并重新启用其凭据，但绝不能恢复旧的明文 Key。
- 应部署在受控运维网络之后；应用服务、浏览器和普通 SDK 客户端不得获得 `ADMIN_API_KEY`。
- 生产进程必须显式配置非开发的 `BOOTSTRAP_API_KEY`、`ADMIN_API_KEY` 和 `BOOTSTRAP_WEBHOOK_SECRET`；内置开发值或缺失后回退到这些值都必须使启动失败。生产 bootstrap/admin API Key 各至少为 32 个无空格可打印 ASCII 字符，且 `ADMIN_API_KEY` 不得使用 application Key 的 `ehk_` 前缀。

### 2.6 数据库访问层

- 常规 CRUD、查询构造和行映射必须通过 Drizzle ORM 完成，并集中在数据库或存储层；HTTP route 和 service 不得直接执行 SQL。
- Drizzle 使用 `node-postgres` 驱动并复用应用的 `pg.Pool`。所有 `bigint` 列必须映射为 JavaScript `bigint`，不得映射为会丢失精度的 `number`。
- 手写 SQL migrations 是数据库结构和 PostgreSQL 函数的权威来源；Drizzle schema 必须与迁移保持一致，但不得使用 `drizzle-kit push` 绕过迁移历史。
- 迁移、`eventhub_append_event()` 这类数据库函数、PostgreSQL 专用维护查询，以及 Drizzle 没有一等接口的会话级 `LISTEN`，可以使用受控且参数化的 SQL 或底层 `pg`。这些例外必须局限在数据库基础设施层。

## 3. 逻辑数据模型

### 3.1 `tenants`

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `id` | UUID PK | 租户标识 |
| `slug` | text not null, unique | 稳定、可读的管理标识；创建后不作为事件授权上下文。 |
| `name` | text not null | 展示名称 |
| `retention_days` | int not null default 30, `>= 30` | 保留天数 |
| `created_at` | timestamptz not null | 创建时间 |
| `updated_at` | timestamptz not null | 最近一次管理更新的时间 |

### 3.2 `tenant_heads`

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `tenant_id` | UUID PK, FK | 租户 |
| `last_offset` | bigint not null default 0 | 最后分配的 offset |

该表每个租户一行。行锁是同一租户写入顺序的串行化点；不同租户可并行写入。

### 3.3 `events`

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `tenant_id` | UUID not null | 由鉴权或连接配置确定 |
| `offset` | bigint not null | 租户内顺序 |
| `stream` | text not null | 逻辑流 |
| `specversion` | text not null, 固定 `1.0` | CloudEvents 版本 |
| `id` | text not null | source 内稳定身份 |
| `source` | text not null | CloudEvents source |
| `type` | text not null | 版本化事件类型 |
| `subject` | text null | 事件主题 |
| `occurred_at` | timestamptz null | 平台报告的发生时间 |
| `received_at` | timestamptz not null | EventHub 接收时间 |
| `datacontenttype` | text not null | MVP 固定为 JSON 媒体类型 |
| `dataschema` | text null | 可选 schema URI |
| `data` | jsonb not null | 事件数据；JSON `null` 以 jsonb 值保存，不是 SQL NULL |
| `attributes` | jsonb not null default `{}` | 其他 CloudEvents extension attributes |

必须至少建立以下约束和索引：

```sql
PRIMARY KEY (tenant_id, offset)
UNIQUE (tenant_id, source, id)
INDEX (tenant_id, stream, offset)
INDEX (tenant_id, type, offset)
INDEX (tenant_id, received_at)
```

所有对 `events` 的读取查询，无论由 Drizzle query builder 还是受控 SQL 片段构造，都必须显式包含 `tenant_id` 条件。类型化 schema、repository 封装或 PostgreSQL Row-Level Security 均不能替代应用层租户条件；RLS 只能作为纵深防御。

### 3.4 `api_clients`

每一行代表一个租户内的一个接入应用。必须保存稳定 client ID、`tenant_id`、应用名称、不可逆的 API Key hash、可安全展示的 key prefix、scopes、创建时间、最后使用时间和撤销时间；同一租户内的应用名称必须唯一。数据库不得保存可恢复的明文 API Key。

scopes 必须是非空集合，且仅可包含 `events:read`、`events:write`。除部署时由受控配置初始化的 bootstrap client 外，应用专属 Key 只能由受 `ADMIN_API_KEY` 保护的管理 API 发放或轮换；原始 Key 只能在发放或轮换的成功响应中返回一次，随后只允许通过再次轮换获得新值。数据库不得保存可恢复的明文，列表、撤销和错误响应也不得回显原始 Key 或其 hash。

认证查询必须同时排除已撤销和已过期的 client，并把记录中的 `tenant_id` 和 scopes 作为唯一授权上下文。key prefix 仅用于审计和人工定位，绝不能用于认证。

### 3.5 `source_connections`

必须保存 `tenant_id`、`provider`、目标 `stream`、启用状态和签名 secret。为了保持 MVP 简单，本地版本将 secret 明文保存在受控数据库中；生产部署必须改用外部 Secret Manager 或应用层加密。轮询型 Connector 还应保存平台 cursor。secret 不得出现在日志、事件数据或 API 响应中。

### 3.6 `publish_idempotency_keys`

当客户端提供 `Idempotency-Key` 时，必须保存：

- `tenant_id` 和 `api_client_id`；
- key 的安全 hash；
- 请求 payload hash；
- 对应事件 `(tenant_id, offset)`；
- 创建和过期时间。

记录至少保留 30 天。payload hash 使用去除服务管理字段后的 RFC 8785 规范化 envelope 计算；同一个 key 和相同 payload 返回原结果，同一个 key 和不同 payload 返回 `409 Conflict`。

## 4. 写入事务与 offset

不得使用 `BIGSERIAL`、identity column 或普通 sequence 作为订阅游标。PostgreSQL sequence 不随事务回滚，并发提交顺序也不由 sequence 值保证。

以下 SQL 用于定义必须保持的数据库事务语义，不要求在业务代码中散布裸 SQL；实现可以通过 Drizzle 事务或由迁移管理的 PostgreSQL 函数达到等价效果。

单事件写入必须等价于以下短事务：

```sql
BEGIN;

-- 先完成身份/幂等检查；随后锁住这个租户的 head。
UPDATE tenant_heads
SET last_offset = last_offset + 1
WHERE tenant_id = $1
RETURNING last_offset;

INSERT INTO events (..., tenant_id, offset, ...)
VALUES (..., $1, $new_offset, ...);

-- payload 只含唤醒所需的小提示，不含完整事件。
SELECT pg_notify(
  'eventhub_events',
  json_build_object('tenant_id', $1, 'offset', $new_offset::text)::text
);

COMMIT;
```

实现还必须满足：

- `tenant_heads` 更新和 `events` 插入处于同一事务。
- 唯一约束冲突不得消耗一个已提交 offset。
- `pg_notify` 必须在相同事务内调用，使通知只在提交后可见。
- 事务内不得进行外部 HTTP 请求、等待消费者或执行耗时平台逻辑。
- 同一租户 offset 从 1 开始；0 是 API 的“从保留窗口起点开始”哨兵值，不是事件 offset。

这保证 offset 与同一租户事件的数据库提交顺序一致。offset 不代表平台发生时间，也不比较不同租户的先后。

数据库列和 SQL 比较使用 `bigint`。跨 HTTP、CloudEvents、SSE 或 NOTIFY JSON 边界时，offset 必须编码为十进制字符串；解析后必须检查其位于 `0..9223372036854775807` 范围内。实际事件 offset 从 1 开始，只有 API cursor 可以使用哨兵值 `"0"`。

## 5. LISTEN/NOTIFY 使用约束

`LISTEN/NOTIFY` 不是事件存储，也不提供持久化投递。实现必须假设通知会被合并、连接会断开、实例会在通知到达时离线。

- channel 固定为 `eventhub_events`。
- payload 必须保持很小，只包含 `tenant_id` 和最新 offset 提示。
- 收到通知后按 `offset > 本地扫描游标` 查询 `events`，不得直接把通知 payload 当事件发送。
- 即使没有通知，每个活跃订阅也必须至少每 5 秒检查数据库 head。
- listener 重连后必须立即对活跃租户执行 catch-up。
- 服务启动时应先建立长期 LISTEN 连接；无论建立连接是否存在竞态，最终都以数据库查询结果为准。
- 不得仅通过普通 Drizzle 池化查询执行 `LISTEN` 并假定订阅持续有效；`LISTEN` 绑定具体 PostgreSQL 会话，通知回调必须由底层 `pg` client 处理。
- LISTEN 连接失效后必须获取新的 `PoolClient`、重新执行 `LISTEN`，并依靠数据库回查补齐断线窗口内的事件。

## 6. 读取与 fan-out

每个 SSE 连接拥有独立的扫描 cursor 和过滤器。一个事件可以同时发送给任意多个连接；读取事件不得改变数据库中的事件或其他连接的进度。

一个实例可以共享按租户的数据库读取结果以降低查询量，但缓存只能是优化：

- 缓存丢失不得影响正确性。
- 缓存不得成为恢复依据。
- 缓存不得跨租户混用。

## 7. 保留与清理

- 默认删除 `received_at < now() - interval '30 days'` 的事件；可延长但不得短于 30 天，以维持幂等窗口承诺。
- `occurred_at` 不参与保留期计算，因为该值来自外部平台，可能缺失或错误。
- 清理任务应小批量运行，避免长事务和长时间锁表。
- 删除事件后不得回退或复用 `tenant_heads.last_offset`。
- API 必须能计算当前租户的 `minimum_available_offset` 和 `head_offset`，用于游标验证。
- MVP 使用普通表；只有在实测表规模、VACUUM 或删除成本构成问题时才采用按 `received_at` 的时间分区。

`head_offset` 等于 `tenant_heads.last_offset`。`minimum_available_offset` 等于仍保留事件的最小 offset；若当前没有保留事件，则定义为 `head_offset + 1`。

## 8. 故障边界

| 故障 | 必须行为 |
| --- | --- |
| PostgreSQL 不可用 | 发布失败；读取返回服务不可用；不得假装成功 |
| `pg_notify` 未送达 | 最多在兜底轮询周期后从表中发现事件 |
| API 实例重启 | 客户端用最后 offset 重连并回放 |
| Webhook 重试 | 通过 `(tenant_id, source, id)` 去重 |
| SSE 写入阻塞 | 关闭慢连接，由客户端回放 |
| 事务回滚 | 事件、offset 增量和通知均不可见 |

## 9. 运维要求

MVP 必须提供 `/health/live`、`/health/ready` 和带 request ID 的结构化请求/错误日志。生产化阶段还应暴露：

- 发布成功、重复、验证失败和数据库失败计数；
- Webhook 验签失败和 Adapter 错误计数；
- 活跃 SSE 连接数、重连数和慢消费者断开数；
- LISTEN 连接状态和重连次数；
- 从数据库 head 到各实例扫描位置的 lag；
- 事件表大小、最早保留时间和清理数量。

日志必须带 request ID；涉及事件时可以记录 tenant ID、offset、source 和 id，也可以为管理操作记录安全的 tenant/client 标识，但不得记录 `ADMIN_API_KEY`、应用 API Key、Key hash、签名 secret 或未经脱敏的完整 Webhook body。

## 10. 质量与发布契约

- 所有 pull request 和分支 push 必须在 Node.js 24 与 PostgreSQL 18 上执行应用类型检查、测试类型检查、自动化测试、构建和容器构建。
- 可执行 TypeScript 应用模块必须逐文件达到 statements、branches、functions 和 lines 四项 100% 覆盖率。进程入口、纯类型声明、Drizzle 声明式 schema 和只做 re-export 的 barrel 不属于可执行覆盖率分母；实际范围必须显式保存在版本库的覆盖率配置中，不得临时降低门槛。
- PostgreSQL 集成测试必须连接专用测试数据库，并实际执行迁移、事务、幂等、租户隔离、`LISTEN/NOTIFY` 与恢复路径；不得在 CI 中因缺少数据库变量而静默跳过。
- 正式发布只接受严格的 `vX.Y.Z` 标签。标签版本必须与 `package.json` 及 lockfile 根包版本一致，否则发布失败。
- 发布前必须重复完整质量门禁。通过后将 `linux/amd64` 与 `linux/arm64` OCI 镜像发布至 GitHub Container Registry，并生成 SBOM 和构建 provenance。
- 发布流水线必须使用最小权限：验证任务只读仓库，镜像任务仅增加 package 写权限，GitHub Release 任务仅增加 content 写权限。
- GitHub Release 创建必须可安全重跑；已存在同标签 Release 时不得重复创建或覆盖。MVP 不发布 npm 包。
