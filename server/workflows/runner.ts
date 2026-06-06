// server/workflows/runner.ts — selection, condition gating, isolation, cascade cap, bounded log.
//
// Invoked AFTER a CRUD write commits. The runner NEVER throws to its caller: every action runs in its
// own try/catch, an unknown action is skipped, a failing action is isolated, cascades are depth-bounded,
// and even an unexpected internal error becomes a logged entry. RecordService treats the result as
// informational only — a workflow outcome can never alter the CRUD response or roll back the write.

import { evaluateCondition } from "./conditions";
import {
  WORKFLOW_CODE,
  WorkflowSkip,
  type ActionRegistry,
  type WorkflowDispatcher,
  type WorkflowHttpClient,
  type WorkflowLogEntry,
  type WorkflowRecordWriter,
  type WorkflowRunContext,
  type WorkflowRunResult,
} from "./types";

/** Cascading writes deeper than this stop and log — bounds workflow→create→workflow loops. */
const MAX_CASCADE_DEPTH = 5;
/** Phase 2 diagnostics-cap style: at most this many log entries, then one LOG_TRUNCATED marker. */
const LOG_CAP = 200;

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";

export class WorkflowRunner implements WorkflowDispatcher {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly writer: WorkflowRecordWriter,
    private readonly http: WorkflowHttpClient,
  ) {}

  async run(ctx: WorkflowRunContext): Promise<WorkflowRunResult> {
    const entries: WorkflowLogEntry[] = [];
    let truncated = false;

    /** Append an entry; returns false once the cap is hit (caller should stop). */
    const add = (entry: WorkflowLogEntry): boolean => {
      if (entries.length < LOG_CAP) {
        entries.push(entry);
        return true;
      }
      if (!truncated) {
        truncated = true;
        entries.push({ workflowIndex: -1, actionType: "", status: "skipped", code: WORKFLOW_CODE.LOG_TRUNCATED });
      }
      return false;
    };

    try {
      // 1. Cascade cap — past the limit, run nothing.
      if (ctx.depth >= MAX_CASCADE_DEPTH) {
        add({
          workflowIndex: -1,
          actionType: "",
          status: "skipped",
          code: WORKFLOW_CODE.MAX_DEPTH,
          message: `cascade depth ${ctx.depth} reached the limit of ${MAX_CASCADE_DEPTH}`,
        });
        return { entries };
      }

      const workflows = Array.isArray(ctx.config.workflows) ? ctx.config.workflows : [];

      for (let i = 0; i < workflows.length; i++) {
        const wf = workflows[i];

        // 2. Select by event + entity (exact-case). Non-matches produce no log noise.
        if (!wf?.trigger || wf.trigger.event !== ctx.event || wf.trigger.entity !== ctx.entity) continue;

        // 3. Gate on condition (fail closed on anything unevaluable).
        const gate = evaluateCondition(wf.condition, ctx.record);
        if (!gate.pass) {
          if (!add({ workflowIndex: i, actionType: "", status: "skipped", code: WORKFLOW_CODE.CONDITION_NOT_MET, message: gate.reason })) return { entries };
          continue;
        }

        // 4. Run each action, isolated.
        const actions = Array.isArray(wf.actions) ? wf.actions : [];
        for (const action of actions) {
          const actionType = typeof action?.type === "string" ? action.type : "";
          const message = typeof action?.message === "string" ? action.message : undefined;
          const handler = this.registry[actionType];

          if (!handler) {
            if (!add({ workflowIndex: i, actionType, status: "skipped", code: WORKFLOW_CODE.UNKNOWN_ACTION, message })) return { entries };
            continue;
          }

          try {
            await handler(action, ctx, { writer: this.writer, http: this.http });
            if (!add({ workflowIndex: i, actionType, status: "ran", message })) return { entries };
          } catch (err) {
            const skipped = err instanceof WorkflowSkip;
            if (
              !add({
                workflowIndex: i,
                actionType,
                status: skipped ? "skipped" : "failed",
                code: skipped ? WORKFLOW_CODE.ACTION_SKIPPED : WORKFLOW_CODE.ACTION_FAILED,
                message: messageOf(err),
              })
            )
              return { entries };
          }
        }
      }
    } catch (err) {
      // Defensive: the runner must never throw, even on an unexpected internal fault.
      add({ workflowIndex: -1, actionType: "", status: "failed", code: WORKFLOW_CODE.RUNNER_ERROR, message: messageOf(err) });
    }

    return { entries };
  }
}
