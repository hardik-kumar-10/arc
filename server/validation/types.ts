// server/validation/types.ts — the validator contract (Phase 3).
//
// Pure result shapes: the validator NEVER throws. `data` uses TypeScript's built-in Record<K,V>
// (the Prisma `Record` model has no business in this layer). On failure the shape mirrors
// architecture.md §4.2 — `{ fieldErrors, formErrors }` — so Phase 4 can hand it straight to
// AppError("VALIDATION_ERROR", ..., details).

export type ValidationOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; fieldErrors: Record<string, string[]>; formErrors: string[] };

export type ValidationMode = "create" | "update";

export interface EntityValidator {
  validate(payload: unknown, mode: ValidationMode): ValidationOutcome;
}
