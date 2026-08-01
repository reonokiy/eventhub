export interface EventHubProblem {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly code?: string;
  readonly detail?: string;
  readonly request_id?: string;
  readonly errors?: readonly string[];
  readonly [extension: string]: unknown;
}

export class EventHubApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly requestId: string | undefined;
  public readonly problem: EventHubProblem | undefined;

  public constructor(input: {
    readonly status: number;
    readonly message: string;
    readonly code: string | undefined;
    readonly requestId: string | undefined;
    readonly problem: EventHubProblem | undefined;
  }) {
    super(input.message);
    this.name = "EventHubApiError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.problem = input.problem;
  }
}

export class EventHubProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EventHubProtocolError";
  }
}
