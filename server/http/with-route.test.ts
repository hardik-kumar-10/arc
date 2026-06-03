import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The single auth seam is mocked; no Clerk session or env keys required.
vi.mock("@/server/auth/context", () => ({ getOwnerContext: vi.fn() }));

import { getOwnerContext } from "@/server/auth/context";
import { withRoute } from "./with-route";
import { ok } from "./envelope";
import { AppError } from "./errors";

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
