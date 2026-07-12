export type TracksErrorCode =
  | "AUTH_REQUIRED"
  | "API_ERROR"
  | "INVALID_RESPONSE"
  | "INVALID_SOURCE"
  | "NOT_FOUND"
  | "TOOL_MISSING"
  | "TOOL_FAILED"
  | "NO_MATCHES";

export class TracksError extends Error {
  readonly code: TracksErrorCode;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    code: TracksErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; exitCode?: number; details?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "TracksError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.exitCode = options.exitCode ?? 1;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
