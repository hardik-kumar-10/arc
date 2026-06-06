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

// ---- drift meta side-channel ------------------------------------------------
//
// `get`/`update` keep returning the FLAT SerializedRecord (callers read `record.title`; route tests
// mock flat returns). Per-read drift belongs in the response ENVELOPE's `meta`, not inside `data`,
// so we cannot stuff it into the flat object. We attach it on a non-enumerable Symbol key: invisible
// to spread, JSON, and deep-equality (so conforming responses stay byte-identical to Phase 4), but
// reachable by the route, which lifts it into `meta`. Absent symbol -> undefined -> no `meta` key.

const DRIFT_META = Symbol("recordDriftMeta");

type WithDriftMeta = { [DRIFT_META]?: Record<string, unknown> };

/** Attach envelope-`meta` for a drifted read; returns the same record for chaining. */
export function attachDriftMeta(record: SerializedRecord, meta: Record<string, unknown>): SerializedRecord {
  Object.defineProperty(record, DRIFT_META, { value: meta, enumerable: false, configurable: true });
  return record;
}

/** Read the drift meta the service attached, or `undefined` for a clean (or externally-built) record. */
export function readDriftMeta(record: SerializedRecord): Record<string, unknown> | undefined {
  return (record as SerializedRecord & WithDriftMeta)[DRIFT_META];
}
