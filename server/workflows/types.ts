// server/workflows/types.ts — the workflow domain contract (Phase 6).
//
// The runner executes config-declared workflows AFTER a CRUD write has committed. It is best-effort:
// a workflow can never fail or roll back the originating write, and the runner never throws to its
// caller. These types pin the seams the runner depends on (a record writer, an HTTP client, an action
// registry) so the whole subsystem stays DB- and network-free in tests via constructor injection.

import type { AppConfig } from "@/server/config/types";

export type WorkflowEvent = "onCreate" | "onUpdate" | "onDelete";

export interface WorkflowRunContext {
  ownerId: string;
  appId: string;
  config: AppConfig; // active normalized config (for entity lookups in actions)
  version: number;
  event: WorkflowEvent;
  entity: string;
  record: Record<string, unknown>; // the final persisted record (Phase 5 representation)
  previous?: Record<string, unknown>; // prior state for onUpdate, if available
  depth: number; // 0 for user-initiated writes; +1 per cascading write
}

export type WorkflowLogStatus = "ran" | "skipped" | "failed";

export interface WorkflowLogEntry {
  workflowIndex: number;
  actionType: string;
  status: WorkflowLogStatus;
  code?: string; // workflow-log namespace (see WORKFLOW_CODE), never an HTTP ErrorCode
  message?: string;
}

export interface WorkflowRunResult {
  entries: WorkflowLogEntry[]; // bounded (see LOG_CAP in the runner)
}

/**
 * Workflow-log codes — a THIRD namespace, separate from HTTP `ErrorCode` and the Phase 2 diagnostic /
 * Phase 5 drift codes. They are informational only and never map to an HTTP status.
 */
export const WORKFLOW_CODE = {
  UNKNOWN_ACTION: "WORKFLOW_UNKNOWN_ACTION",
  ACTION_FAILED: "WORKFLOW_ACTION_FAILED",
  ACTION_SKIPPED: "WORKFLOW_ACTION_SKIPPED",
  CONDITION_NOT_MET: "WORKFLOW_CONDITION_NOT_MET",
  MAX_DEPTH: "WORKFLOW_MAX_DEPTH",
  LOG_TRUNCATED: "WORKFLOW_LOG_TRUNCATED",
  RUNNER_ERROR: "WORKFLOW_RUNNER_ERROR",
} as const;

export type WorkflowCode = (typeof WORKFLOW_CODE)[keyof typeof WORKFLOW_CODE];

/**
 * Thrown by an action handler to request a graceful SKIP (logged `skipped`, not `failed`). Any other
 * thrown value is treated as a failure. Lets handlers distinguish "not applicable" from "errored"
 * without the handler needing access to the run log.
 */
export class WorkflowSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSkip";
  }
}

// ---- narrow seams the runner depends on (injected) -------------------------

export interface WorkflowRecordWriter {
  /** Create a record that DOES cascade workflows at depth+1 (bounded by the cascade cap). */
  createRecord(input: {
    ownerId: string;
    appId: string;
    entity: string;
    data: Record<string, unknown>;
    depth: number;
  }): Promise<void>;

  /** Silent update of the TRIGGERING record that does NOT re-fire workflows (prevents self-loops). */
  setFieldSilent(input: {
    ownerId: string;
    appId: string;
    entity: string;
    id: string;
    field: string;
    value: unknown;
  }): Promise<void>;
}

export interface WorkflowHttpClient {
  post(url: string, body: unknown, opts?: { timeoutMs?: number }): Promise<{ status: number }>;
}

export type ActionDeps = { writer: WorkflowRecordWriter; http: WorkflowHttpClient };

export type ActionHandler = (
  action: Record<string, unknown>,
  ctx: WorkflowRunContext,
  deps: ActionDeps,
) => Promise<void>;

export type ActionRegistry = Record<string, ActionHandler>;

/** What RecordService depends on — a narrow seam, injected after construction to break the cycle. */
export interface WorkflowDispatcher {
  run(ctx: WorkflowRunContext): Promise<WorkflowRunResult>;
}
