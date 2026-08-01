import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  assertPublishableCloudEvent,
  CloudEventValidationError,
  type CloudEvent,
} from "../../domain/cloud-event.js";
import { canonicalJsonSha256 } from "../../domain/canonical-json.js";
import { isJsonObject, type JsonValue } from "../../domain/json.js";
import {
  verifyWebhookSignature,
  WebhookSignatureError,
} from "../../security/webhook-signature.js";
import type { SourceConnectionStore } from "../../service/connections.js";
import type { EventStore } from "../../service/event-store.js";
import { toPublicCloudEvent } from "../../service/public-event.js";
import { requireContentType } from "../content-type.js";
import { HttpError } from "../errors.js";
import { firstHeader } from "../query.js";
import { parseJsonBody } from "../raw-body.js";

export interface WebhookRouteDependencies {
  readonly config: AppConfig;
  readonly eventStore: EventStore;
  readonly connectionStore: SourceConnectionStore;
}

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function registerWebhookRoutes(
  app: FastifyInstance,
  dependencies: WebhookRouteDependencies,
): void {
  app.post("/v1/webhooks/:provider/:connectionId", async (request, reply) => {
    const parameters = request.params as { provider?: unknown; connectionId?: unknown };
    const provider = parameters.provider;
    const connectionId = parameters.connectionId;
    if (
      typeof provider !== "string" ||
      !PROVIDER_PATTERN.test(provider) ||
      typeof connectionId !== "string"
    ) {
      throw new HttpError(404, "connection_not_found", "Webhook connection was not found");
    }
    if (provider !== "hmac") {
      throw new HttpError(404, "connection_not_found", "Webhook connection was not found");
    }

    requireContentType(request.headers["content-type"], "application/json");
    const connection = await dependencies.connectionStore.findActiveConnection(
      provider,
      connectionId,
    );
    if (connection?.signingSecret === undefined || request.rawBody === undefined) {
      throw new HttpError(404, "connection_not_found", "Webhook connection was not found");
    }

    try {
      verifyWebhookSignature({
        secret: connection.signingSecret,
        rawBody: request.rawBody,
        timestamp: firstHeader(request.headers["x-eventhub-timestamp"]),
        signature: firstHeader(request.headers["x-eventhub-signature"]),
        connectionId: connection.id,
        maximumClockSkewSeconds: dependencies.config.webhookMaxClockSkewSeconds,
      });
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        throw new HttpError(401, "invalid_signature", error.message);
      }
      throw error;
    }

    const event = parseHmacWebhookEvent(request.body, provider, connection.id, connection.stream);
    const requestHash = canonicalJsonSha256(event as JsonValue);
    const result = await dependencies.eventStore.append({
      tenantId: connection.tenantId,
      event,
      requestHash,
    });
    if (result.status === "identity_conflict") {
      throw new HttpError(
        409,
        "event_identity_conflict",
        "The provider event identity is already stored with a different payload",
      );
    }
    if (result.status === "idempotency_conflict" || result.storedEvent === undefined) {
      throw new Error(`Unexpected webhook append result: ${result.status}`);
    }

    reply
      .code(result.status === "inserted" ? 202 : 200)
      .header("Content-Type", "application/cloudevents+json; charset=utf-8");
    return toPublicCloudEvent(result.storedEvent);
  });
}

function parseHmacWebhookEvent(
  rawBody: unknown,
  provider: string,
  connectionId: string,
  stream: string,
): CloudEvent {
  try {
    const payload = parseJsonBody(rawBody);
    if (!isJsonObject(payload)) {
      throw new Error("Webhook body must be a JSON object");
    }
    const allowed = new Set(["id", "type", "subject", "time", "data"]);
    const unknown = Object.keys(payload).find((name) => !allowed.has(name));
    if (unknown !== undefined) {
      throw new Error(`Webhook body contains an unknown field: ${unknown}`);
    }
    if (!("data" in payload)) {
      throw new Error("Webhook body must contain data");
    }
    return assertPublishableCloudEvent({
      specversion: "1.0",
      id: payload.id,
      source: `urn:eventhub:${provider}:${connectionId}`,
      type: payload.type,
      ...(payload.subject === undefined ? {} : { subject: payload.subject }),
      ...(payload.time === undefined ? {} : { time: payload.time }),
      datacontenttype: "application/json",
      eventhubstream: stream,
      data: payload.data,
    });
  } catch (error) {
    throw mapHmacWebhookError(error);
  }
}

export function mapHmacWebhookError(error: unknown): HttpError {
  if (error instanceof SyntaxError) {
    return new HttpError(400, "invalid_webhook", "Webhook body must contain valid UTF-8 JSON");
  }
  if (error instanceof CloudEventValidationError) {
    return new HttpError(
      400,
      "invalid_webhook",
      error.validationErrors[0] ?? "Webhook event metadata is invalid",
      error.validationErrors,
    );
  }
  if (error instanceof Error) {
    return new HttpError(400, "invalid_webhook", error.message);
  }
  throw error;
}
