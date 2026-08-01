export interface ApiErrorBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly request_id: string;
  readonly errors?: readonly string[];
  readonly [extension: string]: unknown;
}

export class HttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: readonly string[],
    public readonly metadata?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "HttpError";
  }

  public toBody(requestId: string): ApiErrorBody {
    return {
      type: `https://eventhub.local/problems/${this.code.replaceAll("_", "-")}`,
      title: titleFromCode(this.code),
      status: this.statusCode,
      code: this.code,
      detail: this.message,
      request_id: requestId,
      ...(this.details === undefined ? {} : { errors: this.details }),
      ...this.metadata,
    };
  }
}

function titleFromCode(code: string): string {
  const words = code.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
