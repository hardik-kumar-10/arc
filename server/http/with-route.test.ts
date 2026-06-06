import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The single auth seam is mocked; no Clerk session or env keys required.
vi.mock("@/server/auth/context", () => ({ getOwnerContext: vi.fn() }));

import { getOwnerContext } from "@/server/auth/context";
import { withRoute } from "./with-route";
import { ok } from "./envelope";
import { AppError } from "./errors";
import { setWriteLimiter, resetRateLimiters, type RateLimiter } from "./rate-limit";

afterEach(() => resetRateLimiters());

const mockedGetOwner = vi.mocked(getOwnerContext);
const req = (init?: RequestInit) => new Request("http://localhost/api/x", init);

type Envelope = {
  ok: boolean;
  requestId: string;
  data?: unknown;
  error?: { code: string; message: string; stack?: unknown };
};

beforeEach(() => {
  mockedGetOwner.mockReset();
});

describe("withRoute pipeline", () => {
  it("authed route with no owner → 401 UNAUTHORIZED envelope", async () => {
    mockedGetOwner.mockResolvedValue(null);
    const GET = withRoute((_r, ctx) => ok({ ownerId: ctx.ownerId }, { requestId: ctx.requestId }));

    const res = await GET(req());
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(body.requestId).toBeTruthy();
  });

  it("authed route with owner → 200 and non-null ownerId in data", async () => {
    mockedGetOwner.mockResolvedValue("user_123");
    const GET = withRoute((_r, ctx) => ok({ ownerId: ctx.ownerId }, { requestId: ctx.requestId }));

    const res = await GET(req());
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ ownerId: "user_123" });
  });

  it("public route runs without an owner → 200", async () => {
    mockedGetOwner.mockResolvedValue(null);
    const GET = withRoute((_r, ctx) => ok({ status: "ok" }, { requestId: ctx.requestId }), {
      auth: false,
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  it("oversized content-length header → 413 fast-path reject", async () => {
    mockedGetOwner.mockResolvedValue("user_123");
    const GET = withRoute((_r, ctx) => ok({}, { requestId: ctx.requestId }), {
      maxBodyBytes: 10,
    });

    const res = await GET(req({ headers: { "content-length": "999" } }));
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(413);
    expect(body.error?.code).toBe("PAYLOAD_TOO_LARGE");
  });

  describe("unhandled fault", () => {
    let errSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => errSpy.mockRestore());

    it("plain Error → 500 INTERNAL, logged server-side, no stack/message leaked to client", async () => {
      mockedGetOwner.mockResolvedValue(null);
      const GET = withRoute(
        () => {
          throw new Error("boom secret internals");
        },
        { auth: false },
      );

      const res = await GET(req());
      const body = (await res.json()) as Envelope;

      expect(res.status).toBe(500);
      expect(body.error?.code).toBe("INTERNAL");
      // client sees a generic message; the real one is never returned
      expect(body.error?.message).not.toContain("boom");
      expect(body.error?.stack).toBeUndefined();
      // but it IS logged server-side
      expect(errSpy).toHaveBeenCalledOnce();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("boom");
    });

    it("thrown AppError maps to its code/status and is NOT logged as a fault", async () => {
      mockedGetOwner.mockResolvedValue(null);
      const GET = withRoute(
        () => {
          throw new AppError("NOT_FOUND", "nope");
        },
        { auth: false },
      );

      const res = await GET(req());
      expect(res.status).toBe(404);
      expect(errSpy).not.toHaveBeenCalled();
    });
  });

  it("emits exactly one structured request log line with a matching requestId", async () => {
    mockedGetOwner.mockResolvedValue("user_123");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const GET = withRoute((_r, ctx) => ok({}, { requestId: ctx.requestId }));
      const res = await GET(req({ method: "GET" }));
      const body = (await res.json()) as Envelope;

      expect(logSpy).toHaveBeenCalledOnce();
      const line = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(line).toMatchObject({
        type: "request",
        method: "GET",
        path: "/api/x",
        status: 200,
        requestId: body.requestId,
      });
      expect(typeof line.durationMs).toBe("number");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("Phase 7 — correlation id propagation", () => {
  it("reuses a well-formed inbound X-Request-Id and echoes it as a response header", async () => {
    mockedGetOwner.mockResolvedValue("user_1");
    const GET = withRoute((_r, ctx) => ok({}, { requestId: ctx.requestId }));
    const res = await GET(req({ headers: { "x-request-id": "trace-abc-123" } }));
    const body = (await res.json()) as Envelope;

    expect(body.requestId).toBe("trace-abc-123");
    expect(res.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  it("generates and echoes an id when the inbound one is malformed", async () => {
    mockedGetOwner.mockResolvedValue("user_1");
    const GET = withRoute((_r, ctx) => ok({}, { requestId: ctx.requestId }));
    const res = await GET(req({ headers: { "x-request-id": "bad id!" } }));
    const body = (await res.json()) as Envelope;

    expect(body.requestId).not.toBe("bad id!");
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });
});

describe("Phase 7 — rate limiting", () => {
  const deny: RateLimiter = { async consume() { return { allowed: false, retryAfterSec: 42 }; } };
  const allow: RateLimiter = { async consume() { return { allowed: true, retryAfterSec: 0 }; } };

  it("a write past budget -> 429 RATE_LIMITED with a Retry-After header", async () => {
    mockedGetOwner.mockResolvedValue("user_1");
    setWriteLimiter(deny);
    const POST = withRoute((_r, ctx) => ok({}, { requestId: ctx.requestId }));
    const res = await POST(req({ method: "POST" }));
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(429);
    expect(body.error?.code).toBe("RATE_LIMITED");
    expect(res.headers.get("retry-after")).toBe("42");
  });

  it("reads are exempt even when the limiter would deny", async () => {
    mockedGetOwner.mockResolvedValue("user_1");
    setWriteLimiter(deny);
    const GET = withRoute((_r, ctx) => ok({ ok: true }, { requestId: ctx.requestId }));
    const res = await GET(req({ method: "GET" }));
    expect(res.status).toBe(200);
  });

  it("an allowing limiter lets writes through", async () => {
    mockedGetOwner.mockResolvedValue("user_1");
    setWriteLimiter(allow);
    const POST = withRoute((_r, ctx) => ok({ created: true }, { status: 201, requestId: ctx.requestId }));
    const res = await POST(req({ method: "POST" }));
    expect(res.status).toBe(201);
  });
});
