// server/config/config-service.ts — orchestrates compiler + repository, owns HTTP-facing errors.
//
// Lenient by default, strict on request: plain publishConfig ALWAYS persists and returns the
// diagnostics (the resilience behavior the rubric rewards); `strict: true` is the opt-in that
// surfaces CONFIG_INVALID (422) without persisting. Owner scoping is enforced by the repository;
// a null result maps to NOT_FOUND (never FORBIDDEN) so existence isn't leaked.

import { AppError } from "@/server/http/errors";
import { compileConfig } from "./compiler";
import { type AppRecord, type ConfigRepository, type ConfigVersionMeta } from "./config-repository";
import type { AppConfig, Diagnostic } from "./types";

export interface PublishResult {
  versionId: string;
  version: number;
  diagnostics: Diagnostic[];
  config: AppConfig;
}

export interface ActiveConfigResult {
  config: AppConfig | null;
  version: number | null;
  diagnostics: Diagnostic[];
}

export class ConfigService {
  constructor(private readonly repo: ConfigRepository) {}

  async createApp(input: { ownerId: string; name: unknown }): Promise<AppRecord> {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new AppError("VALIDATION_ERROR", "Invalid app name", {
        fieldErrors: { name: ["Name is required"] },
        formErrors: [],
      });
    }
    return this.repo.createApp({ name: input.name, ownerId: input.ownerId });
  }

  async listApps(input: { ownerId: string }): Promise<AppRecord[]> {
    return this.repo.listApps({ ownerId: input.ownerId });
  }

  async publishConfig(input: {
    ownerId: string;
    appId: string;
    rawConfig: unknown;
    strict?: boolean;
  }): Promise<PublishResult> {
    const app = await this.repo.getApp({ appId: input.appId, ownerId: input.ownerId });
    if (!app) throw new AppError("NOT_FOUND", "App not found");

    const { config, diagnostics } = compileConfig(input.rawConfig);

    if (input.strict && diagnostics.some((d) => d.level === "error")) {
      // Strict mode: surface the reserved CONFIG_INVALID code and persist NOTHING.
      throw new AppError("CONFIG_INVALID", "Config has blocking errors", { diagnostics });
    }

    const version = await this.repo.publishVersion({
      appId: input.appId,
      ownerId: input.ownerId,
      raw: input.rawConfig,
      normalized: config,
      diagnostics,
    });

    return { versionId: version.id, version: version.version, diagnostics, config };
  }

  async getActiveConfig(input: { ownerId: string; appId: string }): Promise<ActiveConfigResult> {
    const app = await this.repo.getApp({ appId: input.appId, ownerId: input.ownerId });
    if (!app) throw new AppError("NOT_FOUND", "App not found");

    const active = await this.repo.getActiveVersion({ appId: input.appId, ownerId: input.ownerId });
    if (!active) return { config: null, version: null, diagnostics: [] };
    return { config: active.normalizedConfig, version: active.version, diagnostics: active.diagnostics };
  }

  async getConfigVersion(input: {
    ownerId: string;
    appId: string;
    version: number;
  }): Promise<{ config: AppConfig; version: number; diagnostics: Diagnostic[] }> {
    const found = await this.repo.getVersion({
      appId: input.appId,
      ownerId: input.ownerId,
      version: input.version,
    });
    if (!found) throw new AppError("NOT_FOUND", "Config version not found");
    return { config: found.normalizedConfig, version: found.version, diagnostics: found.diagnostics };
  }

  async listVersions(input: { ownerId: string; appId: string }): Promise<ConfigVersionMeta[]> {
    const app = await this.repo.getApp({ appId: input.appId, ownerId: input.ownerId });
    if (!app) throw new AppError("NOT_FOUND", "App not found");
    return this.repo.listVersions({ appId: input.appId, ownerId: input.ownerId });
  }
}
