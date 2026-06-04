// server/records/record-service.ts — owner-scoped CRUD orchestration over the active config.
//
// Resolve (active config + entity) -> validate/coerce on writes -> reference-existence checks ->
// owner-scoped repository call -> serialize. Writes are strict-but-coercing (422 with fieldErrors
// on failure); reads are tolerant (bad query params clamp/ignore, never 4xx). No input shape ever
// throws: the validator never throws and every malformed case maps to a structured AppError.

import { AppError } from "@/server/http/errors";
import type { AppConfig, EntityDef, FieldDef } from "@/server/config/types";
import { buildEntityValidator } from "@/server/validation/build-validator";
import { baseFieldSchema } from "@/server/validation/field-schemas";
import type { ListQuery, RecordRepository, SortableField } from "./record-repository";
import { serializeRecord, type SerializedRecord } from "./serialize";

/** Narrow reader (not the whole ConfigService): the active normalized config + its version. */
export interface ActiveConfigReader {
  /** Owner-scoped; null when the app is unknown OR has no published config (-> NOT_FOUND). */
  getActive(input: {
    ownerId: string;
    appId: string;
  }): Promise<{ config: AppConfig; version: number } | null>;
}

const SORTABLE_FIELDS: readonly SortableField[] = ["createdAt", "updatedAt", "id"];
const RESERVED_QUERY_PARAMS = new Set(["page", "limit", "sort", "filter"]);

interface ResolveInput {
  ownerId: string;
  appId: string;
  entity: string;
}

export class RecordService {
  constructor(
    private readonly config: ActiveConfigReader,
    private readonly repo: RecordRepository,
  ) {}

  // ---- create ---------------------------------------------------------------

  async create(input: { ownerId: string; appId: string; entity: string; body: unknown }): Promise<SerializedRecord> {
    const { entityDef, version } = await this.resolve(input);

    const result = buildEntityValidator(entityDef).validate(input.body, "create");
    if (!result.ok) {
      throw new AppError("VALIDATION_ERROR", "Validation failed", {
        fieldErrors: result.fieldErrors,
        formErrors: result.formErrors,
      });
    }

    await this.checkReferences(input, entityDef, result.data);

    const row = await this.repo.create({
      appId: input.appId,
      entity: input.entity,
      ownerId: input.ownerId,
      data: result.data,
      version,
    });
    return serializeRecord(row);
  }

  // ---- get ------------------------------------------------------------------

  async get(input: { ownerId: string; appId: string; entity: string; id: string }): Promise<SerializedRecord> {
    await this.resolve(input);
    const row = await this.repo.getById({
      appId: input.appId,
      entity: input.entity,
      ownerId: input.ownerId,
      id: input.id,
    });
    if (!row) throw new AppError("NOT_FOUND", "Record not found");
    return serializeRecord(row);
  }

  // ---- list -----------------------------------------------------------------

  async list(input: {
    ownerId: string;
    appId: string;
    entity: string;
    searchParams: URLSearchParams;
  }): Promise<{ items: SerializedRecord[]; meta: { page: number; limit: number; total: number } }> {
    const { entityDef } = await this.resolve(input);
    const query = this.parseListQuery(input.searchParams, entityDef);

    const { items, total } = await this.repo.list({
      appId: input.appId,
      entity: input.entity,
      ownerId: input.ownerId,
      query,
    });

    return {
      items: items.map(serializeRecord),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  // ---- update ---------------------------------------------------------------

  async update(input: {
    ownerId: string;
    appId: string;
    entity: string;
    id: string;
    body: unknown;
  }): Promise<SerializedRecord> {
    const { entityDef, version } = await this.resolve(input);

    const existing = await this.repo.getById({
      appId: input.appId,
      entity: input.entity,
      ownerId: input.ownerId,
      id: input.id,
    });
    if (!existing) throw new AppError("NOT_FOUND", "Record not found");

    const result = buildEntityValidator(entityDef).validate(input.body, "update");
    if (!result.ok) {
      throw new AppError("VALIDATION_ERROR", "Validation failed", {
        fieldErrors: result.fieldErrors,
        formErrors: result.formErrors,
      });
    }

    await this.checkReferences(input, entityDef, result.data);

    // Merge: only the sent fields overwrite; update mode injects no defaults (Phase 3 contract).
    const merged = { ...existing.data, ...result.data };

    const row = await this.repo.update({
      appId: input.appId,
      entity: input.entity,
      ownerId: input.ownerId,
      id: input.id,
      data: merged,
      version, // re-stamp to the version the row was just validated under
    });
    if (!row) throw new AppError("NOT_FOUND", "Record not found");
    return serializeRecord(row);
  }

  // ---- delete ---------------------------------------------------------------

  async delete(input: { ownerId: string; appId: string; entity: string; id: string }): Promise<{ id: string }> {
    await this.resolve(input);
    const deleted = await this.repo.delete({
      appId: input.appId,
      entity: input.entity,
      ownerId: input.ownerId,
      id: input.id,
    });
    if (!deleted) throw new AppError("NOT_FOUND", "Record not found");
    return { id: input.id };
  }

  // ---- internals ------------------------------------------------------------

  /** Resolve the active config + the requested entity (exact-case). */
  private async resolve(input: ResolveInput): Promise<{ config: AppConfig; version: number; entityDef: EntityDef }> {
    const active = await this.config.getActive({ ownerId: input.ownerId, appId: input.appId });
    if (!active) throw new AppError("NOT_FOUND", "App not found");

    const entityDef = active.config.entities.find((e) => e.name === input.entity);
    if (!entityDef) throw new AppError("ENTITY_UNKNOWN", `Unknown entity '${input.entity}'`);

    return { config: active.config, version: active.version, entityDef };
  }

  /** Reference existence: every present reference field must point at an owned, existing row. */
  private async checkReferences(
    scope: { appId: string; ownerId: string },
    entityDef: EntityDef,
    data: Record<string, unknown>,
  ): Promise<void> {
    const refs = entityDef.fields.filter(
      (f): f is FieldDef & { ref: string } =>
        f.type === "reference" && typeof f.ref === "string" && f.name in data,
    );
    if (refs.length === 0) return;

    const checks = await Promise.all(
      refs.map(async (field) => {
        const value = data[field.name];
        // Phase 3 guarantees a present reference is a non-empty string; guard defensively anyway.
        if (typeof value !== "string" || value.length === 0) {
          return { field, value, exists: false };
        }
        const exists = await this.repo.exists({
          appId: scope.appId,
          entity: field.ref,
          ownerId: scope.ownerId,
          id: value,
        });
        return { field, value, exists };
      }),
    );

    const fieldErrors: Record<string, string[]> = {};
    for (const { field, value, exists } of checks) {
      if (!exists) {
        fieldErrors[field.name] = [`referenced ${field.ref} '${String(value)}' not found`];
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError("VALIDATION_ERROR", "Validation failed", { fieldErrors, formErrors: [] });
    }
  }

  /** Tolerant query parsing: clamp pagination, validate sort, coerce/drop filters — never 4xx. */
  private parseListQuery(searchParams: URLSearchParams, entityDef: EntityDef): ListQuery {
    const page = this.parsePositiveInt(searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = this.parsePositiveInt(searchParams.get("limit"), 20, 1, 100);
    const sort = this.parseSort(searchParams.get("sort"));
    const filters = this.parseFilters(searchParams, entityDef);
    return { page, limit, sort, filters };
  }

  private parsePositiveInt(raw: string | null, fallback: number, min: number, max: number): number {
    if (raw === null) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  private parseSort(raw: string | null): ListQuery["sort"] {
    if (raw === null) return undefined; // -> repo default (createdAt desc)
    const [field, dirRaw] = raw.split(":");
    if (!SORTABLE_FIELDS.includes(field as SortableField)) return undefined; // unknown field -> default
    const dir = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : "asc";
    return { field: field as SortableField, dir };
  }

  private parseFilters(searchParams: URLSearchParams, entityDef: EntityDef): ListQuery["filters"] {
    const filters: { field: string; value: unknown }[] = [];
    for (const [key, raw] of searchParams.entries()) {
      // Support both `?field=value` and `?filter[field]=value`; reserved params are never filters.
      const bracket = key.match(/^filter\[(.+)\]$/);
      const name = bracket ? bracket[1] : key;
      if (!bracket && RESERVED_QUERY_PARAMS.has(key)) continue;

      const field = entityDef.fields.find((f) => f.name === name);
      if (!field) continue; // unknown field -> ignore

      const parsed = baseFieldSchema(field).safeParse(raw);
      if (!parsed.success) continue; // uncoercible -> drop this one filter
      // JSONB stores dates as ISO strings; normalize so equality matches storage.
      const value = parsed.data instanceof Date ? parsed.data.toISOString() : parsed.data;
      filters.push({ field: name, value });
    }
    return filters.length > 0 ? filters : undefined;
  }
}
