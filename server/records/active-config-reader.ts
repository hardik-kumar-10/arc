// server/records/active-config-reader.ts — the real ActiveConfigReader over the config store.
//
// A NARROW reader (architecture: the service depends on this, not the whole ConfigService) built
// directly on ConfigRepository, so there is no exception-as-control-flow: a missing app or an app
// with no published config both resolve to null, which RecordService maps to NOT_FOUND.

import type { ConfigRepository } from "@/server/config/config-repository";
import type { AppConfig } from "@/server/config/types";
import type { ActiveConfigReader } from "./record-service";

export class ConfigActiveReader implements ActiveConfigReader {
  constructor(private readonly repo: ConfigRepository) {}

  async getActive(input: {
    ownerId: string;
    appId: string;
  }): Promise<{ config: AppConfig; version: number } | null> {
    const app = await this.repo.getApp({ appId: input.appId, ownerId: input.ownerId });
    if (!app) return null;

    const active = await this.repo.getActiveVersion({ appId: input.appId, ownerId: input.ownerId });
    if (!active) return null;

    return { config: active.normalizedConfig, version: active.version };
  }
}
