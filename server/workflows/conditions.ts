// server/workflows/conditions.ts — the declarative condition DSL (pure, never throws).
//
// Phase 2 stored `workflow.condition` as `unknown`, deferring shape validation to here. This is a
// DATA DSL evaluated by a pure function — no eval, no Function, no string-to-code. The cardinal rule
// is FAIL CLOSED: an absent condition runs unconditionally, but a condition we cannot evaluate
// (malformed shape, unknown op, over-deep nesting) returns `pass: false` with a reason — side effects
// must never fire on a condition we couldn't understand.

export interface ConditionResult {
  pass: boolean;
  reason?: string;
}

/** Comparison ops over a single record field. */
const LEAF_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists", "empty"] as const;
type LeafOp = (typeof LEAF_OPS)[number];

/** Bounds pathological nesting of all/any trees. */
const MAX_CONDITION_DEPTH = 20;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fail = (reason: string): ConditionResult => ({ pass: false, reason });

export function evaluateCondition(condition: unknown, record: Record<string, unknown>): ConditionResult {
  return evaluate(condition, record, 0);
}

function evaluate(condition: unknown, record: Record<string, unknown>, depth: number): ConditionResult {
  // Absent condition -> run unconditionally.
  if (condition === undefined || condition === null) return { pass: true };

  if (depth > MAX_CONDITION_DEPTH) return fail("condition nesting too deep");

  if (!isPlainObject(condition)) return fail("condition must be an object");

  // ---- combinators --------------------------------------------------------
  if ("all" in condition) {
    const subs = condition.all;
    if (!Array.isArray(subs)) return fail("'all' must be an array");
    for (const sub of subs) {
      const r = evaluate(sub, record, depth + 1);
      if (!r.pass) return { pass: false, reason: r.reason ?? "an 'all' branch did not match" };
    }
    return { pass: true }; // empty 'all' is vacuously true
  }

  if ("any" in condition) {
    const subs = condition.any;
    if (!Array.isArray(subs)) return fail("'any' must be an array");
    for (const sub of subs) {
      const r = evaluate(sub, record, depth + 1);
      if (r.pass) return { pass: true };
    }
    return fail("no 'any' branch matched");
  }

  // ---- leaf comparison ----------------------------------------------------
  if ("field" in condition && "op" in condition) {
    const { field, op } = condition;
    if (typeof field !== "string") return fail("leaf 'field' must be a string");
    if (typeof op !== "string" || !LEAF_OPS.includes(op as LeafOp)) return fail(`unknown op '${String(op)}'`);
    return evaluateLeaf(op as LeafOp, record[field], condition.value, field);
  }

  return fail("unrecognized condition shape");
}

function evaluateLeaf(op: LeafOp, actual: unknown, expected: unknown, field: string): ConditionResult {
  const notMet = (): ConditionResult => ({ pass: false, reason: `'${field}' ${op} not met` });

  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null ? { pass: true } : notMet();
    case "empty":
      return isEmpty(actual) ? { pass: true } : notMet();
    case "eq":
      return actual === expected ? { pass: true } : notMet();
    case "neq":
      return actual !== expected ? { pass: true } : notMet();
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return compare(op, actual, expected, field);
    case "contains":
      return contains(actual, expected) ? { pass: true } : notMet();
  }
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function compare(op: "gt" | "gte" | "lt" | "lte", a: unknown, b: unknown, field: string): ConditionResult {
  const comparable =
    (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
  if (!comparable) return { pass: false, reason: `'${field}' ${op} needs two numbers or two strings` };
  const pass = op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
  return pass ? { pass: true } : { pass: false, reason: `'${field}' ${op} not met` };
}

function contains(a: unknown, b: unknown): boolean {
  if (typeof a === "string") return typeof b === "string" && a.includes(b);
  if (Array.isArray(a)) return a.includes(b);
  return false;
}
