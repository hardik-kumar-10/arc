// server/records/serialize.ts — flatten a stored record into the API representation.
//
// Flat shape `{ id, createdAt, updatedAt, version, ...data }` is SAFE because Phase 2 dropped any
// field whose name collides with a system column (RESERVED_FIELD_NAMES), so no `data` key can
// shadow id/createdAt/updatedAt/version. Phase 4 returns RAW stored data — no drift projection
// (that's Phase 5); a date field written as an ISO string comes back as that string.

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
