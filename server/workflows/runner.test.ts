// server/workflows/runner.test.ts — selection, gating, isolation, cascade cap, log bounding.
//
// A stub registry of synchronous handlers (no real writer/http needed) drives the runner. We prove:
// matching event+entity fires, non-matches are no-ops, conditions gate, unknown actions are skipped
// (run continues), a failing action is isolated (siblings still run), the cascade cap stops everything,
// and the log is bounded.

import { describe, it, expect, vi } from "vitest";
import type { AppConfig, WorkflowDef } from "@/server/config/types";
import { WorkflowRunner } from "./runner";
import {
  WORKFLOW_CODE,
  WorkflowSkip,
  type ActionRegistry,
  type WorkflowHttpClient,
  type WorkflowRecordWriter,
  type WorkflowRunContext,
} from "./types";

const noopWriter: WorkflowRecordWriter = {
  createRecord: vi.fn().mockResolvedValue(undefined),
  setFieldSilent: vi.fn().mockResolvedValue(undefined),
};
const noopHttp: WorkflowHttpClient = { post: vi.fn().mockResolvedValue({ status: 200 }) };

const configWith = (workflows: WorkflowDef[]): AppConfig => ({
  app: { name: "X" },
  entities: [],
  workflows,
  pages: [],
});

const ctx = (config: AppConfig, over: Partial<WorkflowRunContext> = {}): WorkflowRunContext => ({
  ownerId: "user_A",
  appId: "app_1",
  config,
  version: 1,
  event: "onCreate",
  entity: "Task",
  record: { id: "r1", title: "T" },
  depth: 0,
  ...over,
});

const runnerWith = (registry: ActionRegistry) => new WorkflowRunner(registry, noopWriter, noopHttp);

describe("selection", () => {
  it("fires only workflows matching event + entity (exact-case)", async () => {
    const ran = vi.fn().mockResolvedValue(undefined);
    const config = configWith([
      { trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "go" }] },
      { trigger: { event: "onUpdate", entity: "Task" }, actions: [{ type: "go" }] }, // wrong event
      { trigger: { event: "onCreate", entity: "task" }, actions: [{ type: "go" }] }, // wrong case
    ]);
    const res = await runnerWith({ go: ran }).run(ctx(config));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({ workflowIndex: 0, actionType: "go", status: "ran" });
  });

  it("no matching workflow -> empty result (no-op)", async () => {
    const config = configWith([{ trigger: { event: "onDelete", entity: "Task" }, actions: [{ type: "go" }] }]);
    const res = await runnerWith({ go: vi.fn() }).run(ctx(config));
    expect(res.entries).toHaveLength(0);
  });
});

describe("condition gating", () => {
  it("a false condition skips the workflow with a reason", async () => {
    const ran = vi.fn().mockResolvedValue(undefined);
    const config = configWith([
      {
        trigger: { event: "onCreate", entity: "Task" },
        condition: { field: "title", op: "eq", value: "Nope" },
        actions: [{ type: "go" }],
      },
    ]);
    const res = await runnerWith({ go: ran }).run(ctx(config));
    expect(ran).not.toHaveBeenCalled();
    expect(res.entries[0]).toMatchObject({ status: "skipped", code: WORKFLOW_CODE.CONDITION_NOT_MET });
  });

  it("a passing condition runs the actions", async () => {
    const ran = vi.fn().mockResolvedValue(undefined);
    const config = configWith([
      {
        trigger: { event: "onCreate", entity: "Task" },
        condition: { field: "title", op: "eq", value: "T" },
        actions: [{ type: "go" }],
      },
    ]);
    const res = await runnerWith({ go: ran }).run(ctx(config));
    expect(ran).toHaveBeenCalledOnce();
    expect(res.entries[0].status).toBe("ran");
  });
});

describe("isolation", () => {
  it("unknown action type -> skipped + logged, run continues to siblings", async () => {
    const ran = vi.fn().mockResolvedValue(undefined);
    const config = configWith([
      { trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "ghost" }, { type: "go" }] },
    ]);
    const res = await runnerWith({ go: ran }).run(ctx(config));
    expect(ran).toHaveBeenCalledOnce(); // sibling still ran
    expect(res.entries[0]).toMatchObject({ actionType: "ghost", status: "skipped", code: WORKFLOW_CODE.UNKNOWN_ACTION });
    expect(res.entries[1]).toMatchObject({ actionType: "go", status: "ran" });
  });

  it("a throwing action -> failed + logged, sibling actions still run", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("kaboom"));
    const ran = vi.fn().mockResolvedValue(undefined);
    const config = configWith([
      { trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "boom" }, { type: "go" }] },
    ]);
    const res = await runnerWith({ boom, go: ran }).run(ctx(config));
    expect(ran).toHaveBeenCalledOnce();
    expect(res.entries[0]).toMatchObject({ actionType: "boom", status: "failed", code: WORKFLOW_CODE.ACTION_FAILED, message: "kaboom" });
    expect(res.entries[1].status).toBe("ran");
  });

  it("a WorkflowSkip throw is logged as skipped (not failed)", async () => {
    const skip = vi.fn().mockRejectedValue(new WorkflowSkip("not applicable"));
    const config = configWith([{ trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "s" }] }]);
    const res = await runnerWith({ s: skip }).run(ctx(config));
    expect(res.entries[0]).toMatchObject({ status: "skipped", code: WORKFLOW_CODE.ACTION_SKIPPED });
  });
});

describe("cascade cap", () => {
  it("at the depth limit, nothing runs and one MAX_DEPTH entry is logged", async () => {
    const ran = vi.fn().mockResolvedValue(undefined);
    const config = configWith([{ trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "go" }] }]);
    const res = await runnerWith({ go: ran }).run(ctx(config, { depth: 5 }));
    expect(ran).not.toHaveBeenCalled();
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].code).toBe(WORKFLOW_CODE.MAX_DEPTH);
  });
});

describe("log bounding", () => {
  it("truncates beyond the cap and appends one LOG_TRUNCATED marker", async () => {
    // One workflow with > 200 actions, all unknown -> > 200 skipped entries -> truncation.
    const actions = Array.from({ length: 250 }, () => ({ type: "ghost" }));
    const config = configWith([{ trigger: { event: "onCreate", entity: "Task" }, actions }]);
    const res = await runnerWith({}).run(ctx(config));
    expect(res.entries.length).toBe(201); // 200 + 1 marker
    expect(res.entries[res.entries.length - 1].code).toBe(WORKFLOW_CODE.LOG_TRUNCATED);
  });
});

describe("never throws", () => {
  it("returns a result even if config.workflows is garbage", async () => {
    const bad = { app: { name: "X" }, entities: [], workflows: "not-an-array", pages: [] } as unknown as AppConfig;
    const res = await runnerWith({}).run(ctx(bad));
    expect(res.entries).toEqual([]);
  });
});
