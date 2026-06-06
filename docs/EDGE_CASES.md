# EDGE_CASES.md — the failure map & Loom script

Every failure mode the brief names, the exact response it produces, *why* that is the right behavior,
and the test that proves it. The cardinal invariant across the whole table: **input is 4xx, only a
genuine server fault is 5xx — no client input ever produces a 500.**

All rows are proven by **handler-level** tests that run the real route handlers against real services
over in-memory repos (`server/__edge__/edge-cases.test.ts`), plus focused unit tests for the
hardening primitives. Every response is a discriminated envelope
(`{ ok, data | error, meta?, requestId }`) with a correlation id echoed in the `X-Request-Id` header.

## Demo arc (read top-to-bottom in the Loom)

1. **Publish a broken config → it still works.** Resilience layer 1: normalize, never reject.
2. **Create a record with a type mismatch → it coerces.** Layer 3, write path.
3. **Trigger each failure → clean 4xx, never a 500.** The taxonomy in action.
4. **Republish a changed schema, read an old record → drift projection.** Layer, read path.
5. **Fire a workflow whose action fails → the record is still created, the failure is logged in `meta`.**
6. **Hammer an endpoint → `429`; replay a create with a key → no double insert.**

---

## Config / schema (Phase 2 / 5)

| Input | Expected status + code | Why | Test |
|---|---|---|---|
| Publish config missing app fields | `200` + `diagnostics` (`APP_NAME_DEFAULTED`) | Normalize, never reject: defaults are filled and reported, not rejected | `Config / schema › missing app fields` |
| Publish `config: 42` (non-object) | `200` + `CONFIG_NOT_OBJECT` diagnostic, empty valid config | A garbage config compiles to a safe empty shell, never a 500 | `Config / schema › non-object config payload` |
| Publish with `strict: true` + error diagnostics | `422 CONFIG_INVALID`, nothing persisted | Strict mode is the opt-in that surfaces blocking errors without persisting | `Config / schema › strict publish` |
| Dangling reference (`ref: "Ghost"`) | `200` + `REF_UNKNOWN_ENTITY` diagnostic | Inconsistent schema is repaired + reported, publish still succeeds | `Config / schema › inconsistent schema` |
| Unknown field type / invalid values | field dropped, `200` + diagnostic | Compiler quarantines what it can't use | covered in Phase 2 compiler suite |
| Unknown component (`type` present/absent) | preserved structurally / dropped + diagnostic | UI nodes are opaque-but-structural | covered in Phase 2 compiler suite |

## Validation / CRUD (Phase 3 / 4)

| Input | Expected status + code | Why | Test |
|---|---|---|---|
| Missing required field on create | `422 VALIDATION_ERROR` + `fieldErrors` | Writes are strict-but-coercing; per-field errors are returned | `Validation / CRUD › missing required field` |
| Malformed JSON body | `400 BAD_REQUEST` | Unparseable input is rejected before handler logic | `Validation / CRUD › malformed JSON` |
| Coercible mismatch (`"42"`→42, `"false"`→false) | `201`, coerced | Coerce where safe | `Validation / CRUD › coercible type mismatch` |
| Uncoercible mismatch (`"not-a-number"`) | `422 VALIDATION_ERROR` | Fail cleanly where coercion is unsafe | same test |
| Unknown entity | `404 ENTITY_UNKNOWN` | Entity not in the active config | `Validation / CRUD › unknown entity` |
| Record id not found | `404 NOT_FOUND` | — | `Validation / CRUD › record not found` |
| Cross-owner read | `404 NOT_FOUND` | Owner scoping never leaks existence across users | `Validation / CRUD › cross-owner read` |
| `>= 2` id segments | `400 BAD_REQUEST` | Nested record ids are unsupported | `Validation / CRUD › bad id arity` |
| Dangling reference on write | `422 VALIDATION_ERROR` field error | Reference must point at an owned, existing row | `Validation / CRUD › dangling reference` |

## Drift (Phase 5)

| Input | Expected status + code | Why | Test |
|---|---|---|---|
| Old record read under a new config | `200` + `meta.drift` | Reads are tolerant: project stored data onto the current schema | `Drift › reads cleanly under a new config` |
| Read a record whose entity was removed | `404 ENTITY_UNKNOWN` | No current shape to project into | `Drift › removed entity` |

## Workflows (Phase 6)

| Input | Expected status + code | Why | Test |
|---|---|---|---|
| Create triggers a failing/unknown workflow action | `201`; `meta.workflows` reflects skipped/failed | Workflows are post-commit best-effort; never alter or roll back the write | `Workflows › a failing workflow action` |

## Hardening (Phase 7)

| Input | Expected status + code | Why | Test |
|---|---|---|---|
| Body over the 1 MB cap | `413 PAYLOAD_TOO_LARGE` | Memory-safe ingestion: the read aborts mid-stream | `Hardening › over-cap body` + `read-json › aborts mid-stream` |
| Writes past the rate budget | `429 RATE_LIMITED` + `Retry-After` | Per-owner/IP budget; limiter **fails open** on its own error | `Hardening › rate-limit exhaustion` + `rate-limit.test.ts` |
| Replay create, same key + same body | `201`, same record, no double-insert | Network retries are safe | `Hardening › idempotent replay (same body)` |
| Replay create, same key + different body | `409 CONFLICT` | A key cannot be reused for a divergent request | `Hardening › idempotent replay (different body)` |
| Inbound `X-Request-Id` | echoed back as `X-Request-Id` header; present in body | One id, end to end, for traceability | `Hardening › echoes requestId` + `with-route › correlation id` |

## The umbrella assertion — zero 5xx

A fuzz loop throws a spread of garbage (null, array, primitive, deep nesting, wrong types) at **every
verb**, asserting each response is a structured 4xx (or tolerant 200 for reads) with a `requestId` —
**never a 5xx**. This is the single strongest piece of evidence for the reliability mark.

- `Zero-5xx fuzz loop › POST create` — every garbage body
- `Zero-5xx fuzz loop › PATCH update` — every garbage body
- `Zero-5xx fuzz loop › GET list` — garbage query params → tolerant `200`
- `Zero-5xx fuzz loop › DELETE / apps / config verbs` — junk input

> Implementation note: `server/__edge__/edge-cases.test.ts` wraps **every** response through a single
> `unwrap()` helper that asserts `status < 500` and a non-empty `requestId`. The invariant therefore
> holds for every case in the file, not only the fuzz loop.

## Reliability invariants (state these in the Loom)

- **4xx for input, 5xx only for genuine faults** — proven by the zero-5xx fuzz loop across every verb.
- **Rate limiter fails open** — a limiter outage degrades to "allow," never to an outage of its own.
- **Idempotent creates** — retries can't double-write; same key+body replays, divergent body is `409`.
- **Memory-safe ingestion** — oversized bodies abort mid-stream (the source is cancelled), not buffered.
- **One id, end to end** — an inbound or generated `requestId` is echoed in the header, in the body,
  and in every server log line for that request.
