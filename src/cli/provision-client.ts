import { fileURLToPath } from "node:url";

import {
  provisionApiClient,
  type ApiClientScope,
  type ProvisionApiClientInput,
  type ProvisionedApiClient,
} from "../db/api-clients.js";
import { closePool, createPool } from "../db/pool.js";
import { createDatabase } from "../db/database.js";
import { loadConfig, loadLocalEnvironment } from "../config.js";

export function parseProvisionClientArgs(argv: readonly string[]): ProvisionApiClientInput {
  let tenantId: string | undefined;
  let name: string | undefined;
  const scopes: ApiClientScope[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(`${argument} requires a value`);
    }
    switch (argument) {
      case "--tenant-id":
        if (tenantId !== undefined) {
          throw new TypeError("--tenant-id may be supplied only once");
        }
        tenantId = value;
        break;
      case "--name":
        if (name !== undefined) {
          throw new TypeError("--name may be supplied only once");
        }
        name = value;
        break;
      case "--scope":
        scopes.push(value as ApiClientScope);
        break;
      default:
        throw new TypeError(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (tenantId === undefined) {
    throw new TypeError("--tenant-id is required");
  }
  if (name === undefined) {
    throw new TypeError("--name is required");
  }
  return { tenantId, name, scopes };
}

export function formatProvisionedApiClient(client: ProvisionedApiClient): string {
  return `${JSON.stringify({
    tenant_id: client.tenantId,
    client_id: client.id,
    name: client.name,
    key_prefix: client.keyPrefix,
    scopes: client.scopes,
    api_key: client.apiKey,
  })}\n`;
}

export async function runProvisionClientCli(argv: readonly string[]): Promise<void> {
  const input = parseProvisionClientArgs(argv);
  loadLocalEnvironment();
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
  });
  try {
    const client = await provisionApiClient(input, createDatabase(pool));
    process.stdout.write(formatProvisionedApiClient(client));
  } finally {
    await closePool(pool);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runProvisionClientCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provisioning error";
    process.stderr.write(`Failed to provision API client: ${message}\n`);
    process.exitCode = 1;
  }
}
