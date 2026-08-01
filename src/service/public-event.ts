import type { CloudEvent } from "../domain/cloud-event.js";
import type { StoredEvent } from "./event-store.js";

export function toPublicCloudEvent(stored: StoredEvent): CloudEvent {
  return {
    ...stored.event,
    eventhubstream: stored.stream,
    eventhuboffset: stored.offset.toString(),
    eventhubreceivedat: stored.receivedAt.toISOString(),
  };
}
