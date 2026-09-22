/** An error with an HTTP status and a stable machine-readable code (domain-model error shape). */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: details ? { code, message, details } : { code, message } };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}