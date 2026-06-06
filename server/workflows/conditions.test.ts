// server/workflows/conditions.test.ts — the condition DSL, pure and DB-free.
//
// Each op, all/any combinators, the fail-closed rule for absent/malformed conditions, the nesting
// cap, and never-throws on arbitrary garbage input.

import { describe, it, expect } from "vitest";
import { evaluateCondition } from "./conditions";

const REC = { name: "Widget", qty: 5, tags: ["a", "b"], done: true, note: "" };

describe("evaluateCondition — absent / unconditional", () => {
  it("undefined condition runs unconditionally", () => {
    expect(evaluateCondition(undefined, REC)).toEqual({ pass: true });
  });
  it("null condition runs unconditionally", () => {
    expect(evaluateCondition(null, REC)).toEqual({ pass: true });
  });
});

describe("evaluateCondition — leaf ops", () => {
  it("eq / neq", () => {
    expect(evaluateCondition({ field: "name", op: "eq", value: "Widget" }, REC).pass).toBe(true);
    expect(evaluateCondition({ field: "name", op: "eq", value: "Other" }, REC).pass).toBe(false);
    expect(evaluateCondition({ field: "name", op: "neq", value: "Other" }, REC).pass).toBe(true);
  });

  it("gt / gte / lt / lte over numbers", () => {
    expect(evaluateCondition({ field: "qty", op: "gt", value: 4 }, REC).pass).toBe(true);
    expect(evaluateCondition({ field: "qty", op: "gte", value: 5 }, REC).pass).toBe(true);
    expect(evaluateCondition({ field: "qty", op: "lt", value: 5 }, REC).pass).toBe(false);
    expect(evaluateCondition({ field: "qty", op: "lte", value: 5 }, REC).pass).toBe(true);
  });

  it("ordering with incomparable types fails closed (no throw)", () => {
    const r = evaluateCondition({ field: "name", op: "gt", value: 3 }, REC);
    expect(r.pass).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("contains on strings and arrays", () => {
    expect(evaluateCondition({ field: "name", op: "contains", value: "idg" }, REC).pass).toBe(true);
    expect(evaluateCondition({ field: "tags", op: "contains", value: "a" }, REC).pass).toBe(true);
    expect(evaluateCondition({ field: "tags", op: "contains", value: "z" }, REC).pass).toBe(false);
  });

  it("exists / empty", () => {
    expect(evaluateCondition({ field: "qty", op: "exists" }, REC).pass).toBe(true);
    expect(evaluateCondition({ field: "missing", op: "exists" }, REC).pass).toBe(false);
    expect(evaluateCondition({ field: "note", op: "empty" }, REC).pass).toBe(true); // "" is empty
    expect(evaluateCondition({ field: "name", op: "empty" }, REC).pass).toBe(false);
  });
});

describe("evaluateCondition — combinators", () => {
  it("all = AND", () => {
    const cond = { all: [{ field: "done", op: "eq", value: true }, { field: "qty", op: "gte", value: 5 }] };
    expect(evaluateCondition(cond, REC).pass).toBe(true);
    const cond2 = { all: [{ field: "done", op: "eq", value: true }, { field: "qty", op: "gt", value: 10 }] };
    expect(evaluateCondition(cond2, REC).pass).toBe(false);
  });

  it("any = OR", () => {
    const cond = { any: [{ field: "qty", op: "gt", value: 10 }, { field: "name", op: "eq", value: "Widget" }] };
    expect(evaluateCondition(cond, REC).pass).toBe(true);
    const cond2 = { any: [{ field: "qty", op: "gt", value: 10 }, { field: "name", op: "eq", value: "No" }] };
    expect(evaluateCondition(cond2, REC).pass).toBe(false);
  });

  it("empty all is vacuously true; empty any is false", () => {
    expect(evaluateCondition({ all: [] }, REC).pass).toBe(true);
    expect(evaluateCondition({ any: [] }, REC).pass).toBe(false);
  });

  it("nested combinators", () => {
    const cond = { all: [{ any: [{ field: "name", op: "eq", value: "X" }, { field: "done", op: "eq", value: true }] }, { field: "qty", op: "gte", value: 1 }] };
    expect(evaluateCondition(cond, REC).pass).toBe(true);
  });
});

describe("evaluateCondition — fail closed", () => {
  it("malformed shape -> pass:false + reason", () => {
    for (const bad of [{}, { field: "x" }, { op: "eq" }, { field: 1, op: "eq" }, { all: "nope" }, { any: 42 }]) {
      const r = evaluateCondition(bad, REC);
      expect(r.pass).toBe(false);
      expect(r.reason).toBeTruthy();
    }
  });

  it("unknown op -> pass:false + reason", () => {
    const r = evaluateCondition({ field: "qty", op: "between", value: 3 }, REC);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("unknown op");
  });

  it("over-deep nesting fails closed, never throws", () => {
    // Build all-nesting deeper than the cap (20).
    let cond: unknown = { field: "qty", op: "gte", value: 0 };
    for (let i = 0; i < 30; i++) cond = { all: [cond] };
    const r = evaluateCondition(cond, REC);
    expect(r.pass).toBe(false);
  });

  it("never throws on arbitrary garbage", () => {
    for (const garbage of [42, "str", true, [], [1, 2], () => 1, Symbol("x"), { field: {}, op: {} }]) {
      expect(() => evaluateCondition(garbage as unknown, REC)).not.toThrow();
      expect(evaluateCondition(garbage as unknown, REC).pass).toBe(false);
    }
  });
});
