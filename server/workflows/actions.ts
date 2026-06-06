// server/workflows/actions.ts — the action registry and built-in handlers.
//
// "Registry, not codegen": an action's `type` string selects a handler. Adding a new action type
// later is one registry entry, no core change — the extensibility story. An UNKNOWN type is simply
// not in the registry; the runner logs WORKFLOW_UNKNOWN_ACTION and skips it. Handlers may throw on
// bad input or external failure — the RUNNER catches and isolates; handlers must NOT swallow silently.
// A handler throws `WorkflowSkip` to request a graceful skip (e.g. setField on a deleted record).

import { toStoredRepr } from "@/server/records/value-repr";
import type { ActionHandler, ActionRegistry } from "./types";
import { WorkflowSkip } from "./types";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `log` — no side effect; the runner records the entry (and surfaces `action.message`). Always safe. */
const log: ActionHandler = async () => {
  // Intentionally a no-op: its value is the logged `ran` entry. Ideal for demos/tests.
};

/**
 * `setField` — set a field on the TRIGGERING record via a SILENT write (does not re-fire workflows,
 * so an onUpdate workflow cannot loop). Value is coerced through `toStoredRepr` to match storage.
 */
const setField: ActionHandler = async (action, ctx, { writer }) => {
  const field = action.field;
  if (typeof field !== "string" || field.length === 0) throw new Error("setField requires a string 'field'");
  if (ctx.event === "onDelete") throw new WorkflowSkip("setField cannot run on a deleted record");

  const id = ctx.record.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("setField: triggering record has no id");

  await writer.setFieldSilent({
    ownerId: ctx.ownerId,
    appId: ctx.appId,
    entity: ctx.entity,
    id,
    field,
    value: toStoredRepr(action.value),
  });
};

/**
 * `createRecord` — create a record in a target entity within the SAME owner/app. This cascades: the
 * created record fires its own onCreate at depth+1 (bounded by the runner's cascade cap). Data flows
 * through the normal Phase 3/4 create path (validated/coerced).
 */
const createRecord: ActionHandler = async (action, ctx, { writer }) => {
  const entity = action.entity;
  if (typeof entity !== "string" || entity.length === 0) throw new Error("createRecord requires a string 'entity'");
  const data = isPlainObject(action.data) ? action.data : {};

  await writer.createRecord({
    ownerId: ctx.ownerId,
    appId: ctx.appId,
    entity,
    data,
    depth: ctx.depth + 1,
  });
};

/**
 * `webhook` — POST to an external URL via the injected client. A non-2xx, a timeout, or a network
 * error throws -> the runner logs a `failed` action and isolates it. Never rolls back the write.
 */
const webhook: ActionHandler = async (action, ctx, { http }) => {
  const url = action.url;
  if (typeof url !== "string" || url.length === 0) throw new Error("webhook requires a string 'url'");
  const payload =
    "payload" in action ? action.payload : { event: ctx.event, entity: ctx.entity, record: ctx.record };
  const timeoutMs = typeof action.timeoutMs === "number" ? action.timeoutMs : 5000;

  const res = await http.post(url, payload, { timeoutMs });
  if (res.status < 200 || res.status >= 300) throw new Error(`webhook returned non-2xx status ${res.status}`);
};

/** The built-in registry. Extend by adding an entry — no core change required. */
export const builtinActions: ActionRegistry = { log, setField, createRecord, webhook };
