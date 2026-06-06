export const newRequestId = (): string => crypto.randomUUID();

// A caller/proxy may supply its own correlation id via `X-Request-Id`. Accept it only when it is
// well-formed (safe charset, bounded length) to avoid header injection or unbounded log fields;
// otherwise generate a fresh id (Phase 1 behavior).
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export const resolveRequestId = (inbound: string | null): string =>
  inbound && REQUEST_ID_RE.test(inbound) ? inbound : newRequestId();
