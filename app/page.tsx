"use client";

// app/page.tsx — arc backend demo console.
//
// A THIN, TRANSPARENT window over the API. It contains ZERO business logic: it sends raw input and
// renders the raw response (status code + full envelope). It performs no validation, coercion,
// normalization, or error-hiding — every failure is shown verbatim, because the failures are the
// demonstration. All logic lives server-side; this page only transports bytes and pretty-prints JSON.

import { useCallback, useEffect, useState } from "react";
import { SignInButton, UserButton, useAuth } from "@clerk/nextjs";

const REPO_URL = "https://github.com/hardik-kumar-10/arc";

// ---- transport (NOT business logic) ----------------------------------------
// One fetch wrapper. It attaches a bearer token only if the user pasted one, sends the body byte
// string EXACTLY as given (so malformed JSON reaches the server untouched), and captures the raw
// status + raw text. It never parses for meaning — JSON.parse is only to pretty-print for display;
// if that fails we show the raw text.
type CallResult = {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
  method: string;
  path: string;
};

type ClientError = { clientError: string };

async function rawCall(
  method: string,
  path: string,
  opts: { token?: string; rawBody?: string } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (opts.token?.trim()) headers["Authorization"] = `Bearer ${opts.token.trim()}`;
  if (opts.rawBody !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: opts.rawBody });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text, method, path };
}

// ---- presentational primitives ---------------------------------------------

function StatusPill({ status }: { status: number }) {
  const tone =
    status < 300
      ? "bg-green-100 text-green-800 border-green-300"
      : status < 400
        ? "bg-blue-100 text-blue-800 border-blue-300"
        : status < 500
          ? "bg-amber-100 text-amber-900 border-amber-300"
          : "bg-red-100 text-red-800 border-red-300";
  return (
    <span className={`inline-block rounded border px-2 py-0.5 font-mono text-xs font-bold ${tone}`}>
      HTTP {status}
    </span>
  );
}

// Renders one raw call: the request line, the HTTP status, and the FULL envelope pretty-printed
// (requestId, error.code/error.details, meta — nothing is cherry-picked or hidden).
function ResultView({
  res,
  extra,
}: {
  res: CallResult | ClientError | null;
  extra?: (r: CallResult) => React.ReactNode;
}) {
  if (!res) return null;
  if ("clientError" in res) {
    return (
      <pre className="mt-2 overflow-auto rounded border border-red-300 bg-red-50 p-3 font-mono text-xs text-red-800">
        Client-side error (no HTTP request reached the API — the browser failed first):{"\n"}
        {res.clientError}
      </pre>
    );
  }
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 font-mono text-xs text-zinc-500">
        <StatusPill status={res.status} />
        <span>
          {res.method} {res.path}
        </span>
      </div>
      {extra?.(res)}
      <pre className="mt-2 max-h-96 overflow-auto rounded border border-zinc-300 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-800">
        {res.json !== undefined ? JSON.stringify(res.json, null, 2) : res.text || "(empty body)"}
      </pre>
    </div>
  );
}

// A button that runs one async call, owns its own loading/result state, and renders the raw result
// below itself. `onResult` lets a panel capture an id from the response into page state (e.g. appId).
function CallButton({
  label,
  run,
  onResult,
  extra,
  variant = "default",
}: {
  label: string;
  run: () => Promise<CallResult>;
  onResult?: (r: CallResult) => void;
  extra?: (r: CallResult) => React.ReactNode;
  variant?: "default" | "danger" | "ghost";
}) {
  const [res, setRes] = useState<CallResult | ClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const click = async () => {
    setLoading(true);
    try {
      const r = await run();
      setRes(r);
      onResult?.(r);
    } catch (e) {
      setRes({ clientError: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    } finally {
      setLoading(false);
    }
  };
  const tone =
    variant === "danger"
      ? "border-red-300 bg-red-50 text-red-800 hover:bg-red-100"
      : variant === "ghost"
        ? "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100"
        : "border-zinc-800 bg-zinc-900 text-white hover:bg-zinc-700";
  return (
    <div>
      <button
        onClick={click}
        disabled={loading}
        className={`rounded border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${tone}`}
      >
        {loading ? "…" : label}
      </button>
      <ResultView res={res} extra={extra} />
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-300 bg-white p-5 shadow-sm">
      <h2 className="font-mono text-sm font-bold uppercase tracking-wide text-zinc-900">{title}</h2>
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
      {label}
      {children}
    </label>
  );
}

const inputCls =
  "rounded border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none";
const areaCls = `${inputCls} min-h-40 resize-y`;

// A deliberately broken sample config. After compilation it yields a usable `Task` entity AND a
// non-empty diagnostics array (reserved field dropped, unknown type dropped, nameless entity dropped).
const BROKEN_CONFIG = JSON.stringify(
  {
    app: { name: "Demo App" },
    entities: [
      {
        name: "Task",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "priority", type: "number" },
          { name: "id", type: "string" },
          { name: "weird", type: "telepathy" },
        ],
      },
      { fields: [{ name: "orphan", type: "string" }] },
    ],
    workflows: [],
    pages: [],
  },
  null,
  2,
);

// Diagnostics show up prominently for the config demo, pulled from data.diagnostics (success) or
// error.details.diagnostics (strict failure). Display-only — it reads, never transforms.
function Diagnostics({ res }: { res: CallResult }) {
  const j = res.json as
    | { data?: { diagnostics?: unknown[] }; error?: { details?: { diagnostics?: unknown[] } } }
    | undefined;
  const diags = j?.data?.diagnostics ?? j?.error?.details?.diagnostics;
  if (!Array.isArray(diags) || diags.length === 0) return null;
  return (
    <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-3">
      <div className="font-mono text-xs font-bold text-amber-900">
        diagnostics ({diags.length}) — config was repaired, not rejected:
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {diags.map((d, i) => {
          const dx = d as { level?: string; code?: string; path?: string; message?: string };
          return (
            <li key={i} className="font-mono text-[11px] text-amber-900">
              <span className="font-bold uppercase">{dx.level}</span> · {dx.code} ·{" "}
              <span className="text-amber-700">{dx.path}</span> — {dx.message}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- page ------------------------------------------------------------------

export default function Console() {
  const { isLoaded, isSignedIn } = useAuth();

  // The only page-level state the brief asks for: appId, bearer token, last record id.
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("");
  const [recordId, setRecordId] = useState("");

  // Section-local inputs.
  const [appName, setAppName] = useState("Demo App");
  const [configText, setConfigText] = useState(BROKEN_CONFIG);
  const [strict, setStrict] = useState(false);
  const [entity, setEntity] = useState("Task");
  const [recordBody, setRecordBody] = useState('{\n  "title": "Hello",\n  "priority": 1\n}');

  // ownerId banner — proves who the API thinks you are (GET /api/me), independent of the Clerk chip.
  const [me, setMe] = useState<CallResult | ClientError | null>(null);
  const refreshMe = useCallback(async () => {
    try {
      setMe(await rawCall("GET", "/api/me", { token }));
    } catch (e) {
      setMe({ clientError: e instanceof Error ? e.message : String(e) });
    }
  }, [token]);
  // Sync the ownerId banner with the external API whenever identity (sign-in or pasted token)
  // changes. setMe runs only after the awaited fetch resolves — never synchronously in the effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await rawCall("GET", "/api/me", { token });
        if (!cancelled) setMe(r);
      } catch (e) {
        if (!cancelled) setMe({ clientError: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, isSignedIn]);

  const ownerId =
    me && !("clientError" in me) && me.status === 200
      ? ((me.json as { data?: { ownerId?: string } })?.data?.ownerId ?? null)
      : null;

  // Build the publish request body WITHOUT parsing the config: splice the raw textarea text into the
  // envelope. Valid JSON in the box -> valid envelope; broken JSON -> the server receives broken JSON
  // and answers with its own error. Zero client-side parsing/validation.
  const publishBody = () => `{"config":${configText || "null"}${strict ? ',"strict":true' : ""}}`;

  const appBase = `/api/apps/${encodeURIComponent(appId)}`;
  const entityBase = `${appBase}/data/${encodeURIComponent(entity)}`;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-5 py-8">
      {/* Header / auth */}
      <header className="rounded-lg border border-zinc-300 bg-zinc-900 p-5 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-mono text-lg font-bold">arc — backend demo console</h1>
            <p className="text-xs text-zinc-400">
              Thin window over the API · raw request in, raw response out · all logic is server-side.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!isLoaded ? (
              <span className="text-xs text-zinc-400">loading auth…</span>
            ) : isSignedIn ? (
              <UserButton />
            ) : (
              <SignInButton mode="modal">
                <button className="rounded border border-white/30 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-200">
                  Sign in
                </button>
              </SignInButton>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-white/15 bg-black/30 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-400">GET /api/me → ownerId</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-sm text-green-300">{ownerId ?? "(not authenticated)"}</span>
              <button onClick={refreshMe} className="text-[11px] text-zinc-400 underline hover:text-white">
                refresh
              </button>
            </div>
            {me && !("clientError" in me) ? (
              <div className="mt-1 font-mono text-[11px] text-zinc-500">status {me.status}</div>
            ) : null}
          </div>
          <Labeled label="Fallback: paste a bearer token (overrides the session cookie if filled)">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="eyJ… (a manually-minted Clerk session JWT)"
              className={`${inputCls} bg-black/30 text-green-200 placeholder:text-zinc-600`}
            />
          </Labeled>
        </div>
      </header>

      {/* Active ids */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-300 bg-white px-4 py-2 text-sm">
        <span className="font-medium text-zinc-600">Active appId:</span>
        <input
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder="(create an app below, or paste an id)"
          className={`${inputCls} flex-1`}
        />
        <span className="font-medium text-zinc-600">Last recordId:</span>
        <input
          value={recordId}
          onChange={(e) => setRecordId(e.target.value)}
          placeholder="(set after a create)"
          className={`${inputCls} flex-1`}
        />
      </div>

      {/* Health */}
      <Panel title="Health" hint="Public, no auth. Proves the deploy is live.">
        <CallButton
          label="GET /api/health"
          run={() => rawCall("GET", "/api/health", { token })}
          variant="ghost"
        />
      </Panel>

      {/* App */}
      <Panel title="App" hint="Create captures the returned id into page state for every call below.">
        <Labeled label="name (sent raw inside { name })">
          <input value={appName} onChange={(e) => setAppName(e.target.value)} className={inputCls} />
        </Labeled>
        <div className="flex flex-wrap gap-3">
          <CallButton
            label="POST /api/apps (create)"
            run={() => rawCall("POST", "/api/apps", { token, rawBody: `{"name":${JSON.stringify(appName)}}` })}
            onResult={(r) => {
              const id = (r.json as { data?: { id?: string } })?.data?.id;
              if (id) setAppId(id);
            }}
          />
          <CallButton label="GET /api/apps (list)" run={() => rawCall("GET", "/api/apps", { token })} variant="ghost" />
        </div>
      </Panel>

      {/* Publish config */}
      <Panel
        title="Publish config"
        hint="Headline demo: a broken config is normalized, not rejected → 200 + diagnostics. The textarea is spliced into the request raw — no client-side parsing."
      >
        <Labeled label="config (raw — pre-filled with a deliberately broken sample)">
          <textarea
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            className={areaCls}
            spellCheck={false}
          />
        </Labeled>
        <label className="flex items-center gap-2 text-xs text-zinc-600">
          <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          strict (reject on blocking errors → 422 CONFIG_INVALID, persists nothing)
        </label>
        <div className="flex flex-wrap gap-3">
          <CallButton
            label="POST …/config (publish)"
            run={() => rawCall("POST", `${appBase}/config`, { token, rawBody: publishBody() })}
            extra={(r) => <Diagnostics res={r} />}
          />
          <CallButton
            label="GET …/config (active)"
            run={() => rawCall("GET", `${appBase}/config`, { token })}
            variant="ghost"
            extra={(r) => <Diagnostics res={r} />}
          />
          <CallButton
            label="GET …/config/versions (history)"
            run={() => rawCall("GET", `${appBase}/config/versions`, { token })}
            variant="ghost"
          />
        </div>
      </Panel>

      {/* Records */}
      <Panel
        title="Records"
        hint="Generic CRUD over whatever entity the active config defines. The body textarea is sent verbatim — malformed JSON reaches the server untouched. Output includes system fields and any meta.drift."
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <Labeled label="entity">
            <input value={entity} onChange={(e) => setEntity(e.target.value)} className={inputCls} />
          </Labeled>
          <Labeled label="record body (raw JSON, sent verbatim)">
            <textarea
              value={recordBody}
              onChange={(e) => setRecordBody(e.target.value)}
              className={areaCls}
              spellCheck={false}
            />
          </Labeled>
        </div>
        <div className="flex flex-wrap gap-3">
          <CallButton
            label="POST (create)"
            run={() => rawCall("POST", entityBase, { token, rawBody: recordBody })}
            onResult={(r) => {
              const id = (r.json as { data?: { id?: string } })?.data?.id;
              if (id) setRecordId(id);
            }}
          />
          <CallButton label="GET (list)" run={() => rawCall("GET", entityBase, { token })} variant="ghost" />
          <CallButton
            label="GET (by id)"
            run={() => rawCall("GET", `${entityBase}/${encodeURIComponent(recordId)}`, { token })}
            variant="ghost"
          />
          <CallButton
            label="PATCH (update)"
            run={() => rawCall("PATCH", `${entityBase}/${encodeURIComponent(recordId)}`, { token, rawBody: recordBody })}
          />
          <CallButton
            label="DELETE"
            run={() => rawCall("DELETE", `${entityBase}/${encodeURIComponent(recordId)}`, { token })}
            variant="danger"
          />
        </div>
      </Panel>

      {/* Edge cases */}
      <Panel
        title="Edge-case quick buttons"
        hint="One click each → watch the resilience behavior. These target entity 'Task' on the active appId; publish the sample config first so 'Task' exists."
      >
        <div className="flex flex-wrap gap-3">
          <CallButton
            label="Missing required → 422 fieldErrors"
            run={() => rawCall("POST", `${appBase}/data/Task`, { token, rawBody: "{}" })}
            variant="ghost"
          />
          <CallButton
            label="Uncoercible type → 422"
            run={() => rawCall("POST", `${appBase}/data/Task`, { token, rawBody: '{"title":"ok","priority":"not-a-number"}' })}
            variant="ghost"
          />
          <CallButton
            label="Unknown entity → 404 ENTITY_UNKNOWN"
            run={() => rawCall("GET", `${appBase}/data/NoSuchEntity`, { token })}
            variant="ghost"
          />
          <CallButton
            label="Malformed JSON → 400"
            run={() => rawCall("POST", `${appBase}/data/Task`, { token, rawBody: "{ not valid json" })}
            variant="ghost"
          />
          <CallButton
            label="Missing record → 404"
            run={() => rawCall("GET", `${appBase}/data/Task/does-not-exist`, { token })}
            variant="ghost"
          />
        </div>
      </Panel>

      <footer className="mt-2 border-t border-zinc-300 pt-4 text-xs text-zinc-500">
        <p>
          arc backend demo console · Backend track. All logic is server-side; this UI only sends raw
          input and renders raw responses.
        </p>
        <p className="mt-1 flex flex-wrap gap-3">
          <a href={REPO_URL} className="underline hover:text-zinc-800" target="_blank" rel="noreferrer">
            GitHub repo
          </a>
          <a href="/reference" className="underline hover:text-zinc-800">
            API reference (Scalar)
          </a>
          <a href="/openapi.yaml" className="underline hover:text-zinc-800">
            OpenAPI spec
          </a>
        </p>
      </footer>
    </main>
  );
}
