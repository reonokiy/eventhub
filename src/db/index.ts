export {
  closePool,
  createPool,
  getPool,
  setDefaultPool,
} from "./pool.js";
export { createDatabase, getDatabase, type Database } from "./database.js";
export {
  apiClients,
  events,
  publishIdempotencyKeys,
  sourceConnections,
  tenantHeads,
  tenants,
} from "./schema.js";
export {
  appendEvent,
  computeEnvelopeHash,
  CursorAheadError,
  EventIdentityConflictError,
  getEventByOffset,
  getTenantEventBounds,
  getTenantHighWaterMark,
  hashIdempotencyKey,
  IdempotencyKeyConflictError,
  listEvents,
  TenantNotFoundError,
} from "./events.js";
export { authenticateApiKey, authenticateApiKeyValue, verifyActiveApiKey } from "./auth.js";
export {
  ApiClientNotFoundError,
  ApiClientNameConflictError,
  ApiClientProvisioningValidationError,
  generateApiKey,
  listApiClients,
  provisionApiClient,
  revokeApiClient,
  rotateApiClient,
  validateApiClientManagementInput,
  validateProvisionApiClientInput,
} from "./api-clients.js";
export type {
  AdminApiClient,
  AdminProvisionedApiClient,
  ApiClientManagementInput,
  ApiClientScope,
  ProvisionApiClientInput,
  ProvisionedApiClient,
  RevokeApiClientInput,
  RotatedApiClient,
  RotateApiClientInput,
} from "./api-clients.js";
export {
  createTenant,
  listTenants,
  TenantManagementValidationError,
  TenantSlugConflictError,
  validateCreateTenantInput,
} from "./tenants.js";
export type { AdminTenant, CreateTenantInput } from "./tenants.js";
export { getSourceConnection } from "./connections.js";
export { ensureBootstrapTenantAndClient } from "./bootstrap.js";
export type {
  ApiClientPrincipal,
  AppendEventInput,
  AppendEventResult,
  BootstrapOptions,
  BootstrapResult,
  BootstrapWebhookConnection,
  EventPage,
  EventReplayReason,
  JsonObject,
  ListEventsInput,
  OffsetInput,
  PublishIdempotency,
  SourceConnection,
  StoredEvent,
  TenantEventBounds,
} from "./types.js";
