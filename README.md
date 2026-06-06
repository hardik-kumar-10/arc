# arc

A config-driven application backend — define your data schema via a published config, then read/write records against it through a generic REST API. Built on Next.js 16 App Router, Prisma 7, Clerk authentication, and PostgreSQL.

## What it does

- **Apps** — create logical apps, each with its own config lineage and record store.
- **Config publishing** — POST a JSON schema config; the server compiles, validates, and versions it. Supports lenient (repair + warn) and strict (reject on error) modes.
- **Generic CRUD** — every entity defined in the active config gets full CRUD at `/api/apps/{appId}/data/{entity}` with no extra code.
- **Security** — all resources are owner-scoped via Clerk; another owner's app returns `404` (existence is never leaked). All protected routes reject unauthenticated callers with `401`.
- **Rate limiting** — writes are limited to 100/60s per owner; reads are exempt. Returns `429` with `Retry-After`.
- **Idempotency** — record creates accept an optional `Idempotency-Key` header; replaying the same key returns the original response, a mismatched body returns `409`.

The interactive API docs are available at [`/reference`](http://localhost:3000/reference) (Scalar), and the raw OpenAPI 3.1 spec is served at [`/openapi.yaml`](http://localhost:3000/openapi.yaml).

## Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Route Handlers) |
| Language | TypeScript (strict) |
| Database / ORM | PostgreSQL + Prisma 7 (`@prisma/adapter-pg`) |
| Auth | Clerk (`@clerk/nextjs`) |
| Validation | Zod |
| Rate limiting / idempotency | `rate-limiter-flexible` (in-process) |
| Styling | Tailwind CSS v4 |
| Tests | Vitest |

## Project structure

```
app/
  api/            # Route handlers (health, me, apps, config, records)
  reference/      # Scalar API docs UI
  page.tsx        # Demo console (home)
lib/
  auth/           # getOwnerContext() — Clerk abstraction
  config/         # Config compiler / validator
  db/             # Prisma client singleton
  http/           # withRoute() — request lifecycle, error handling, rate limiting
  records/        # RecordService — generic entity CRUD
  validation/     # Zod schemas and validators
  workflows/      # Workflow actions and conditions
prisma/
  schema.prisma   # App, ConfigVersion, Record models
  migrations/     # Applied migration history
server/           # Server-side utilities
docs/
  API_TEST_REPORT.md      # Full conformance + security test results
  DEPLOYMENT_CHECKLIST.md # Step-by-step deploy guide
  EDGE_CASES.md           # Resilience matrix
openapi.yaml      # OpenAPI 3.1 contract
```

## Getting started

### Prerequisites

- Node.js 20 LTS or newer
- A PostgreSQL database (local or hosted — Neon, Supabase, etc.)
- A [Clerk](https://clerk.com) development application

### 1. Install dependencies

```bash
npm install
```

### 2. Set environment variables

Copy the example below to `.env`:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/arc"

CLERK_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."
NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in"
NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up"
```

### 3. Generate the Prisma client and run migrations

```bash
npx prisma generate
npx prisma migrate deploy
```

### 4. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to use the demo console, or [http://localhost:3000/reference](http://localhost:3000/reference) for the interactive API docs.

## API overview

All responses use a standard envelope:

- **Success:** `{ ok: true, data, meta?, requestId }`
- **Failure:** `{ ok: false, error: { code, message, details? }, requestId }`

Every response echoes an `x-request-id` header. Send `X-Request-Id` in your request to supply your own correlation ID.

### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | public | Liveness probe |
| GET | `/api/me` | ✅ | Current `ownerId` |
| GET | `/api/apps` | ✅ | List caller's apps |
| POST | `/api/apps` | ✅ | Create an app |
| GET | `/api/apps/{appId}/config` | ✅ | Active config + version + diagnostics |
| POST | `/api/apps/{appId}/config` | ✅ | Publish a config |
| GET | `/api/apps/{appId}/config/versions` | ✅ | Version history |
| GET | `/api/apps/{appId}/config/versions/{version}` | ✅ | A specific version |
| GET | `/api/apps/{appId}/data/{entity}` | ✅ | List records (paginated) |
| POST | `/api/apps/{appId}/data/{entity}` | ✅ | Create a record |
| GET | `/api/apps/{appId}/data/{entity}/{id}` | ✅ | Get a record |
| PATCH | `/api/apps/{appId}/data/{entity}/{id}` | ✅ | Partial update |
| DELETE | `/api/apps/{appId}/data/{entity}/{id}` | ✅ | Delete a record |

### Error codes

| Code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | Malformed body or shape |
| `UNAUTHORIZED` | 401 | No authenticated owner |
| `NOT_FOUND` | 404 | Resource not found in owner scope |
| `ENTITY_UNKNOWN` | 404 | Entity not in active config |
| `CONFLICT` | 409 | Idempotency key reused with different body |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds size cap |
| `VALIDATION_ERROR` | 422 | Field validation failed |
| `CONFIG_INVALID` | 422 | Strict publish with blocking errors |
| `RATE_LIMITED` | 429 | Write limit exceeded |
| `INTERNAL` | 500 | Server fault |

## Scripts

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm run start        # Start production server
npm run typecheck    # TypeScript type check
npm run lint         # ESLint
npm run test         # Run tests (Vitest)
npm run test:watch   # Vitest in watch mode
```

## Testing

The project ships two black-box API test harnesses:

```bash
node .api-test.mjs                                            # Unauthenticated surface (38 assertions)
AUTH_TOKEN=<clerk session jwt> node .api-authed-test.mjs     # Authenticated surface (64 assertions)
```

See [`docs/API_TEST_REPORT.md`](docs/API_TEST_REPORT.md) for the full conformance and security test results. All 102 assertions pass, with 0 contract violations and 0 security issues.

## Deployment

See [`docs/DEPLOYMENT_CHECKLIST.md`](docs/DEPLOYMENT_CHECKLIST.md) for a full step-by-step guide covering Vercel and self-hosted Node/Docker options.

**Key notes before deploying:**

- `app/generated/prisma` is git-ignored — add `"postinstall": "prisma generate"` to `package.json` or run `npx prisma generate` in your build pipeline.
- Run `npx prisma migrate deploy` against your production database before the app serves traffic.
- Rate limiting and idempotency are **in-process** (per-instance). For multi-instance or serverless deployments, swap in a shared store (Postgres/Redis) behind the existing `RateLimiter` / `IdempotencyStore` interfaces.
