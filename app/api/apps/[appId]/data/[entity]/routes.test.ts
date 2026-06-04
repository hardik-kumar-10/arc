import { describe, it, expect, vi, beforeEach } from "vitest";

// Two mocked seams: the auth context (owner identity) and the wired RecordService. The real
// repositories and DB never load.
vi.mock("@/server/auth/context", () => ({ getOwnerContext: vi.fn() }));
vi.mock("@/server/records/service", () => ({
  recordService: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { getOwnerContext } from "@/server/auth/context";
import { recordService } from "@/server/records/service";
import { GET, POST, PATCH, DELETE } from "./[[...id]]/route";

const mockedOwner = vi.mocked(getOwnerContext);
const svc = vi.mocked(recordService, true);

const OWNER = "user_1";
const APP = "app_1";
const ENTITY = "Task";

const seg = (id?: string[]) => ({ params: Promise.resolve({ appId: APP, entity: ENTITY, ...(id ? { id } : {}) }) });

const getReq = (qs = "") => new Request(`http://localhost/api/apps/${APP}/data/${ENTITY}${qs}`);
const bodyReq = (method: string, body: unknown) =>
  new Request(`http://localhost/api/apps/${APP}/data/${ENTITY}`, {
    method,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

type Envelope = { ok: boolean; data?: unknown; meta?: unknown; error?: { code: string } };

beforeEach(() => {
  vi.clearAllMocks();
  mockedOwner.mockResolvedValue(OWNER);
});

describe("GET routing", () => {
  it("no id segment -> list (passes searchParams)", async () => {
    svc.list.mockResolvedValue({ items: [{ id: "r1", createdAt: new Date(), updatedAt: new Date(), version: 1 }], meta: { page: 2, limit: 5, total: 1 } });
    const res = await GET(getReq("?page=2&limit=5"), seg());
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(200);
    expect(svc.list).toHaveBeenCalledOnce();
    expect(svc.get).not.toHaveBeenCalled();
    expect(body.meta).toEqual({ page: 2, limit: 5, total: 1 });
    expect(Array.isArray(body.data)).toBe(true);
    const passed = svc.list.mock.calls[0][0].searchParams;
    expect(passed.get("page")).toBe("2");
  });

  it("one id segment -> get one", async () => {
    svc.get.mockResolvedValue({ id: "r1", createdAt: new Date(), updatedAt: new Date(), version: 1 });
    const res = await GET(getReq("/r1"), seg(["r1"]));
    expect(res.status).toBe(200);
    expect(svc.get).toHaveBeenCalledWith({ ownerId: OWNER, appId: APP, entity: ENTITY, id: "r1" });
  });

  it(">= 2 id segments -> BAD_REQUEST", async () => {
    const res = await GET(getReq("/a/b"), seg(["a", "b"]));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("BAD_REQUEST");
    expect(svc.get).not.toHaveBeenCalled();
  });
});

describe("POST", () => {
  it("collection route -> create, 201", async () => {
    svc.create.mockResolvedValue({ id: "r1", createdAt: new Date(), updatedAt: new Date(), version: 1, title: "x" });
    const res = await POST(bodyReq("POST", { title: "x" }), seg());
    expect(res.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith({ ownerId: OWNER, appId: APP, entity: ENTITY, body: { title: "x" } });
  });

  it("to a specific id -> BAD_REQUEST", async () => {
    const res = await POST(bodyReq("POST", { title: "x" }), seg(["r1"]));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("BAD_REQUEST");
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("malformed JSON body -> BAD_REQUEST", async () => {
    const res = await POST(bodyReq("POST", "{not json"), seg());
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("BAD_REQUEST");
    expect(svc.create).not.toHaveBeenCalled();
  });
});

describe("PATCH", () => {
  it("with id -> update", async () => {
    svc.update.mockResolvedValue({ id: "r1", createdAt: new Date(), updatedAt: new Date(), version: 1, title: "y" });
    const res = await PATCH(bodyReq("PATCH", { title: "y" }), seg(["r1"]));
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith({ ownerId: OWNER, appId: APP, entity: ENTITY, id: "r1", body: { title: "y" } });
  });

  it("without id -> BAD_REQUEST", async () => {
    const res = await PATCH(bodyReq("PATCH", { title: "y" }), seg());
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("BAD_REQUEST");
    expect(svc.update).not.toHaveBeenCalled();
  });
});

describe("DELETE", () => {
  it("with id -> delete, returns { id }", async () => {
    svc.delete.mockResolvedValue({ id: "r1" });
    const res = await DELETE(getReq("/r1"), seg(["r1"]));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ id: "r1" });
    expect(svc.delete).toHaveBeenCalledWith({ ownerId: OWNER, appId: APP, entity: ENTITY, id: "r1" });
  });

  it("without id -> BAD_REQUEST", async () => {
    const res = await DELETE(getReq(""), seg());
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("BAD_REQUEST");
    expect(svc.delete).not.toHaveBeenCalled();
  });
});

describe("auth", () => {
  it("unauthenticated -> 401", async () => {
    mockedOwner.mockResolvedValue(null);
    const res = await GET(getReq(""), seg());
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });
});
