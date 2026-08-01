import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;

export interface VerifyWebhookSignatureInput {
  readonly secret: string;
  readonly rawBody: Buffer;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly connectionId: string;
  readonly maximumClockSkewSeconds: number;
  readonly now?: Date;
}

export function createWebhookSignature(
  secret: string,
  timestamp: string,
  connectionId: string,
  rawBody: Buffer,
): string {
  const digest = createHmac("sha256", secret)
    .update(timestamp, "utf8")
    .update(".", "utf8")
    .update(connectionId, "utf8")
    .update(".", "utf8")
    .update(rawBody)
    .digest("hex");
  return `v1=${digest}`;
}

export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): void {
  if (input.timestamp === undefined || !/^\d+$/.test(input.timestamp)) {
    throw new WebhookSignatureError("X-EventHub-Timestamp must be a Unix timestamp");
  }
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    throw new WebhookSignatureError("X-EventHub-Timestamp is invalid");
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > input.maximumClockSkewSeconds) {
    throw new WebhookSignatureError("Webhook timestamp is outside the allowed clock skew");
  }

  const match = input.signature === undefined ? null : SIGNATURE_PATTERN.exec(input.signature);
  if (match?.[1] === undefined) {
    throw new WebhookSignatureError("X-EventHub-Signature must use v1=<lowercase-hex>");
  }

  const expected = createWebhookSignature(
    input.secret,
    input.timestamp,
    input.connectionId,
    input.rawBody,
  );
  const expectedBuffer = Buffer.from(expected, "ascii");
  const providedBuffer = Buffer.from(`v1=${match[1]}`, "ascii");
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw new WebhookSignatureError("Webhook signature is invalid");
  }
}

export class WebhookSignatureError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}
