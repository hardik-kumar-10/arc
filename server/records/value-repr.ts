// server/records/value-repr.ts — the single source for "stored representation".
//
// JSONB has no Date type: a coerced `Date` is persisted as an ISO string and read back as that
// string. Phase 4's filter path normalized a coerced Date to ISO inline; Phase 5 extracts that one
// rule here so the write path, the filter path, and the read-time projector all agree on the stored
// shape *by construction* — nobody reimplements Date→ISO. The rule is intentionally tiny and
// idempotent: applying it to already-stored data is a no-op.

/** Normalize one coerced value to the representation JSONB stores: Date → ISO string, else as-is. */
export function toStoredRepr(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Apply {@link toStoredRepr} to every top-level value of a validated/coerced data object. */
export function toStoredData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = toStoredRepr(value);
  }
  return out;
}
