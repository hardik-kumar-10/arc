// server/http/idempotency.test.ts — idempotent-create semantics, DB-free.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemoryIdempotencyStore,
  hashBody,
  runWithIdempotency,
  resetIdempotencyStore,
} from "./idempotency";

beforeEach(() => resetIdempotencyStore());

const OWNER = "user_1";

describe("hashBody", () => {
  it("is stable for equal bodies and differs for different ones", () => {
    expect(hashBody({ a: 1 })).toBe(hashBody({ a: 1 }));
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
  });
});

describe("runWithIdempotency", () => {
  it("first call produces and stores; same key + same body replays without re-producing", async () => {
    const produce = vi.fn().mockResolvedValue({ status: 201, data: { id: "rec_1" } });

    const first = await runWithIdempotency({ ownerId: OWNER, key: "k1", body: { title: "x" } }, produce);
    const second = await runWithIdempotency({ ownerId: OWNER, key: "k1", body: { title: "x" } }, produce);

    expect(produce).toHaveBeenCalledOnce(); // no second insert
    expect(second).toEqual(first); // identical stored result
  });

  it("same key + DIFFERENT body -> CONFLICT", async () => {
    const produce = vi.fn().mockResolvedValue({ status: 201, data: { id: "rec_1" } });
    await runWithIdempotency({ ownerId: OWNER, key: "k1", body: { title: "x" } }, produce);

    await expect(
      runWithIdempotency({ ownerId: OWNER, key: "k1", body: { title: "DIFFERENT" } }, produce),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(produce).toHaveBeenCalledOnce(); // the divergent retry did not insert
  });

  it("keys are owner-scoped: same key for different owners do not collide", async () => {
    const p1 = vi.fn().mockResolvedValue({ status: 201, data: { id: "a" } });
    const p2 = vi.fn().mockResolvedValue({ status: 201, data: { id: "b" } });
    const a = await runWithIdempotency({ ownerId: "user_A", key: "shared", body: { v: 1 } }, p1);
    const b = await runWithIdempotency({ ownerId: "user_B", key: "shared", body: { v: 2 } }, p2);
    expect(a.data).toEqual({ id: "a" });
    expect(b.data).toEqual({ id: "b" });
  });
});

describe("MemoryIdempotencyStore TTL", () => {
  it("expires entries after the TTL", async () => {
    const store = new MemoryIdempotencyStore(10); // 10ms TTL
    await store.set(OWNER, "k", { bodyHash: "h", result: { status: 201, data: 1 } });
    expect(await store.get(OWNER, "k")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.get(OWNER, "k")).toBeNull();
  });
});
