// server/validation/field-schemas.ts — per-field base Zod schemas (the coercion rules).
//
// "strict-but-coercing": coerce where safe, fail cleanly where not — and never let a bare
// `z.coerce.*` silently corrupt data. Verified Zod 4 traps closed here:
//   z.coerce.number(): "" / "  " / null / [] -> 0, true -> 1   (all must FAIL instead)
//   z.coerce.date():   null -> Date(0), true -> valid Date      (all must FAIL instead)
// Each guarded `preprocess` only converts inputs that are *meaningfully* coercible and passes
// everything else through unchanged, so the inner schema type-rejects it. These return the BASE
// schema only — optional/prefault/required wrapping is build-validator's job.

import { z } from "zod";
import type { FieldDef } from "@/server/config/types";

// string — numbers/booleans coerce to string; objects/arrays/null reach z.string() and are rejected.
const stringSchema = z.preprocess(
  (input) => (typeof input === "number" || typeof input === "boolean" ? String(input) : input),
  z.string(),
);

// number — only finite numbers and non-empty numeric strings convert; everything else falls through
// to z.number() (type error) or is caught by the finite refine.
const numberSchema = z.preprocess((input) => {
  if (typeof input === "number") return input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return input; // "" / "  " -> pass through -> rejected (not silently 0)
    const n = Number(trimmed);
    return Number.isNaN(n) ? input : n; // "abc" -> pass through -> rejected; "42" -> 42
  }
  return input; // boolean / null / array / object -> rejected
}, z.number().refine(Number.isFinite, "Must be a finite number"));

// boolean — explicit allow-list; NOT truthiness-based, so "false" stays false.
const booleanSchema = z.preprocess((input) => {
  if (typeof input === "boolean") return input;
  if (input === "true") return true;
  if (input === "false") return false;
  if (input === 1) return true;
  if (input === 0) return false;
  return input; // anything else -> rejected
}, z.boolean());

// date — only strings and finite numbers are fed to `new Date`; null/boolean/array/object fall
// through to z.date() and are rejected (closing null->Date(0) / true->Date(1)). Invalid Date caught.
const dateSchema = z.preprocess((input) => {
  if (typeof input === "string" || (typeof input === "number" && Number.isFinite(input))) {
    return new Date(input);
  }
  return input;
}, z.date().refine((d) => !Number.isNaN(d.getTime()), "Invalid date"));

/** Base schema for a normalized field. Phase 2 guarantees field soundness; we do not re-check it. */
export function baseFieldSchema(field: FieldDef): z.ZodType {
  switch (field.type) {
    case "string":
      return stringSchema;
    case "number":
      return numberSchema;
    case "boolean":
      return booleanSchema;
    case "date":
      return dateSchema;
    case "enum":
      // Phase 2 guarantees a non-empty string[]; TS can't see the non-empty tuple, hence the cast.
      return z.enum((field.values ?? []) as [string, ...string[]]);
    case "reference":
      return z.string().min(1, "Reference id required");
  }
}
