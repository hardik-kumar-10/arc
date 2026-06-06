// server/workflows/record-writer.ts — WorkflowRecordWriter implemented over RecordService + repo.
//
// This adapter is the composition-root bridge that breaks the would-be cycle
// (RecordService -> WorkflowRunner -> writes -> RecordService): the runner depends only on the narrow
// `WorkflowRecordWriter` interface, and this concrete impl is wired in at `records/service.ts`.
//
// - createRecord -> the normal RecordService.create path, PASSING depth, so cascades fire their own
//   workflows at depth+1 and are bounded by the runner's cascade cap.
// - setFieldSilent -> a repo-level scoped update that BYPASSES the hook, so a self-update from a
//   `setField` action cannot re-fire workflows (no onUpdate loop).

import { toStoredRepr } from "@/server/records/value-repr";
import type { RecordRepository } from "@/server/records/record-repository";
import type { RecordService } from "@/server/records/record-service";
import type { WorkflowRecordWriter } from "./types";

export class RecordServiceWorkflowWriter implements WorkflowRecordWriter {
  constructor(
    private readonly recordService: RecordService,
    private readonly repo: RecordRepository,
  ) {}

  async createRecord(input: {
    ownerId: string;
    appId: string;
    entity: string;
    data: Record<string, unknown>;
    depth: number;
  }): Promise<void> {
    await this.recordService.create({
      ownerId: input.ownerId,
      appId: input.appId,
      entity: input.entity,
      body: input.data,
      depth: input.depth, // tracked + capped by the runner's cascade limit
    });
  }

  async setFieldSilent(input: {
    ownerId: string;
    appId: string;
    entity: string;
    id: string;
    field: string;
    value: unknown;
  }): Promise<void> {
    const scope = { appId: input.appId, entity: input.entity, ownerId: input.ownerId, id: input.id };
    const existing = await this.repo.getById(scope);
    if (!existing) return; // record gone -> silent no-op (never throws into the runner)

    const merged = { ...existing.data, [input.field]: toStoredRepr(input.value) };
    await this.repo.update({ ...scope, data: merged, version: existing.version }); // repo-level: no hook re-fire
  }
}
