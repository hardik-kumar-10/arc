// server/records/serialize.ts — flatten a stored record into the API representation.
//
// Flat shape `{ id, createdAt, updatedAt, version, ...data }` is SAFE because Phase 2 dropped any
// field whose name collides with a system column (RESERVED_FIELD_NAMES), so no `data` key can
// shadow id/createdAt/updatedAt/version. Phase 5 feeds this the *projected* data, but the flat
// shape is unchanged — a conforming record serializes byte-identically to Phase 4.

import type { StoredRecord } from "./record-repository";

export interface SerializedRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  [key: string]: unknown;
}

export function serializeRecord(row: StoredRecord): SerializedRecord {
  return {
    ...row.data,
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

// ---- response-meta side-channel ---------------------------------------------
//
// `get`/`create`/`update`/`delete` keep returning their FLAT result (callers read `record.title`;
// route tests mock flat returns). Per-request envelope `meta` — Phase 5 drift, Phase 6 workflow
// summary — belongs in the response ENVELOPE's `meta`, not inside `data`, so we cannot stuff it into
// the result. We carry it on a non-enumerable Symbol key: invisible to spread, JSON, and deep-equality
// (so clean responses stay byte-identical to Phase 4/5), but reachable by the route, which lifts it
// into `meta`. Absent symbol -> undefined -> no `meta` key. Multiple producers MERGE into one object.

const RESPONSE_META = Symbol("recordResponseMeta");

type WithResponseMeta = { [RESPONSE_META]?: Record<string, unknown> };

/** Merge a partial into the result's response-meta (creating it if absent); returns the same object. */
export function attachResponseMeta<T extends object>(record: T, partial: Record<string, unknown>): T {
  const existing = readResponseMeta(record) ?? {};
  Object.defineProperty(record, RESPONSE_META, {
    value: { ...existing, ...partial },
    enumerable: false,
    configurable: true,
  });
  return record;
}

/** Read the merged response-meta, or `undefined` for a clean (or externally-built) result. */
export function readResponseMeta<T extends object>(record: T): Record<string, unknown> | undefined {
  return (record as T & WithResponseMeta)[RESPONSE_META];
}

/** Phase 5 drift meta is just response meta — kept as a named alias for clarity at call sites. */
export function attachDriftMeta(record: SerializedRecord, meta: Record<string, unknown>): SerializedRecord {
  return attachResponseMeta(record, meta);
}
export const readDriftMeta = readResponseMeta;
