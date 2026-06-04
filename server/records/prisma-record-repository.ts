// server/records/prisma-record-repository.ts — the real RecordRepository over the Phase 1 model.
//
// First phase to import the Prisma `Record` model: it is aliased to `RecordRow` so it never shadows
// TypeScript's built-in Record<K,V>. Every `where` carries the full { appId, entity, ownerId } scope
// (defence-in-depth: scoping cannot be forgotten at a call site). A row outside the scope resolves
// to null/false, which the service maps to NOT_FOUND — existence is never leaked across owners.

import { Prisma } from "@/app/generated/prisma/client";
import type { Record as RecordRow } from "@/app/generated/prisma/client";
import { prisma } from "@/server/db/client";
import type { ListQuery, RecordRepository, StoredRecord } from "./record-repository";

/** Cast a stored JSON column back to its known map shape (single cast site, no `any`). */
function dataFromJson(value: Prisma.JsonValue): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

/** Cast a coerced record body into a JSON input (Dates serialize to ISO strings on write). */
function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toStoredRecord(row: RecordRow): StoredRecord {
  return {
    id: row.id,
    appId: row.appId,
    entity: row.entity,
    ownerId: row.ownerId,
    data: dataFromJson(row.data),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Build the owner+app+entity scope, plus optional JSONB equality filters (AND-ed together). */
function buildWhere(input: {
  appId: string;
  entity: string;
  ownerId: string;
  filters?: ListQuery["filters"];
}): Prisma.RecordWhereInput {
  const where: Prisma.RecordWhereInput = {
    appId: input.appId,
    entity: input.entity,
    ownerId: input.ownerId,
  };
  if (input.filters && input.filters.length > 0) {
    where.AND = input.filters.map((f) => ({
      data: { path: [f.field], equals: toJsonInput(f.value) },
    }));
  }
  return where;
}

export class PrismaRecordRepository implements RecordRepository {
  async create(input: {
    appId: string;
    entity: string;
    ownerId: string;
    data: Record<string, unknown>;
    version: number;
  }): Promise<StoredRecord> {
    const row = await prisma.record.create({
      data: {
        appId: input.appId,
        entity: input.entity,
        ownerId: input.ownerId,
        data: toJsonInput(input.data),
        version: input.version,
      },
    });
    return toStoredRecord(row);
  }

  async getById(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
  }): Promise<StoredRecord | null> {
    const row = await prisma.record.findFirst({
      where: { id: input.id, appId: input.appId, entity: input.entity, ownerId: input.ownerId },
    });
    return row ? toStoredRecord(row) : null;
  }

  async list(input: {
    appId: string;
    entity: string;
    ownerId: string;
    query: ListQuery;
  }): Promise<{ items: StoredRecord[]; total: number }> {
    const { page, limit, sort, filters } = input.query;
    const where = buildWhere({
      appId: input.appId,
      entity: input.entity,
      ownerId: input.ownerId,
      filters,
    });
    const orderBy: Prisma.RecordOrderByWithRelationInput = sort
      ? { [sort.field]: sort.dir }
      : { createdAt: "desc" };

    const [items, total] = await Promise.all([
      prisma.record.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.record.count({ where }),
    ]);
    return { items: items.map(toStoredRecord), total };
  }

  async update(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
    data: Record<string, unknown>;
    version: number;
  }): Promise<StoredRecord | null> {
    // Scope the match with updateMany (composite, owner-aware) so a cross-owner id never updates;
    // re-read within scope to return the fresh row (or null if nothing matched).
    const result = await prisma.record.updateMany({
      where: { id: input.id, appId: input.appId, entity: input.entity, ownerId: input.ownerId },
      data: { data: toJsonInput(input.data), version: input.version },
    });
    if (result.count === 0) return null;
    return this.getById(input);
  }

  async delete(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
  }): Promise<boolean> {
    const result = await prisma.record.deleteMany({
      where: { id: input.id, appId: input.appId, entity: input.entity, ownerId: input.ownerId },
    });
    return result.count > 0;
  }

  async exists(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
  }): Promise<boolean> {
    const count = await prisma.record.count({
      where: { id: input.id, appId: input.appId, entity: input.entity, ownerId: input.ownerId },
    });
    return count > 0;
  }
}
