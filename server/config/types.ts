// server/config/types.ts — the config domain contract (Phase 2).
//
// These are the shapes the compiler GUARANTEES on output: every array is present (never
// undefined), and every value has been normalized/coerced or dropped. The compiler's *input*
// is always `unknown` — it assumes nothing about its argument.

import { FIELD_TYPES } from "./meta-schema";

/** The closed set of field types the backend can build a validator for (Phase 3). */
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Field names that collide with the `Record` table's system columns (Phase 1 schema). A user
 * field with one of these names cannot coexist with the real column in Phase 4, so the compiler
 * drops it (`FIELD_RESERVED_NAME`). Exported as the single source for any later Phase 4 check.
 */
export const RESERVED_FIELD_NAMES = [
  "id",
  "ownerId",
  "version",
  "createdAt",
  "updatedAt",
] as const;

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean; // default false
  default?: unknown; // present only when type-compatible
  values?: string[]; // present only when type === "enum"
  ref?: string; // present only when type === "reference"
}

export interface EntityDef {
  name: string; // unique within the config (case-sensitive)
  fields: FieldDef[];
}

export type WorkflowEvent = "onCreate" | "onUpdate" | "onDelete";

export interface WorkflowAction {
  type: string;
  [k: string]: unknown;
}

export interface WorkflowDef {
  trigger: { event: WorkflowEvent; entity: string };
  condition?: unknown; // shape validated in Phase 6; only structurally preserved here
  actions: WorkflowAction[];
}

/** The backend treats UI nodes as opaque-but-structural: it checks `type`, never the semantics. */
export interface ComponentNode {
  type: string;
  props?: Record<string, unknown>;
  children?: ComponentNode[];
}

export interface PageDef {
  path: string;
  title?: string;
  components?: ComponentNode[];
}

export interface AppConfig {
  app: { name: string };
  entities: EntityDef[];
  workflows: WorkflowDef[];
  pages: PageDef[];
}

export interface Diagnostic {
  level: "error" | "warning" | "info";
  code: string; // stable machine code, e.g. "FIELD_UNKNOWN_TYPE"
  path: string; // locator, e.g. "entities[2].fields[0].type"
  message: string; // human-readable
}

export interface CompileResult {
  config: AppConfig;
  diagnostics: Diagnostic[];
}
