// server/records/record-service.test.ts — RecordService behavior, fully DB-free.
//
// A stub ActiveConfigReader returns a fixed config + version; an in-memory RecordRepository mimics
// the Prisma impl (owner+app+entity scope, JSONB round-trip so coerced Dates come back as ISO
// strings, equality filtering, system-column sort, pagination). No Prisma, no DB.

import { describe, it, expect, beforeEach } from "vitest";
import { AppError } from "@/server/http/errors";
import type { AppConfig } from "@/server/config/types";
import { RecordService, type ActiveConfigReader } from "./record-service";
import type { ListQuery, RecordRepository, StoredRecord } from "./record-repository";
import { readDriftMeta, readResponseMeta } from "./serialize";
import type { DriftNote } from "./project";
import { RecordServiceWorkflowWriter } from "@/server/workflows/record-writer";
import { WorkflowRunner } from "@/server/workflows/runner";
import { builtinActions } from "@/server/workflows/actions";
import type { WorkflowHttpClient } from "@/server/workflows/types";

const APP_ID = "app_1";
const ACTIVE_VERSION = 3;

const CONFIG: AppConfig = {
  app: { name: "Tracker" },
  entities: [
    { name: "User", fields: [{ name: "email", type: "string", required: true }] },
    {
      name: "Task",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "done", type: "boolean", default: false },
        { name: "priority", type: "number" },
        { name: "due", type: "date" },
        { name: "status", type: "enum", values: ["open", "closed"] },
        { name: "assignee", type: "reference", ref: "User" },
      ],
    },
  ],
  workflows: [],
  pages: [],
};

const stubReader = (config: AppConfig | null): ActiveConfigReader => ({
  async getActive() {
    return config ? { config, version: ACTIVE_VERSION } : null;
  },
});

/** In-memory repository mirroring the Prisma impl's scope + JSONB-serialization semantics. */
function makeRepo(): RecordRepository {
  const rows = new Map<string, StoredRecord>();
  let seq = 0;

  const scoped = (r: StoredRecord, s: { appId: string; entity: string; ownerId: string }) =>
    r.appId === s.appId && r.entity === s.entity && r.ownerId === s.ownerId;

  const clone = (data: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(JSON.stringify(data)) as Record<string, unknown>;

  const matchesFilters = (data: Record<string, unknown>, filters: ListQuery["filters"]) =>
    !filters || filters.every((f) => data[f.field] === f.value);

  return {
    async create(input) {
      seq += 1;
      const now = new Date(Date.now() + seq); // monotonic so createdAt ordering is stable
      const row: StoredRecord = {
        id: `rec_${seq}`,
        appId: input.appId,
        entity: input.entity,
        ownerId: input.ownerId,
        data: clone(input.data),
        version: input.version,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return { ...row, data: clone(row.data) };
    },

    async getById(input) {
      const row = rows.get(input.id);
      if (!row || !scoped(row, input)) return null;
      return { ...row, data: clone(row.data) };
    },

    async list(input) {
      let items = [...rows.values()].filter(
        (r) => scoped(r, input) && matchesFilters(r.data, input.query.filters),
      );
      const { sort, page, limit } = input.query;
      const field = sort?.field ?? "createdAt";
      const dir = sort?.dir ?? "desc";
      items.sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === "asc" ? cmp : -cmp;
      });
      const total = items.length;
      items = items.slice((page - 1) * limit, (page - 1) * limit + limit);
      return { items: items.map((r) => ({ ...r, data: clone(r.data) })), total };
    },

    async update(input) {
      const row = rows.get(input.id);
      if (!row || !scoped(row, input)) return null;
      const updated: StoredRecord = {
        ...row,
        data: clone(input.data),
        version: input.version,
        updatedAt: new Date(Date.now() + ++seq),
      };
      rows.set(row.id, updated);
      return { ...updated, data: clone(updated.data) };
    },

    async delete(input) {
      const row = rows.get(input.id);
      if (!row || !scoped(row, input)) return false;
      rows.delete(input.id);
      return true;
    },

    async exists(input) {
      const row = rows.get(input.id);
      return !!row && scoped(row, input);
    },
  };
}

const USER_A = "user_A";
const USER_B = "user_B";

let repo: RecordRepository;
let svc: RecordService;

beforeEach(() => {
  repo = makeRepo();
  svc = new RecordService(stubReader(CONFIG), repo);
});

const sp = (qs = "") => new URLSearchParams(qs);

describe("lifecycle", () => {
  it("create -> get -> list -> update -> delete on a defined entity", async () => {
    const created = await svc.create({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      body: { title: "Write tests" },
    });
    expect(created.id).toBeTruthy();
    expect(created.title).toBe("Write tests");
    expect(created.done).toBe(false); // default applied on create
    expect(created.version).toBe(ACTIVE_VERSION); // stamped with active version

    const fetched = await svc.get({ ownerId: USER_A, appId: APP_ID, entity: "Task", id: created.id });
    expect(fetched.title).toBe("Write tests");

    const listed = await svc.list({ ownerId: USER_A, appId: APP_ID, entity: "Task", searchParams: sp() });
    expect(listed.items).toHaveLength(1);
    expect(listed.meta).toEqual({ page: 1, limit: 20, total: 1 });

    const updated = await svc.update({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      id: created.id,
      body: { done: true },
    });
    expect(updated.done).toBe(true);
    expect(updated.title).toBe("Write tests"); // untouched

    const del = await svc.delete({ ownerId: USER_A, appId: APP_ID, entity: "Task", id: created.id });
    expect(del).toEqual({ id: created.id });

    await expect(
      svc.get({ ownerId: USER_A, appId: APP_ID, entity: "Task", id: created.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("owner isolation", () => {
  it("user_B cannot get/update/delete user_A's record and list excludes it", async () => {
    const a = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "A's task" } });

    await expect(
      svc.get({ ownerId: USER_B, appId: APP_ID, entity: "Task", id: a.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.update({ ownerId: USER_B, appId: APP_ID, entity: "Task", id: a.id, body: { done: true } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      svc.delete({ ownerId: USER_B, appId: APP_ID, entity: "Task", id: a.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const bList = await svc.list({ ownerId: USER_B, appId: APP_ID, entity: "Task", searchParams: sp() });
    expect(bList.items).toHaveLength(0);
  });
});

describe("resolution failures", () => {
  it("unknown entity -> ENTITY_UNKNOWN", async () => {
    await expect(
      svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Ghost", body: { x: 1 } }),
    ).rejects.toMatchObject({ code: "ENTITY_UNKNOWN" });
  });

  it("case is significant: 'task' != 'Task' -> ENTITY_UNKNOWN", async () => {
    await expect(
      svc.create({ ownerId: USER_A, appId: APP_ID, entity: "task", body: { title: "x" } }),
    ).rejects.toMatchObject({ code: "ENTITY_UNKNOWN" });
  });

  it("unknown app (reader returns null) -> NOT_FOUND", async () => {
    const noApp = new RecordService(stubReader(null), repo);
    await expect(
      noApp.list({ ownerId: USER_A, appId: "ghost", entity: "Task", searchParams: sp() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("validation", () => {
  it("bad create body -> VALIDATION_ERROR with fieldErrors, nothing persisted", async () => {
    try {
      await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { done: "not-a-bool" } });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe("VALIDATION_ERROR");
      const details = e.details as { fieldErrors: Record<string, string[]> };
      expect(details.fieldErrors.title).toBeTruthy(); // required, missing
      expect(details.fieldErrors.done).toBeTruthy(); // wrong type
    }
    const list = await svc.list({ ownerId: USER_A, appId: APP_ID, entity: "Task", searchParams: sp() });
    expect(list.items).toHaveLength(0);
  });

  it("never 500: fuzzed bodies map to VALIDATION_ERROR, never throw a raw error", async () => {
    for (const body of [null, undefined, 42, "str", [], [1, 2], true]) {
      await expect(
        svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body }),
      ).rejects.toBeInstanceOf(AppError);
    }
  });
});

describe("update merge", () => {
  it("PATCH one field changes only that key; no defaults injected", async () => {
    const created = await svc.create({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      body: { title: "Original", priority: 5 },
    });
    const updated = await svc.update({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      id: created.id,
      body: { title: "Renamed" },
    });
    expect(updated.title).toBe("Renamed");
    expect(updated.priority).toBe(5); // preserved
    expect(updated.done).toBe(false); // preserved from create-time default, not re-injected
  });

  it("update of an unknown record -> NOT_FOUND, no defaults leak", async () => {
    await expect(
      svc.update({ ownerId: USER_A, appId: APP_ID, entity: "Task", id: "nope", body: { done: true } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reference existence", () => {
  it("reference to a missing id -> field-level VALIDATION_ERROR", async () => {
    try {
      await svc.create({
        ownerId: USER_A,
        appId: APP_ID,
        entity: "Task",
        body: { title: "T", assignee: "user_does_not_exist" },
      });
      throw new Error("expected throw");
    } catch (err) {
      const e = err as AppError;
      expect(e.code).toBe("VALIDATION_ERROR");
      const details = e.details as { fieldErrors: Record<string, string[]> };
      expect(details.fieldErrors.assignee?.[0]).toContain("referenced User");
    }
  });

  it("reference to an existing owned record -> success", async () => {
    const user = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "User", body: { email: "a@x.io" } });
    const task = await svc.create({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      body: { title: "T", assignee: user.id },
    });
    expect(task.assignee).toBe(user.id);
  });

  it("cannot reference another owner's record (scope blocks existence probing)", async () => {
    const userA = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "User", body: { email: "a@x.io" } });
    await expect(
      svc.create({ ownerId: USER_B, appId: APP_ID, entity: "Task", body: { title: "T", assignee: userA.id } }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("list tolerance", () => {
  beforeEach(async () => {
    await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "T1", done: true } });
    await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "T2", done: false } });
  });

  it("non-numeric page/limit clamp to defaults", async () => {
    const res = await svc.list({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      searchParams: sp("page=abc&limit=xyz"),
    });
    expect(res.meta.page).toBe(1);
    expect(res.meta.limit).toBe(20);
  });

  it("limit above the cap clamps to 100", async () => {
    const res = await svc.list({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      searchParams: sp("limit=9999"),
    });
    expect(res.meta.limit).toBe(100);
  });

  it("unknown sort field falls back (no throw)", async () => {
    const res = await svc.list({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      searchParams: sp("sort=bogus:desc"),
    });
    expect(res.items).toHaveLength(2);
  });

  it("unknown filter field is ignored", async () => {
    const res = await svc.list({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      searchParams: sp("nonexistent=whatever"),
    });
    expect(res.items).toHaveLength(2);
  });

  it("valid equality filter narrows results (with coercion)", async () => {
    const res = await svc.list({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      searchParams: sp("done=true"),
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].title).toBe("T1");
  });

  it("uncoercible filter value is dropped, not 4xx", async () => {
    const res = await svc.list({
      ownerId: USER_A,
      appId: APP_ID,
      entity: "Task",
      searchParams: sp("priority=not-a-number"),
    });
    expect(res.items).toHaveLength(2); // filter dropped, all returned
  });
});

// ---- Phase 5: schema-drift tolerance ---------------------------------------
//
// A row is written under a "v1" config (stamped version 1), then the reader is repointed at a "v2"
// config (version 2) sharing the SAME repo. Reads must project the v1 row onto the v2 schema and
// never error. The drift envelope `meta` rides a Symbol side-channel read via `readDriftMeta`.

const ENTITY = "Item";

const V1: AppConfig = {
  app: { name: "Drift" },
  entities: [
    {
      name: ENTITY,
      fields: [
        { name: "name", type: "string", required: true },
        { name: "color", type: "enum", values: ["red", "blue"] },
        { name: "oldType", type: "string" }, // becomes number in v2
        { name: "legacy", type: "string" }, // removed in v2
      ],
    },
  ],
  workflows: [],
  pages: [],
};

const V2: AppConfig = {
  app: { name: "Drift" },
  entities: [
    {
      name: ENTITY,
      fields: [
        { name: "name", type: "string", required: true }, // unchanged
        { name: "color", type: "enum", values: ["red", "green"] }, // "blue" no longer allowed
        { name: "oldType", type: "number" }, // type changed from string
        { name: "qty", type: "number", required: true }, // added, required, no default
        { name: "status", type: "string", default: "active" }, // added, has default
        // "legacy" removed
      ],
    },
  ],
  workflows: [],
  pages: [],
};

const readerFor = (config: AppConfig, version: number): ActiveConfigReader => ({
  async getActive() {
    return { config, version };
  },
});

const driftOf = (record: { [k: string]: unknown }): DriftNote[] => {
  const meta = readDriftMeta(record as never);
  return (meta?.drift as DriftNote[] | undefined) ?? [];
};

describe("Phase 5 drift tolerance", () => {
  let sharedRepo: RecordRepository;
  let v1: RecordService;
  let v2: RecordService;

  beforeEach(() => {
    sharedRepo = makeRepo();
    v1 = new RecordService(readerFor(V1, 1), sharedRepo);
    v2 = new RecordService(readerFor(V2, 2), sharedRepo);
  });

  const writeV1 = () =>
    v1.create({
      ownerId: USER_A,
      appId: APP_ID,
      entity: ENTITY,
      body: { name: "Widget", color: "blue", oldType: "123", legacy: "drop-me" },
    });

  it("get projects a v1 row onto the v2 schema, reports drift, never errors", async () => {
    const created = await writeV1();
    expect(created.version).toBe(1);

    const got = await v2.get({ ownerId: USER_A, appId: APP_ID, entity: ENTITY, id: created.id });

    // projected data conforms to v2
    expect(got.name).toBe("Widget"); // unchanged
    expect(got.color).toBeNull(); // "blue" no longer allowed, no default -> null
    expect(got.oldType).toBe(123); // string -> number coerced
    expect(got.qty).toBeNull(); // added required, no default -> null (read still succeeds)
    expect(got.status).toBe("active"); // added with default -> backfilled
    expect("legacy" in got).toBe(false); // removed field dropped

    const codes = driftOf(got).map((n) => n.code).sort();
    expect(codes).toEqual(
      ["ENUM_VALUE_INVALID", "FIELD_BACKFILLED_DEFAULT", "FIELD_BACKFILLED_NULL", "FIELD_COERCED", "FIELD_DROPPED_ON_READ"].sort(),
    );

    const meta = readDriftMeta(got as never);
    expect(meta?.writtenVersion).toBe(1);
    expect(meta?.activeVersion).toBe(2);
  });

  it("list reports driftedCount and leaves conforming rows untouched", async () => {
    await writeV1(); // drifted row (version 1)
    const conforming = await v2.create({
      ownerId: USER_A,
      appId: APP_ID,
      entity: ENTITY,
      body: { name: "Fresh", color: "red", oldType: 9, qty: 2 },
    });
    expect(conforming.version).toBe(2);

    const res = await v2.list({ ownerId: USER_A, appId: APP_ID, entity: ENTITY, searchParams: sp() });
    expect(res.items).toHaveLength(2);
    expect(res.meta.driftedCount).toBe(1);

    // list never inlines per-item notes into the data shape
    for (const item of res.items) {
      expect("drift" in item).toBe(false);
    }
    // the conforming row is byte-identical to its create output (status defaulted, etc.)
    const fresh = res.items.find((i) => i.name === "Fresh");
    expect(fresh?.status).toBe("active");
    expect(fresh?.qty).toBe(2);
  });

  it("update project-then-merges: re-stamps to the active version with a conforming row", async () => {
    const created = await writeV1();

    const updated = await v2.update({
      ownerId: USER_A,
      appId: APP_ID,
      entity: ENTITY,
      id: created.id,
      body: { name: "Renamed" },
    });

    // patch applied; existing row migrated onto v2 and re-stamped truthfully
    expect(updated.name).toBe("Renamed");
    expect(updated.version).toBe(2); // re-stamped to active
    expect(updated.color).toBeNull(); // migrated
    expect(updated.oldType).toBe(123); // migrated/coerced
    expect(updated.qty).toBeNull(); // missing-required backfilled to null, edit still succeeds
    expect(updated.status).toBe("active"); // default backfilled
    expect("legacy" in updated).toBe(false); // removed key gone

    // the update reports the migration drift of the EXISTING row
    expect(driftOf(updated).length).toBeGreaterThan(0);

    // a subsequent read is now conforming (same version) -> no drift
    const reread = await v2.get({ ownerId: USER_A, appId: APP_ID, entity: ENTITY, id: created.id });
    expect(reread.version).toBe(2);
    expect(driftOf(reread)).toHaveLength(0);
  });

  it("conforming records carry no drift meta (regression guard vs Phase 4)", async () => {
    const created = await v2.create({
      ownerId: USER_A,
      appId: APP_ID,
      entity: ENTITY,
      body: { name: "Clean", color: "green", oldType: 1, qty: 1 },
    });
    const got = await v2.get({ ownerId: USER_A, appId: APP_ID, entity: ENTITY, id: created.id });
    expect(readDriftMeta(got as never)).toBeUndefined();
  });

  it("entity removed from the active config -> ENTITY_UNKNOWN (not raw passthrough)", async () => {
    const created = await writeV1();
    const empty: AppConfig = { app: { name: "Drift" }, entities: [], workflows: [], pages: [] };
    const v3 = new RecordService(readerFor(empty, 3), sharedRepo);
    await expect(
      v3.get({ ownerId: USER_A, appId: APP_ID, entity: ENTITY, id: created.id }),
    ).rejects.toMatchObject({ code: "ENTITY_UNKNOWN" });
  });
});

// ---- Phase 6: workflow runner (real runner over in-memory writers) ----------
//
// A real WorkflowRunner + builtin actions are wired over the in-memory repo via the
// RecordServiceWorkflowWriter, with a stub HTTP client. No DB, no network. The overriding invariant:
// no workflow outcome ever alters or rolls back the CRUD response.

type WfSummary = { ran: number; skipped: number; failed: number };
const workflowsOf = (result: object): WfSummary | undefined =>
  readResponseMeta(result)?.workflows as WfSummary | undefined;

const stubHttp = (status: number): WorkflowHttpClient => ({
  async post() {
    return { status };
  },
});

/** Wire a RecordService with a real runner over the given config + http stub. */
function wireWorkflows(config: AppConfig, http: WorkflowHttpClient = stubHttp(200)) {
  const wfRepo = makeRepo();
  const service = new RecordService(stubReader(config), wfRepo);
  const writer = new RecordServiceWorkflowWriter(service, wfRepo);
  service.setWorkflowRunner(new WorkflowRunner(builtinActions, writer, http));
  return service;
}

describe("Phase 6 workflow runner", () => {
  const TASK_AUDIT: AppConfig = {
    app: { name: "WF" },
    entities: [
      { name: "Task", fields: [{ name: "title", type: "string", required: true }, { name: "done", type: "boolean", default: false }] },
      { name: "Audit", fields: [{ name: "msg", type: "string", required: true }] },
    ],
    workflows: [
      { trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "createRecord", entity: "Audit", data: { msg: "created" } }] },
    ],
    pages: [],
  };

  it("onCreate workflow with createRecord creates the secondary record", async () => {
    const svc = wireWorkflows(TASK_AUDIT);
    const created = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "Hi" } });

    expect(created.title).toBe("Hi"); // CRUD response unaffected
    expect(workflowsOf(created)).toEqual({ ran: 1, skipped: 0, failed: 0 });

    const audits = await svc.list({ ownerId: USER_A, appId: APP_ID, entity: "Audit", searchParams: sp() });
    expect(audits.items).toHaveLength(1);
    expect(audits.items[0].msg).toBe("created");
  });

  it("a failing workflow action does NOT fail the originating write; meta.workflows.failed reflects it", async () => {
    const config: AppConfig = {
      ...TASK_AUDIT,
      workflows: [{ trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "webhook", url: "https://x.test/hook" }] }],
    };
    const svc = wireWorkflows(config, stubHttp(500)); // webhook -> non-2xx -> failed action

    const created = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "Survives" } });
    expect(created.title).toBe("Survives"); // record still created and returned
    expect(workflowsOf(created)).toEqual({ ran: 0, skipped: 0, failed: 1 });

    const list = await svc.list({ ownerId: USER_A, appId: APP_ID, entity: "Task", searchParams: sp() });
    expect(list.items).toHaveLength(1); // persisted despite the failure
  });

  it("a setField workflow updates the triggering record without infinite-looping", async () => {
    const config: AppConfig = {
      ...TASK_AUDIT,
      workflows: [{ trigger: { event: "onUpdate", entity: "Task" }, actions: [{ type: "setField", field: "done", value: true }] }],
    };
    const svc = wireWorkflows(config);

    const created = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "T" } });
    expect(created.done).toBe(false);

    const updated = await svc.update({ ownerId: USER_A, appId: APP_ID, entity: "Task", id: created.id, body: { title: "T2" } });
    expect(workflowsOf(updated)).toEqual({ ran: 1, skipped: 0, failed: 0 }); // ran once, no re-fire loop

    const reread = await svc.get({ ownerId: USER_A, appId: APP_ID, entity: "Task", id: created.id });
    expect(reread.title).toBe("T2");
    expect(reread.done).toBe(true); // silent setField applied
  });

  it("onDelete setField is gracefully skipped; delete still returns { id }", async () => {
    const config: AppConfig = {
      ...TASK_AUDIT,
      workflows: [{ trigger: { event: "onDelete", entity: "Task" }, actions: [{ type: "setField", field: "done", value: true }] }],
    };
    const svc = wireWorkflows(config);
    const created = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "Doomed" } });

    const del = await svc.delete({ ownerId: USER_A, appId: APP_ID, entity: "Task", id: created.id });
    expect(del).toEqual({ id: created.id });
    expect(workflowsOf(del)).toEqual({ ran: 0, skipped: 1, failed: 0 });
  });

  it("a config with no workflows behaves identically to Phase 5 (no-op runner)", async () => {
    const config: AppConfig = { ...TASK_AUDIT, workflows: [] };
    const svc = wireWorkflows(config);
    const created = await svc.create({ ownerId: USER_A, appId: APP_ID, entity: "Task", body: { title: "Plain" } });
    expect(readResponseMeta(created)).toBeUndefined(); // no meta attached at all
  });
});
