// server/config/publish-retry.ts — race-safe version-publish retry (decision 2 in phase2.md).
//
// Extracted from the Prisma repository so it can be unit-tested without a database: a concurrent
// publish that collides on the (appId, version) unique constraint (Prisma error P2002) is retried
// a bounded number of times, and only after exhausting attempts does it surface as CONFLICT —
// never a 500. Any non-collision error propagates unchanged (becomes INTERNAL upstream).

import { AppError } from "@/server/http/errors";

export const MAX_PUBLISH_ATTEMPTS = 5;

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export async function withPublishRetry<T>(
  attempt: () => Promise<T>,
  maxAttempts: number = MAX_PUBLISH_ATTEMPTS,
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // collision — recompute and retry on the next iteration
    }
  }
  throw new AppError("CONFLICT", "Concurrent publish; please retry");
}
