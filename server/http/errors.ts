export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ENTITY_UNKNOWN"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "VALIDATION_ERROR"
  | "CONFIG_INVALID"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ENTITY_UNKNOWN: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 422,
  CONFIG_INVALID: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code];
}

/** Expected failures throw this; the pipeline turns it into a structured envelope. */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}
