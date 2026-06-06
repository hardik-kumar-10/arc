// Authenticated black-box conformance tests against the live API.
// TOKEN is passed via env AUTH_TOKEN (minted by the bash driver).
const BASE = "http://localhost:3000";
const TOKEN = process.env.AUTH_TOKEN;
if (!TOKEN) { console.error("missing AUTH_TOKEN"); process.exit(1); }
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const results = [];
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));
function rec(name, pass, detail, sev = "fail") { results.push({ name, pass, detail, sev }); }

async function req(method, path, { headers = {}, body, raw, noAuth } = {}) {
  const h = { ...(noAuth ? {} : AUTH), ...headers };
  const init = { method, headers: h };
  if (body !== undefined) { init.body = raw ? body : JSON.stringify(body); if (!raw && !h["content-type"]) h["content-type"] = "application/json"; }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}
function expectOk(t, r, status) {
  const p = r.status === status; rec(`${t}: status ${status}`, p, p ? "ok" : `got ${r.status}: ${r.text.slice(0,160)}`);
  if (r.json) { if (r.json.ok !== true) rec(`${t}: ok=true`, false, `ok=${r.json.ok}`); if (!("data" in r.json)) rec(`${t}: has data`, false, "no data"); if (typeof r.json.requestId !== "string") rec(`${t}: requestId`, false, "missing"); }
  else rec(`${t}: json`, false, `non-json: ${r.text.slice(0,120)}`);
  return r.json?.data;
}
function expectErr(t, r, status, code) {
  const p = r.status === status; rec(`${t}: status ${status}`, p, p ? "ok" : `got ${r.status}: ${r.text.slice(0,160)}`);
  if (r.json) { if (r.json.ok !== false) rec(`${t}: ok=false`, false, `ok=${r.json.ok}`); if (code && r.json.error?.code !== code) rec(`${t}: code=${code}`, false, `got ${r.json.error?.code}`); }
  else rec(`${t}: json`, false, `non-json: ${r.text.slice(0,120)}`);
  return r.json;
}

const validConfig = {
  app: { name: "Test App" },
  entities: [
    { name: "Project", fields: [ { name: "title", type: "string", required: true } ] },
    { name: "Task", fields: [
      { name: "title", type: "string", required: true },
      { name: "done", type: "boolean", default: false },
      { name: "priority", type: "number" },
      { name: "status", type: "enum", values: ["open","closed"], default: "open" },
      { name: "project", type: "reference", ref: "Project" },
    ] },
  ],
  workflows: [],
  pages: [ { path: "/tasks", title: "Tasks" } ],
};

async function main() {
  // ---- /me ----
  { const r = await req("GET", "/api/me"); const d = expectOk("me", r, 200);
    if (!d || typeof d.ownerId !== "string") rec("me: ownerId shape", false, JSON.stringify(d)); else rec("me: ownerId shape", true, d.ownerId); }

  // ---- apps: list (baseline) ----
  { const r = await req("GET", "/api/apps"); const d = expectOk("apps.list", r, 200);
    if (!Array.isArray(d)) rec("apps.list: array", false, JSON.stringify(d)?.slice(0,120)); else rec("apps.list: array", true, `len=${d.length}`); }

  // ---- apps: create validation ----
  { const r = await req("POST", "/api/apps", { body: {} }); expectErr("apps.create empty", r, 422, "VALIDATION_ERROR"); }
  { const r = await req("POST", "/api/apps", { body: { name: "" } }); expectErr("apps.create blankname", r, 422, "VALIDATION_ERROR"); }
  { const r = await req("POST", "/api/apps", { body: { name: 123 } }); expectErr("apps.create nonstring", r, 422, "VALIDATION_ERROR"); }

  // ---- apps: create ok ----
  let appId;
  { const r = await req("POST", "/api/apps", { body: { name: "QA App" } }); const d = expectOk("apps.create", r, 201);
    if (d) { appId = d.id;
      const okShape = typeof d.id==="string" && d.name==="QA App" && typeof d.ownerId==="string" && ("activeConfigVersionId" in d) && isIso(d.createdAt) && isIso(d.updatedAt);
      rec("apps.create: App schema", okShape, JSON.stringify(d).slice(0,200));
      rec("apps.create: activeConfigVersionId null", d.activeConfigVersionId === null, `=${JSON.stringify(d.activeConfigVersionId)}`, "warn");
    } }
  if (!appId) { rec("FATAL", false, "no appId; aborting authed CRUD tests"); return finish(); }

  // ---- config: active before publish ----
  { const r = await req("GET", `/api/apps/${appId}/config`); const d = expectOk("config.active(empty)", r, 200);
    if (d) rec("config.active(empty): nulls", d.config === null && d.version === null && Array.isArray(d.diagnostics), JSON.stringify(d).slice(0,160)); }

  // ---- config: versions empty ----
  { const r = await req("GET", `/api/apps/${appId}/config/versions`); const d = expectOk("config.versions(empty)", r, 200);
    if (d) rec("config.versions(empty): []", Array.isArray(d) && d.length===0, JSON.stringify(d).slice(0,120)); }

  // ---- config: publish (lenient) ----
  { const r = await req("POST", `/api/apps/${appId}/config`, { body: { config: validConfig } }); const d = expectOk("config.publish", r, 200);
    if (d) { const ok = typeof d.versionId==="string" && d.version===1 && Array.isArray(d.diagnostics) && d.config && Array.isArray(d.config.entities);
      rec("config.publish: PublishResult schema", ok, JSON.stringify({versionId:d.versionId,version:d.version,diag:d.diagnostics?.length}).slice(0,160)); } }

  // ---- config: strict publish with blocking error (entities not array) ----
  { const r = await req("POST", `/api/apps/${appId}/config`, { body: { config: { entities: "nope" }, strict: true } });
    const j = expectErr("config.publish strict-invalid", r, 422, "CONFIG_INVALID");
    if (j) rec("config.publish strict: diagnostics in details", Array.isArray(j.error?.details?.diagnostics), JSON.stringify(j.error?.details)?.slice(0,160)); }

  // ---- config: active after publish ----
  { const r = await req("GET", `/api/apps/${appId}/config`); const d = expectOk("config.active", r, 200);
    if (d) rec("config.active: version=1", d.version === 1 && !!d.config, `version=${d.version}`); }

  // ---- config: version history ----
  { const r = await req("GET", `/api/apps/${appId}/config/versions`); const d = expectOk("config.versions", r, 200);
    if (Array.isArray(d) && d[0]) { const m = d[0]; const ok = typeof m.id==="string" && m.version===1 && isIso(m.createdAt) && m.diagnosticCounts && typeof m.diagnosticCounts.error==="number";
      rec("config.versions: ConfigVersionMeta schema", ok, JSON.stringify(m).slice(0,180)); } else rec("config.versions: has entry", false, JSON.stringify(d)?.slice(0,120)); }

  // ---- config: get specific version ----
  { const r = await req("GET", `/api/apps/${appId}/config/versions/1`); const d = expectOk("config.version[1]", r, 200);
    if (d) rec("config.version[1]: shape", d.version===1 && !!d.config && Array.isArray(d.diagnostics), JSON.stringify({v:d.version}).slice(0,80)); }
  { const r = await req("GET", `/api/apps/${appId}/config/versions/999`); expectErr("config.version[999]", r, 404, "NOT_FOUND"); }
  { const r = await req("GET", `/api/apps/${appId}/config/versions/abc`); expectErr("config.version[abc]", r, 400, "BAD_REQUEST"); }
  { const r = await req("GET", `/api/apps/${appId}/config/versions/0`); expectErr("config.version[0]", r, 400, "BAD_REQUEST"); }
  { const r = await req("GET", `/api/apps/${appId}/config/versions/-1`); expectErr("config.version[-1]", r, 400, "BAD_REQUEST"); }

  // ---- records: unknown entity ----
  { const r = await req("GET", `/api/apps/${appId}/data/Nope`); expectErr("data.unknownEntity", r, 404, "ENTITY_UNKNOWN"); }

  // ---- records: create validation (missing required title) ----
  { const r = await req("POST", `/api/apps/${appId}/data/Task`, { body: { done: true } });
    const j = expectErr("data.create missing-required", r, 422, "VALIDATION_ERROR");
    if (j) rec("data.create: fieldErrors present", !!j.error?.details?.fieldErrors, JSON.stringify(j.error?.details)?.slice(0,160)); }

  // ---- records: create validation (wrong type) ----
  { const r = await req("POST", `/api/apps/${appId}/data/Task`, { body: { title: "X", priority: "high" } });
    expectErr("data.create wrong-type", r, 422, "VALIDATION_ERROR"); }

  // ---- records: bad enum ----
  { const r = await req("POST", `/api/apps/${appId}/data/Task`, { body: { title: "X", status: "banana" } });
    expectErr("data.create bad-enum", r, 422, "VALIDATION_ERROR"); }

  // ---- records: reference to nonexistent ----
  { const r = await req("POST", `/api/apps/${appId}/data/Task`, { body: { title: "X", project: "does_not_exist" } });
    expectErr("data.create bad-ref", r, 422, "VALIDATION_ERROR"); }

  // ---- records: create a Project (for valid ref) ----
  let projectId;
  { const r = await req("POST", `/api/apps/${appId}/data/Project`, { body: { title: "P1" } }); const d = expectOk("data.create Project", r, 201);
    if (d) { projectId = d.id; rec("data.create Project: system fields", typeof d.id==="string" && isIso(d.createdAt) && isIso(d.updatedAt) && typeof d.version==="number", JSON.stringify(d).slice(0,160)); } }

  // ---- records: create valid Task ----
  let taskId;
  { const r = await req("POST", `/api/apps/${appId}/data/Task`, { body: { title: "T1", priority: 3, project: projectId } }); const d = expectOk("data.create Task", r, 201);
    if (d) { taskId = d.id;
      const ok = d.title==="T1" && d.priority===3 && d.done===false && d.status==="open" && typeof d.id==="string";
      rec("data.create Task: defaults+values", ok, JSON.stringify(d).slice(0,200)); } }

  // ---- records: POST to specific id -> BAD_REQUEST ----
  { const r = await req("POST", `/api/apps/${appId}/data/Task/${taskId}`, { body: { title: "Z" } });
    expectErr("data.post-to-id", r, 400, "BAD_REQUEST"); }

  // ---- records: get by id ----
  { const r = await req("GET", `/api/apps/${appId}/data/Task/${taskId}`); const d = expectOk("data.get", r, 200);
    if (d) rec("data.get: matches", d.id===taskId && d.title==="T1", JSON.stringify(d).slice(0,160)); }
  { const r = await req("GET", `/api/apps/${appId}/data/Task/missing_id`); expectErr("data.get missing", r, 404, "NOT_FOUND"); }

  // ---- records: list + meta ----
  { const r = await req("GET", `/api/apps/${appId}/data/Task`); const d = expectOk("data.list", r, 200);
    const m = r.json?.meta;
    if (Array.isArray(d)) rec("data.list: array", true, `len=${d.length}`); else rec("data.list: array", false, JSON.stringify(d)?.slice(0,120));
    if (m) rec("data.list: meta shape", typeof m.page==="number" && typeof m.limit==="number" && typeof m.total==="number", JSON.stringify(m)); else rec("data.list: meta present", false, "no meta"); }

  // ---- records: list query params (clamp + filter + sort) ----
  { const r = await req("GET", `/api/apps/${appId}/data/Task?limit=9999&page=-5`); const m = r.json?.meta;
    if (m) rec("data.list: limit clamped <=100", m.limit<=100 && m.page>=1, JSON.stringify(m), "warn"); }
  { const r = await req("GET", `/api/apps/${appId}/data/Task?status=open`); const d = expectOk("data.list filter", r, 200);
    if (Array.isArray(d)) rec("data.list filter: returns matches", d.every(x=>x.status==="open"), `len=${d.length}`, "warn"); }
  { const r = await req("GET", `/api/apps/${appId}/data/Task?garbageparam=1&sort=bogus:xx`); expectOk("data.list tolerant-params", r, 200); }

  // ---- records: update ----
  { const r = await req("PATCH", `/api/apps/${appId}/data/Task/${taskId}`, { body: { title: "T1-updated", done: true } }); const d = expectOk("data.update", r, 200);
    if (d) rec("data.update: applied", d.title==="T1-updated" && d.done===true, JSON.stringify(d).slice(0,160)); }
  { const r = await req("PATCH", `/api/apps/${appId}/data/Task/${taskId}`, { body: { priority: "nan" } }); expectErr("data.update invalid", r, 422, "VALIDATION_ERROR"); }
  { const r = await req("PATCH", `/api/apps/${appId}/data/Task`, { body: { title: "x" } }); expectErr("data.update no-id", r, 400, "BAD_REQUEST"); }
  { const r = await req("PATCH", `/api/apps/${appId}/data/Task/missing`, { body: { title: "x" } }); expectErr("data.update missing", r, 404, "NOT_FOUND"); }

  // ---- records: idempotency ----
  { const key = "idem-" + Date.now();
    const r1 = await req("POST", `/api/apps/${appId}/data/Task`, { headers: { "idempotency-key": key }, body: { title: "Idem" } });
    const r2 = await req("POST", `/api/apps/${appId}/data/Task`, { headers: { "idempotency-key": key }, body: { title: "Idem" } });
    const id1 = r1.json?.data?.id, id2 = r2.json?.data?.id;
    rec("data.idempotency: same id on replay", !!id1 && id1===id2, `id1=${id1} id2=${id2}`, "warn");
    // conflicting body w/ same key -> CONFLICT (409) per spec
    const r3 = await req("POST", `/api/apps/${appId}/data/Task`, { headers: { "idempotency-key": key }, body: { title: "Different" } });
    rec("data.idempotency: conflict on body mismatch", r3.status===409, `got ${r3.status} code=${r3.json?.error?.code}`, "warn"); }

  // ---- records: delete ----
  { const r = await req("DELETE", `/api/apps/${appId}/data/Task`); expectErr("data.delete no-id", r, 400, "BAD_REQUEST"); }
  { const r = await req("DELETE", `/api/apps/${appId}/data/Task/${taskId}`); const d = expectOk("data.delete", r, 200);
    if (d) rec("data.delete: returns id", d.id===taskId, JSON.stringify(d)); }
  { const r = await req("GET", `/api/apps/${appId}/data/Task/${taskId}`); expectErr("data.delete confirmed-gone", r, 404, "NOT_FOUND"); }
  { const r = await req("DELETE", `/api/apps/${appId}/data/Task/${taskId}`); expectErr("data.delete already-gone", r, 404, "NOT_FOUND"); }

  // ---- owner scoping / unknown app ----
  { const r = await req("GET", `/api/apps/app_totally_fake/config`); expectErr("scoping.unknownApp", r, 404, "NOT_FOUND"); }
  { const r = await req("GET", `/api/apps/app_totally_fake/data/Task`); expectErr("scoping.unknownApp data", r, 404, "NOT_FOUND"); }

  // ---- nested record id (2 segments) -> BAD_REQUEST ----
  { const r = await req("GET", `/api/apps/${appId}/data/Task/a/b`);
    rec("data.nested-id", r.status===400 || r.status===404, `got ${r.status} code=${r.json?.error?.code}`, "warn"); }

  finish();
}

function finish() {
  const fails = results.filter((r) => !r.pass);
  console.log("\n================ AUTHED RESULTS ================");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL[" + r.sev + "]"}  ${r.name}  ::  ${r.detail}`);
  console.log(`\nTotal: ${results.length}  Pass: ${results.length - fails.length}  Fail: ${fails.length}`);
  const hard = fails.filter(f=>f.sev==="fail");
  console.log(`Hard fails: ${hard.length}  Warnings: ${fails.length-hard.length}`);
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
