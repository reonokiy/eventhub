# TypeScript SDK 契约

## 1. 目标与入口

TypeScript SDK 以 `eventhub/sdk` 导出，供生产者和消费者接入既有 `/v1` HTTP/SSE 协议；该入口不依赖 Node.js 内建模块。适合单进程 Node.js 的 `FileCursorStore` 从 `eventhub/sdk/node` 导出。它不引入另一套事件格式、鉴权语义或服务端 cursor；所有协议行为仍以 [api.md](./api.md)、[event-format.md](./event-format.md) 和 [delivery-semantics.md](./delivery-semantics.md) 为准。

SDK 必须导出 `EventHubClient`，并提供以下能力：

- `publish()`：发布一个 CloudEvents structured JSON 事件；调用者可传递发布幂等键。
- `list()`：读取一页历史事件，并保留服务返回的分页 cursor 和保留窗口边界。
- `subscribe()`：建立带鉴权的 SSE 订阅，按事件顺序产出业务事件，并在可恢复的断线后从调用者提供的 cursor 恢复。
- `consume()`：在 `subscribe()` 之上执行业务回调，并在回调成功后持久化 cursor。

客户端构造时需要服务基础地址和该应用专属 API Key。精确的构造参数、过滤参数和返回类型以随包发布的 TypeScript 声明为准；它们不能改变本文档定义的 HTTP 协议含义。

## 2. 凭据与运行位置

SDK 使用 `Authorization: Bearer <api-key>` 调用 EventHub。应用必须使用通过受 `ADMIN_API_KEY` 保护的管理 API 发放的专属 Key，不得共享 bootstrap Key 或把一个应用的 Key 交给另一个应用。SDK 不封装 `/v1/admin`：管理密钥只能由受控运维环境使用。

- 仅发布的进程使用只含 `events:write` 的 Key。
- 仅消费的进程使用只含 `events:read` 的 Key。
- 同一可信进程确有两种职责时，才使用同时拥有两个 scope 的 Key。

Key 是 bearer secret。浏览器中无法安全保密的客户端不得直接嵌入它；应经由后端/BFF 或使用专门的短期授权方案。SDK 不记录 Key，也不得把它放入错误消息、cursor 文件或遥测属性。

## 3. 发布与历史读取

`publish()` 必须按照 `POST /v1/events` 的约定发送事件，接受并返回服务端补充 `eventhuboffset` 与 `eventhubreceivedat` 的完整 envelope。遇到网络错误或可重试的服务端错误时，调用方重试必须复用同一 `Idempotency-Key`、`source` 和 `id`。

`list()` 必须按照 `GET /v1/events` 的分页和过滤约定工作。调用方只能将响应中的 `next_after` 当作后续扫描 cursor；不得假设 offset 连续，也不得将其转成 JavaScript `number`。SDK 不能把 `next_after` 自动视为“业务已经处理完成”。

## 4. 实时订阅与 cursor

`subscribe()` 必须用 SSE 的 `after`/`Last-Event-ID` 规则建立或恢复订阅，忽略 heartbeat，并只产出可解析的业务事件。连接意外关闭后，它必须从最后一个已持久化的 cursor 恢复，因此消费者仍可能收到重复事件。

SDK 提供可替换的异步 cursor store 抽象，并提供适合测试的内存 store 与适合单个 Node.js 进程的文件 store。应用可以实现自己的 store，例如把 cursor 与业务写入放入同一个数据库事务。文件 store 不是多进程协调工具；多个 worker 不能无协调地共享同一个 cursor 文件。

`consume()` 的固定顺序是：

1. 从 cursor store 读取最后一个成功处理的 cursor；
2. 订阅该位置之后的事件；
3. 调用应用的业务回调；
4. 仅当回调成功后，保存该事件的 `eventhuboffset`；
5. 回调失败时不更新 cursor，并把错误交给调用方处理。

因此 SDK 提供的是 at-least-once，而不是 exactly-once。业务回调必须可幂等；若业务数据库支持事务，业务副作用与 cursor 更新应该放在同一事务中。

## 5. 错误与恢复

SDK 应以可检查的错误暴露非成功 HTTP 响应及其稳定 `code`，尤其是 `401 unauthorized`、`403 forbidden` 和 `410 cursor_expired`。遇到 `410 cursor_expired` 时，SDK 不得静默把保存的 cursor 跳到最新位置或自动覆盖 cursor store。

应用必须明确选择以下一种恢复策略：

1. 从服务返回的 `minimum_available_offset - 1` 恢复，并接受保留窗口之前的数据已不可回放；
2. 先从源系统完成全量同步，再从当前 head 继续；
3. 停止消费并要求人工处理。

网络中断、服务器主动关闭慢 SSE 连接和进程重启都属于正常恢复路径；认证、授权、事件格式和过期 cursor 错误不会因为简单重连而自行恢复。
