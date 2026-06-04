import { describe, it, expect } from "vitest";
import { serializeRecord } from "./serialize";
import type { StoredRecord } from "./record-repository";

const row: StoredRecord = {
  id: "rec_1",
  appId: "app_1",
  entity: "Task",
  ownerId: "user_A",
  data: { title: "Hello", done: false, priority: 3 },
  version: 2,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("serializeRecord", () => {
  it("flattens data to the top level with system fields present", () => {
    const out = serializeRecord(row);
    expect(out).toEqual({
      id: "rec_1",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: 2,
      title: "Hello",
      done: false,
      priority: 3,
    });
  });

  it("loses no data key and exposes the system fields", () => {
    const out = serializeRecord(row);
    for (const key of Object.keys(row.data)) {
      expect(out[key]).toBe(row.data[key]);
    }
    expect(out.id).toBe("rec_1");
    expect(out.version).toBe(2);
    expect(out.createdAt).toBe(row.createdAt);
    expect(out.updatedAt).toBe(row.updatedAt);
  });

  it("system fields win even if a data key collides (reserved names are dropped upstream)", () => {
    // Phase 2 guarantees this never happens, but the spread order must still favour system columns.
    const shadow: StoredRecord = { ...row, data: { id: "EVIL", version: 999, title: "x" } };
    const out = serializeRecord(shadow);
    expect(out.id).toBe("rec_1");
    expect(out.version).toBe(2);
    expect(out.title).toBe("x");
  });
});
