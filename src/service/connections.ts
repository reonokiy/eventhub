export interface SourceConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly stream: string;
  readonly signingSecret?: string;
}

export interface SourceConnectionStore {
  findActiveConnection(provider: string, connectionId: string): Promise<SourceConnection | undefined>;
}
