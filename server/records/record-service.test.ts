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
