import { AppError, httpStatusFor } from "./errors";
import { logError } from "./logger";

export function ok<T>(
  data: T,
  init: { status?: number; meta?: Record<string, unknown>; requestId: string },
): Response {
  return Response.json(
    {
      ok: true,
      data,
      ...(init.meta ? { meta: init.meta } : {}),
      requestId: init.requestId,
    },
    { status: init.status ?? 200 },
  );
}

export function fail(err: unknown, requestId: string): Response {
  const appError =
    err instanceof AppError ? err : new AppError("INTERNAL", "Unexpected server error");

  // Genuine faults are logged in full server-side and never leaked to the client.
  if (!(err instanceof AppError)) {
    logError({ requestId, error: err });
  }

  return Response.json(
    {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details !== undefined ? { details: appError.details } : {}),
      },
      requestId,
    },
    { status: httpStatusFor(appError.code) },
  );
}
