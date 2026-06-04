// server/config/compiler.ts — the pure config compiler (Phase 2 core deliverable).
//
// compileConfig(input: unknown) ALWAYS returns a fully-populated AppConfig plus a diagnostics
// list. It NEVER throws and performs NO I/O (no DB, no network, no Date.now() in the output),
// so it is deterministic and trivially unit-testable. The strategy is "normalize, never reject":
// a bad field drops that field, a bad entity drops that entity, a bad workflow drops that
// workflow — each drop/repair appends a Diagnostic with a stable machine code.

import {
  isDefaultCompatible,
  isFieldType,
  isNonEmptyString,
  isPlainObject,
  isStringArray,
} from "./meta-schema";
import {
  RESERVED_FIELD_NAMES,
  type AppConfig,
  type ComponentNode,
  type CompileResult,
  type Diagnostic,
  type EntityDef,
  type FieldDef,
  type PageDef,
  type WorkflowAction,
  type WorkflowDef,
  type WorkflowEvent,
} from "./types";

/** Hard caps that keep output bounded for adversarial input (decisions 7 & 8 in phase2.md). */
const MAX_DIAGNOSTICS = 1000;
const MAX_COMPONENT_DEPTH = 50;

const WORKFLOW_EVENTS: readonly WorkflowEvent[] = ["onCreate", "onUpdate", "onDelete"];
const RESERVED = RESERVED_FIELD_NAMES as readonly string[];

function emptyConfig(): AppConfig {
  return { app: { name: "Untitled" }, entities: [], workflows: [], pages: [] };
}

/**
 * Bounded diagnostics collector. Once it reaches the cap it replaces the would-be next entry
 * with a single DIAGNOSTICS_TRUNCATED marker and silently ignores everything after — so the
 * report is bounded even though normalization of the config itself still runs to completion.
 */
class Diagnostics {
  readonly list: Diagnostic[] = [];
  private stopped = false;

  push(level: Diagnostic["level"], code: string, path: string, message: string): void {
    if (this.stopped) return;
    if (this.list.length >= MAX_DIAGNOSTICS - 1) {
      this.list.push({
        level: "warning",
        code: "DIAGNOSTICS_TRUNCATED",
        path: "",
        message: "Too many issues; further diagnostics were omitted.",
      });
      this.stopped = true;
      return;
    }
    this.list.push({ level, code, path, message });
  }
}

export function compileConfig(input: unknown): CompileResult {
  const diag = new Diagnostics();

  // Rule 1 — top level.
  if (!isPlainObject(input)) {
    diag.push("error", "CONFIG_NOT_OBJECT", "", "Top-level config must be an object.");
    return { config: emptyConfig(), diagnostics: diag.list };
  }

  const app = normalizeApp(input.app, diag);
  const entities = normalizeEntities(input.entities, diag);
  const entityNames = new Set(entities.map((e) => e.name));
  const workflows = normalizeWorkflows(input.workflows, entityNames, diag);
  const pages = normalizePages(input.pages, diag);

  return { config: { app, entities, workflows, pages }, diagnostics: diag.list };
}

// Rule 2 — app.
function normalizeApp(raw: unknown, diag: Diagnostics): { name: string } {
  if (raw === undefined) {
    diag.push("info", "APP_MISSING", "app", "No `app` block; defaulting name to \"Untitled\".");
    return { name: "Untitled" };
  }
  if (!isPlainObject(raw)) {
    diag.push("warning", "APP_NAME_DEFAULTED", "app", "`app` is not an object; name defaulted.");
    return { name: "Untitled" };
  }
  const extra = Object.keys(raw).filter((k) => k !== "name");
  if (extra.length > 0) {
    diag.push("info", "APP_UNKNOWN_KEYS", "app", `Stripped unknown app keys: ${extra.join(", ")}.`);
  }
  if (!isNonEmptyString(raw.name)) {
    diag.push("warning", "APP_NAME_DEFAULTED", "app.name", "`app.name` missing/invalid; defaulted.");
    return { name: "Untitled" };
  }
  return { name: raw.name };
}

// Rule 3 — entities (two-pass: names first, then fields so references can resolve).
function normalizeEntities(raw: unknown, diag: Diagnostics): EntityDef[] {
  if (raw === undefined) {
    diag.push("info", "ENTITIES_MISSING", "entities", "No `entities`; treated as empty.");
    return [];
  }
  if (!Array.isArray(raw)) {
    diag.push("error", "ENTITIES_NOT_ARRAY", "entities", "`entities` must be an array.");
    return [];
  }

  // Pass 1 — resolve surviving entity names (drop nameless / duplicates).
  const seen = new Set<string>();
  const survivors: { name: string; rawFields: unknown; index: number }[] = [];
  raw.forEach((ent, i) => {
    const path = `entities[${i}]`;
    if (!isPlainObject(ent)) {
      diag.push("error", "ENTITY_NOT_OBJECT", path, "Entity must be an object.");
      return;
    }
    if (!isNonEmptyString(ent.name)) {
      diag.push("error", "ENTITY_NO_NAME", path, "Entity is missing a non-empty `name`.");
      return;
    }
    if (seen.has(ent.name)) {
      diag.push("error", "ENTITY_DUPLICATE", `${path}.name`, `Duplicate entity "${ent.name}" dropped.`);
      return;
    }
    seen.add(ent.name);
    survivors.push({ name: ent.name, rawFields: ent.fields, index: i });
  });

  // Pass 2 — normalize fields now that the full entity-name set is known.
  return survivors.map((s) => {
    const fields = normalizeFields(s.rawFields, seen, `entities[${s.index}]`, diag);
    if (fields.length === 0) {
      diag.push("warning", "ENTITY_NO_FIELDS", `entities[${s.index}]`, `Entity "${s.name}" has no fields.`);
    }
    return { name: s.name, fields };
  });
}

const KNOWN_FIELD_KEYS = new Set(["name", "type", "required", "default", "values", "ref"]);

function normalizeFields(
  raw: unknown,
  entityNames: Set<string>,
  entityPath: string,
  diag: Diagnostics,
): FieldDef[] {
  if (!Array.isArray(raw)) {
    diag.push("warning", "ENTITY_FIELDS_NOT_ARRAY", `${entityPath}.fields`, "`fields` not an array; treated as empty.");
    return [];
  }

  const seenFields = new Set<string>();
  const out: FieldDef[] = [];

  raw.forEach((f, i) => {
    const path = `${entityPath}.fields[${i}]`;
    if (!isPlainObject(f)) {
      diag.push("error", "FIELD_NOT_OBJECT", path, "Field must be an object.");
      return;
    }
    if (!isNonEmptyString(f.name)) {
      diag.push("error", "FIELD_NO_NAME", path, "Field is missing a non-empty `name`.");
      return;
    }
    const name = f.name;
    if (seenFields.has(name)) {
      diag.push("error", "FIELD_DUPLICATE", `${path}.name`, `Duplicate field "${name}" dropped.`);
      return;
    }
    if (RESERVED.includes(name)) {
      diag.push("error", "FIELD_RESERVED_NAME", `${path}.name`, `Field name "${name}" is reserved.`);
      return;
    }
    if (!isFieldType(f.type)) {
      diag.push("error", "FIELD_UNKNOWN_TYPE", `${path}.type`, `Unknown field type for "${name}".`);
      return;
    }
    const type = f.type;

    const field: FieldDef = { name, type };

    // required — coerce; non-boolean defaults to false (omitted) with a warning.
    if (f.required !== undefined) {
      if (typeof f.required === "boolean") field.required = f.required;
      else
        diag.push("warning", "FIELD_REQUIRED_DEFAULTED", `${path}.required`, "`required` not boolean; defaulted to false.");
    }

    // enum — needs non-empty string values, else the whole field is dropped.
    if (type === "enum") {
      if (!isStringArray(f.values) || f.values.length === 0) {
        diag.push("error", "ENUM_NO_VALUES", `${path}.values`, `Enum field "${name}" needs non-empty string \`values\`.`);
        return;
      }
      field.values = f.values;
    }

    // reference — `ref` must name a surviving entity, else the field is dropped.
    if (type === "reference") {
      if (typeof f.ref !== "string" || !entityNames.has(f.ref)) {
        diag.push("error", "REF_UNKNOWN_ENTITY", `${path}.ref`, `Reference field "${name}" points to unknown entity.`);
        return;
      }
      field.ref = f.ref;
    }

    // default — kept only if type-compatible; otherwise dropped, field survives.
    if (f.default !== undefined) {
      if (isDefaultCompatible(type, f.default, field.values)) field.default = f.default;
      else diag.push("warning", "DEFAULT_DROPPED", `${path}.default`, `Incompatible default for "${name}" dropped.`);
    }

    const extra = Object.keys(f).filter((k) => !KNOWN_FIELD_KEYS.has(k));
    if (extra.length > 0) {
      diag.push("info", "FIELD_UNKNOWN_KEYS", path, `Stripped unknown field keys: ${extra.join(", ")}.`);
    }

    seenFields.add(name);
    out.push(field);
  });

  return out;
}

// Rule 4 — workflows.
function normalizeWorkflows(raw: unknown, entityNames: Set<string>, diag: Diagnostics): WorkflowDef[] {
  if (raw === undefined) {
    diag.push("info", "WORKFLOWS_MISSING", "workflows", "No `workflows`; treated as empty.");
    return [];
  }
  if (!Array.isArray(raw)) {
    diag.push("error", "WORKFLOWS_NOT_ARRAY", "workflows", "`workflows` must be an array.");
    return [];
  }

  const out: WorkflowDef[] = [];
  raw.forEach((wf, i) => {
    const path = `workflows[${i}]`;
    if (!isPlainObject(wf)) {
      diag.push("error", "WORKFLOW_NOT_OBJECT", path, "Workflow must be an object.");
      return;
    }
    if (!isPlainObject(wf.trigger)) {
      diag.push("error", "WORKFLOW_BAD_TRIGGER", `${path}.trigger`, "Workflow `trigger` must be an object.");
      return;
    }
    const event = wf.trigger.event;
    if (typeof event !== "string" || !(WORKFLOW_EVENTS as readonly string[]).includes(event)) {
      diag.push("error", "WORKFLOW_BAD_TRIGGER", `${path}.trigger.event`, "Unknown workflow `trigger.event`.");
      return;
    }
    if (typeof wf.trigger.entity !== "string" || !entityNames.has(wf.trigger.entity)) {
      diag.push("error", "WORKFLOW_UNKNOWN_ENTITY", `${path}.trigger.entity`, "Workflow targets an unknown entity.");
      return;
    }
    const triggerEntity = wf.trigger.entity;

    if (!Array.isArray(wf.actions) || wf.actions.length === 0) {
      diag.push("error", "WORKFLOW_NO_ACTIONS", `${path}.actions`, "Workflow needs a non-empty `actions` array.");
      return;
    }
    const actions: WorkflowAction[] = [];
    wf.actions.forEach((a, j) => {
      if (!isPlainObject(a) || !isNonEmptyString(a.type)) {
        diag.push("warning", "WORKFLOW_ACTION_DROPPED", `${path}.actions[${j}]`, "Action missing string `type` dropped.");
        return;
      }
      actions.push(a as WorkflowAction);
    });
    if (actions.length === 0) {
      diag.push("error", "WORKFLOW_NO_ACTIONS", `${path}.actions`, "Workflow has no valid actions left.");
      return;
    }

    const workflow: WorkflowDef = {
      trigger: { event: event as WorkflowEvent, entity: triggerEntity },
      actions,
    };
    if (wf.condition !== undefined) workflow.condition = wf.condition;
    out.push(workflow);
  });

  return out;
}

// Rule 5 — pages (structural only).
function normalizePages(raw: unknown, diag: Diagnostics): PageDef[] {
  if (raw === undefined) {
    diag.push("info", "PAGES_MISSING", "pages", "No `pages`; treated as empty.");
    return [];
  }
  if (!Array.isArray(raw)) {
    diag.push("error", "PAGES_NOT_ARRAY", "pages", "`pages` must be an array.");
    return [];
  }

  const seenPaths = new Set<string>();
  const out: PageDef[] = [];
  raw.forEach((p, i) => {
    const path = `pages[${i}]`;
    if (!isPlainObject(p)) {
      diag.push("error", "PAGE_NOT_OBJECT", path, "Page must be an object.");
      return;
    }
    if (!isNonEmptyString(p.path)) {
      diag.push("error", "PAGE_NO_PATH", `${path}.path`, "Page is missing a non-empty `path`.");
      return;
    }
    if (seenPaths.has(p.path)) {
      diag.push("warning", "PAGE_DUPLICATE_PATH", `${path}.path`, `Duplicate page path "${p.path}" dropped.`);
      return;
    }
    seenPaths.add(p.path);

    const page: PageDef = { path: p.path };
    if (typeof p.title === "string") page.title = p.title;
    if (p.components !== undefined) {
      page.components = normalizeComponents(p.components, `${path}.components`, 1, diag);
    }
    out.push(page);
  });

  return out;
}

function normalizeComponents(
  raw: unknown,
  path: string,
  depth: number,
  diag: Diagnostics,
): ComponentNode[] {
  if (!Array.isArray(raw)) {
    diag.push("warning", "COMPONENTS_NOT_ARRAY", path, "`components` not an array; treated as empty.");
    return [];
  }
  if (depth > MAX_COMPONENT_DEPTH) {
    diag.push("warning", "COMPONENT_MAX_DEPTH", path, `Component nesting exceeded depth ${MAX_COMPONENT_DEPTH}; subtree dropped.`);
    return [];
  }

  const out: ComponentNode[] = [];
  raw.forEach((node, i) => {
    const np = `${path}[${i}]`;
    if (!isPlainObject(node) || !isNonEmptyString(node.type)) {
      diag.push("error", "COMPONENT_NO_TYPE", np, "Component node is missing a string `type`.");
      return;
    }
    const result: ComponentNode = { type: node.type };
    if (isPlainObject(node.props)) result.props = node.props;
    if (node.children !== undefined) {
      result.children = normalizeComponents(node.children, `${np}.children`, depth + 1, diag);
    }
    out.push(result);
  });

  return out;
}
