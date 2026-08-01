# 统一事件格式规范

## 1. 基础格式

EventHub 使用 [CloudEvents 1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) structured JSON 格式。HTTP 媒体类型为：

```http
Content-Type: application/cloudevents+json
```

MVP 只支持 JSON `data`，不支持 `data_base64`。服务输出的事件必须是一个完整 CloudEvents envelope，而不是仅输出 `data`。

## 2. 标准字段

| 字段 | 必填 | 约束与含义 |
| --- | --- | --- |
| `specversion` | 是 | 必须为字符串 `"1.0"` |
| `id` | 是 | 在同一个 `source` 内稳定且唯一，1–255 字符 |
| `source` | 是 | 合法 URI-reference，表示事件生产来源，1–512 字符 |
| `type` | 是 | 版本化事件类型，1–255 字符 |
| `subject` | 否 | 来源内部的业务对象标识，最多 1024 字符 |
| `time` | 否 | RFC 3339 时间；表示平台发生时间而非入库时间。写入时规范化为 UTC、毫秒精度 |
| `datacontenttype` | 是 | 必须为 `application/json` 或带 charset 的等价 JSON 类型 |
| `dataschema` | 否 | 合法 URI，指向 `data` 的 schema |
| `data` | 是 | 任意合法 JSON 值 |

`id` 不得使用每次投递都变化的 Webhook delivery attempt ID，除非该平台只提供这个稳定事件身份。对于平台重试，同一业务事件必须生成相同的 `source` 和 `id`。

## 3. EventHub extension attributes

EventHub 使用以下 CloudEvents extension attributes：

| 字段 | 方向 | 必填 | 含义 |
| --- | --- | --- | --- |
| `eventhubstream` | 写入与读取 | 是 | 逻辑流名称 |
| `eventhuboffset` | 仅服务输出 | 是 | 租户内持久化 offset，编码为正整数十进制字符串 |
| `eventhubreceivedat` | 仅服务输出 | 是 | EventHub 入库时间，RFC 3339 UTC |

租户身份来自鉴权或 `source_connections`，不得由请求 body 指定。`tenant_id` 不进入对外事件 envelope。

客户端发布时不得发送 `eventhuboffset` 或 `eventhubreceivedat`；发送这些服务管理字段返回 `400 Bad Request`。服务可以接受其他符合 CloudEvents 命名和类型要求的 extension attributes，但名称不得以 `eventhub` 开头。

## 4. stream 命名

`eventhubstream` 必须：

- 长度为 1–128 字符；
- 匹配 `^[a-z0-9][a-z0-9._-]*$`；
- 区分大小写，但由于只允许小写，调用方不得依赖大小写折叠；
- 表示稳定的订阅边界，例如 `engineering`、`billing.stripe`。

stream 不是安全边界。授权仍以 tenant 和 API client scopes 为准。

## 5. type 命名与版本

建议使用反向域名风格并以语义版本尾缀结束：

```text
com.github.issue.opened.v1
com.stripe.payment_intent.succeeded.v1
com.eventhub.order.created.v2
```

- 同一 `type` 的 `data` 必须保持向后兼容。
- 删除字段、改变字段类型或改变字段语义时必须发布新 type 版本。
- 增加可选字段不要求升版本；消费者必须忽略不认识的字段。
- Adapter 不应把所有平台事件归并成模糊的 `event.received` 类型。

## 6. 标准发布示例

客户端请求中的事件：

```json
{
  "specversion": "1.0",
  "id": "evt_01J5YX7Q5J0T8H3MQB5FA6VW9P",
  "source": "urn:eventhub:app:orders-api",
  "type": "com.acme.order.created.v1",
  "subject": "orders/order-123",
  "time": "2026-08-01T13:20:00Z",
  "datacontenttype": "application/json",
  "eventhubstream": "orders",
  "data": {
    "order_id": "order-123",
    "amount": 2599,
    "currency": "EUR"
  }
}
```

持久化后服务返回或推送的事件：

```json
{
  "specversion": "1.0",
  "id": "evt_01J5YX7Q5J0T8H3MQB5FA6VW9P",
  "source": "urn:eventhub:app:orders-api",
  "type": "com.acme.order.created.v1",
  "subject": "orders/order-123",
  "time": "2026-08-01T13:20:00Z",
  "datacontenttype": "application/json",
  "eventhubstream": "orders",
  "eventhuboffset": "1043",
  "eventhubreceivedat": "2026-08-01T13:20:00.418Z",
  "data": {
    "order_id": "order-123",
    "amount": 2599,
    "currency": "EUR"
  }
}
```

## 7. 平台 Webhook 映射

每个平台 Adapter 必须按以下规则映射：

| CloudEvents 字段 | 来源 |
| --- | --- |
| `id` | 平台稳定事件 ID；否则使用确定性 hash |
| `source` | `urn:eventhub:{provider}:{connection_id}` |
| `type` | `com.{provider}.{platform_event_type}.v1` |
| `subject` | 平台资源标识（若存在） |
| `time` | 平台事件发生时间（若可信且存在） |
| `eventhubstream` | `source_connections` 中配置的目标 stream |
| `data` | 平台原始业务 payload 或有文档的轻度标准化结果 |

确定性 ID 必须根据不会随重试改变的规范化字段计算，例如：

```text
sha256(provider + connection_id + canonical_event_payload)
```

如果平台提供业务事件 ID，应优先使用平台 ID，不要用完整 payload hash 替代。

Adapter 可以在 `data` 中增加 `_eventhub` 元数据以说明平台 delivery ID 或映射版本，但不得放置 secret、签名或访问令牌。

## 8. 身份、重复与冲突

事件身份键固定为：

```text
(tenant_id, source, id)
```

- 首次出现：持久化并分配新 offset。
- 身份键已存在且语义 payload 相同：视为重复，返回原事件和原 offset。
- 身份键已存在但规范化 envelope 不同：返回 `409 event_identity_conflict`，不得覆盖原事件或分配新 offset。

用于比较的规范化 envelope 不包含服务生成的 `eventhuboffset`、`eventhubreceivedat`，并使用 [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) 生成比较 hash，因此不受 JSON object key 顺序和无意义空白影响。

## 9. 大小和输入限制

- 完整 HTTP request body 不得超过 1 MiB（1,048,576 bytes）；超出返回 `413 Payload Too Large`。
- 字符串必须是合法 UTF-8。
- 不接受 `NaN`、`Infinity` 或语法不合法的 JSON；调用方不得发送重复 JSON object key。
- JSON 字符串不得包含 NUL 或未配对的 UTF-16 surrogate；超过 JavaScript safe integer 范围的业务整数必须编码为字符串，避免解析时精度丢失。
- MVP 单次发布只允许一个事件，不接受数组批量发布。
- 未知的标准顶层字段按 CloudEvents extension attribute 处理；不符合 extension 命名要求时返回 `400`。

## 10. 时间语义

- `time` 是生产平台报告的业务发生时间，可能为空、延迟或乱序。
- `eventhubreceivedat` 是 EventHub 成功持久化时的服务时间。
- `eventhuboffset` 是唯一规范顺序。消费者不得使用 `time` 判断是否已消费或构造恢复游标。
- `eventhuboffset` 必须匹配 `^[1-9][0-9]*$`，且数值不超过 PostgreSQL signed `bigint` 上限。消费者比较顺序时必须按整数语义比较，不得按字符串字典序比较。
