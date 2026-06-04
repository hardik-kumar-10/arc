// server/config/prisma-config-repository.ts — the real ConfigRepository over the Phase 1 models.
//
// Every read is owner-scoped (directly on App.ownerId, or through the `app` relation for
// ConfigVersion), so a row that exists but isn't the caller's resolves to null. publishVersion is
// race-safe: it retries on a (appId, version) unique collision and only surfaces CONFLICT after
// exhausting attempts — a version race must never become a 500 (architecture.md §2.2).

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/server/db/client";
import {
  countDiagnostics,
  type AppRecord,
  type ConfigRepository,
  type ConfigVersionMeta,
  type ConfigVersionRecord,
} from "./config-repository";
import { withPublishRetry } from "./publish-retry";
import type { AppConfig, Diagnostic } from "./types";

/** Cast a stored JSON column back to its known domain shape (single cast site, no `any`). */
function fromJson<T>(value: Prisma.JsonValue): T {
  return value as unknown as T;
}

/** Cast an arbitrary value into a JSON input, mapping JS null to Prisma's JSON null sentinel. */
function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

type AppRow = {
  id: string;
  name: string;
  ownerId: string;
  activeConfigVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type VersionRow = {
  id: string;
  appId: string;
  version: number;
  rawConfig: Prisma.JsonValue;
  normalizedConfig: Prisma.JsonValue;
  diagnostics: Prisma.JsonValue;
  createdAt: Date;
};

function toAppRecord(row: AppRow): AppRecord {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    activeConfigVersionId: row.activeConfigVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersionRecord(row: VersionRow): ConfigVersionRecord {
  return {
    id: row.id,
    appId: row.appId,
    version: row.version,
    rawConfig: row.rawConfig as unknown,
    normalizedConfig: fromJson<AppConfig>(row.normalizedConfig),
    diagnostics: fromJson<Diagnostic[]>(row.diagnostics),
    createdAt: row.createdAt,
  };
}

export class PrismaConfigRepository implements ConfigRepository {
  async createApp(input: { name: string; ownerId: string }): Promise<AppRecord> {
    const app = await prisma.app.create({ data: { name: input.name, ownerId: input.ownerId } });
    return toAppRecord(app);
  }

  async getApp(input: { appId: string; ownerId: string }): Promise<AppRecord | null> {
    const app = await prisma.app.findFirst({
      where: { id: input.appId, ownerId: input.ownerId },
    });
    return app ? toAppRecord(app) : null;
  }

  async listApps(input: { ownerId: string }): Promise<AppRecord[]> {
    const apps = await prisma.app.findMany({
      where: { ownerId: input.ownerId },
      orderBy: { createdAt: "desc" },
    });
    return apps.map(toAppRecord);
  }

  async publishVersion(input: {
    appId: string;
    ownerId: string;
    raw: unknown;
    normalized: AppConfig;
    diagnostics: Diagnostic[];
  }): Promise<ConfigVersionRecord> {
    // Retries on a (appId, version) collision; exhaustion → CONFLICT (never a 500).
    const created = await withPublishRetry(() =>
      prisma.$transaction(async (tx) => {
        const last = await tx.configVersion.findFirst({
          where: { appId: input.appId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const nextVersion = (last?.version ?? 0) + 1;

        const row = await tx.configVersion.create({
          data: {
            appId: input.appId,
            version: nextVersion,
            rawConfig: toJsonInput(input.raw),
            normalizedConfig: toJsonInput(input.normalized),
            diagnostics: toJsonInput(input.diagnostics),
          },
        });
        await tx.app.update({
          where: { id: input.appId },
          data: { activeConfigVersionId: row.id },
        });
        return row;
      }),
    );
    return toVersionRecord(created);
  }

  async getActiveVersion(input: {
    appId: string;
    ownerId: string;
  }): Promise<ConfigVersionRecord | null> {
    const app = await prisma.app.findFirst({
      where: { id: input.appId, ownerId: input.ownerId },
      select: { activeConfigVersionId: true },
    });
    if (!app?.activeConfigVersionId) return null;
    const row = await prisma.configVersion.findUnique({ where: { id: app.activeConfigVersionId } });
    return row ? toVersionRecord(row) : null;
  }

  async getVersion(input: {
    appId: string;
    ownerId: string;
    version: number;
  }): Promise<ConfigVersionRecord | null> {
    const row = await prisma.configVersion.findFirst({
      where: { appId: input.appId, version: input.version, app: { ownerId: input.ownerId } },
    });
    return row ? toVersionRecord(row) : null;
  }

  async listVersions(input: { appId: string; ownerId: string }): Promise<ConfigVersionMeta[]> {
    const rows = await prisma.configVersion.findMany({
      where: { appId: input.appId, app: { ownerId: input.ownerId } },
      orderBy: { version: "desc" },
      select: { id: true, version: true, createdAt: true, diagnostics: true },
    });
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      createdAt: r.createdAt,
      diagnosticCounts: countDiagnostics(fromJson<Diagnostic[]>(r.diagnostics)),
    }));
  }
}
