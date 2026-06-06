// server/http/idempotency.ts — opt-in idempotent creates (Phase 7).
//
// A network retry must not double-create. A POST carrying an `Idempotency-Key` is recorded as
// (ownerId, key) -> { bodyHash, result }. Replaying the SAME key + SAME body returns the STORED
// result (no second insert); the SAME key + a DIFFERENT body is a `CONFLICT` (409 — exactly the code
// reserved for it). Absent header -> behaves exactly as before (idempotency is opt-in). Keys are
// owner-scoped so one user's key cannot collide with another's.
//
// The store is a narrow seam: the default is an in-memory TTL map (no schema change); a Prisma/Redis
// TTL store plugs in behind the same interface for production/multi-instance.

import { createHash } from "node:crypto";
import { AppError } from "./errors";

/** The captured response of a successful create, replayed verbatim on a matching retry. */
export interface IdempotentResult {
  status: number;
  data: unknown;
  meta?: Record<string, unknown>;
}

interface StoredEntry {
  bodyHash: string;
  result: IdempotentResult;
}

export interface IdempotencyStore {
  get(ownerId: string, key: string): Promise<StoredEntry | null>;
  set(ownerId: string, key: string, entry: StoredEntry): Promise<void>;
}

/** Stable content hash of the request body, so a re-sent identical body matches its first request. */
export function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, { entry: StoredEntry; expiresAt: number }>();

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  private composite(ownerId: string, key: string): string {
    return `${ownerId}::${key}`;
  }

  async get(ownerId: string, key: string): Promise<StoredEntry | null> {
    const k = this.composite(ownerId, key);
    const hit = this.map.get(k);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.map.delete(k);
      return null;
    }
    return hit.entry;
  }

  async set(ownerId: string, key: string, entry: StoredEntry): Promise<void> {
    this.map.set(this.composite(ownerId, key), { entry, expiresAt: Date.now() + this.ttlMs });
  }
}

// ---- module singleton (swappable for tests / production store) --------------

let store: IdempotencyStore = new MemoryIdempotencyStore();

export const getIdempotencyStore = (): IdempotencyStore => store;
export const setIdempotencyStore = (s: IdempotencyStore): void => {
  store = s;
};
export const resetIdempotencyStore = (): void => {
  store = new MemoryIdempotencyStore();
};

/**
 * Run a create under an idempotency key. First call: produce, store, return. Replay (same body):
 * return the stored result. Replay (different body): throw CONFLICT. Owner-scoped.
 */
export async function runWithIdempotency(
  input: { ownerId: string; key: string; body: unknown },
  produce: () => Promise<IdempotentResult>,
): Promise<IdempotentResult> {
  const s = getIdempotencyStore();
  const bodyHash = hashBody(input.body);

  const existing = await s.get(input.ownerId, input.key);
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      throw new AppError("CONFLICT", "Idempotency-Key was reused with a different request body");
    }
    return existing.result; // replay: no second insert
  }

  const result = await produce();
  await s.set(input.ownerId, input.key, { bodyHash, result });
  return result;
}
