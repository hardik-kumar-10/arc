// server/records/project.test.ts — the projector, pure and DB-free (no mocks).
//
// One case per row of the Phase 5 Task 2 table, plus the load-bearing invariants: idempotency on a
// conforming record, stored-representation consistency (dates stay ISO strings), never-throws under
// fuzzed garbage, and bounded notes.

import { describe, it, expect } from "vitest";
import type { EntityDef } from "@/server/config/types";
import { projectRecordData, DRIFT_CODE } from "./project";

/** A wide entity exercising every field type + default/required/enum/reference permutations. */
const ENTITY: EntityDef = {
  name: "Task",
  fields: [
    { name: "title", type: "string", required: true },
    { name: "count", type: "number" },
    { name: "done", type: "boolean", default: false },
    { name: "due", type: "date" },
    { name: "status", type: "enum", values: ["open", "closed"] },
    { name: "priority", type: "enum", values: ["low", "high"], default: "low" },
    { name: "assignee", type: "reference", ref: "User" },
    { name: "nickname", type: "string" }, // optional, no default
    { name: "rank", type: "number", required: true }, // required, no default
    { name: "tag", type: "string", default: "none" }, // optional, has default
  ],
};

describe("projectRecordData — Task 2 rules", () => {
  it("conforming value -> no-op, no note", () => {
    const { data, notes } = projectRecordData({ title: "hi" }, { name: "E", fields: [{ name: "title", type: "string" }] });
    expect(data.title).toBe("hi");
    expect(notes).toHaveLength(0);
  });

  it("type changed but coercible -> FIELD_COERCED (info), value in stored repr", () => {
    const entity: EntityDef = { name: "E", fields: [{ name: "count", type: "number" }] };
    const { data, notes } = projectRecordData({ count: "42" }, entity);
    expect(data.count).toBe(42);
    expect(notes).toEqual([{ level: "info", code: DRIFT_CODE.FIELD_COERCED, field: "count", message: expect.any(String) }]);
  });

  it("type changed, not coercible -> default if set, else null + FIELD_COERCION_FAILED (warning)", () => {
    const entity: EntityDef = {
      name: "E",
      fields: [
        { name: "count", type: "number" }, // no default -> null
        { name: "score", type: "number", default: 7 }, // default -> 7
      ],
    };
    const { data, notes } = projectRecordData({ count: "abc", score: "abc" }, entity);
    expect(data.count).toBeNull();
    expect(data.score).toBe(7);
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.code === DRIFT_CODE.FIELD_COERCION_FAILED && n.level === "warning")).toBe(true);
  });

  it("enum value no longer allowed -> default if valid, else null + ENUM_VALUE_INVALID (warning)", () => {
    const { data, notes } = projectRecordData({ status: "archived", priority: "archived" }, ENTITY);
    expect(data.status).toBeNull(); // no default
    expect(data.priority).toBe("low"); // default, still valid
    const enumNotes = notes.filter((n) => n.code === DRIFT_CODE.ENUM_VALUE_INVALID);
    expect(enumNotes).toHaveLength(2);
    expect(enumNotes.every((n) => n.level === "warning")).toBe(true);
  });

  it("absent field with default -> backfilled default + FIELD_BACKFILLED_DEFAULT (info)", () => {
    const entity: EntityDef = { name: "E", fields: [{ name: "done", type: "boolean", default: false }] };
    const { data, notes } = projectRecordData({}, entity);
    expect(data.done).toBe(false);
    expect(notes).toEqual([{ level: "info", code: DRIFT_CODE.FIELD_BACKFILLED_DEFAULT, field: "done", message: expect.any(String) }]);
  });

  it("absent now-required field, no default -> null (read succeeds) + FIELD_BACKFILLED_NULL (warning)", () => {
    const entity: EntityDef = { name: "E", fields: [{ name: "rank", type: "number", required: true }] };
    const { data, notes } = projectRecordData({}, entity);
    expect(data.rank).toBeNull();
    expect(notes).toEqual([{ level: "warning", code: DRIFT_CODE.FIELD_BACKFILLED_NULL, field: "rank", message: expect.any(String) }]);
  });

  it("absent optional field, no default -> key omitted, no note", () => {
    const entity: EntityDef = { name: "E", fields: [{ name: "nickname", type: "string" }] };
    const { data, notes } = projectRecordData({}, entity);
    expect("nickname" in data).toBe(false);
    expect(notes).toHaveLength(0);
  });

  it("stored key not in current schema -> dropped + FIELD_DROPPED_ON_READ (info)", () => {
    const entity: EntityDef = { name: "E", fields: [{ name: "title", type: "string" }] };
    const { data, notes } = projectRecordData({ title: "hi", legacy: "gone" }, entity);
    expect("legacy" in data).toBe(false);
    expect(data.title).toBe("hi");
    expect(notes).toEqual([{ level: "info", code: DRIFT_CODE.FIELD_DROPPED_ON_READ, field: "legacy", message: expect.any(String) }]);
  });

  it("reference field -> stored string passes through unchanged, no note", () => {
    const entity: EntityDef = { name: "E", fields: [{ name: "assignee", type: "reference", ref: "User" }] };
    const { data, notes } = projectRecordData({ assignee: "user_xyz" }, entity);
    expect(data.assignee).toBe("user_xyz");
    expect(notes).toHaveLength(0);
  });
});

describe("projectRecordData — invariants", () => {
  it("idempotency: a conforming record projects byte-identically with zero notes", () => {
    const stored = {
      title: "Write tests",
      count: 3,
      done: true,
      due: "2026-01-01T00:00:00.000Z",
      status: "open",
      priority: "high",
      assignee: "user_1",
      nickname: "tt",
      rank: 1,
      tag: "x",
    };
    const { data, notes } = projectRecordData(structuredClone(stored), ENTITY);
    expect(data).toEqual(stored);
    expect(notes).toHaveLength(0);
  });

  it("representation: a date stored as an ISO string projects to the SAME ISO string (not a Date)", () => {
    const iso = new Date("2026-03-04T05:06:07.000Z").toISOString();
    const entity: EntityDef = { name: "E", fields: [{ name: "due", type: "date" }] };
    const { data, notes } = projectRecordData({ due: iso }, entity);
    expect(data.due).toBe(iso);
    expect(data.due).not.toBeInstanceOf(Date);
    expect(notes).toHaveLength(0);
  });

  it("never throws: fuzzed stored data of every shape always yields a ProjectionResult", () => {
    const fuzz: unknown[] = [
      null,
      undefined,
      42,
      "string",
      true,
      [],
      [1, 2, 3],
      { title: null, count: [], done: {}, due: true, status: 1, assignee: {}, rank: [] },
      { title: { nested: { garbage: [1, [2, [3]]] } } },
      { count: NaN, due: "not-a-date", status: ["array"], priority: null },
    ];
    for (const stored of fuzz) {
      const run = () => projectRecordData(stored as Record<string, unknown>, ENTITY);
      expect(run).not.toThrow();
      const result = run();
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("notes");
      expect(Array.isArray(result.notes)).toBe(true);
    }
  });

  it("bounded notes: an entity wide enough to exceed the cap yields a truncated, bounded list", () => {
    // 150 required-no-default fields, all absent -> 150 would-be warnings, capped at 100 + 1 marker.
    const fields = Array.from({ length: 150 }, (_, i) => ({ name: `f${i}`, type: "string" as const, required: true }));
    const { notes } = projectRecordData({}, { name: "Wide", fields });
    expect(notes.length).toBe(101); // 100 notes + 1 truncation marker
    expect(notes[notes.length - 1].code).toBe(DRIFT_CODE.DRIFT_NOTES_TRUNCATED);
    expect(notes.filter((n) => n.code === DRIFT_CODE.DRIFT_NOTES_TRUNCATED)).toHaveLength(1);
  });
});
