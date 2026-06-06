# Deployment Checklist — arc backend

A practical, do-this-in-order guide to deploying the arc config-driven backend (Next.js 16 App
Router + Prisma 7 + Clerk + PostgreSQL), plus the API reference at the bottom.

> Conventions in this repo that affect deploys:
> - **Next 16** uses `proxy.ts` (not `middleware.ts`) for the Clerk middleware. Build runs on **Turbopack**.
> - The Prisma client is generated to `app/generated/prisma`, which is **git-ignored** — it must be
>   regenerated on every clean checkout/build (see §3).
> - DB access uses the **`@prisma/adapter-pg` (node-postgres) driver adapter**, so `DATABASE_URL`
>   must be a **direct `postgresql://` connection string** (not a `prisma+postgres://` proxy URL).

---

## 0. Stack at a glance

| Concern | Choice |
|---|---|
| Runtime | Next.js 16 (App Router, Route Handlers), Node **20 LTS or newer** |
| Language | TypeScript (strict) |
| DB / ORM | PostgreSQL + Prisma 7 (driver adapter `@prisma/adapter-pg`) |
| Auth | Clerk (abstracted behind `getOwnerContext()`) |
| Rate limit / idempotency | in-process (`rate-limiter-flexible` memory store) — see §7 caveat |
| Public entrypoints | `/` (demo console), `/api/health` (public), `/reference` (Scalar docs) |

---

## 1. Pre-flight (before you touch a server)

- [ ] CI is green locally: `npm run typecheck && npm run lint && npm run test && npm run build`.
- [ ] A **production PostgreSQL** instance is provisioned and reachable from the host
      (Neon / Supabase / RDS / Prisma Postgres — any Postgres 14+).
- [ ] A **Clerk production instance** exists (separate from the dev instance) with its own keys.
- [ ] You have the production env values for every variable in §2.
- [ ] Decide the host: **Vercel** (recommended, §5a) or a **Node server / container** (§5b).

---

## 2. Environment variables

Set these in the host's environment (Vercel Project Settings → Environment Variables, or the
container's secret store). **Never commit `.env`** — it is git-ignored.

| Variable | Required | Scope | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | server | Direct `postgresql://user:pass@host:5432/db?sslmode=require` string. Use a **pooled** endpoint for serverless (see §4). |
| `CLERK_SECRET_KEY` | ✅ | server | Clerk **production** secret (`sk_live_…`). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✅ | client+server | Clerk **production** publishable key (`pk_live_…`). Inlined at build → must be present **at build time**. |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | ✅ | client | e.g. `/sign-in` (or a Clerk-hosted URL). |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | ✅ | client | e.g. `/sign-up`. |
| `NODE_ENV` | auto | server | Set to `production` by the platform; gates the Prisma singleton. |

> ⚠️ `NEXT_PUBLIC_*` values are **baked into the client bundle at build time**. If you rotate the
> publishable key or sign-in URLs, you must **rebuild**, not just restart.

---

## 3. Generate the Prisma client (mandatory — currently not automated)

`app/generated/prisma` is git-ignored, and `package.json` has **no `postinstall`/`generate` script**.
A clean build (Vercel, fresh container) will therefore **fail to compile** unless the client is
generated first. Pick one:

- [ ] **Recommended — wire it once.** Add a `postinstall` script so every install regenerates it:
  ```json
  // package.json → "scripts"
  "postinstall": "prisma generate"
  ```
  (Or fold it into build: `"build": "prisma generate && next build"`.)
- [ ] **Or run it explicitly** in your deploy pipeline before `next build`:
  ```bash
  npx prisma generate
  ```

Verify locally on a clean tree: `rm -rf app/generated/prisma && npx prisma generate && npm run build`.

---

## 4. Database migrations

Two migrations exist and must be applied to the production DB **before** the app serves traffic:

- `20260604100307_init` — App / ConfigVersion / Record tables + scope index.
- `20260604120000_record_data_gin` — GIN index on `Record.data` (`jsonb_path_ops`) for filtering.

Steps:

- [ ] Apply migrations against production (idempotent; safe to re-run):
  ```bash
  DATABASE_URL="<prod direct url>" npx prisma migrate deploy
  ```
- [ ] Confirm tables + indexes exist (the GIN index is `Record_data_gin_idx`).
- [ ] **Connection pooling:** the app uses node-postgres directly. On serverless/multi-instance,
      point `DATABASE_URL` at a **pooled** endpoint (PgBouncer / Neon pooler / Supabase pooler) to
      avoid exhausting Postgres connections. Run `migrate deploy` against the **direct** (unpooled)
      URL, then run the app against the pooled URL.

> `prisma migrate deploy` only applies committed migrations — it never generates or resets. Do **not**
> use `migrate dev`/`db push` in production.

---

## 5. Build & deploy

### 5a. Vercel (recommended for Next.js)

- [ ] Import the repo; framework preset **Next.js** (auto-detected).
- [ ] Add all §2 env vars for the **Production** (and Preview) environments.
- [ ] Ensure Prisma generate runs (the `postinstall` from §3 covers this automatically).
- [ ] Build command: default `next build`; Install: default `npm install`; Output: default.
- [ ] Run `prisma migrate deploy` as a **release step** (Vercel deploy hook / CI job) — Vercel does
      not run migrations for you.
- [ ] Deploy, then run §6 verification against the deployment URL.

### 5b. Node server / container

- [ ] Build:
  ```bash
  npm ci
  npx prisma generate          # if not wired as postinstall
  npm run build
  ```
- [ ] Migrate: `npx prisma migrate deploy` (with the prod `DATABASE_URL`).
- [ ] Start: `npm run start` (serves on `PORT`, default 3000). Put it behind TLS (reverse proxy).
- [ ] Provide all §2 env vars to the process/container. Example Dockerfile sketch:
  ```dockerfile
  FROM node:20-slim AS build
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npx prisma generate && npm run build
  FROM node:20-slim
  WORKDIR /app
  COPY --from=build /app ./
  ENV NODE_ENV=production
  EXPOSE 3000
  CMD ["npm","run","start"]
  ```
  Run `prisma migrate deploy` as a separate init/job step, not inside the long-running container.

---

## 6. Post-deploy verification (smoke test)

Run against the live URL (replace `$BASE`):

- [ ] **Deploy is live (public):**
  ```bash
  curl -s $BASE/api/health        # -> {"ok":true,"data":{"status":"ok",...}}
  ```
- [ ] **Auth works end-to-end:** open `/`, sign in via Clerk, confirm the header shows your
      `ownerId` (from `GET /api/me`). Or with a minted token:
  ```bash
  curl -s $BASE/api/me -H "Authorization: Bearer <session-jwt>"   # -> { ownerId }
  ```
- [ ] **DB + CRUD path:** create an app → publish the sample config → create a record (use the demo
      console at `/`, or the cURL flow in `docs/API_TEST_REPORT.md`).
- [ ] **Resilience is intact:** the demo console's edge-case buttons return the documented 4xx
      envelopes (422 / 404 / 400) — i.e. a bad payload never 500s.
- [ ] **Docs render:** `/reference` (Scalar) loads and `/openapi.yaml` is served.
- [ ] **Logs:** structured request lines (`{requestId, method, path, status, durationMs}`) appear;
      no unexpected `INTERNAL`/500s.

---

## 7. Production hardening & known caveats

- [ ] **Rate limiting & idempotency are in-process** (`MemoryRateLimiter`, in-memory idempotency
      store). They are **per-instance** and **reset on restart**. For multi-instance / serverless,
      swap in the shared stores noted in `architecture.md` §12 (Postgres/Redis behind the existing
      `RateLimiter` / `IdempotencyStore` seams) — otherwise limits are per-lambda and not global.
- [ ] **Body size cap & streaming abort** are enforced (`PAYLOAD_TOO_LARGE`); no action needed.
- [ ] **`/api/health` is the only public route** — wire it to your uptime monitor.
- [ ] **Clerk production setup:** add the deployment domain to Clerk's allowed origins; set the
      production sign-in/sign-up URLs; confirm `pk_live_*`/`sk_live_*` (not test keys) are in use.
- [ ] **Secrets:** `CLERK_SECRET_KEY` and `DATABASE_URL` are server-only — never expose via
      `NEXT_PUBLIC_*`. Rotate if they ever touched a log or a shared shell.
- [ ] **Optional hardening headers** (`X-Content-Type-Options`, etc.) are not set — see
      `docs/API_TEST_REPORT.md` BUG-1 if you want to add them at the proxy/CDN layer.

---

## 8. Rollback

- [ ] **App:** redeploy the previous build (Vercel: "Promote" a prior deployment; container: deploy
      the previous image tag).
- [ ] **DB:** migrations are **forward-only**. The two current migrations are **additive**
      (new tables + an index), so an app rollback is safe without a DB rollback. If a *future*
      migration is destructive, ship a paired down-migration / backup-and-restore plan before
      deploying it.

---

## 9. API documentation

The machine-readable contract is **`openapi.yaml`** (OpenAPI 3.1), rendered live at **`/reference`**
(Scalar) and served raw at **`/openapi.yaml`**. Summary below.

### Conventions
- **Auth:** Clerk session. Every route except `GET /api/health` requires an authenticated owner
  (session cookie same-origin, or `Authorization: Bearer <jwt>`). Unauthenticated → `401`.
- **Owner scoping:** all resources are owner-scoped; another owner's resource returns `404`
  (existence is never leaked).
- **Envelope:** success `{ ok:true, data, meta?, requestId }`; failure
  `{ ok:false, error:{ code, message, details? }, requestId }`. Every response echoes `x-request-id`.
- **Rate limiting:** writes only, **100 / 60s / owner** → `429` + `Retry-After`. Reads exempt.
- **Idempotency:** opt-in `Idempotency-Key` header on record creates.

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | Liveness probe. |
| GET | `/api/me` | ✅ | Current `ownerId`. |
| GET | `/api/apps` | ✅ | List the caller's apps. |
| POST | `/api/apps` | ✅ | Create an app → `201`. |
| GET | `/api/apps/{appId}/config` | ✅ | Active normalized config + version + diagnostics. |
| POST | `/api/apps/{appId}/config` | ✅ | Publish a config (lenient → `200`+diagnostics; `strict:true` → `422 CONFIG_INVALID`). |
| GET | `/api/apps/{appId}/config/versions` | ✅ | Version history (newest first). |
| GET | `/api/apps/{appId}/config/versions/{version}` | ✅ | A specific historical version. |
| GET | `/api/apps/{appId}/data/{entity}` | ✅ | List records (pagination/sort/filter; tolerant params). |
| POST | `/api/apps/{appId}/data/{entity}` | ✅ | Create a record → `201` (supports `Idempotency-Key`). |
| GET | `/api/apps/{appId}/data/{entity}/{id}` | ✅ | Get a record by id. |
| PATCH | `/api/apps/{appId}/data/{entity}/{id}` | ✅ | Partial update. |
| DELETE | `/api/apps/{appId}/data/{entity}/{id}` | ✅ | Delete → `{ id }`. |

### Error taxonomy (code → HTTP)

| Code | HTTP | When |
|---|---|---|
| `BAD_REQUEST` | 400 | Unparseable/empty body, malformed shape. |
| `UNAUTHORIZED` | 401 | No authenticated owner. |
| `FORBIDDEN` | 403 | Authenticated but not allowed. |
| `NOT_FOUND` | 404 | Record/app not found within owner scope. |
| `ENTITY_UNKNOWN` | 404 | Entity not defined in the active config. |
| `CONFLICT` | 409 | Idempotency key reused with a different body. |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds the size cap. |
| `VALIDATION_ERROR` | 422 | Field validation failed (`details.fieldErrors`/`formErrors`). |
| `CONFIG_INVALID` | 422 | Strict publish of a config with blocking errors. |
| `RATE_LIMITED` | 429 | Write rate limit exceeded. |
| `INTERNAL` | 500 | Genuine server fault only. |

**Further reading:** `architecture.md` (HLD + scaling paths), `docs/EDGE_CASES.md` (resilience
matrix), `docs/API_TEST_REPORT.md` (live conformance + security results, reproducible cURL flows).
