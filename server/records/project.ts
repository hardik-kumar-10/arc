// server/records/project.ts — read-time projection of stored data onto the CURRENT schema.
//
// Records are never migrated in the DB: each row's `data` was validated under the config version
// stamped in `Record.version`. When the active config moves on, a v1 row must still read cleanly
// under v3. This projector is the read-tolerant counterpart of the Phase 3 validator: where the
// validator REJECTS, the projector REPAIRS. It is PURE and NEVER THROWS — the worst case is an
// all-null/all-default object plus a bounded list of drift notes, returned successfully.
//
// Representation is delegated to `toStoredRepr` (the same rule the write/filter paths use), so a
// record that already conforms projects to a BYTE-IDENTICAL object with ZERO notes (the load-bearing
// idempotency invariant). No new coercion logic lives here: every per-field coercion runs through
// Phase 3's `baseFieldSchema(...).safeParse(...)`; this file only adds a lenient fall-forward policy.

import type { EntityDef, FieldDef } from "@/server/config/types";
import { baseFieldSchema } from "@/server/validation/field-schemas";
import { toStoredRepr } from "./value-repr";

/** Drift severity. Drift is reported, never thrown — it is metadata, not a failure. */
type DriftLevel = "info" | "warning";

/**
 * Drift-note codes — a THIRD namespace, separate from HTTP `ErrorCode` and the Phase 2 compiler
 * diagnostic codes. These never map to an HTTP status; they ride in `meta`, not in an error body.
 */
export const DRIFT_CODE = {
  FIELD_COERCED: "FIELD_COERCED",
  FIELD_COERCION_FAILED: "FIELD_COERCION_FAILED",
  ENUM_VALUE_INVALID: "ENUM_VALUE_INVALID",
  FIELD_BACKFILLED_DEFAULT: "FIELD_BACKFILLED_DEFAULT",
  FIELD_BACKFILLED_NULL: "FIELD_BACKFILLED_NULL",
  FIELD_DROPPED_ON_READ: "FIELD_DROPPED_ON_READ",
  DRIFT_NOTES_TRUNCATED: "DRIFT_NOTES_TRUNCATED",
} as const;

export type DriftCode = (typeof DRIFT_CODE)[keyof typeof DRIFT_CODE];

export interface DriftNote {
  level: DriftLevel;
  code: DriftCode;
  field: string; // the field name involved ("" for a record-level note)
  message: string;
}

export interface ProjectionResult {
  data: Record<string, unknown>; // current-schema shape, in stored representation
  notes: DriftNote[]; // bounded; see NOTE_CAP
}

/** Phase 2 diagnostics-cap style: report at most this many notes, then one TRUNCATED marker. */
const NOTE_CAP = 100;

/** Narrow any stored value to a plain object; null / array / primitive garbage becomes `{}`. */
function asObject(stored: unknown): Record<string, unknown> {
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    return stored as Record<string, unknown>;
  }
  return {};
}

/** Coerce a config-supplied default into stored representation, or `null` if it is uncoercible. */
function defaultInStoredRepr(field: FieldDef): unknown {
  if (field.default === undefined) return null;
  if (field.type === "enum") {
    // Enum defaults are validated against the current `values`, not coerced.
    return field.values?.includes(field.default as string) ? field.default : null;
  }
  const parsed = baseFieldSchema(field).safeParse(field.default);
  return parsed.success ? toStoredRepr(parsed.data) : null;
}

export function projectRecordData(stored: Record<string, unknown>, entity: EntityDef): ProjectionResult {
  const src = asObject(stored);
  const data: Record<string, unknown> = {};
  const notes: DriftNote[] = [];
  let truncated = false;

  const addNote = (level: DriftLevel, code: DriftCode, field: string, message: string): void => {
    if (notes.length < NOTE_CAP) {
      notes.push({ level, code, field, message });
    } else if (!truncated) {
      truncated = true;
      notes.push({
        level: "info",
        code: DRIFT_CODE.DRIFT_NOTES_TRUNCATED,
        field: "",
        message: `Drift notes truncated at ${NOTE_CAP}; the data is still fully projected.`,
      });
    }
  };

  const known = new Set<string>();

  for (const field of entity.fields) {
    known.add(field.name);
    const present = Object.prototype.hasOwnProperty.call(src, field.name);

    // ---- absent field: backfill or omit ------------------------------------
    if (!present) {
      if (field.default !== undefined) {
        data[field.name] = defaultInStoredRepr(field);
        addNote("info", DRIFT_CODE.FIELD_BACKFILLED_DEFAULT, field.name, `Missing '${field.name}' backfilled with its default.`);
      } else if (field.required === true) {
        // Read still succeeds — a missing required field reads as null, it does NOT reject.
        data[field.name] = null;
        addNote("warning", DRIFT_CODE.FIELD_BACKFILLED_NULL, field.name, `Now-required '${field.name}' was absent; read as null.`);
      }
      // optional, no default -> omit the key (consistent choice); no note.
      continue;
    }

    const value = src[field.name];

    // ---- reference: existence is a write-time concern; pass the stored value through ----
    if (field.type === "reference") {
      data[field.name] = value;
      continue;
    }

    // ---- enum: membership check against the CURRENT value set ----------------
    if (field.type === "enum") {
      if (typeof value === "string" && field.values?.includes(value)) {
        data[field.name] = value; // still valid -> no-op
      } else {
        data[field.name] = defaultInStoredRepr(field);
        addNote("warning", DRIFT_CODE.ENUM_VALUE_INVALID, field.name, `Value of '${field.name}' is no longer an allowed enum value.`);
      }
      continue;
    }

    // ---- scalar/date: coerce leniently via the Phase 3 base schema ----------
    const parsed = baseFieldSchema(field).safeParse(value);
    if (parsed.success) {
      const coerced = toStoredRepr(parsed.data);
      data[field.name] = coerced;
      if (coerced !== value) {
        addNote("info", DRIFT_CODE.FIELD_COERCED, field.name, `Value of '${field.name}' coerced to type '${field.type}'.`);
      }
    } else {
      data[field.name] = defaultInStoredRepr(field);
      addNote("warning", DRIFT_CODE.FIELD_COERCION_FAILED, field.name, `Value of '${field.name}' could not be coerced to type '${field.type}'.`);
    }
  }

  // ---- stored keys no longer in the schema: drop them on read --------------
  for (const key of Object.keys(src)) {
    if (!known.has(key)) {
      addNote("info", DRIFT_CODE.FIELD_DROPPED_ON_READ, key, `Field '${key}' is no longer in the schema and was dropped on read.`);
    }
  }

  return { data, notes };
}
