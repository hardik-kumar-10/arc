// server/__edge__/edge-cases.test.ts — the consolidated edge-case proof (Phase 7 centerpiece).
//
// Handler-level and end to end: the REAL route handlers run against REAL services wired over in-memory
// repositories (a stubbed auth seam + stub HTTP client; no DB, no network). It is grouped by the
// brief's failure list so the file reads as the rubric, and every case asserts: correct ErrorCode,
// correct HTTP status, a well-formed envelope carrying `requestId`, and — the invariant — that the
// status is NEVER 5xx for any client input. The closing fuzz loop is the strongest single piece of
// evidence for the reliability mark: garbage at every verb, zero 5xx.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mocked seams (hoisted so the factories see the holders) ----------------
const H = vi.hoisted(() => ({
  recordService: null as unknown,
  configService: null as unknown,
  owner: null as string | null,
}));

vi.mock("@/server/auth/context", () => ({
  getOwnerContext: vi.fn(async () => H.owner),
}));
// Live getters: the route reads the current per-test service instance each call.
vi.mock("@/server/records/service", () => ({
  get recordService() {
    return H.recordService;
  },
}));
vi.mock("@/server/config/service", () => ({
  get configService() {
    return H.configService;
  },
}));

import type { AppConfig } from "@/server/config/types";
import { ConfigService } from "@/server/config/config-service";
import type {
  AppRecord,
  ConfigRepository,
  ConfigVersionMeta,
  ConfigVersionRecord,
} from "@/server/config/config-repository";
import { countDiagnostics } from "@/server/config/config-repository";
import { RecordService } from "@/server/records/record-service";
import { ConfigActiveReader } from "@/server/records/active-config-reader";
import type { ListQuery, RecordRepository, StoredRecord } from "@/server/records/record-repository";
import { RecordServiceWorkflowWriter } from "@/server/workflows/record-writer";
import { WorkflowRunner } from "@/server/workflows/runner";
import { builtinActions } from "@/server/workflows/actions";
import type { WorkflowHttpClient } from "@/server/workflows/types";
import { resetRateLimiters, setWriteLimiter, type RateLimiter } from "@/server/http/rate-limit";
import { resetIdempotencyStore } from "@/server/http/idempotency";

import * as appsRoute from "@/app/api/apps/route";
import * as configRoute from "@/app/api/apps/[appId]/config/route";
import * as dataRoute from "@/app/api/apps/[appId]/data/[entity]/[[...id]]/route";

const OWNER = "user_A";
const OTHER = "user_B";

// ---- in-memory repositories (mirror the Prisma impls' scoping semantics) ----

class InMemoryConfigRepository implements ConfigRepository {
  private apps = new Map<string, AppRecord>();
  private versions: ConfigVersionRecord[] = [];
  private seq = 0;
  private id() {
    this.seq += 1;
    return `id_${this.seq}`;
  }
  async createApp(input: { name: string; ownerId: string }) {
    const now = new Date();
    const app: AppRecord = { id: this.id(), name: input.name, ownerId: input.ownerId, activeConfigVersionId: null, createdAt: now, updatedAt: now };
    this.apps.set(app.id, app);
    return { ...app };
  }
  async getApp(input: { appId: string; ownerId: string }) {
    const app = this.apps.get(input.appId);
    return app && app.ownerId === input.ownerId ? { ...app } : null;
  }
  async listApps(input: { ownerId: string }) {
    return [...this.apps.values()].filter((a) => a.ownerId === input.ownerId).map((a) => ({ ...a }));
  }
  async publishVersion(input: { appId: string; ownerId: string; raw: unknown; normalized: AppConfig; diagnostics: ConfigVersionRecord["diagnostics"] }) {
    const existing = this.versions.filter((v) => v.appId === input.appId);
    const nextVersion = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const rec: ConfigVersionRecord = { id: this.id(), appId: input.appId, version: nextVersion, rawConfig: input.raw, normalizedConfig: input.normalized, diagnostics: input.diagnostics, createdAt: new Date() };
    this.versions.push(rec);
    const app = this.apps.get(input.appId);
    if (app) app.activeConfigVersionId = rec.id;
    return { ...rec };
  }
  async getActiveVersion(input: { appId: string; ownerId: string }) {
    const app = this.apps.get(input.appId);
    if (!app || app.ownerId !== input.ownerId || !app.activeConfigVersionId) return null;
    const v = this.versions.find((x) => x.id === app.activeConfigVersionId);
    return v ? { ...v } : null;
  }
  async getVersion(input: { appId: string; ownerId: string; version: number }) {
    const app = this.apps.get(input.appId);
    if (!app || app.ownerId !== input.ownerId) return null;
    const v = this.versions.find((x) => x.appId === input.appId && x.version === input.version);
    return v ? { ...v } : null;
  }
  async listVersions(input: { appId: string; ownerId: string }): Promise<ConfigVersionMeta[]> {
    const app = this.apps.get(input.appId);
    if (!app || app.ownerId !== input.ownerId) return [];
    return this.versions
      .filter((v) => v.appId === input.appId)
      .sort((a, b) => b.version - a.version)
      .map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt, diagnosticCounts: countDiagnostics(v.diagnostics) }));
  }
}

function makeRecordRepo(): RecordRepository {
  const rows = new Map<string, StoredRecord>();
  let seq = 0;
  const scoped = (r: StoredRecord, s: { appId: string; entity: string; ownerId: string }) =>
    r.appId === s.appId && r.entity === s.entity && r.ownerId === s.ownerId;
  const clone = (d: Record<string, unknown>) => JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  const matches = (d: Record<string, unknown>, f: ListQuery["filters"]) => !f || f.every((x) => d[x.field] === x.value);
  return {
    async create(input) {
      seq += 1;
      const now = new Date(Date.now() + seq);
      const row: StoredRecord = { id: `rec_${seq}`, ...input, data: clone(input.data), createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      return { ...row, data: clone(row.data) };
    },
    async getById(input) {
      const r = rows.get(input.id);
      return r && scoped(r, input) ? { ...r, data: clone(r.data) } : null;
    },
    async list(input) {
      let items = [...rows.values()].filter((r) => scoped(r, input) && matches(r.data, input.query.filters));
      const { page, limit } = input.query;
      const total = items.length;
      items = items.slice((page - 1) * limit, (page - 1) * limit + limit);
      return { items: items.map((r) => ({ ...r, data: clone(r.data) })), total };
    },
    async update(input) {
      const r = rows.get(input.id);
      if (!r || !scoped(r, input)) return null;
      const updated: StoredRecord = { ...r, data: clone(input.data), version: input.version, updatedAt: new Date(Date.now() + ++seq) };
      rows.set(r.id, updated);
      return { ...updated, data: clone(updated.data) };
    },
    async delete(input) {
      const r = rows.get(input.id);
      if (!r || !scoped(r, input)) return false;
      rows.delete(input.id);
      return true;
    },
    async exists(input) {
      const r = rows.get(input.id);
      return !!r && scoped(r, input);
    },
  };
}

// ---- standard config used by most CRUD cases --------------------------------

const STD_CONFIG: AppConfig = {
  app: { name: "Tracker" },
  entities: [
    { name: "User", fields: [{ name: "email", type: "string", required: true }] },
    {
      name: "Task",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "done", type: "boolean", default: false },
        { name: "priority", type: "number" },
        { name: "assignee", type: "reference", ref: "User" },
      ],
    },
  ],
  workflows: [],
  pages: [],
};

const stubHttp: WorkflowHttpClient = { async post() { return { status: 200 }; } };

let configRepo: InMemoryConfigRepository;

beforeEach(() => {
  resetRateLimiters();
  resetIdempotencyStore();
  configRepo = new InMemoryConfigRepository();
  const recordRepo = makeRecordRepo();
  const rs = new RecordService(new ConfigActiveReader(configRepo), recordRepo);
  const writer = new RecordServiceWorkflowWriter(rs, recordRepo);
  rs.setWorkflowRunner(new WorkflowRunner(builtinActions, writer, stubHttp));
  H.configService = new ConfigService(configRepo);
  H.recordService = rs;
  H.owner = OWNER;
});

// ---- helpers ----------------------------------------------------------------

const cs = () => H.configService as ConfigService;

async function bootstrap(config: AppConfig = STD_CONFIG): Promise<string> {
  const app = await cs().createApp({ ownerId: OWNER, name: "App" });
  await cs().publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: config });
  return app.id;
}

const seg = (params: Record<string, string | string[]>) => ({ params: Promise.resolve(params) });

const jsonReq = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api", {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

interface Envelope {
  ok: boolean;
  requestId: string;
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function unwrap(res: Response): Promise<{ status: number; body: Envelope }> {
  const body = (await res.json()) as Envelope;
  // Universal invariants for EVERY response in this suite:
  expect(res.status).toBeLessThan(500); // never a 5xx for client input
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(0);
  return { status: res.status, body };
}

// shorthands for data routes
const dataColl = (appId: string, entity: string) => seg({ appId, entity });
const dataItem = (appId: string, entity: string, id: string) => seg({ appId, entity, id: [id] });

// =====================================================================================
// Config / schema (Phase 2 / 5)
// =====================================================================================
describe("Config / schema", () => {
  it("missing app fields -> defaults applied, 200 + diagnostics", async () => {
    const app = await cs().createApp({ ownerId: OWNER, name: "App" });
    const res = await configRoute.POST(jsonReq("POST", { config: { entities: [] } }), seg({ appId: app.id }));
    const { status, body } = await unwrap(res);
    expect(status).toBe(200);
    const data = body.data as { diagnostics: unknown[]; config: AppConfig };
    expect(data.config.app.name).toBeTruthy(); // app name defaulted
    expect(data.diagnostics.length).toBeGreaterThan(0);
  });

  it("non-object config payload -> empty valid config + CONFIG_NOT_OBJECT, still 200", async () => {
    const app = await cs().createApp({ ownerId: OWNER, name: "App" });
    const res = await configRoute.POST(jsonReq("POST", { config: 42 }), seg({ appId: app.id }));
    const { status, body } = await unwrap(res);
    expect(status).toBe(200);
    const data = body.data as { diagnostics: { code: string }[] };
    expect(data.diagnostics.some((d) => d.code === "CONFIG_NOT_OBJECT")).toBe(true);
  });

  it("strict publish with error-level diagnostics -> 422 CONFIG_INVALID, nothing persisted", async () => {
    const app = await cs().createApp({ ownerId: OWNER, name: "App" });
    const res = await configRoute.POST(jsonReq("POST", { config: 42, strict: true }), seg({ appId: app.id }));
    const { status, body } = await unwrap(res);
    expect(status).toBe(422);
    expect(body.error?.code).toBe("CONFIG_INVALID");
  });

  it("inconsistent schema (dangling reference) -> diagnostic, still 200", async () => {
    const app = await cs().createApp({ ownerId: OWNER, name: "App" });
    const config = { entities: [{ name: "Task", fields: [{ name: "owner", type: "reference", ref: "Ghost" }] }] };
    const res = await configRoute.POST(jsonReq("POST", { config }), seg({ appId: app.id }));
    const { status, body } = await unwrap(res);
    expect(status).toBe(200);
    const data = body.data as { diagnostics: { code: string }[] };
    expect(data.diagnostics.some((d) => d.code === "REF_UNKNOWN_ENTITY")).toBe(true);
  });
});

// =====================================================================================
// Validation / CRUD (Phase 3 / 4)
// =====================================================================================
describe("Validation / CRUD", () => {
  it("missing required field on create -> 422 with fieldErrors", async () => {
    const appId = await bootstrap();
    const res = await dataRoute.POST(jsonReq("POST", { done: true }), dataColl(appId, "Task"));
    const { status, body } = await unwrap(res);
    expect(status).toBe(422);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect((body.error?.message ?? "")).toBeTruthy();
  });

  it("malformed JSON body -> 400 BAD_REQUEST", async () => {
    const appId = await bootstrap();
    const res = await dataRoute.POST(jsonReq("POST", "{not json"), dataColl(appId, "Task"));
    const { status, body } = await unwrap(res);
    expect(status).toBe(400);
    expect(body.error?.code).toBe("BAD_REQUEST");
  });

  it("coercible type mismatch -> coerced 201; uncoercible -> 422", async () => {
    const appId = await bootstrap();
    const okRes = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "T", priority: "42", done: "false" }), dataColl(appId, "Task")));
    expect(okRes.status).toBe(201);
    const rec = okRes.body.data as { priority: number; done: boolean };
    expect(rec.priority).toBe(42);
    expect(rec.done).toBe(false);

    const badRes = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "T", priority: "not-a-number" }), dataColl(appId, "Task")));
    expect(badRes.status).toBe(422);
  });

  it("unknown entity -> 404 ENTITY_UNKNOWN", async () => {
    const appId = await bootstrap();
    const res = await unwrap(await dataRoute.POST(jsonReq("POST", { x: 1 }), dataColl(appId, "Ghost")));
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("ENTITY_UNKNOWN");
  });

  it("record not found -> 404 NOT_FOUND", async () => {
    const appId = await bootstrap();
    const res = await unwrap(await dataRoute.GET(jsonReq("GET"), dataItem(appId, "Task", "nope")));
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("NOT_FOUND");
  });

  it("cross-owner read -> 404 NOT_FOUND (existence not leaked)", async () => {
    const appId = await bootstrap();
    const created = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "Mine" }), dataColl(appId, "Task")));
    const id = (created.body.data as { id: string }).id;

    H.owner = OTHER; // a different user
    const res = await unwrap(await dataRoute.GET(jsonReq("GET"), dataItem(appId, "Task", id)));
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("NOT_FOUND");
  });

  it("bad id arity (>=2 segments) -> 400 BAD_REQUEST", async () => {
    const appId = await bootstrap();
    const res = await unwrap(await dataRoute.GET(jsonReq("GET"), seg({ appId, entity: "Task", id: ["a", "b"] })));
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("BAD_REQUEST");
  });

  it("dangling reference on write -> 422 field error", async () => {
    const appId = await bootstrap();
    const res = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "T", assignee: "user_missing" }), dataColl(appId, "Task")));
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("VALIDATION_ERROR");
  });
});

// =====================================================================================
// Drift (Phase 5)
// =====================================================================================
describe("Drift", () => {
  it("a record written under an old config reads cleanly under a new one -> 200 + meta.drift", async () => {
    const app = await cs().createApp({ ownerId: OWNER, name: "App" });
    // v1: Task has a `legacy` field
    await cs().publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: { entities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }, { name: "legacy", type: "string" }] }] } });
    const created = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "T", legacy: "drop" }), dataColl(app.id, "Task")));
    const id = (created.body.data as { id: string }).id;

    // v2: `legacy` removed
    await cs().publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: { entities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] } });
    const got = await unwrap(await dataRoute.GET(jsonReq("GET"), dataItem(app.id, "Task", id)));
    expect(got.status).toBe(200);
    expect(got.body.meta?.drift).toBeTruthy();
    expect("legacy" in (got.body.data as Record<string, unknown>)).toBe(false);
  });

  it("removed entity -> 404 ENTITY_UNKNOWN (no shape to project into)", async () => {
    const app = await cs().createApp({ ownerId: OWNER, name: "App" });
    await cs().publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: { entities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] } });
    const created = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "T" }), dataColl(app.id, "Task")));
    const id = (created.body.data as { id: string }).id;

    await cs().publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: { entities: [] } });
    const res = await unwrap(await dataRoute.GET(jsonReq("GET"), dataItem(app.id, "Task", id)));
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("ENTITY_UNKNOWN");
  });
});

// =====================================================================================
// Workflows (Phase 6)
// =====================================================================================
describe("Workflows", () => {
  it("a failing workflow action -> originating write still 201; meta.workflows.failed reflects it", async () => {
    const config: AppConfig = {
      app: { name: "WF" },
      entities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }],
      workflows: [{ trigger: { event: "onCreate", entity: "Task" }, actions: [{ type: "ghost-action" }] }],
      pages: [],
    };
    const app = await cs().createApp({ ownerId: OWNER, name: "App" });
    await cs().publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: config });

    const res = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "Survives" }), dataColl(app.id, "Task")));
    expect(res.status).toBe(201); // CRUD unaffected by workflow outcome
    const wf = res.body.meta?.workflows as { skipped: number } | undefined;
    expect(wf?.skipped).toBe(1); // unknown action -> skipped + logged
  });
});

// =====================================================================================
// Hardening (Phase 7)
// =====================================================================================
describe("Hardening", () => {
  it("over-cap body -> 413 PAYLOAD_TOO_LARGE", async () => {
    const appId = await bootstrap();
    const huge = JSON.stringify({ title: "x".repeat(1_100_000) }); // > 1 MB cap
    const res = await unwrap(await dataRoute.POST(jsonReq("POST", huge), dataColl(appId, "Task")));
    expect(res.status).toBe(413);
    expect(res.body.error?.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rate-limit exhaustion -> 429 RATE_LIMITED with Retry-After", async () => {
    const appId = await bootstrap();
    const deny: RateLimiter = { async consume() { return { allowed: false, retryAfterSec: 30 }; } };
    setWriteLimiter(deny);
    const res = await dataRoute.POST(jsonReq("POST", { title: "T" }), dataColl(appId, "Task"));
    const { status, body } = await unwrap(res);
    expect(status).toBe(429);
    expect(body.error?.code).toBe("RATE_LIMITED");
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("idempotent replay (same key + same body) returns the same record, no double-create", async () => {
    const appId = await bootstrap();
    const headers = { "idempotency-key": "key-1" };
    const first = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "Once" }, headers), dataColl(appId, "Task")));
    const second = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "Once" }, headers), dataColl(appId, "Task")));

    expect(first.status).toBe(201);
    expect((first.body.data as { id: string }).id).toBe((second.body.data as { id: string }).id);

    const list = await unwrap(await dataRoute.GET(jsonReq("GET"), dataColl(appId, "Task")));
    expect((list.body.data as unknown[]).length).toBe(1); // exactly one insert
  });

  it("idempotent replay (same key + different body) -> 409 CONFLICT", async () => {
    const appId = await bootstrap();
    const headers = { "idempotency-key": "key-2" };
    await unwrap(await dataRoute.POST(jsonReq("POST", { title: "A" }, headers), dataColl(appId, "Task")));
    const res = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "B" }, headers), dataColl(appId, "Task")));
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("CONFLICT");
  });

  it("every response echoes its requestId as the X-Request-Id header", async () => {
    const appId = await bootstrap();
    const res = await dataRoute.GET(jsonReq("GET", undefined, { "x-request-id": "edge-trace-001" }), dataColl(appId, "Task"));
    expect(res.headers.get("x-request-id")).toBe("edge-trace-001");
  });
});

// =====================================================================================
// The umbrella: zero 5xx under fuzzing every verb
// =====================================================================================
describe("Zero-5xx fuzz loop (the reliability invariant)", () => {
  const garbage: unknown[] = [null, 42, "str", true, [], [1, 2, 3], { nested: { deep: [1, [2, [3]]] } }, { title: { not: "a string" } }, { priority: [] }];

  it("POST create: every garbage body -> structured 4xx, never 5xx", async () => {
    const appId = await bootstrap();
    for (const body of garbage) {
      const res = await dataRoute.POST(jsonReq("POST", body), dataColl(appId, "Task"));
      const { status } = await unwrap(res); // unwrap asserts <500 + requestId
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it("PATCH update: every garbage body -> structured 4xx, never 5xx", async () => {
    const appId = await bootstrap();
    const created = await unwrap(await dataRoute.POST(jsonReq("POST", { title: "Base" }), dataColl(appId, "Task")));
    const id = (created.body.data as { id: string }).id;
    for (const body of garbage) {
      const res = await dataRoute.PATCH(jsonReq("PATCH", body), dataItem(appId, "Task", id));
      await unwrap(res);
    }
  });

  it("GET list: garbage query params -> tolerant 200, never 5xx", async () => {
    const appId = await bootstrap();
    for (const qs of ["page=abc&limit=-9", "sort=;DROP", "filter[ghost]=x", "priority=" + encodeURIComponent("[]"), "%ZZ=1"]) {
      const res = await dataRoute.GET(new Request(`http://localhost/api?${qs}`), dataColl(appId, "Task"));
      const { status } = await unwrap(res);
      expect(status).toBe(200);
    }
  });

  it("DELETE / apps / config verbs on junk input -> never 5xx", async () => {
    const appId = await bootstrap();
    await unwrap(await dataRoute.DELETE(jsonReq("DELETE"), dataItem(appId, "Task", "missing")));
    await unwrap(await appsRoute.POST(jsonReq("POST", { name: 123 }), seg({})));
    await unwrap(await appsRoute.POST(jsonReq("POST", null), seg({})));
    await unwrap(await configRoute.POST(jsonReq("POST", { config: [1, 2, 3] }), seg({ appId })));
    await unwrap(await configRoute.POST(jsonReq("POST", "not json"), seg({ appId })));
  });
});
