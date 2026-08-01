import { EventHubApiError, EventHubProtocolError, type EventHubProblem } from "./errors.js";

/** A JSON value accepted by the EventHub CloudEvents API. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** EventHub offsets are decimal strings and must be treated as opaque cursors. */
export type EventHubCursor = string;

export interface PublishableEvent {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly datacontenttype: string;
  readonly eventhubstream: string;
  readonly subject?: string;
  readonly time?: string;
  readonly dataschema?: string;
  readonly data: JsonValue;
  readonly [attribute: string]: JsonValue | undefined;
}

export interface EventHubEvent extends PublishableEvent {
  readonly eventhuboffset: EventHubCursor;
  readonly eventhubreceivedat: string;
}

export interface EventFilters {
  readonly stream?: string | readonly string[];
  readonly type?: string | readonly string[];
  readonly source?: string | readonly string[];
}

export interface ListEventsOptions extends EventFilters {
  readonly after?: EventHubCursor;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface EventPage {
  readonly events: readonly EventHubEvent[];
  readonly page: {
    readonly after: EventHubCursor;
    readonly next_after: EventHubCursor;
    readonly head_offset: EventHubCursor;
    readonly minimum_available_offset: EventHubCursor;
    readonly has_more: boolean;
  };
}

export interface PublishOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface PublishResult {
  readonly event: EventHubEvent;
  readonly idempotentReplay: boolean;
  readonly location: string | undefined;
  readonly requestId: string | undefined;
}

export interface SubscribeOptions extends EventFilters {
  /**
   * The exclusive initial cursor. When omitted, EventHub starts at the head at
   * connection time, matching the server SSE contract.
   */
  readonly after?: EventHubCursor;
  readonly signal?: AbortSignal;
  /** Delay used until the server sends an SSE `retry` control field. */
  readonly reconnectDelayMs?: number;
}

export interface CursorStore {
  load(): Promise<EventHubCursor | undefined>;
  save(cursor: EventHubCursor): Promise<void>;
}

export interface ConsumeOptions extends Omit<SubscribeOptions, "after"> {
  readonly cursorStore: CursorStore;
  readonly onEvent: (event: EventHubEvent) => Promise<void> | void;
  /** Used for a new store. Defaults to `"0"` so retained events are replayed. */
  readonly initialCursor?: EventHubCursor;
}

export type FetchLike = typeof globalThis.fetch;

export interface EventHubClientOptions {
  /** EventHub origin or a path prefix, for example `https://events.example.com/`. */
  readonly baseUrl: string | URL;
  readonly apiKey: string;
  readonly fetch?: FetchLike;
}

const DEFAULT_RECONNECT_DELAY_MS = 3_000;

export class EventHubClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;

  public constructor(options: EventHubClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async publish(
    event: PublishableEvent,
    options: PublishOptions = {},
  ): Promise<PublishResult> {
    const headers = this.#headers("application/cloudevents+json");
    headers.set("Content-Type", "application/cloudevents+json");
    if (options.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    }
    const response = await this.#request(this.#endpoint("v1/events"), {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      event: (await response.json()) as EventHubEvent,
      idempotentReplay: response.headers.get("idempotent-replayed") === "true",
      location: response.headers.get("location") ?? undefined,
      requestId: response.headers.get("x-request-id") ?? undefined,
    };
  }

  public async list(options: ListEventsOptions = {}): Promise<EventPage> {
    const url = this.#endpoint("v1/events");
    appendOptional(url.searchParams, "after", options.after);
    appendOptional(url.searchParams, "limit", options.limit);
    appendFilters(url.searchParams, options);
    const response = await this.#request(url, {
      method: "GET",
      headers: this.#headers("application/json"),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return (await response.json()) as EventPage;
  }

  /**
   * Opens a resilient Server-Sent Events subscription. It reconnects from the
   * last received EventHub offset after transient network and 5xx failures.
   */
  public async *subscribe(
    options: SubscribeOptions = {},
  ): AsyncGenerator<EventHubEvent, void, undefined> {
    let cursor = options.after;
    let reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

    while (options.signal?.aborted !== true) {
      let response: Response;
      try {
        response = await this.#openStream(options, cursor);
      } catch (error) {
        if (!shouldReconnect(error)) {
          throw error;
        }
        if (!(await waitForReconnect(reconnectDelayMs, options.signal))) {
          return;
        }
        continue;
      }

      try {
        if (response.body === null) {
          throw new EventHubProtocolError("EventHub returned an SSE response without a body");
        }
        for await (const frame of readSseFrames(response.body, options.signal)) {
          if (frame.retry !== undefined) {
            reconnectDelayMs = frame.retry;
          }
          const event = eventFromSseFrame(frame);
          if (event === undefined) {
            continue;
          }
          cursor = event.eventhuboffset;
          yield event;
        }
      } catch (error) {
        if (!shouldReconnect(error)) {
          throw error;
        }
      }

      if (!(await waitForReconnect(reconnectDelayMs, options.signal))) {
        return;
      }
    }
  }

  /**
   * Processes events and advances the cursor only after `onEvent` succeeds.
   * A fresh store begins at `initialCursor` or the retained-log sentinel `0`.
   */
  public async consume(options: ConsumeOptions): Promise<void> {
    const savedCursor = await options.cursorStore.load();
    const after = savedCursor ?? options.initialCursor ?? "0";
    const subscriptionOptions: SubscribeOptions = {
      ...(options.stream === undefined ? {} : { stream: options.stream }),
      ...(options.type === undefined ? {} : { type: options.type }),
      ...(options.source === undefined ? {} : { source: options.source }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.reconnectDelayMs === undefined
        ? {}
        : { reconnectDelayMs: options.reconnectDelayMs }),
      after,
    };
    for await (const event of this.subscribe(subscriptionOptions)) {
      await options.onEvent(event);
      await options.cursorStore.save(event.eventhuboffset);
    }
  }

  async #openStream(options: SubscribeOptions, cursor: EventHubCursor | undefined): Promise<Response> {
    const url = this.#endpoint("v1/events/stream");
    appendOptional(url.searchParams, "after", cursor);
    appendFilters(url.searchParams, options);
    const headers = this.#headers("text/event-stream");
    if (cursor !== undefined) {
      headers.set("Last-Event-ID", cursor);
    }
    const response = await this.#request(url, {
      method: "GET",
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!isSseContentType(response.headers.get("content-type"))) {
      throw new EventHubProtocolError("EventHub returned a stream response with an invalid Content-Type");
    }
    return response;
  }

  async #request(url: URL, init: RequestInit): Promise<Response> {
    const response = await this.#fetch(url, init);
    if (!response.ok) {
      throw await toApiError(response);
    }
    return response;
  }

  #endpoint(path: string): URL {
    return new URL(path, this.#baseUrl);
  }

  #headers(accept: string): Headers {
    return new Headers({
      Accept: accept,
      Authorization: `Bearer ${this.#apiKey}`,
    });
  }
}

interface SseFrame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string | undefined;
  readonly retry: number | undefined;
}

function normalizeBaseUrl(baseUrl: string | URL): URL {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function appendOptional(
  parameters: URLSearchParams,
  name: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) {
    parameters.append(name, String(value));
  }
}

function appendFilters(parameters: URLSearchParams, filters: EventFilters): void {
  appendFilter(parameters, "stream", filters.stream);
  appendFilter(parameters, "type", filters.type);
  appendFilter(parameters, "source", filters.source);
}

function appendFilter(
  parameters: URLSearchParams,
  name: "stream" | "type" | "source",
  value: string | readonly string[] | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    parameters.append(name, value);
    return;
  }
  for (const item of value) {
    parameters.append(name, item);
  }
}

function isSseContentType(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  return value.split(";", 1)[0]!.trim().toLowerCase() === "text/event-stream";
}

function shouldReconnect(error: unknown): boolean {
  return !(error instanceof EventHubProtocolError) &&
    !(error instanceof EventHubApiError && error.status < 500);
}

async function waitForReconnect(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal === undefined) {
    await delay(delayMs);
    return true;
  }
  if (signal.aborted) {
    return false;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    while (signal?.aborted !== true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      let nextFrame = takeSseFrame(buffer);
      while (nextFrame !== undefined) {
        buffer = nextFrame.remaining;
        yield parseSseFrame(nextFrame.value);
        nextFrame = takeSseFrame(buffer);
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function takeSseFrame(buffer: string): { readonly value: string; readonly remaining: string } | undefined {
  const boundary = /\r?\n\r?\n/.exec(buffer);
  if (boundary === null) {
    return undefined;
  }
  return {
    value: buffer.slice(0, boundary.index),
    remaining: buffer.slice(boundary.index + boundary[0].length),
  };
}

function parseSseFrame(value: string): SseFrame {
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const untrimmed = separator === -1 ? "" : line.slice(separator + 1);
    const fieldValue = untrimmed.startsWith(" ") ? untrimmed.slice(1) : untrimmed;

    switch (field) {
      case "data":
        data.push(fieldValue);
        break;
      case "id":
        if (!fieldValue.includes("\u0000")) {
          id = fieldValue;
        }
        break;
      case "event":
        event = fieldValue;
        break;
      case "retry": {
        const parsedRetry = parseRetry(fieldValue);
        if (parsedRetry !== undefined) {
          retry = parsedRetry;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    id,
    event,
    data: data.length === 0 ? undefined : data.join("\n"),
    retry,
  };
}

function parseRetry(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function eventFromSseFrame(frame: SseFrame): EventHubEvent | undefined {
  if (frame.data === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    throw new EventHubProtocolError("EventHub sent invalid JSON in an SSE data field");
  }
  if (!isRecord(parsed)) {
    throw new EventHubProtocolError("EventHub sent an SSE data field that is not an object");
  }
  const event = parsed as EventHubEvent;
  const frameId = requireNonEmptyString(frame.id, "SSE event id");
  const frameType = requireNonEmptyString(frame.event, "SSE event type");
  const offset = requireNonEmptyString(event.eventhuboffset, "eventhuboffset");
  const type = requireNonEmptyString(event.type, "CloudEvents type");
  if (offset !== frameId) {
    throw new EventHubProtocolError("SSE event id does not match eventhuboffset");
  }
  if (type !== frameType) {
    throw new EventHubProtocolError("SSE event type does not match CloudEvents type");
  }
  requireNonEmptyString(event.eventhubreceivedat, "eventhubreceivedat");
  return event;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new EventHubProtocolError(`SSE event is missing ${field}`);
  }
  return value;
}

async function toApiError(response: Response): Promise<EventHubApiError> {
  const body = parseProblem(await response.text());
  const detail = stringProperty(body, "detail") ?? `EventHub request failed with HTTP ${response.status}`;
  const requestId =
    stringProperty(body, "request_id") ?? response.headers.get("x-request-id") ?? undefined;
  return new EventHubApiError({
    status: response.status,
    message: detail,
    code: stringProperty(body, "code"),
    requestId,
    problem: body,
  });
}

function parseProblem(value: string): EventHubProblem | undefined {
  if (value === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringProperty(
  value: EventHubProblem | undefined,
  property: "code" | "detail" | "request_id",
): string | undefined {
  const candidate = value?.[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
