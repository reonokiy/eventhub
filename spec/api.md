# HTTP API 规范

## 1. 通用约定

API 基础路径为 `/v1`。除 SSE 外，请求和响应均使用 UTF-8 JSON。

### 1.1 应用 API Key 鉴权

可信应用调用以下接口时必须发送：

```http
Authorization: Bearer <api-key>
```

应用 API Key 确定 `tenant_id` 和 scopes。MVP scopes：

- `events:write`：调用 `POST /v1/events`。
- `events:read`：调用历史查询和 SSE。

缺少或无效凭证返回 `401`；凭证有效但 scope 不足返回 `403`。响应和日志不得回显 API Key。应用 Key 只适用于事件发布、历史读取和 SSE，不得用于 `/v1/admin`。

### 1.2 管理 API：租户与应用凭据

所有 `/v1/admin` 接口都必须使用与应用 Key 完全独立的服务端配置密钥：

```http
Authorization: Bearer <ADMIN_API_KEY>
```

`ADMIN_API_KEY` 不是 `api_clients` 表中的应用凭据，不携带 tenant 或 event scope，也不得用于事件接口。它不得以由服务签发的 application Key 前缀 `ehk_` 开头。普通应用 Key 调用任一 `/v1/admin` 接口必须得到 `401 admin_unauthorized`，即使该 Key 拥有 `events:read` 和/或 `events:write`。

生产启动配置必须显式使用非开发的 `BOOTSTRAP_API_KEY`、`ADMIN_API_KEY` 与 `BOOTSTRAP_WEBHOOK_SECRET`；缺失值回退到内置开发值的情况也必须被拒绝。生产的 bootstrap 与 admin API Key 各至少为 32 个无空格可打印 ASCII 字符，且两者不得相同。开发默认值只可用于 `NODE_ENV=development` 的本地环境。

所有管理写请求使用 `application/json`。`rotate` 与 `revoke` 的请求 body 必须是空 JSON object（`{}`）；省略 body、非 JSON body 或携带未知字段均返回 `400 invalid_admin_request`。管理端点及其职责如下：

| 方法与路径 | 职责 |
| --- | --- |
| `POST /v1/admin/tenants` | 创建租户，接收稳定 slug、展示名称和可选保留期。 |
| `GET /v1/admin/tenants` | 列出可管理租户的安全元数据。 |
| `POST /v1/admin/tenants/:tenantId/api-clients` | 为一个租户发放新的应用 API Key，接收应用名称和 scope 集合。 |
| `GET /v1/admin/tenants/:tenantId/api-clients` | 列出租户的应用 Key 安全元数据。 |
| `POST /v1/admin/tenants/:tenantId/api-clients/:clientId/revoke` | 撤销应用 Key。 |
| `POST /v1/admin/tenants/:tenantId/api-clients/:clientId/rotate` | 轮换应用 Key。 |

每个接入应用必须拥有独立 Key；同一租户内的应用名称必须唯一。租户 `slug` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 且最多 63 个字符；租户和应用的展示名称在去除首尾空白后均为 1–255 字符。`scopes` 必须是非空集合，且只能包含 `events:read` 与 `events:write`。生产者应只获授 `events:write`，消费者应只获授 `events:read`；只有确实兼具两种职责的同一可信应用才可同时获授两者。

创建和轮换成功时，响应返回 `{ "api_key": "…", "client": { … } }`。`api_key` 只在该一次成功响应中出现；调用方必须立即保存到受控 Secret Manager 或应用部署密钥中。列出、撤销和所有错误响应不得包含原始 Key 或其 hash，日志同样不得记录它们。轮换成功后旧 Key 必须立即失效，且会签发新的 Key；管理者可以用轮换为同一应用 client 重新启用凭据，但旧的明文 Key 永远不可恢复。撤销不删除应用的历史事件或审计元数据。

已建立的 SSE 连接也绑定建立连接时那一个 Key 的 hash，而不是只绑定 client ID。服务会在每个订阅循环、每批回放以及每个业务事件写出前重新确认该 hash 仍然有效且保有 `events:read`。因此轮换或撤销后，连接一旦观察到变更便不再读取或发送新的业务事件，并关闭；在 PostgreSQL 可用时，空闲连接最迟在下一次 `SSE_POLL_INTERVAL_MS` 轮询后关闭，收到事件唤醒时通常更早。SSE 已返回 `200` 后无法改写为 `401`，客户端应把关闭视为需要重新连接；旧 Key 的新连接会得到 `401 unauthorized`。

管理写操作当前不接受 `Idempotency-Key`。如果创建、发放或轮换的成功响应在网络中丢失，管理员必须先查询列表确认状态；尤其不得盲目重试轮换，因为每次成功轮换都会替换上一次返回的原始 Key。

当前版本不提供删除租户或删除应用 client 的管理接口。管理接口必须只经由受控运维网络、部署作业或 CI/CD 暴露；部署必须在入口层实施合适的来源限制并将 `ADMIN_API_KEY` 保存在 Secret Manager 中。

管理 API 的稳定错误码如下：

| 状态 | code | 场景 |
| --- | --- | --- |
| `400` | `invalid_admin_request` | 管理请求字段、scope、UUID 或 JSON 不合法。 |
| `401` | `admin_unauthorized` | `ADMIN_API_KEY` 缺失或无效，或使用了应用 Key。 |
| `404` | `tenant_not_found` | 目标租户不存在。 |
| `404` | `api_client_not_found` | 目标应用 client 不存在。 |
| `409` | `tenant_slug_conflict` | 已存在相同 tenant slug。 |
| `409` | `api_client_name_conflict` | 该租户内已存在相同应用名称。 |

Webhook 接口不使用 API Key；它通过 `connection_id` 查找租户和 secret，并按平台规则验签。

### 1.3 请求追踪

客户端可以发送 `X-Request-ID`。服务必须在所有响应中返回一个合法的 `X-Request-ID`；非法、缺失或过长时由服务重新生成。

### 1.4 错误格式

非 2xx JSON 错误使用 `application/problem+json`：

```json
{
  "type": "https://eventhub.local/problems/invalid-event",
  "title": "Invalid event",
  "status": 400,
  "code": "invalid_event",
  "detail": "specversion must be 1.0",
  "request_id": "req_01J5Z0A1W4GQY6JXCQKZ9S4AE8"
}
```

字段 `code` 是稳定的机器可读值；`detail` 仅供诊断，客户端不得解析其文本。

## 2. 发布统一事件

```http
POST /v1/events
Authorization: Bearer <api-key>
Content-Type: application/cloudevents+json
Idempotency-Key: <optional-key>
```

请求 body 必须符合 [event-format.md](./event-format.md)。MVP 每次只接受一个事件。

### 2.1 Idempotency-Key

- 可选，长度 1–255 个可打印 ASCII 字符。
- 作用域为 `(tenant_id, api_client_id)`。
- 同一个 key 和语义相同的请求 envelope 在记录保留期内返回第一次请求的结果，不分配新 offset；比较按 RFC 8785 规范化 JSON 进行，object key 顺序和无意义空白不构成差异。
- 同一个 key 和不同 payload 返回 `409 idempotency_key_conflict`。
- 即使没有该 header，事件身份 `(tenant_id, source, id)` 仍然执行去重。

### 2.2 成功响应

首次写入：

```http
HTTP/1.1 201 Created
Content-Type: application/cloudevents+json
Location: /v1/events/1043
```

body 为包含服务 extension attributes 的完整事件。

幂等重放或事件身份重复：

```http
HTTP/1.1 200 OK
Idempotent-Replayed: true
Content-Type: application/cloudevents+json
```

body 为第一次持久化的完整事件和原 offset。

### 2.3 状态码

| 状态 | code | 场景 |
| --- | --- | --- |
| `201` | — | 新事件已提交 |
| `200` | — | 相同请求或相同事件已存在 |
| `400` | `invalid_event` | envelope 或字段不合法 |
| `400` | `invalid_json` | body 不是合法的 UTF-8 JSON |
| `401` | `unauthorized` | API Key 缺失或无效 |
| `403` | `forbidden` | 缺少 `events:write` |
| `409` | `event_identity_conflict` | 同 source/id 对应不同事件 |
| `409` | `idempotency_key_conflict` | 同 idempotency key 对应不同 payload |
| `413` | `payload_too_large` | body 超过限制 |
| `415` | `unsupported_media_type` | Content-Type 不支持 |
| `503` | `storage_unavailable` | 无法完成持久化 |

任何成功响应都意味着事件已经提交到 PostgreSQL。只写入进程内队列或仅发送 NOTIFY 不得返回成功。

## 3. 接收平台 Webhook

```http
POST /v1/webhooks/{provider}/{connection_id}
Content-Type: <provider media type>
```

- `provider` 匹配 `^[a-z0-9][a-z0-9-]{0,63}$`。
- `connection_id` 是不可猜测的连接标识，但不可猜测性不能替代签名验证。
- 服务必须使用未经 JSON 解析或重序列化的原始 body 验签。
- 成功响应只在所有同步接受的事件提交后发送。

### 3.1 通用 HMAC Adapter

通用 provider 名称为 `hmac`，请求必须包含：

```http
X-EventHub-Timestamp: 1785590400
X-EventHub-Signature: v1=<hex>
```

body 是被完整签名的事件描述对象；`id`、`type` 和 `data` 必填，`subject`、`time` 可选：

```json
{
  "id": "provider-event-123",
  "type": "com.example.issue.opened.v1",
  "subject": "issues/42",
  "time": "2026-08-01T13:20:00Z",
  "data": {"issue": 42}
}
```

签名输入的字节序列为：

```text
ASCII(timestamp) + "." + ASCII(connection_id) + "." + raw_request_body
```

`<hex>` 是连接 secret 上的 HMAC-SHA256 小写十六进制结果。服务必须：

1. 在解析 body 前验签；
2. 使用常量时间比较；
3. 拒绝与服务时间相差超过 5 分钟的时间戳；
4. 从已签名 body 读取 event ID/type，并使用 event ID 做持久化去重；
5. 将配置中的目标 stream 用作 `eventhubstream`。

真实平台 Adapter 必须遵循平台官方签名规则；其 header 可以不同，但仍需满足原始 body 验签、时间窗口（平台支持时）和持久化去重。

### 3.2 Webhook 响应

| 状态 | code | 场景 |
| --- | --- | --- |
| `202 Accepted` | — | 验签成功、事件已持久化 |
| `200 OK` | — | 已持久化过的重复 delivery |
| `400` | `invalid_webhook` | 必填 header 或 payload 不合法 |
| `401` | `invalid_signature` | 签名错误或签名时间戳过期 |
| `404` | `connection_not_found` | provider/connection 不存在或已禁用 |
| `409` | `event_identity_conflict` | 同事件身份出现不同内容 |
| `413` | `payload_too_large` | body 超过限制 |
| `415` | `unsupported_media_type` | 媒体类型不支持 |
| `503` | `storage_unavailable` | 未能持久化；平台可以重试 |

`202` 在本 API 中表示平台投递已被 EventHub 接受，不表示尚未落库。Adapter 的后续外部副作用不属于该响应承诺。

## 4. 查询历史事件

```http
GET /v1/events?after=1042&limit=100&stream=orders&type=com.acme.order.created.v1
Authorization: Bearer <api-key>
Accept: application/json
```

参数：

| 参数 | 必填 | 规则 |
| --- | --- | --- |
| `after` | 否 | 表示非负 bigint 的十进制字符串，exclusive；默认 `0` |
| `limit` | 否 | 1–1000，默认 100 |
| `stream` | 否 | 精确匹配，可重复，重复值按 OR |
| `type` | 否 | 精确匹配，可重复，重复值按 OR |
| `source` | 否 | 精确匹配，可重复，重复值按 OR |

不同过滤维度之间按 AND 组合。结果必须按 `eventhuboffset ASC` 排序。

响应：

```json
{
  "events": [
    {
      "specversion": "1.0",
      "id": "evt_123",
      "source": "urn:eventhub:app:orders-api",
      "type": "com.acme.order.created.v1",
      "datacontenttype": "application/json",
      "eventhubstream": "orders",
      "eventhuboffset": "1043",
      "eventhubreceivedat": "2026-08-01T13:20:00.418Z",
      "data": {"order_id": "order-123"}
    }
  ],
  "page": {
    "after": "1042",
    "next_after": "1043",
    "head_offset": "1100",
    "minimum_available_offset": "81",
    "has_more": true
  }
}
```

分页必须使用 offset，不得使用页码。服务在查询开始时捕获 `head_offset` 作为本页快照上界：

- 返回数量达到 `limit` 时，`next_after` 是最后返回事件的 offset，`has_more` 表示在快照上界内是否还存在匹配事件。
- 返回数量小于 `limit` 时，说明已扫描到快照上界；`next_after` 必须等于 `head_offset`，`has_more=false`。
- 没有匹配事件时仍将 `next_after` 推进到 `head_offset`，避免过滤订阅反复扫描无关事件。

游标过期规则见第 6 节。

历史查询状态码：

| 状态 | code | 场景 |
| --- | --- | --- |
| `200` | — | 查询成功，包括空结果 |
| `400` | `invalid_cursor` | `after` 不是规范的非负 bigint 十进制字符串 |
| `400` | `cursor_ahead` | `after` 大于请求时的 `head_offset` |
| `400` | `invalid_limit` | limit 不是 1–1000 的整数 |
| `400` | `invalid_filter` | stream、type 或 source 过滤参数不合法 |
| `401` | `unauthorized` | API Key 缺失或无效 |
| `403` | `forbidden` | 缺少 `events:read` |
| `410` | `cursor_expired` | cursor 早于保留边界 |
| `503` | `storage_unavailable` | 无法完成可靠读取 |

## 5. SSE 实时订阅

```http
GET /v1/events/stream?after=1042&stream=orders&type=com.acme.order.created.v1
Authorization: Bearer <api-key>
Accept: text/event-stream
Last-Event-ID: 1042
```

过滤参数与历史查询相同，但不支持 `limit`。

### 5.1 起始游标

按以下顺序确定起始位置：

1. 存在 `Last-Event-ID` 时优先使用它。这允许标准 EventSource 在 URL 仍含初始 `after` 的情况下自动重连。
2. 否则，存在 query `after` 时使用它。
3. 两者都未提供时，从建立连接时的租户 `head_offset` 开始，只接收随后提交的事件。
4. 显式 `after=0` 表示从当前保留窗口内最早的事件开始回放。

### 5.2 成功响应头

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

代理和应用必须禁用对 SSE 的响应缓冲和内容转换。

### 5.3 业务事件帧

```text
id: 1043
event: com.acme.order.created.v1
data: {"specversion":"1.0","id":"evt_123","source":"urn:eventhub:app:orders-api","type":"com.acme.order.created.v1","datacontenttype":"application/json","eventhubstream":"orders","eventhuboffset":"1043","eventhubreceivedat":"2026-08-01T13:20:00.418Z","data":{"order_id":"order-123"}}

```

- `id` 必须等于 `eventhuboffset` 的十进制字符串值。
- `event` 必须等于 CloudEvents `type`。
- `data` 必须是单行紧凑 JSON 的完整 envelope。
- 每个帧以空行结束。

连接建立后，服务先发送一次 `retry: 3000` SSE 控制字段；它设置客户端重连建议，不属于业务事件帧。

### 5.4 heartbeat

至少每 15 秒发送注释 heartbeat，防止空闲连接被中间层关闭：

```text
: keepalive

```

heartbeat 不推进 cursor。过滤订阅重连时可以从最后一个匹配业务事件重新扫描一段无关 offset；这可能产生额外查询，但不会漏掉匹配事件。

### 5.5 catch-up 与实时切换

服务必须先从 PostgreSQL 回放 `offset > cursor` 的事件，再保持实时等待。切换过程中到达的新事件仍通过同一个 offset 查询补齐；不得依赖某次 NOTIFY 恰好到达来避免竞态。

当连接积压待发送数据超过 1 MiB，或 30 秒无写入进展时，服务应关闭连接。客户端必须使用最后收到的 SSE `id` 重连。

### 5.6 SSE 建连错误

在发送 `200` 响应头前可以返回：

| 状态 | code | 场景 |
| --- | --- | --- |
| `400` | `invalid_cursor` | cursor 不是规范的非负 bigint 十进制字符串 |
| `400` | `cursor_ahead` | 起始 cursor 大于建连时的 `head_offset` |
| `401` | `unauthorized` | API Key 缺失或无效 |
| `403` | `forbidden` | 缺少 `events:read` |
| `410` | `cursor_expired` | cursor 早于保留边界 |
| `503` | `storage_unavailable` | 无法建立可靠读取 |

发送 `200` 后发生错误时，服务只能关闭流；客户端按重连规则恢复。

## 6. 游标过期

令 `minimum_available_offset` 为当前租户仍保留的最小 offset。以下情况返回 `410 Gone`：

```text
after > 0 AND after < minimum_available_offset - 1
```

`after=0` 是显式从保留窗口起点开始的哨兵，始终允许。错误 body 必须提供恢复边界：

```json
{
  "type": "https://eventhub.local/problems/cursor-expired",
  "title": "Cursor expired",
  "status": 410,
  "code": "cursor_expired",
  "detail": "Events after this cursor are no longer fully retained",
  "minimum_available_offset": "81",
  "head_offset": "1100",
  "request_id": "req_01J5Z0A1W4GQY6JXCQKZ9S4AE8"
}
```

消费者必须明确选择从 `minimum_available_offset - 1` 恢复、执行外部全量同步，或停止处理；服务不得静默跳过缺失区间。

## 7. 单事件读取

`POST /v1/events` 的 `Location` 指向：

```http
GET /v1/events/{offset}
Authorization: Bearer <api-key>
```

- 找到本租户事件时返回 `200` 和 `application/cloudevents+json`。
- offset 不存在、已过期或属于其他租户时统一返回 `404 event_not_found`，避免泄漏租户信息。
- path 中的 offset 必须为规范的正 bigint 十进制字符串，否则返回 `400 invalid_offset`。

## 8. JSON 中的 offset 编码

数据库 offset 是 signed `bigint`，但所有 HTTP JSON 字段（包括 `eventhuboffset`、`after`、`next_after`、`head_offset` 和 `minimum_available_offset`）必须使用十进制字符串，不得输出 JSON number。这样可避免超过 JavaScript `Number.MAX_SAFE_INTEGER` 后的精度丢失。

- 实际事件 offset 匹配 `^[1-9][0-9]*$`。
- cursor 可以为哨兵字符串 `"0"`，除此之外不得有前导零、正号、小数点或指数形式。
- 最大允许值为 `"9223372036854775807"`。
- 比较和加减必须使用 bigint/任意精度整数语义，不得使用字典序。

## 9. 健康检查

- `GET /health/live`：进程存活即 `200`，不依赖数据库。
- `GET /health/ready`：只有 PostgreSQL 可查询且服务可接受请求时返回 `200`，否则 `503`。

健康检查不得返回 secret、连接字符串或租户数据。
