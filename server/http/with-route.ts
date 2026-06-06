import { AppError } from "./errors";
import { fail } from "./envelope";
import { logRequest } from "./logger";
import { MAX_BODY_BYTES } from "./limits";
import { enforceRateLimit } from "./rate-limit";
import { getOwnerContext } from "@/server/auth/context";
import { resolveRequestId } from "@/lib/ids";

interface BaseContext {
  requestId: string;
  params: Record<string, string | string[]>;
}

/** Context for authed routes — `ownerId` is guaranteed non-null by the pipeline. */
export interface AuthedContext extends BaseContext {
  ownerId: string;
}

/** Context for public routes — `ownerId` may be null (best-effort identity). */
export interface PublicContext extends BaseContext {
  ownerId: string | null;
}

type AuthedHandler = (req: Request, ctx: AuthedContext) => Promise<Response> | Response;
type PublicHandler = (req: Request, ctx: PublicContext) => Promise<Response> | Response;

interface BaseOptions {
  /** Header-level fast-path guard; the authoritative byte check lives in readJson. */
  maxBodyBytes?: number;
}

// Next 16 route handlers receive an async `params` context.
type RouteHandler = (
  req: Request,
  segment?: { params?: Promise<Record<string, string | string[]>> },
) => Promise<Response>;

// Overloads bind the context type to the `auth` flag: authed handlers get a non-null
// `ownerId: string`; public handlers get `ownerId: string | null`. This pushes the
// owner-scoping guarantee into the type system (no `!` at use sites in later phases).
export function withRoute(
  handler: AuthedHandler,
  options?: BaseOptions & { auth?: true },
): RouteHandler;
export function withRoute(
  handler: PublicHandler,
  options: BaseOptions & { auth: false },
): RouteHandler;
export function withRoute(
  handler: AuthedHandler | PublicHandler,
  options: BaseOptions & { auth?: boolean } = {},
): RouteHandler {
  const { auth = true, maxBodyBytes = MAX_BODY_BYTES } = options;

  return async function (req, segment): Promise<Response> {
    // One correlation id, end to end: reuse a well-formed inbound X-Request-Id, else generate one.
    const requestId = resolveRequestId(req.headers.get("x-request-id"));
    const startedAt = Date.now();
    const path = new URL(req.url).pathname;
    let status = 500;

    try {
      // Cheap fast-path: reject obviously-oversized honest requests before doing any work.
      // A missing/lying content-length is NOT trusted — readJson does the real byte check.
      const contentLength = Number(req.headers.get("content-length") ?? 0);
      if (contentLength > maxBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE", "Request body too large");
      }

      const ownerId = await getOwnerContext();
      if (auth && !ownerId) {
        throw new AppError("UNAUTHORIZED", "Authentication required");
      }

      // Rate limit in one place, after auth, before the handler (writes only; reads exempt).
      await enforceRateLimit(req, ownerId);

      const params = segment?.params ? await segment.params : {};

      // The overloads guarantee the caller's handler matches its declared auth mode; the
      // implementation invokes through the public (nullable) shape, which is the safe widening.
      const res = await (handler as PublicHandler)(req, { ownerId, requestId, params });
      status = res.status;
      res.headers.set("x-request-id", requestId); // echo the correlation id on success
      return res;
    } catch (err) {
      const res = fail(err, requestId);
      status = res.status;
      res.headers.set("x-request-id", requestId); // echo it on failures too
      if (err instanceof AppError && err.code === "RATE_LIMITED") {
        const retryAfterSec = (err.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
        if (typeof retryAfterSec === "number") res.headers.set("retry-after", String(retryAfterSec));
      }
      return res;
    } finally {
      logRequest({
        requestId,
        method: req.method,
        path,
        status,
        durationMs: Date.now() - startedAt,
      });
    }
  };
}
