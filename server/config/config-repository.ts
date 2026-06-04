// server/config/config-repository.ts — the storage seam.
//
// The ConfigService depends only on this interface, so the test suite mocks it with an in-memory
// implementation and stays DB-free (mirroring how Phase 1 mocked getOwnerContext). The real
// Prisma-backed implementation lives in prisma-config-repository.ts.

import type { AppConfig, Diagnostic } from "./types";

export interface AppRecord {
  id: string;
  name: string;
  ownerId: string;
  activeConfigVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConfigVersionRecord {
  id: string;
  appId: string;
  version: number;
  rawConfig: unknown;
  normalizedConfig: AppConfig;
  diagnostics: Diagnostic[];
  createdAt: Date;
}

export interface ConfigVersionMeta {
  id: string;
  version: number;
  createdAt: Date;
  diagnosticCounts: { error: number; warning: number; info: number };
}

export interface ConfigRepository {
  createApp(input: { name: string; ownerId: string }): Promise<AppRecord>;
  /** Owner-scoped; a row that exists but isn't the caller's resolves to null (no existence leak). */
  getApp(input: { appId: string; ownerId: string }): Promise<AppRecord | null>;
  listApps(input: { ownerId: string }): Promise<AppRecord[]>;
  /** Creates an immutable version AND repoints the app's active pointer, atomically + race-safe. */
  publishVersion(input: {
    appId: string;
    ownerId: string;
    raw: unknown;
    normalized: AppConfig;
    diagnostics: Diagnostic[];
  }): Promise<ConfigVersionRecord>;
  getActiveVersion(input: { appId: string; ownerId: string }): Promise<ConfigVersionRecord | null>;
  getVersion(input: { appId: string; ownerId: string; version: number }): Promise<ConfigVersionRecord | null>;
  listVersions(input: { appId: string; ownerId: string }): Promise<ConfigVersionMeta[]>;
}

/** Shared helper: diagnostic counts by level for version-history metadata. */
export function countDiagnostics(diagnostics: Diagnostic[]): ConfigVersionMeta["diagnosticCounts"] {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.level] += 1;
  return counts;
}
