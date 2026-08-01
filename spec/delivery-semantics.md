# 投递与恢复语义

## 1. 核心承诺

EventHub 对保留窗口内的已提交事件提供：

- 持久化后再确认；
- 租户内按 offset 的稳定顺序；
- 历史回放；
- 广播给多个独立消费者；
- at-least-once 投递。

EventHub 不承诺 exactly-once。网络在“服务已写出事件、客户端已处理、连接在确认前断开”时无法判断处理是否完成，因此重连后可以再次收到同一事件。

## 2. “已接受”的定义

只有包含事件插入的 PostgreSQL 事务提交成功，事件才算被 EventHub 接受。

- API 的 `201`、Webhook 的 `202` 均表示事务已经提交。
- 数据库事务失败时必须返回失败，不得仅因为消息进入内存队列或 NOTIFY 已调用而返回成功。
- 事务提交后，即使 API 响应在网络中丢失，重试也会通过幂等规则返回原事件；因此生产者也可能观察到重复成功。

## 3. 顺序

### 3.1 保证范围

对同一租户的任意两个已提交事件 A、B：

```text
A.eventhuboffset < B.eventhuboffset
```

表示 A 在 EventHub 日志中先于 B。虽然线协议将 offset 编码为十进制字符串，这里的比较是整数比较而不是字典序比较。历史 API 和单个 SSE 连接必须按 offset 递增输出。

### 3.2 不保证的顺序

- 不保证不同租户之间的全局先后。
- 不保证 offset 与 CloudEvents `time` 一致。
- 不保证多个外部平台的网络到达顺序等于它们的业务发生顺序。
- 断线重连边界允许重复，所以消费者可能再次看到较小或等于其“已处理但尚未持久化”位置的事件。

## 4. 广播，而非竞争消费

每个 API 客户端或应用维护自己的 cursor。读取一个事件不会把它从队列中取走，也不会影响其他应用读取。

MVP 没有：

- consumer group；
- 服务端 ACK；
- 服务端 per-consumer cursor；
- 服务端 dead-letter queue；
- 多 worker 竞争同一事件的协议。

如果一个应用内部有多个 worker，该应用必须自行协调 cursor、分区和幂等处理。

## 5. 消费者处理算法

推荐消费者采用以下顺序：

1. 从持久化的本地 cursor 建立 SSE，或使用历史 REST 拉取。
2. 收到业务事件后，以 `(source, id)` 或 `eventhuboffset` 做幂等检查。
3. 在自己的本地事务中完成业务写入。
4. 业务写入成功后，持久化最新成功处理的 offset。
5. 失败时不要推进 cursor；停止或重试该事件。
6. 断线后使用最后持久化的 cursor 重连。

若消费者数据库允许，应把业务副作用和 cursor 更新放在同一事务。无法同事务提交的外部副作用（例如发送邮件或调用支付 API）必须使用下游服务的幂等 key、outbox 或等价机制。

消费者不得在开始处理事件前持久化 cursor，否则进程崩溃会导致事件被跳过。

TypeScript SDK 的 `consume()` 遵循同一顺序：只有其业务回调成功完成后，才调用 cursor store 保存 `eventhuboffset`。SDK 内存或文件 cursor store 只解决单个应用实例的存储问题，不提供消费者组或多 worker 协调。

## 6. 重复来源

重复可以发生在以下位置：

- 平台重复发送 Webhook；
- 生产者未收到 HTTP 响应后重试；
- SSE 帧已经到达客户端，但客户端保存 cursor 前断线；
- 客户端主动回退 cursor 以重放；
- 客户端在进程崩溃前未能持久化最新 cursor。

服务端用 `(tenant_id, source, id)` 防止重复事件占用新的 offset；消费者仍必须幂等，因为传输层可以重复交付同一条已存事件。

## 7. LISTEN/NOTIFY 与完整性

NOTIFY 只是“数据库可能有新 offset”的唤醒信号。以下情况不得造成事件遗漏：

- API 实例尚未执行 LISTEN；
- LISTEN 连接断开或重连；
- 相同通知被 PostgreSQL 合并；
- 实例收到通知时没有活跃订阅；
- 通知 payload 无法解析；
- 多个 API 实例只收到各自在线期间的通知。

每次恢复都必须执行：

```text
SELECT ... FROM events
WHERE tenant_id = :tenant
  AND offset > :cursor
  AND offset <= :captured_head
ORDER BY offset ASC
```

过滤器可以加入查询，但扫描位置必须能推进到 captured head。周期性读取数据库 head 是通知通道的兜底。

## 8. SSE 断线恢复

### 8.1 业务事件

SSE `id` 等于 `eventhuboffset`。客户端应保存最近成功处理的 offset，并作为 query `after` 或 `Last-Event-ID` 重连。

### 8.2 重连后的重复和缺口

- `after` 是 exclusive；重连返回严格大于它的事件。
- 客户端使用最后“收到”而非最后“完成”的 offset，可能漏掉处理中的事件，因此业务消费者应保存最后完成位置。
- 客户端使用稍旧 cursor 会收到重复，但不会造成缺口。

## 9. 过滤语义

stream、type 和 source 过滤只决定哪些业务事件发送给客户端，不创建独立日志，也不改变 offset。

因此同一 stream 中的相邻事件 offset 可以不连续，这是正常行为。消费者必须把 offset 当不透明的单调游标，不能要求 `next = current + 1`。

如果服务扫描了不匹配的事件，历史 REST 通过 `next_after` 推进扫描位置；活跃 SSE 连接可以只在内存中推进扫描位置。SSE 重连后从最后匹配事件重新扫描无关 offset 是允许的，两者均不得伪造业务事件。

## 10. 保留期和永久离线消费者

默认保留期为 30 天，按 `eventhubreceivedat`/数据库 `received_at` 计算。EventHub 只保证在该窗口内可回放。

当 cursor 早于仍可完整回放的边界时返回 `410 cursor_expired`。收到该错误后，消费者必须选择：

1. 从 `minimum_available_offset - 1` 开始，只处理仍保留的事件；
2. 从源系统执行全量状态同步，再从当前 head 继续；
3. 停止并要求人工处理。

服务不得自动选择，也不得把过期 cursor 静默推进到最新位置。

## 11. 慢消费者与背压

SSE 服务不能无限缓存。每个连接默认最多积压 1 MiB 待发送数据；30 秒无写入进展也视为慢消费者。

达到限制时：

1. 记录结构化原因和该连接最后扫描/发送的 offset；
2. 关闭 SSE 连接；
3. 不删除或标记数据库事件；
4. 由客户端用持久化 cursor 重连并回放。

服务不得因为某个慢消费者阻塞同租户的事件写入或其他订阅。

## 12. 生产者重试

生产者只有在收到成功响应时才可确认发布完成。以下响应可以按指数退避并加入 jitter 后重试：

- 网络错误或超时；
- `429 Too Many Requests`，优先遵守 `Retry-After`；
- `503 Service Unavailable`。

生产者重试时必须复用相同 `Idempotency-Key`、`source` 和 `id`。对 `400`、`401`、`403`、`409`、`413`、`415` 不应无修改重试。

Webhook 平台重试由平台控制；Adapter 必须把重复 delivery 安全地映射到原事件。

## 13. 一致性边界

| 能力 | 语义 |
| --- | --- |
| 事件持久化 | PostgreSQL 事务原子提交 |
| 租户内顺序 | 以 tenant offset 为准 |
| 实时通知 | best-effort 唤醒 |
| 历史回放 | 保留窗口内按 offset 查询 |
| SSE 投递 | at-least-once |
| Webhook 去重 | 保留窗口内按事件身份去重 |
| 下游副作用 | 由消费者保证幂等 |
| 跨租户顺序 | 不提供 |
| exactly-once | 不提供 |

## 14. 必测故障场景

- 提交成功但 HTTP 响应丢失，生产者使用相同 key 重试。
- 两个并发请求发布相同 `(source, id)`。
- 同一个 idempotency key 携带不同 body。
- 写入在 head 更新后、事件插入前回滚。
- NOTIFY 完全禁用时，活跃 SSE 仍通过轮询收到事件。
- LISTEN 连接重连期间写入多条事件。
- SSE 在帧发送后、消费者存 cursor 前断开。
- 过滤订阅跨越大量无关事件后重连，仍能收到后续匹配事件。
- 慢消费者被断开后从旧 cursor 补齐。
- 清理任务删除旧事件后，过期 cursor 得到 `410` 而不是空结果。
