// server/http/rate-limit.ts — per-owner (per-IP when anonymous) rate limiting (Phase 7).
//
// Applied INSIDE withRoute, after auth, before the handler — one place, like auth. Only WRITE methods
// are metered; reads are exempt (a read budget can be added behind the same seam if needed). The
// limiter is a narrow seam (like every storage seam in this codebase): the default in-memory impl is
// backed by `rate-limiter-flexible` (`RateLimiterMemory`); the production swap is its Postgres store,
// wired behind the same interface. Tests inject a tiny-budget limiter for determinism.
//
// CARDINAL RULE — FAIL OPEN: if the limiter itself errors (store hiccup), we LOG and ALLOW. A rate
// limiter must never become an availability risk; only an actual budget-exhaustion produces a 429.

import { RateLimiterMemory } from "rate-limiter-flexible";
import { AppError } from "./errors";
import { logError } from "./logger";

/** One config module for the budgets (defensible defaults; tune here). */
export const RATE_LIMITS = {
  write: { points: 100, durationSec: 60 }, // 100 writes / minute / owner (or IP)
} as const;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  consume(key: string, points?: number): Promise<RateLimitDecision>;
}

/** Default limiter: in-memory token buckets via rate-limiter-flexible, fail-open on internal error. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly limiter: RateLimiterMemory;

  constructor(opts: { points: number; durationSec: number }) {
    this.limiter = new RateLimiterMemory({ points: opts.points, duration: opts.durationSec });
  }

  async consume(key: string, points = 1): Promise<RateLimitDecision> {
    try {
      await this.limiter.consume(key, points);
      return { allowed: true, retryAfterSec: 0 };
    } catch (rejection) {
      // rate-limiter-flexible rejects with a `RateLimiterRes` on EXHAUSTION, but with an `Error` on a
      // genuine store fault. The latter must FAIL OPEN — never turn a limiter hiccup into a 5xx/outage.
      if (rejection instanceof Error) {
        logError({ requestId: "rate-limiter", error: rejection });
        return { allowed: true, retryAfterSec: 0 };
      }
      const msBeforeNext = (rejection as { msBeforeNext?: number }).msBeforeNext ?? 1000;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(msBeforeNext / 1000)) };
    }
  }
}

// ---- module singleton (swappable for tests / production store) --------------

let writeLimiter: RateLimiter = new MemoryRateLimiter(RATE_LIMITS.write);

export const getWriteLimiter = (): RateLimiter => writeLimiter;
export const setWriteLimiter = (limiter: RateLimiter): void => {
  writeLimiter = limiter;
};
export const resetRateLimiters = (): void => {
  writeLimiter = new MemoryRateLimiter(RATE_LIMITS.write);
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const isWriteMethod = (method: string): boolean => WRITE_METHODS.has(method.toUpperCase());

/** Bucket key: the authenticated owner when present, else the client IP from forwarding headers. */
export function rateLimitKey(req: Request, ownerId: string | null): string {
  if (ownerId) return `owner:${ownerId}`;
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0]?.trim() : req.headers.get("x-real-ip");
  return `ip:${ip && ip.length > 0 ? ip : "unknown"}`;
}

/** Enforce the write budget; reads are exempt. Throws RATE_LIMITED (-> 429) on exhaustion. */
export async function enforceRateLimit(req: Request, ownerId: string | null): Promise<void> {
  if (!isWriteMethod(req.method)) return; // reads are exempt
  const decision = await getWriteLimiter().consume(rateLimitKey(req, ownerId));
  if (!decision.allowed) {
    throw new AppError("RATE_LIMITED", "Too many requests", { retryAfterSec: decision.retryAfterSec });
  }
}
