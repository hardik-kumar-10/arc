# API Conformance & Security Test Report (Full / Authenticated)

**Target:** `http://localhost:3000` (live `npm run dev`)
**Contract:** `openapi.yaml`
**Method:** Black-box, spec-driven. Authenticated via minted Clerk dev-user session tokens.
**Date:** 2026-06-06
**Harnesses:** `.api-test.mjs` (unauth, 38 assertions) · `.api-authed-test.mjs` (authed, 64 assertions) · manual `curl` probes (rate-limit, cross-owner isolation).

## Result: ✅ PASS — 0 contract violations, 0 security issues

| Suite | Assertions | Pass | Fail |
|-------|-----------:|-----:|-----:|
| Unauthenticated surface | 38 | 37 | 1 (warn) |
| Authenticated surface | 64 | 64 | 0 |
| Rate-limit probe | — | ✅ | — |
| Cross-owner isolation | 7 routes | ✅ | — |

The one "failure" is an informational warning (no HTTP hardening headers), not a contract or security defect.

---

## Coverage — every path + method in the spec was exercised

| Endpoint | Methods | Result |
|----------|---------|--------|
| `/api/health` | GET, HEAD, (405 probes) | ✅ |
| `/api/me` | GET | ✅ `{ownerId}` |
| `/api/apps` | GET, POST | ✅ list + `201` create |
| `/api/apps/{appId}/config` | GET, POST | ✅ active + publish + strict mode |
| `/api/apps/{appId}/config/versions` | GET | ✅ history |
| `/api/apps/{appId}/config/versions/{version}` | GET | ✅ + 400/404 edges |
| `/api/apps/{appId}/data/{entity}` | GET, POST | ✅ list/create + validation |
| `/api/apps/{appId}/data/{entity}/{id}` | GET, PATCH, DELETE | ✅ full CRUD + edges |

---

## What was verified conformant (authenticated)

**Schemas match the spec exactly:**
- `App` — `{id, name, ownerId, activeConfigVersionId:null, createdAt, updatedAt}` on create (`201`).
- `PublishResult` — `{versionId, version:1, diagnostics, config}`.
- `ConfigVersionMeta` — `{id, version, createdAt, diagnosticCounts:{error,warning,info}}`.
- Active config empty-state — `{config:null, version:null, diagnostics:[]}` before first publish.
- `Record` — flat `{...userFields, id, createdAt, updatedAt, version}`; defaults applied
  (`done:false`, `status:"open"`), enum/number/reference values preserved.
- List `meta` — `{page, limit, total}`.

**Behavioral contracts:**
- **Validation (`422 VALIDATION_ERROR`)** with `details.fieldErrors` — missing required field, wrong
  type, bad enum value, and dangling reference all rejected correctly.
- **Strict config publish** — invalid config with `strict:true` → `422 CONFIG_INVALID` carrying
  `details.diagnostics`; nothing persisted.
- **Lenient config publish** — valid config persists as version 1; reflected in active config + history.
- **Version path validation** — `999`→`404 NOT_FOUND`; `abc`/`0`/`-1`→`400 BAD_REQUEST`.
- **Generic CRUD edges** — `POST` to a specific id → `400`; `PATCH`/`DELETE` without id → `400`;
  unknown id → `404`; unknown entity → `404 ENTITY_UNKNOWN`; nested id (`/a/b`) → `400`.
- **Idempotency** — repeated `POST` with same `Idempotency-Key` returns the same record id; a
  **mismatched body under the same key → `409 CONFLICT`**. ✅ exactly per spec.
- **Tolerant list queries** — `limit=9999` clamps to `100`, `page=-5` clamps to `1`, unknown params
  and `sort=bogus:xx` ignored (no 4xx); `?status=open` filters correctly.
- **Delete semantics** — returns `{id}`; subsequent GET → `404`; re-delete → `404`.

---

## Security results — all strong

### ✅ Cross-owner isolation (the critical boundary)
Created a second Clerk user (B) and attempted to reach user A's app on every route:

```
[404 NOT_FOUND] GET    /api/apps/{A_app}/config
[404 NOT_FOUND] GET    /api/apps/{A_app}/config/versions
[404 NOT_FOUND] GET    /api/apps/{A_app}/config/versions/1
[404 NOT_FOUND] GET    /api/apps/{A_app}/data/Task
[404 NOT_FOUND] POST   /api/apps/{A_app}/config      (publish)
[404 NOT_FOUND] POST   /api/apps/{A_app}/data/Task   (create)
B's own /api/apps  ->  count:0, containsAApp:false
```
Every attempt returns **`404 NOT_FOUND`** (never `200`, never `403`) — existence is not leaked, and
both reads and writes are owner-scoped. No IDOR / horizontal-privilege-escalation.

### ✅ Authentication
- All 12 protected routes reject signed-out callers with `401 UNAUTHORIZED`.
- A garbage bearer token → `401` (token is actually verified, not just presence-checked).

### ✅ Rate limiting (matches `RATE_LIMITS.write = 100/60s`)
Fired 115 writes as one owner:
```
201s: 100   429s: 15   first 429 at request #101
Retry-After: 20
body: {"ok":false,"error":{"code":"RATE_LIMITED","message":"Too many requests",
        "details":{"retryAfterSec":20}}, ...}
```
Exactly 100 allowed, then `429 RATE_LIMITED` with the `Retry-After` header. Reads remained exempt
(used to fetch app ids mid-throttle). ✅

### ✅ Error hygiene
No stack traces, file paths, or internal identifiers in any error body. Malformed JSON → structured
error, never a `500`.

### ✅ Injection-resistant correlation id
A malformed inbound `X-Request-Id` is discarded and regenerated as a server uuid (no reflection of
attacker-controlled header values).

---

## Findings (both Low; neither blocks)

### BUG-1 — No HTTP security hardening headers (Low / Hardening)
Responses omit `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`,
`Strict-Transport-Security`. Not spec-mandated; recommend at least `X-Content-Type-Options: nosniff`.

### BUG-2 — `413` evaluated before authentication (Low / Info-disclosure, by-design)
An **unauthenticated** oversized-body request to `POST /api/apps` returns `413 PAYLOAD_TOO_LARGE`
instead of `401` (the `content-length` guard precedes the auth check in `with-route.ts`). The spec
documents both statuses, so this is not a strict violation — but it lets an anonymous caller probe
the body-size limit pre-auth. Accept as-is, or move auth ahead of the size guard.

---

## Notes / test residue
- The rate-limit probe created ~100 throwaway apps named `"rl"` and the conformance run created a
  `"QA App"` for the dev user; a second Clerk user `dev-b@example.com` was created. Clean up if the
  dev DB matters.

## Reproduce
```bash
cd arc
node .api-test.mjs                          # unauth suite
AUTH_TOKEN=<clerk session jwt> node .api-authed-test.mjs   # authed suite
```
