// server/workflows/actions.test.ts — built-in action handlers, DB/network-free via stub seams.
//
// Each handler is invoked directly with a stub WorkflowRecordWriter + WorkflowHttpClient. We assert
// the side effect (or thrown error the runner would catch), owner/app confinement, depth+1 cascade,
// and the silent-update path that prevents onUpdate self-loops.

import { describe, it, expect, vi } from "vitest";
import type { AppConfig } from "@/server/config/types";
import { builtinActions } from "./actions";
import { WorkflowSkip, type WorkflowHttpClient, type WorkflowRecordWriter, type WorkflowRunContext } from "./types";

const CONFIG: AppConfig = { app: { name: "X" }, entities: [], workflows: [], pages: [] };

const ctx = (over: Partial<WorkflowRunContext> = {}): WorkflowRunContext => ({
  ownerId: "user_A",
  appId: "app_1",
  config: CONFIG,
  version: 1,
  event: "onCreate",
  entity: "Task",
  record: { id: "rec_1", title: "T" },
  depth: 0,
  ...over,
});

const makeWriter = () => ({
  createRecord: vi.fn<WorkflowRecordWriter["createRecord"]>().mockResolvedValue(undefined),
  setFieldSilent: vi.fn<WorkflowRecordWriter["setFieldSilent"]>().mockResolvedValue(undefined),
});

const makeHttp = (status = 200) => ({
  post: vi.fn<WorkflowHttpClient["post"]>().mockResolvedValue({ status }),
});

const deps = (writer: WorkflowRecordWriter, http: WorkflowHttpClient) => ({ writer, http });

describe("log", () => {
  it("is a safe no-op (no writes, no http)", async () => {
    const writer = makeWriter();
    const http = makeHttp();
    await expect(builtinActions.log({ type: "log", message: "hi" }, ctx(), deps(writer, http))).resolves.toBeUndefined();
    expect(writer.createRecord).not.toHaveBeenCalled();
    expect(writer.setFieldSilent).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe("setField", () => {
  it("calls setFieldSilent (the no-re-fire path) on the triggering record, owner/app scoped", async () => {
    const writer = makeWriter();
    const http = makeHttp();
    await builtinActions.setField({ type: "setField", field: "done", value: true }, ctx(), deps(writer, http));
    expect(writer.setFieldSilent).toHaveBeenCalledWith({
      ownerId: "user_A",
      appId: "app_1",
      entity: "Task",
      id: "rec_1",
      field: "done",
      value: true,
    });
  });

  it("coerces the value through stored representation (Date -> ISO)", async () => {
    const writer = makeWriter();
    const iso = "2026-01-02T03:04:05.000Z";
    await builtinActions.setField({ type: "setField", field: "due", value: new Date(iso) }, ctx(), deps(writer, makeHttp()));
    expect(writer.setFieldSilent).toHaveBeenCalledWith(expect.objectContaining({ value: iso }));
  });

  it("on a deleted record requests a graceful skip (throws WorkflowSkip)", async () => {
    const writer = makeWriter();
    await expect(
      builtinActions.setField({ type: "setField", field: "x", value: 1 }, ctx({ event: "onDelete" }), deps(writer, makeHttp())),
    ).rejects.toBeInstanceOf(WorkflowSkip);
    expect(writer.setFieldSilent).not.toHaveBeenCalled();
  });

  it("missing 'field' throws (runner will isolate as failed)", async () => {
    await expect(builtinActions.setField({ type: "setField" }, ctx(), deps(makeWriter(), makeHttp()))).rejects.toThrow();
  });
});

describe("createRecord", () => {
  it("creates into the target entity at depth+1, same owner/app", async () => {
    const writer = makeWriter();
    await builtinActions.createRecord(
      { type: "createRecord", entity: "Audit", data: { msg: "created" } },
      ctx({ depth: 2 }),
      deps(writer, makeHttp()),
    );
    expect(writer.createRecord).toHaveBeenCalledWith({
      ownerId: "user_A",
      appId: "app_1",
      entity: "Audit",
      data: { msg: "created" },
      depth: 3, // depth+1
    });
  });

  it("non-object data defaults to {}", async () => {
    const writer = makeWriter();
    await builtinActions.createRecord({ type: "createRecord", entity: "Audit", data: 42 }, ctx(), deps(writer, makeHttp()));
    expect(writer.createRecord).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
  });

  it("missing 'entity' throws", async () => {
    await expect(builtinActions.createRecord({ type: "createRecord" }, ctx(), deps(makeWriter(), makeHttp()))).rejects.toThrow();
  });
});

describe("webhook", () => {
  it("posts via the injected client and resolves on 2xx", async () => {
    const http = makeHttp(200);
    await builtinActions.webhook({ type: "webhook", url: "https://x.test/hook" }, ctx(), deps(makeWriter(), http));
    expect(http.post).toHaveBeenCalledWith(
      "https://x.test/hook",
      expect.objectContaining({ event: "onCreate", entity: "Task" }),
      { timeoutMs: 5000 },
    );
  });

  it("a non-2xx response throws (runner logs failed)", async () => {
    await expect(
      builtinActions.webhook({ type: "webhook", url: "https://x.test" }, ctx(), deps(makeWriter(), makeHttp(500))),
    ).rejects.toThrow(/non-2xx/);
  });

  it("a client throw (timeout/network) propagates for the runner to catch", async () => {
    const http: WorkflowHttpClient = { post: vi.fn().mockRejectedValue(new Error("aborted")) };
    await expect(
      builtinActions.webhook({ type: "webhook", url: "https://x.test" }, ctx(), deps(makeWriter(), http)),
    ).rejects.toThrow("aborted");
  });

  it("missing 'url' throws", async () => {
    await expect(builtinActions.webhook({ type: "webhook" }, ctx(), deps(makeWriter(), makeHttp()))).rejects.toThrow();
  });
});
