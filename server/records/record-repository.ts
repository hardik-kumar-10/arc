// server/records/record-repository.ts — the mockable storage seam for user records.
//
// Every method is owner+app+entity scoped; scoping is enforced INSIDE the implementation so no
// caller can forget it. A row that exists but belongs to another owner is invisible (null/false),
// which the service maps to NOT_FOUND — existence is never leaked across owners. The service mocks
// this with an in-memory impl and stays DB-free; the real Prisma impl lives alongside.

/** Stored record shape — `data` uses TypeScript's built-in Record<K,V>, not the Prisma model. */
export interface StoredRecord {
  id: string;
  appId: string;
  entity: string;
  ownerId: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Phase 4 sorts only by system columns; ordering by a JSONB data field needs raw SQL (future). */
export type SortableField = "createdAt" | "updatedAt" | "id";

export interface ListQuery {
  page: number; // already clamped by the service (>= 1)
  limit: number; // already clamped by the service ([1, 100])
  sort?: { field: SortableField; dir: "asc" | "desc" };
  filters?: { field: string; value: unknown }[]; // equality only; field+value validated by the service
}

export interface RecordRepository {
  create(input: {
    appId: string;
    entity: string;
    ownerId: string;
    data: Record<string, unknown>;
    version: number;
  }): Promise<StoredRecord>;

  getById(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
  }): Promise<StoredRecord | null>;

  list(input: {
    appId: string;
    entity: string;
    ownerId: string;
    query: ListQuery;
  }): Promise<{ items: StoredRecord[]; total: number }>;

  update(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
    data: Record<string, unknown>;
    version: number;
  }): Promise<StoredRecord | null>;

  delete(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
  }): Promise<boolean>;

  /** Reference existence check — owner-scoped, so you cannot reference (or probe for) another's row. */
  exists(input: {
    appId: string;
    entity: string;
    ownerId: string;
    id: string;
  }): Promise<boolean>;
}
