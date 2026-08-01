import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EventHubApiError,
  EventHubClient,
  EventHubProtocolError,
  type CursorStore,
  type EventHubEvent,
  type FetchLike,
  type PublishableEvent,
} from "../../src/sdk/index.js";

const EVENT: EventHubEvent = {
  specversion: "1.0",
  id: "order-42-created",
  source: "urn:example:orders",
  type: "com.example.order.created.v1",
  datacontenttype: "application/json",
  eventhubstream: "orders",
  data: { order_id: "42" },
  eventhuboffset: "42",
  eventhubreceivedat: "2026-08-01T13:20:00.000Z",
};

const PUBLISHABLE_EVENT: PublishableEvent = {
  specversion: "1.0",
  id: EVENT.id,
  source: EVENT.source,
  type: EVENT.type,
  datacontenttype: EVENT.datacontenttype,
  eventhubstream: EVENT.eventhubstream,
  data: EVENT.data,
};

describe("EventHub TypeScript SDK", () => {
  it("publishes CloudEvents with authentication and returns publish metadata", async () => {
    const requests = createFetch([
      jsonResponse(EVENT, 200, {
        "idempotent-replayed": "true",
        location: "/v1/events/42",
        "x-request-id": "req-publish",
      }),
      jsonResponse(EVENT, 201),
    ]);
    const client = new EventHubClient({
      baseUrl: "https://events.example.test/gateway",
      apiKey: "publish-secret",
      fetch: requests.fetch,
    });
    const controller = new AbortController();

    const result = await client.publish(PUBLISHABLE_EVENT, { idempotencyKey: "order-42" });
    const withoutKey = await client.publish(PUBLISHABLE_EVENT, { signal: controller.signal });
    assert.doesNotThrow(() => {
      new EventHubClient({ baseUrl: "https://events.example.test", apiKey: "uses-default-fetch" });
    });

    assert.deepEqual(result, {
      event: EVENT,
      idempotentReplay: true,
      location: "/v1/events/42",
      requestId: "req-publish",
    });
    assert.equal(withoutKey.idempotentReplay, false);
    assert.equal(requests.calls[0]?.url.pathname, "/gateway/v1/events");
    assert.equal(requests.calls[0]?.init?.method, "POST");
    assert.equal(header(requests.calls[0], "authorization"), "Bearer publish-secret");
    assert.equal(header(requests.calls[0], "accept"), "application/cloudevents+json");
    assert.equal(header(requests.calls[0], "content-type"), "application/cloudevents+json");
    assert.equal(header(requests.calls[0], "idempotency-key"), "order-42");
    assert.equal(header(requests.calls[1], "idempotency-key"), null);
    assert.equal(requests.calls[1]?.init?.signal, controller.signal);
    assert.deepEqual(JSON.parse(String(requests.calls[0]?.init?.body)), PUBLISHABLE_EVENT);
  });

  it("lists events with cursor, filters, and a caller abort signal", async () => {
    const requests = createFetch([
      jsonResponse(pageResponse()),
      jsonResponse(pageResponse()),
    ]);
    const controller = new AbortController();
    const client = new EventHubClient({
      baseUrl: "https://events.example.test/",
      apiKey: "read-secret",
      fetch: requests.fetch,
    });

    assert.deepEqual(
      await client.list({
        after: "40",
        limit: 2,
        stream: ["orders", "payments"],
        type: EVENT.type,
        source: EVENT.source,
        signal: controller.signal,
      }),
      pageResponse(),
    );
    await client.list();

    const first = requests.calls[0];
    assert.deepEqual(first?.url.searchParams.getAll("stream"), ["orders", "payments"]);
    assert.deepEqual(first?.url.searchParams.getAll("type"), [EVENT.type]);
    assert.deepEqual(first?.url.searchParams.getAll("source"), [EVENT.source]);
    assert.equal(first?.url.searchParams.get("after"), "40");
    assert.equal(first?.url.searchParams.get("limit"), "2");
    assert.equal(first?.init?.signal, controller.signal);
    assert.equal(header(first, "accept"), "application/json");
    assert.equal(requests.calls[1]?.url.search, "");
  });

  it("exposes typed problem errors without retaining request credentials", async () => {
    const requests = createFetch([
      jsonResponse(
        {
          code: "cursor_expired",
          detail: "The cursor is older than the retained event window",
          request_id: "req-problem",
        },
        410,
      ),
      new Response("not-json", { status: 502, headers: { "x-request-id": "req-header" } }),
      new Response("[]", { status: 500 }),
    ]);
    const client = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "do-not-leak",
      fetch: requests.fetch,
    });

    await assert.rejects(client.list(), (error: unknown) => {
      assert.ok(error instanceof EventHubApiError);
      assert.equal(error.status, 410);
      assert.equal(error.code, "cursor_expired");
      assert.equal(error.requestId, "req-problem");
      assert.equal(error.message, "The cursor is older than the retained event window");
      assert.doesNotMatch(JSON.stringify(error), /do-not-leak/);
      return true;
    });
    await assert.rejects(client.list(), (error: unknown) => {
      assert.ok(error instanceof EventHubApiError);
      assert.equal(error.status, 502);
      assert.equal(error.code, undefined);
      assert.equal(error.requestId, "req-header");
      assert.equal(error.message, "EventHub request failed with HTTP 502");
      return true;
    });
    await assert.rejects(client.list(), (error: unknown) => {
      assert.ok(error instanceof EventHubApiError);
      assert.equal(error.status, 500);
      assert.equal(error.problem, undefined);
      return true;
    });
  });

  it("parses incremental SSE frames and sends the initial cursor in both reconnection forms", async () => {
    const controller = new AbortController();
    const frame = sseFrame(EVENT);
    const requests = createFetch([
      sseResponse([
        "retry: invalid\n\nretry: 99999999999999999\n\nid: ignored\u0000\n\nfield-without-value\n\n",
        ": keepalive\n\nretry: 0\r\nunknown: value\r\n\r\n",
        frame.slice(0, 13),
        frame.slice(13),
      ]),
    ]);
    const client = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: requests.fetch,
    });
    const iterator = client.subscribe({
      after: "41",
      stream: "orders",
      signal: controller.signal,
      reconnectDelayMs: 0,
    });

    assert.deepEqual((await iterator.next()).value, EVENT);
    controller.abort();
    assert.equal((await iterator.next()).done, true);
    assert.equal(requests.calls.length, 1);
    assert.equal(requests.calls[0]?.url.searchParams.get("after"), "41");
    assert.equal(requests.calls[0]?.url.searchParams.get("stream"), "orders");
    assert.equal(header(requests.calls[0], "last-event-id"), "41");
    assert.equal(header(requests.calls[0], "accept"), "text/event-stream");
  });

  it("reconnects after transient network and server failures", async () => {
    const noSignalRequests = createFetch([
      new Error("connection reset without a signal"),
      sseResponse([sseFrame(EVENT)]),
    ]);
    const noSignalClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: noSignalRequests.fetch,
    });
    const noSignalIterator = noSignalClient.subscribe({ reconnectDelayMs: 0 });
    assert.deepEqual((await noSignalIterator.next()).value, EVENT);
    await noSignalIterator.return(undefined);
    assert.equal(noSignalRequests.calls.length, 2);

    const networkController = new AbortController();
    const networkRequests = createFetch([
      new Error("connection reset"),
      sseResponse([sseFrame(EVENT)]),
    ]);
    const networkClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: networkRequests.fetch,
    });
    const networkIterator = networkClient.subscribe({
      after: "0",
      signal: networkController.signal,
      reconnectDelayMs: 0,
    });
    assert.deepEqual((await networkIterator.next()).value, EVENT);
    networkController.abort();
    assert.equal((await networkIterator.next()).done, true);
    assert.equal(networkRequests.calls.length, 2);

    const serverController = new AbortController();
    const serverRequests = createFetch([
      new Response("{}", { status: 503 }),
      sseResponse([sseFrame(EVENT)]),
    ]);
    const serverClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: serverRequests.fetch,
    });
    const serverIterator = serverClient.subscribe({
      signal: serverController.signal,
      reconnectDelayMs: 0,
    });
    assert.deepEqual((await serverIterator.next()).value, EVENT);
    serverController.abort();
    assert.equal((await serverIterator.next()).done, true);
    assert.equal(serverRequests.calls.length, 2);
  });

  it("stops reconnecting when a signal is already or becomes aborted", async () => {
    const alreadyAborted = new AbortController();
    const alreadyAbortedClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: (async () => {
        alreadyAborted.abort();
        throw new Error("connection reset");
      }) as FetchLike,
    });
    assert.equal(
      (await alreadyAbortedClient.subscribe({ signal: alreadyAborted.signal }).next()).done,
      true,
    );

    const controller = new AbortController();
    const delayedAbortClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: (async () => {
        setTimeout(() => controller.abort(), 0);
        throw new Error("connection reset");
      }) as FetchLike,
    });
    assert.equal(
      (await delayedAbortClient.subscribe({ signal: controller.signal, reconnectDelayMs: 60_000 }).next())
        .done,
      true,
    );
  });

  it("reconnects when a live SSE response fails while being read", async () => {
    const controller = new AbortController();
    const requests = createFetch([
      failingSseResponse(),
      sseResponse([sseFrame(EVENT)]),
    ]);
    const client = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: requests.fetch,
    });
    const iterator = client.subscribe({ signal: controller.signal, reconnectDelayMs: 0 });

    assert.deepEqual((await iterator.next()).value, EVENT);
    controller.abort();
    assert.equal((await iterator.next()).done, true);
    assert.equal(requests.calls.length, 2);
  });

  it("reconnects from the last delivered SSE id after a completed response", async () => {
    const controller = new AbortController();
    const requests = createFetch([
      sseResponse([sseFrame(EVENT)]),
      () => {
        controller.abort();
        return sseResponse([]);
      },
    ]);
    const client = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: requests.fetch,
    });
    const iterator = client.subscribe({ signal: controller.signal, reconnectDelayMs: 0 });

    assert.deepEqual((await iterator.next()).value, EVENT);
    assert.equal((await iterator.next()).done, true);
    assert.equal(requests.calls.length, 2);
    assert.equal(requests.calls[1]?.url.searchParams.get("after"), "42");
    assert.equal(header(requests.calls[1], "last-event-id"), "42");
  });

  it("does not retry terminal API and protocol failures", async () => {
    const expiredRequests = createFetch([
      jsonResponse({ code: "cursor_expired", detail: "expired" }, 410),
    ]);
    const expiredClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: expiredRequests.fetch,
    });
    await assert.rejects(expiredClient.subscribe({ reconnectDelayMs: 0 }).next(), (error: unknown) => {
      assert.ok(error instanceof EventHubApiError);
      assert.equal(error.status, 410);
      return true;
    });
    assert.equal(expiredRequests.calls.length, 1);

    const emptyErrorRequests = createFetch([new Response("", { status: 401 })]);
    const emptyErrorClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: emptyErrorRequests.fetch,
    });
    await assert.rejects(emptyErrorClient.subscribe({ reconnectDelayMs: 0 }).next(), EventHubApiError);

    const noBodyRequests = createFetch([
      new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const noBodyClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: noBodyRequests.fetch,
    });
    await assert.rejects(noBodyClient.subscribe({ reconnectDelayMs: 0 }).next(), EventHubProtocolError);

    const missingContentTypeRequests = createFetch([new Response(null, { status: 200 })]);
    const missingContentTypeClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: missingContentTypeRequests.fetch,
    });
    await assert.rejects(
      missingContentTypeClient.subscribe({ reconnectDelayMs: 0 }).next(),
      EventHubProtocolError,
    );

    const incorrectContentTypeRequests = createFetch([
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const incorrectContentTypeClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: incorrectContentTypeRequests.fetch,
    });
    await assert.rejects(
      incorrectContentTypeClient.subscribe({ reconnectDelayMs: 0 }).next(),
      EventHubProtocolError,
    );
  });

  it("rejects malformed SSE business frames", async () => {
    const malformedFrames = [
      "id: 42\nevent: com.example.order.created.v1\ndata: not-json\n\n",
      "id: 42\nevent: com.example.order.created.v1\ndata: []\n\n",
      `event: ${EVENT.type}\ndata: ${JSON.stringify(EVENT)}\n\n`,
      `id:\nevent: ${EVENT.type}\ndata: ${JSON.stringify(EVENT)}\n\n`,
      `id: 42\ndata: ${JSON.stringify(EVENT)}\n\n`,
      `id: 42\nevent:\ndata: ${JSON.stringify(EVENT)}\n\n`,
      `id: 42\nevent: ${EVENT.type}\ndata: ${JSON.stringify({
        ...EVENT,
        eventhuboffset: undefined,
      })}\n\n`,
      `id: 42\nevent: ${EVENT.type}\ndata: ${JSON.stringify({
        ...EVENT,
        eventhuboffset: "",
      })}\n\n`,
      `id: 42\nevent: ${EVENT.type}\ndata: ${JSON.stringify({
        ...EVENT,
        type: undefined,
      })}\n\n`,
      `id: 42\nevent: ${EVENT.type}\ndata: ${JSON.stringify({
        ...EVENT,
        type: "",
      })}\n\n`,
      `id: 41\nevent: ${EVENT.type}\ndata: ${JSON.stringify(EVENT)}\n\n`,
      `id: 42\nevent: other.type\ndata: ${JSON.stringify(EVENT)}\n\n`,
      `id: 42\nevent: ${EVENT.type}\ndata: ${JSON.stringify({
        ...EVENT,
        eventhubreceivedat: undefined,
      })}\n\n`,
    ];

    for (const frame of malformedFrames) {
      const requests = createFetch([sseResponse([frame])]);
      const client = new EventHubClient({
        baseUrl: "https://events.example.test",
        apiKey: "read-secret",
        fetch: requests.fetch,
      });
      await assert.rejects(client.subscribe({ reconnectDelayMs: 0 }).next(), EventHubProtocolError);
    }
  });

  it("persists a consumer cursor only after the event callback succeeds", async () => {
    const controller = new AbortController();
    const store = new RecordingCursorStore();
    const requests = createFetch([sseResponse([sseFrame(EVENT)])]);
    const client = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: requests.fetch,
    });

    await client.consume({
      cursorStore: store,
      stream: ["orders"],
      type: EVENT.type,
      source: EVENT.source,
      signal: controller.signal,
      reconnectDelayMs: 0,
      onEvent: async (event) => {
        assert.equal(event.eventhuboffset, "42");
        controller.abort();
      },
    });

    assert.deepEqual(store.saved, ["42"]);
    assert.equal(requests.calls[0]?.url.searchParams.get("after"), "0");
    assert.equal(header(requests.calls[0], "last-event-id"), "0");
    assert.deepEqual(requests.calls[0]?.url.searchParams.getAll("stream"), ["orders"]);
  });

  it("uses a saved cursor in preference to initialCursor and leaves it unchanged after failures", async () => {
    const store = new RecordingCursorStore("40");
    const requests = createFetch([sseResponse([sseFrame(EVENT)])]);
    const client = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: requests.fetch,
    });

    await assert.rejects(
      client.consume({
        cursorStore: store,
        initialCursor: "5",
        onEvent: () => {
          throw new Error("business write failed");
        },
      }),
      /business write failed/,
    );
    assert.deepEqual(store.saved, []);
    assert.equal(requests.calls[0]?.url.searchParams.get("after"), "40");

    const initialRequests = createFetch([
      () => {
        return new Response(null, { status: 200 });
      },
    ]);
    const initialClient = new EventHubClient({
      baseUrl: "https://events.example.test",
      apiKey: "read-secret",
      fetch: initialRequests.fetch,
    });
    await assert.rejects(
      initialClient.consume({
        cursorStore: new RecordingCursorStore(),
        initialCursor: "5",
        onEvent: () => undefined,
      }),
      EventHubProtocolError,
    );
    assert.equal(initialRequests.calls[0]?.url.searchParams.get("after"), "5");
  });
});

interface FetchCall {
  readonly url: URL;
  readonly init: RequestInit | undefined;
}

type FetchStep = Response | Error | (() => Response | Promise<Response>);

function createFetch(steps: readonly FetchStep[]): {
  readonly calls: FetchCall[];
  readonly fetch: FetchLike;
} {
  const pending = [...steps];
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    const step = pending.shift();
    assert.ok(step !== undefined, "unexpected fetch call");
    if (step instanceof Error) {
      throw step;
    }
    return typeof step === "function" ? await step() : step;
  };
  return { calls, fetch };
}

function requestUrl(input: Parameters<FetchLike>[0]): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return new URL(input.url);
}

function header(call: FetchCall | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function pageResponse(): {
  readonly events: readonly EventHubEvent[];
  readonly page: {
    readonly after: string;
    readonly next_after: string;
    readonly head_offset: string;
    readonly minimum_available_offset: string;
    readonly has_more: boolean;
  };
} {
  return {
    events: [EVENT],
    page: {
      after: "40",
      next_after: "42",
      head_offset: "42",
      minimum_available_offset: "1",
      has_more: false,
    },
  };
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "Text/Event-Stream; charset=utf-8" } },
  );
}

function failingSseResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("SSE socket failed"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function sseFrame(event: EventHubEvent): string {
  return `id: ${event.eventhuboffset}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

class RecordingCursorStore implements CursorStore {
  public readonly saved: string[] = [];
  readonly #initial: string | undefined;

  public constructor(initial?: string) {
    this.#initial = initial;
  }

  public async load(): Promise<string | undefined> {
    return this.#initial;
  }

  public async save(cursor: string): Promise<void> {
    this.saved.push(cursor);
  }
}
