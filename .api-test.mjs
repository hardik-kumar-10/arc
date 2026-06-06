// Black-box conformance tests against the live API, driven by openapi.yaml contract.
const BASE = "http://localhost:3000";
const results = [];
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function record(name, pass, detail, severity = "fail") {
  results.push({ name, pass, detail, severity });
}

async function req(method, path, { headers = {}, body, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!raw && !init.headers["content-type"]) init.headers["content-type"] = "application/json";
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}

// Generic envelope assertions ------------------------------------------------
function assertErrorEnvelope(t, r, expectStatus, expectCode) {
  if (r.status !== expectStatus) record(`${t}: status`, false, `expected ${expectStatus}, got ${r.status} (body: ${r.text.slice(0,160)})`);
  else record(`${t}: status`, true, `${r.status}`);
  const j = r.json;
  if (!j) return record(`${t}: json body`, false, `non-JSON body: ${r.text.slice(0,120)}`);
  if (j.ok !== false) record(`${t}: ok=false`, false, `ok=${JSON.stringify(j.ok)}`);
  if (!j.error || typeof j.error !== "object") record(`${t}: error object`, false, `error=${JSON.stringify(j.error)}`);
  else {
    if (expectCode && j.error.code !== expectCode) record(`${t}: error.code`, false, `expected ${expectCode}, got ${JSON.stringify(j.error.code)}`);
    else if (expectCode) record(`${t}: error.code`, true, expectCode);
    if (typeof j.error.message !== "string") record(`${t}: error.message`, false, `message=${JSON.stringify(j.error.message)}`);
  }
  if (typeof j.requestId !== "string") record(`${t}: requestId field`, false, `requestId=${JSON.stringify(j.requestId)}`);
  if (!isUuid(r.headers.get("x-request-id"))) record(`${t}: x-request-id header`, false, `header=${r.headers.get("x-request-id")}`);
}

function assertOkEnvelope(t, r, expectStatus) {
  if (r.status !== expectStatus) record(`${t}: status`, false, `expected ${expectStatus}, got ${r.status}`);
  else record(`${t}: status`, true, `${r.status}`);
  const j = r.json;
  if (!j) return record(`${t}: json body`, false, `non-JSON: ${r.text.slice(0,120)}`);
  if (j.ok !== true) record(`${t}: ok=true`, false, `ok=${JSON.stringify(j.ok)}`);
  if (!("data" in j)) record(`${t}: data field`, false, `no data key`);
  if (typeof j.requestId !== "string") record(`${t}: requestId field`, false, `missing requestId`);
}

const PROTECTED = [
  ["GET", "/api/me"],
  ["GET", "/api/apps"],
  ["POST", "/api/apps", { body: { name: "x" } }],
  ["GET", "/api/apps/app_test/config"],
  ["POST", "/api/apps/app_test/config", { body: { config: {} } }],
  ["GET", "/api/apps/app_test/config/versions"],
  ["GET", "/api/apps/app_test/config/versions/1"],
  ["GET", "/api/apps/app_test/data/Task"],
  ["POST", "/api/apps/app_test/data/Task", { body: { title: "x" } }],
  ["GET", "/api/apps/app_test/data/Task/rec_1"],
  ["PATCH", "/api/apps/app_test/data/Task/rec_1", { body: { title: "y" } }],
  ["DELETE", "/api/apps/app_test/data/Task/rec_1"],
];

async function main() {
  // 1. Health: public, 200, envelope, time, x-request-id
  {
    const r = await req("GET", "/api/health");
    assertOkEnvelope("health", r, 200);
    const d = r.json?.data;
    if (!(d && d.status === "ok" && typeof d.time === "string")) record("health: data shape", false, `data=${JSON.stringify(d)}`);
    else record("health: data shape", true, "status+time present");
    if (!isUuid(r.headers.get("x-request-id"))) record("health: x-request-id header", false, r.headers.get("x-request-id"));
    else record("health: x-request-id header", true, "uuid");
  }

  // 2. Auth enforcement on every protected route (signed-out -> 401 UNAUTHORIZED)
  for (const [method, path, opts] of PROTECTED) {
    const r = await req(method, path, opts);
    assertErrorEnvelope(`auth ${method} ${path}`, r, 401, "UNAUTHORIZED");
  }

  // 3. X-Request-Id correlation: well-formed inbound id should be echoed
  {
    const myId = "11111111-2222-4333-8444-555555555555";
    const r = await req("GET", "/api/health", { headers: { "x-request-id": myId } });
    const echoed = r.headers.get("x-request-id");
    if (echoed === myId && r.json?.requestId === myId) record("requestId: reuse inbound", true, "echoed");
    else record("requestId: reuse inbound", false, `header=${echoed} body=${r.json?.requestId}`, "warn");
  }
  // 3b. Malformed inbound id should NOT be reflected (anti-injection) -> server generates uuid
  {
    const r = await req("GET", "/api/health", { headers: { "x-request-id": "not a uuid <script>" } });
    const echoed = r.headers.get("x-request-id");
    if (isUuid(echoed)) record("requestId: reject malformed inbound", true, "regenerated uuid");
    else record("requestId: reject malformed inbound", false, `reflected/garbage: ${echoed}`, "security");
  }

  // 4. Health rejects non-GET methods (route only exports GET)
  for (const m of ["POST", "DELETE", "PUT"]) {
    const r = await req(m, "/api/health", m === "GET" ? {} : { body: {} });
    if (r.status === 405) record(`health ${m}: 405`, true, "method not allowed");
    else record(`health ${m}: not 200`, r.status !== 200, `got ${r.status}`, r.status === 200 ? "fail" : "warn");
  }

  // 5. Unknown API route -> should not 200
  {
    const r = await req("GET", "/api/does-not-exist");
    record("unknown route: not 200", r.status !== 200, `got ${r.status}`, "warn");
  }

  // 6. Malformed JSON body to a protected POST. Auth runs before body parse,
  //    so signed-out we expect 401 (not a 500/raw error leak).
  {
    const r = await req("POST", "/api/apps", { raw: true, body: "{not json", headers: { "content-type": "application/json" } });
    if (r.status === 500) record("malformed json: no 500", false, "server error on bad body", "fail");
    else record("malformed json: no 500", true, `${r.status}`);
    if (r.json && r.json.ok === false) record("malformed json: structured error", true, `code=${r.json.error?.code}`);
    else record("malformed json: structured error", false, `body=${r.text.slice(0,120)}`);
  }

  // 7. Security: error bodies must not leak stack traces / internals
  {
    const r = await req("GET", "/api/me");
    const leak = /at \w+ \(|\/home\/|node_modules|stack|Error:/i.test(r.text);
    record("security: no stack leak in 401", !leak, leak ? `leak: ${r.text.slice(0,160)}` : "clean", "security");
  }
  // 7b. Security headers presence (informational)
  {
    const r = await req("GET", "/api/health");
    const sec = ["x-content-type-options","x-frame-options","content-security-policy","strict-transport-security"];
    const present = sec.filter((h) => r.headers.get(h));
    record("security: hardening headers", present.length > 0, `present: [${present.join(", ") || "none"}]`, "warn");
  }

  // 8. Content-Type of responses
  {
    const r = await req("GET", "/api/health");
    const ct = r.headers.get("content-type") || "";
    record("health: content-type json", ct.includes("application/json"), ct);
  }

  // Report -------------------------------------------------------------------
  const fails = results.filter((r) => !r.pass);
  console.log("\n================ RAW RESULTS ================");
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL[" + r.severity + "]"}  ${r.name}  ::  ${r.detail}`);
  console.log(`\nTotal: ${results.length}  Pass: ${results.length - fails.length}  Fail: ${fails.length}`);
  console.log("FAILS_JSON_START" + JSON.stringify(fails) + "FAILS_JSON_END");
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
