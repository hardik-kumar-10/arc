// server/config/meta-schema.ts — leaf validation helpers (Zod 4).
//
// This file is NOT a gatekeeper. There is deliberately no `z.object(wholeConfig).parse(...)`:
// a top-level strict parse REJECTS, and Phase 2's whole point is to REPAIR. Zod is used here
// only for small, per-node leaf checks the compiler calls as it walks the document.

import { z } from "zod";

/** Single source of truth for the field-type set; `FieldType` (types.ts) is derived from this. */
export const FIELD_TYPES = ["string", "number", "boolean", "date", "enum", "reference"] as const;

/** Zod enum derived from the same array — never let the two drift. */
export const fieldTypeSchema = z.enum(FIELD_TYPES);

export type FieldType = (typeof FIELD_TYPES)[number];

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}

/** A plain (non-array, non-null) object — the only shape the compiler descends into. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Is `value` usable as the `default` for a field of `type`? For enums, `values` must contain it.
 * Used to decide DEFAULT_DROPPED — an incompatible default is dropped, the field is kept.
 */
export function isDefaultCompatible(
  type: FieldType,
  value: unknown,
  values?: string[],
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      // accept an ISO/parseable date string or a finite epoch number
      return (
        (typeof value === "string" && !Number.isNaN(Date.parse(value))) ||
        (typeof value === "number" && Number.isFinite(value))
      );
    case "enum":
      return typeof value === "string" && (values?.includes(value) ?? false);
    case "reference":
      // a reference default is the id of a target record — only a string is meaningful
      return typeof value === "string";
  }
}
