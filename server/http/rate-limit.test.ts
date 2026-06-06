// server/http/rate-limit.test.ts — the limiter primitive, deterministic and DB-free.

import { describe, it, expect, vi } from "vitest";
import { MemoryRateLimiter, rateLimitKey, isWriteMethod, type RateLimiter } from "./rate-limit";

describe("MemoryRateLimiter", () => {
  it("allows up to the budget, then denies with a Retry-After", async () => {
    const limiter = new MemoryRateLimiter({ points: 2, durationSec: 60 });
    expect((await limiter.consume("k")).allowed).toBe(true);
    expect((await limiter.consume("k")).allowed).toBe(true);
    const third = await limiter.consume("k");
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("buckets are per-key (one key's exhaustion doesn't affect another)", async () => {
    const limiter = new MemoryRateLimiter({ points: 1, durationSec: 60 });
    expect((await limiter.consume("a")).allowed).toBe(true);
    expect((await limiter.consume("a")).allowed).toBe(false);
    expect((await limiter.consume("b")).allowed).toBe(true); // independent bucket
  });

  it("FAILS OPEN: an internal limiter error allows the request (logged, not 5xx)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = new MemoryRateLimiter({ points: 1, durationSec: 60 });
    // Force the underlying store to throw a genuine Error (not a RateLimiterRes rejection).
    const inner = limiter as unknown as { limiter: { consume: () => Promise<unknown> } };
    inner.limiter.consume = () => Promise.reject(new Error("store down"));

    const decision = await limiter.consume("k");
    expect(decision.allowed).toBe(true); // fail open
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});

describe("rateLimitKey", () => {
  const req = (headers: Record<string, string> = {}) => new Request("http://x/api", { headers });

  it("keys by owner when authenticated", () => {
    expect(rateLimitKey(req(), "user_1")).toBe("owner:user_1");
  });

  it("keys by first forwarded IP when anonymous", () => {
    expect(rateLimitKey(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), null)).toBe("ip:1.2.3.4");
  });

  it("falls back to 'unknown' when no IP header is present", () => {
    expect(rateLimitKey(req(), null)).toBe("ip:unknown");
  });
});

describe("isWriteMethod", () => {
  it("treats mutating verbs as writes and GET/HEAD as reads", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(isWriteMethod(m)).toBe(true);
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(isWriteMethod(m)).toBe(false);
  });
});

// The interface is honored by alternative impls (e.g. a Postgres-backed limiter in production).
describe("RateLimiter seam", () => {
  it("accepts any impl returning a decision", async () => {
    const stub: RateLimiter = { async consume() { return { allowed: false, retryAfterSec: 30 }; } };
    expect(await stub.consume("k")).toEqual({ allowed: false, retryAfterSec: 30 });
  });
});
