import { EventEmitter } from "node:events";
import type { Notification, Pool, PoolClient } from "pg";

export type WakeReason = "notification" | "poll" | "aborted";

export interface EventNotifier {
  waitForTenant(tenantId: string, timeoutMs: number, signal?: AbortSignal): Promise<WakeReason>;
}

export interface NotifierLogger {
  info(properties: object, message: string): void;
  warn(properties: object, message: string): void;
  error(properties: object, message: string): void;
}

interface ListenerConnection {
  readonly client: PoolClient;
  readonly onNotification: (notification: Notification) => void;
  readonly onError: (error: Error) => void;
  readonly onEnd: () => void;
}

const CHANNEL = "eventhub_events";
const GLOBAL_EVENT = "eventhub:all";

export class PostgresNotifier implements EventNotifier {
  readonly #events = new EventEmitter();
  readonly #pool: Pool;
  readonly #logger: NotifierLogger;
  readonly #reconnectDelayMs: number;
  #connection: ListenerConnection | undefined;
  #connecting: Promise<void> | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #stopped = true;

  public constructor(pool: Pool, logger: NotifierLogger, reconnectDelayMs = 1000) {
    this.#pool = pool;
    this.#logger = logger;
    this.#reconnectDelayMs = reconnectDelayMs;
    this.#events.setMaxListeners(0);
  }

  public async start(): Promise<void> {
    if (!this.#stopped) {
      await this.#ensureConnected();
      return;
    }
    this.#stopped = false;
    try {
      await this.#ensureConnected();
    } catch (error) {
      this.#stopped = true;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    await this.#connecting?.catch(() => undefined);

    const connection = this.#connection;
    this.#connection = undefined;
    this.#events.removeAllListeners();
    if (connection === undefined) {
      return;
    }

    try {
      await connection.client.query(`UNLISTEN ${CHANNEL}`);
      this.#release(connection, false);
    } catch (error) {
      this.#release(connection, true);
      this.#logger.warn({ err: error }, "PostgreSQL notification listener cleanup failed");
    }
  }

  public waitForTenant(
    tenantId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WakeReason> {
    if (signal?.aborted === true) {
      return Promise.resolve("aborted");
    }

    return new Promise((resolve) => {
      const tenantEvent = tenantEventName(tenantId);

      const finish = (reason: WakeReason): void => {
        clearTimeout(timer);
        this.#events.off(tenantEvent, onNotification);
        this.#events.off(GLOBAL_EVENT, onNotification);
        signal?.removeEventListener("abort", onAbort);
        resolve(reason);
      };
      const onNotification = (): void => finish("notification");
      const onAbort = (): void => finish("aborted");
      const timer = setTimeout(() => finish("poll"), timeoutMs);
      timer.unref();

      this.#events.once(tenantEvent, onNotification);
      this.#events.once(GLOBAL_EVENT, onNotification);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #ensureConnected(): Promise<void> {
    if (this.#connection !== undefined) {
      return Promise.resolve();
    }
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    const client = await this.#pool.connect();
    let connection: ListenerConnection;
    connection = {
      client,
      onNotification: (notification) => this.#onNotification(notification),
      onError: (error) => this.#onConnectionFailure(connection, error),
      onEnd: () => this.#onConnectionFailure(connection),
    };
    client.on("notification", connection.onNotification);
    client.on("error", connection.onError);
    client.on("end", connection.onEnd);

    try {
      await client.query(`LISTEN ${CHANNEL}`);
      if (this.#stopped) {
        this.#release(connection, true);
        return;
      }
      this.#connection = connection;
      this.#logger.info({}, "PostgreSQL notification listener is ready");
      this.#events.emit(GLOBAL_EVENT);
    } catch (error) {
      this.#connection = undefined;
      this.#release(connection, true);
      throw error;
    }
  }

  #onConnectionFailure(connection: ListenerConnection, error?: Error): void {
    if (this.#connection !== connection) {
      return;
    }
    this.#connection = undefined;
    this.#release(connection, true);
    if (error !== undefined) {
      this.#logger.error({ err: error }, "PostgreSQL notification connection failed");
    }
    this.#scheduleReconnect();
  }

  #release(connection: ListenerConnection, destroy: boolean): void {
    connection.client.off("notification", connection.onNotification);
    connection.client.off("error", connection.onError);
    connection.client.off("end", connection.onEnd);
    connection.client.release(destroy);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) {
      return;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#ensureConnected().catch((error: unknown) => {
        this.#logger.warn({ err: error }, "PostgreSQL notification reconnect failed; polling remains active");
        this.#scheduleReconnect();
      });
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref();
  }

  #onNotification(notification: Notification): void {
    if (notification.channel !== CHANNEL) {
      return;
    }
    const tenantId = readTenantId(notification.payload);
    if (tenantId === undefined) {
      this.#events.emit(GLOBAL_EVENT);
      return;
    }
    this.#events.emit(tenantEventName(tenantId));
  }
}

function readTenantId(payload: string | undefined): string | undefined {
  if (payload === undefined || payload.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const value = (parsed as Record<string, unknown>).tenant_id;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function tenantEventName(tenantId: string): string {
  return `eventhub:tenant:${tenantId}`;
}
