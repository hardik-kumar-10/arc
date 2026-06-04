import { describe, it, expect } from "vitest";
import { ConfigService } from "./config-service";
import {
  countDiagnostics,
  type AppRecord,
  type ConfigRepository,
  type ConfigVersionMeta,
  type ConfigVersionRecord,
} from "./config-repository";
import { withPublishRetry } from "./publish-retry";

// In-memory ConfigRepository — keeps the service suite DB-free, mirroring how Phase 1 mocked
// getOwnerContext. Owner scoping is enforced exactly as the Prisma implementation does.
class InMemoryConfigRepository implements ConfigRepository {
  private apps = new Map<string, AppRecord>();
  private versions: ConfigVersionRecord[] = [];
  private seq = 0;
  private id(): string {
    this.seq += 1;
    return `id_${this.seq}`;
  }

  async createApp(input: { name: string; ownerId: string }): Promise<AppRecord> {
    const now = new Date();
    const app: AppRecord = {
      id: this.id(),
      name: input.name,
      ownerId: input.ownerId,
      activeConfigVersionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.apps.set(app.id, app);
    return { ...app };
  }

  async getApp(input: { appId: string; ownerId: string }): Promise<AppRecord | null> {
    const app = this.apps.get(input.appId);
    return app && app.ownerId === input.ownerId ? { ...app } : null;
  }

  async listApps(input: { ownerId: string }): Promise<AppRecord[]> {
    return [...this.apps.values()].filter((a) => a.ownerId === input.ownerId).map((a) => ({ ...a }));
  }

  async publishVersion(input: {
    appId: string;
    ownerId: string;
    raw: unknown;
    normalized: ConfigVersionRecord["normalizedConfig"];
    diagnostics: ConfigVersionRecord["diagnostics"];
  }): Promise<ConfigVersionRecord> {
    const existing = this.versions.filter((v) => v.appId === input.appId);
    const nextVersion = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const rec: ConfigVersionRecord = {
      id: this.id(),
      appId: input.appId,
      version: nextVersion,
      rawConfig: input.raw,
      normalizedConfig: input.normalized,
      diagnostics: input.diagnostics,
      createdAt: new Date(),
    };
    this.versions.push(rec);
    const app = this.apps.get(input.appId);
    if (app) app.activeConfigVersionId = rec.id;
    return { ...rec };
  }

  async getActiveVersion(input: { appId: string; ownerId: string }): Promise<ConfigVersionRecord | null> {
    const app = this.apps.get(input.appId);
    if (!app || app.ownerId !== input.ownerId || !app.activeConfigVersionId) return null;
    const v = this.versions.find((x) => x.id === app.activeConfigVersionId);
    return v ? { ...v } : null;
  }

  async getVersion(input: {
    appId: string;
    ownerId: string;
    version: number;
  }): Promise<ConfigVersionRecord | null> {
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
      .map((v) => ({
        id: v.id,
        version: v.version,
        createdAt: v.createdAt,
        diagnosticCounts: countDiagnostics(v.diagnostics),
      }));
  }
}

const OWNER = "user_1";
function setup() {
  const repo = new InMemoryConfigRepository();
  return { repo, service: new ConfigService(repo) };
}

describe("ConfigService — apps", () => {
  it("rejects an empty app name with VALIDATION_ERROR", async () => {
    const { service } = setup();
    await expect(service.createApp({ ownerId: OWNER, name: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("lists only the caller's apps", async () => {
    const { service } = setup();
    await service.createApp({ ownerId: OWNER, name: "Mine" });
    await service.createApp({ ownerId: "other", name: "Theirs" });
    const apps = await service.listApps({ ownerId: OWNER });
    expect(apps.map((a) => a.name)).toEqual(["Mine"]);
  });
});

describe("ConfigService — publish & versioning", () => {
  it("increments version, repoints active, and keeps old versions fetchable", async () => {
    const { service } = setup();
    const app = await service.createApp({ ownerId: OWNER, name: "App" });

    const r1 = await service.publishConfig({
      ownerId: OWNER,
      appId: app.id,
      rawConfig: { app: { name: "A" }, entities: [] },
    });
    const r2 = await service.publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: { app: { name: "A2" } } });

    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);

    const active = await service.getActiveConfig({ ownerId: OWNER, appId: app.id });
    expect(active.version).toBe(2);

    const old = await service.getConfigVersion({ ownerId: OWNER, appId: app.id, version: 1 });
    expect(old.version).toBe(1);
    expect(old.config.app.name).toBe("A");
  });

  it("returns the compiled config under the `config` key with diagnostics (lenient)", async () => {
    const { service } = setup();
    const app = await service.createApp({ ownerId: OWNER, name: "App" });
    const result = await service.publishConfig({ ownerId: OWNER, appId: app.id, rawConfig: "garbage" });

    expect(result.version).toBe(1);
    expect(result.config).toEqual({ app: { name: "Untitled" }, entities: [], workflows: [], pages: [] });
    expect(result.diagnostics.some((d) => d.code === "CONFIG_NOT_OBJECT")).toBe(true);
  });

  it("getActiveConfig returns nulls for an app with no published version yet", async () => {
    const { service } = setup();
    const app = await service.createApp({ ownerId: OWNER, name: "App" });
    const active = await service.getActiveConfig({ ownerId: OWNER, appId: app.id });
    expect(active).toEqual({ config: null, version: null, diagnostics: [] });
  });
});

describe("ConfigService — strict mode", () => {
  it("throws CONFIG_INVALID and persists nothing when an error-level diagnostic exists", async () => {
    const { service } = setup();
    const app = await service.createApp({ ownerId: OWNER, name: "App" });

    await expect(
      service.publishConfig({
        ownerId: OWNER,
        appId: app.id,
        rawConfig: { entities: [{ fields: [] }] }, // nameless entity → ENTITY_NO_NAME (error)
        strict: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    const versions = await service.listVersions({ ownerId: OWNER, appId: app.id });
    expect(versions).toHaveLength(0);
  });

  it("strict publish succeeds when there are only warnings/info", async () => {
    const { service } = setup();
    const app = await service.createApp({ ownerId: OWNER, name: "App" });
    const result = await service.publishConfig({
      ownerId: OWNER,
      appId: app.id,
      rawConfig: { app: {}, entities: [] }, // APP_NAME_DEFAULTED is only a warning
      strict: true,
    });
    expect(result.version).toBe(1);
  });
});

describe("ConfigService — owner scoping", () => {
  it("maps cross-owner access to NOT_FOUND (existence not leaked)", async () => {
    const { service } = setup();
    const app = await service.createApp({ ownerId: OWNER, name: "App" });

    await expect(service.getActiveConfig({ ownerId: "intruder", appId: app.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      service.publishConfig({ ownerId: "intruder", appId: app.id, rawConfig: {} }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.getConfigVersion({ ownerId: "intruder", appId: app.id, version: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("withPublishRetry — version race (decision 2)", () => {
  it("retries on a P2002 collision then succeeds", async () => {
    let calls = 0;
    const result = await withPublishRetry(async () => {
      calls += 1;
      if (calls < 2) throw { code: "P2002" };
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("surfaces CONFLICT after exhausting attempts", async () => {
    let calls = 0;
    await expect(
      withPublishRetry(async () => {
        calls += 1;
        throw { code: "P2002" };
      }, 3),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toBe(3);
  });

  it("propagates a non-collision error unchanged (becomes INTERNAL upstream)", async () => {
    await expect(
      withPublishRetry(async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
  });
});
