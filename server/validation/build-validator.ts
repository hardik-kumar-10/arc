// server/validation/build-validator.ts — assemble a per-entity validator from field schemas.
//
// Two object schemas are built once and dispatched by mode. Update is NOT createSchema.partial():
// verified that .partial() still APPLIES .default()/.prefault(), which would silently reset a field
// omitted from a PATCH. So update is its own all-optional, no-default shape (absent = leave as
// stored). Defaults use .prefault() (not .default()) so an absent value is coerced exactly like a
// present one — e.g. a date default stored as a string comes back as a Date, not a string.

import { z } from "zod";
import type { EntityDef } from "@/server/config/types";
import { baseFieldSchema } from "./field-schemas";
import type { EntityValidator, ValidationMode, ValidationOutcome } from "./types";

export function buildEntityValidator(entity: EntityDef): EntityValidator {
  const createShape: Record<string, z.ZodType> = {};
  const updateShape: Record<string, z.ZodType> = {};

  for (const field of entity.fields) {
    const base = baseFieldSchema(field);

    if (field.default !== undefined) {
      // default present -> coerced default, field may be absent
      createShape[field.name] = base.prefault(field.default);
    } else if (field.required !== true) {
      // optional, no default -> absent allowed
      createShape[field.name] = base.optional();
    } else {
      // required, no default -> absent is an error (create mode)
      createShape[field.name] = base;
    }

    // update: every field optional, no default, never required (PATCH semantics)
    updateShape[field.name] = base.optional();
  }

  const createSchema = z.object(createShape);
  const updateSchema = z.object(updateShape);

  return {
    validate(payload: unknown, mode: ValidationMode): ValidationOutcome {
      const schema = mode === "create" ? createSchema : updateSchema;
      const result = schema.safeParse(payload);

      if (result.success) {
        return { ok: true, data: result.data };
      }

      // z.flattenError types fieldErrors as a Partial map; normalize to the strict
      // Record<string, string[]> shape (architecture.md §4.2) without casts.
      const flat = z.flattenError(result.error);
      const fieldErrors: Record<string, string[]> = {};
      for (const [key, messages] of Object.entries(flat.fieldErrors)) {
        if (messages && messages.length > 0) fieldErrors[key] = messages;
      }
      return { ok: false, fieldErrors, formErrors: flat.formErrors };
    },
  };
}
