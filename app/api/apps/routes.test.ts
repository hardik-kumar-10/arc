import { describe, it, expect, vi, beforeEach } from "vitest";

// Two mocked seams: the auth context (owner identity) and the wired ConfigService. The real
// repository and DB never load.
vi.mock("@/server/auth/context", () => ({ getOwnerContext: vi.fn() }));
vi.mock("@/server/config/service", () => ({
  configService: {
    createApp: vi.fn(),
    listApps: vi.fn(),
    publishConfig: vi.fn(),
    getActiveConfig: vi.fn(),
    getConfigVersion: vi.fn(),
    listVersions: vi.fn(),
  },
}));

import { getOwnerContext } from "@/server/auth/context";
import { configService } from "@/server/config/service";
import { AppError } from "@/server/http/errors";
import { POST as createApp, GET as listApps } from "./route";
import { POST as publishConfig, GET as getActiveConfig } from "./[appId]/config/route";
import { GET as getVersion } from "./[appId]/config/versions/[version]/route";

const mockedOwner = vi.mocked(getOwnerContext);
const svc = vi.mocked(configService, true);

const OWNER = "user_1";
const seg = (params: Record<string, string | string[]>) => ({ params: Promise.resolve(params) });
const jsonReq = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const getReq = (path: string) => new Request(`http://localhost${path}`);

type Envelope = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; details?: { fieldErrors?: Record<string, string[]> } };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedOwner.mockResolvedValue(OWNER);
});

describe("POST /api/apps", () => {
  it("creates an app → 201", async () => {
    svc.createApp.mockResolvedValue({
      id: "app_1",
      name: "Billing",
      ownerId: OWNER,
      activeConfigVersionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await createApp(jsonReq("/api/apps", { name: "Billing" }));
    expect(res.status).toBe(201);
  });

  it("missing name → 422 VALIDATION_ERROR with fieldErrors", async () => {
    const res = await createApp(jsonReq("/api/apps", {}));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(422);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(body.error?.details?.fieldErrors?.name).toBeTruthy();
  });

  it("unauthenticated → 401", async () => {
    mockedOwner.mockResolvedValue(null);
    const res = await listApps(getReq("/api/apps"));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });
});

describe("POST /api/apps/[appId]/config", () => {
  it("publishes a deliberately broken config → 200 with diagnostics", async () => {
    svc.publishConfig.mockResolvedValue({
      versionId: "v_1",
      version: 1,
      diagnostics: [{ level: "error", code: "ENTITY_NO_NAME", path: "entities[0]", message: "x" }],
      config: { app: { name: "Untitled" }, entities: [], workflows: [], pages: [] },
    });
    const res = await publishConfig(
      jsonReq("/api/apps/app_1/config", { config: { entities: [{ fields: [] }] } }),
      seg({ appId: "app_1" }),
    );
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(200);
    expect((body.data as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
  });

  it("unknown appId → 404", async () => {
    svc.publishConfig.mockRejectedValue(new AppError("NOT_FOUND", "App not found"));
    const res = await publishConfig(jsonReq("/api/apps/ghost/config", { config: {} }), seg({ appId: "ghost" }));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  it("getActiveConfig on unknown appId → 404", async () => {
    svc.getActiveConfig.mockRejectedValue(new AppError("NOT_FOUND", "App not found"));
    const res = await getActiveConfig(getReq("/api/apps/ghost/config"), seg({ appId: "ghost" }));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/apps/[appId]/config/versions/[version]", () => {
  it("fetches a specific version → 200", async () => {
    svc.getConfigVersion.mockResolvedValue({
      version: 2,
      config: { app: { name: "A" }, entities: [], workflows: [], pages: [] },
      diagnostics: [],
    });
    const res = await getVersion(getReq("/api/apps/app_1/config/versions/2"), seg({ appId: "app_1", version: "2" }));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(200);
    expect((body.data as { version: number }).version).toBe(2);
  });

  it("non-numeric version → 400 BAD_REQUEST", async () => {
    const res = await getVersion(
      getReq("/api/apps/app_1/config/versions/abc"),
      seg({ appId: "app_1", version: "abc" }),
    );
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe("BAD_REQUEST");
  });

  it("nonexistent version → 404", async () => {
    svc.getConfigVersion.mockRejectedValue(new AppError("NOT_FOUND", "Config version not found"));
    const res = await getVersion(getReq("/api/apps/app_1/config/versions/9"), seg({ appId: "app_1", version: "9" }));
    expect(res.status).toBe(404);
  });
});
