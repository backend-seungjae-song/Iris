#!/usr/bin/env node
// qa-plan: 동결된 계획을 모델 없이 실행한다.
//
//   iris-browser plan check <plan.json>              계획을 읽고 문법·참조를 확인만 한다
//   iris-browser plan digest <plan.json>             동결 digest를 낸다(manifest의 plan.digest)
//   iris-browser plan run <plan.json> --run <runId>  실행한다
//
// 배경: 화면을 한 장씩 읽어 모델이 다음 조작을 정하면 단계마다 왕복이 생기고,
// 그 왕복이 회차 시간과 토큰의 대부분이다. 계획이 이미 무엇을 누르고 무엇을 확인할지 정해
// 두었다면 그 사이에 모델이 개입할 필요가 없다. 러너는 그 왕복을 없앤다.
//
// 러너가 하지 않는 것도 분명히 해 둔다. 계획에 없는 것을 알아내지 않고, 어긋난 것을 고쳐서
// 지나가지 않는다. 대상이 하나로 좁혀지지 않으면 그 시나리오를 멈추고 왜 멈췄는지만 남긴다.
// 자동 복구는 잘못 누른 것을 통과로 만든다.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { stateHome } from "../server/state-home.cjs";
import { artifactDir } from "../server/artifacts-home.cjs";
import { port as acPort } from "../server/env.cjs";

// 상태 폴더. 개발 인스턴스와 설치된 앱이 같은 폴더를 쓰면 개발 회차의 QA 장부·매크로·탭
// 기록이 설치된 앱 것과 섞이고, 그러면 "이 증거가 어느 쪽 것인가"를 확인할 수 없다.
// 어디인지는 state-home.cjs 한 곳이 정한다.
const IRIS_HOME = stateHome();

const PORT = acPort();
const SESSION = process.env.IRIS_SESSION || process.env.HERDR_PANE_ID || null;
const MACRO_STORE = path.join(artifactDir("qa", IRIS_HOME), "macros.json");

// --------------------------------------------------------------------- 전송

function post(cmd, args, runId) {
  const payload = JSON.stringify({ cmd, args: args || {}, session: SESSION, ...(runId ? { run: runId } : {}) });
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/browser-cmd", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let body = ""; res.on("data", (c) => (body += c));
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({ ok: false, error: "응답 파싱 실패: " + body.slice(0, 200) }); } });
      });
    req.on("error", (e) => resolve({ ok: false, error: "연결 실패(앱·서버 실행 중?): " + e.message }));
    req.write(payload); req.end();
  });
}

const journal = (runId, event) => post("journal", { runId, event }, runId);

// --------------------------------------------------------------------- 계획

function loadPlan(file) {
  const raw = fs.readFileSync(file, "utf8");
  let plan;
  try { plan = JSON.parse(raw); }
  catch (e) { throw new Error(`계획을 JSON으로 읽지 못했다: ${e.message}\n(계획은 JSON이다 — 검사기가 계획의 전이와 manifest의 전이를 대조하려면 읽을 수 있어야 한다)`); }
  return { plan, digest: crypto.createHash("sha256").update(raw).digest("hex") };
}

// 계약 위반이 실행 중에 드러나면 절반 실행된 상태가 남는다. 먼저 다 본다.
function checkPlan(plan) {
  const errs = [];
  if (plan.plan_version !== 1) errs.push("plan_version이 1이 아니다");
  if (!plan.target) errs.push("target이 없다");
  const scenarios = Array.isArray(plan.scenarios) ? plan.scenarios : [];
  if (!scenarios.length) errs.push("scenarios가 비어 있다");

  // 계약에 없는 필드는 오타이거나 읽히지 않는 설정이다. 둘 다 그냥 지나가면 안 된다.
  // 계획을 쓴 사람은 그것이 반영됐다고 믿는다.
  const TOP = new Set(["plan_version", "target", "project_id", "revision", "transitions",
                       "observations", "params", "macros", "scenarios"]);
  const SCEN = new Set(["id", "transition", "priority", "actor", "needs", "isolation", "reset", "steps"]);
  const STEP = new Set(["id", "name", "instrument", "action", "assert", "macro", "optional", "external"]);
  const unknown = (obj, allow, where) => {
    for (const k of Object.keys(obj || {})) if (!allow.has(k)) errs.push(`${where}: 계약에 없는 필드 — ${k}`);
  };
  unknown(plan, TOP, "계획");

  const ids = new Set(), stepIds = new Set();
  const macros = plan.macros || {}, params = plan.params || {};
  const transitions = new Set((plan.transitions || []).map((t) => t.name));

  const checkValue = (v, where) => {
    if (v && typeof v === "object" && v.param != null && !params[v.param])
      errs.push(`${where}: params에 없는 슬롯을 참조한다 — ${v.param}`);
  };

  // 확인할 것은 두 종류다. 전이는 상태를 바꾸는 일이라 조작으로만 실행되고, 관찰은 어떤 상태에서
  // 화면이 어떠해야 하는가라 그 상태에 도달했을 때 여럿을 한 번에 본다.
  //
  // 이 둘을 한 축으로 두면, 확인할 것을 전부 전이로 적고 시나리오 하나가 전이 하나를
  // 가리키게 되어 같은 화면에서 한꺼번에 볼 수 있는 것들이 서로 다른 시나리오로 흩어지고 같은
  // 상태를 몇 번씩 다시 만든다. 나눠 두면 커버리지 분모(전이 수 + 관찰 수)는 그대로면서
  // 도달 횟수만 줄어든다.
  //
  // 상태는 따로 선언하지 않는다. 전이의 from·to에 적힌 이름이 곧 상태다. 두 곳에 적으면
  // 언젠가 일치하지 않게 된다.
  const states = new Set();
  for (const t of plan.transitions || []) {
    if (!t || typeof t !== "object") continue;
    if (t.from) states.add(String(t.from));
    if (t.to) states.add(String(t.to));
  }
  const observations = Array.isArray(plan.observations) ? plan.observations : [];
  const TRANS = new Set(["name", "from", "to", "priority", "surface", "boundary", "store", "derived", "time"]);
  const OBS = new Set(["id", "at", "name", "assert", "priority", "surface", "optional"]);
  const obsIds = new Set();
  for (const t of plan.transitions || []) {
    if (!t || typeof t !== "object") { errs.push("transitions에 객체가 아닌 항목이 있다"); continue; }
    if (!t.name) { errs.push("이름 없는 전이"); continue; }
    unknown(t, TRANS, `전이:${t.name}`);
    // 관찰을 쓰려면 상태 그래프가 있어야 한다. 관찰은 "어느 상태에서 보는가"로 연결되므로,
    // 전이가 어디서 어디로 가는지 없으면 연결할 대상이 없다.
    if (observations.length && (!t.from || !t.to))
      errs.push(`전이:${t.name}: observations를 쓰려면 from·to가 있어야 한다 — 관찰이 매달릴 상태가 없다`);
  }
  for (const o of observations) {
    if (!o || typeof o !== "object") { errs.push("observations에 객체가 아닌 항목이 있다"); continue; }
    if (!o.id) { errs.push("id 없는 관찰"); continue; }
    unknown(o, OBS, `관찰:${o.id}`);
    if (obsIds.has(o.id)) errs.push(`관찰 id가 겹친다 — ${o.id}`);
    obsIds.add(o.id);
    if (!o.at) errs.push(`관찰:${o.id}: 어느 상태에서 보는지(at)가 없다`);
    else if (states.size && !states.has(String(o.at)))
      errs.push(`관찰:${o.id}: 전이가 만들지 않는 상태를 가리킨다 — ${o.at}`);
    if (!o.assert) errs.push(`관찰:${o.id}: assert가 없다 — 무엇이 보이면 된 것인지가 관찰의 전부다`);
    else {
      if (!o.assert.mode) errs.push(`관찰:${o.id}: assert에 mode가 없다`);
      if (["contains", "equals"].includes(o.assert.mode) && o.assert.value == null)
        errs.push(`관찰:${o.id}: ${o.assert.mode}인데 비교할 값이 없다`);
      checkValue(o.assert.value, `관찰:${o.id}`);
    }
  }

  const checkSteps = (steps, where) => {
    for (const st of steps || []) {
      if (!st.id) { errs.push(`${where}: id 없는 단계`); continue; }
      const key = `${where}/${st.id}`;
      unknown(st, STEP, key);
      if (stepIds.has(key)) errs.push(`${key}: 단계 id가 겹친다`);
      stepIds.add(key);
      if (!st.name) errs.push(`${key}: name이 없다 — manifest의 단계 이름이 여기서 온다`);
      const kinds = ["action", "assert", "macro"].filter((k) => st[k] != null);
      // external은 다른 계측기 몫이라 여기에 조작이 없다. 있으면 누가 하는 단계인지 구분되지 않는다.
      if (st.external && kinds.length) errs.push(`${key}: external인데 조작이 적혀 있다 — 누가 하는 단계인지 갈리지 않는다`);
      else if (!st.external && kinds.length !== 1) errs.push(`${key}: action·assert·macro 중 정확히 하나여야 한다 (지금 ${kinds.length}개)`);
      if (st.macro && !macros[st.macro]) errs.push(`${key}: 없는 매크로를 부른다 — ${st.macro}`);
      if (st.action) {
        const verbs = Object.keys(st.action);
        if (verbs.length !== 1) errs.push(`${key}: 한 단계는 한 조작이다 (지금 ${verbs.length}개)`);
        const a = st.action[verbs[0]];
        if (a && typeof a === "object" && a.value != null) checkValue(a.value, key);
        if (verbs[0] === "login" && a && a.param && params[a.param] && params[a.param].kind !== "credential")
          errs.push(`${key}: login은 credential 슬롯만 받는다`);
      }
      if (st.assert) {
        if (!st.assert.mode) errs.push(`${key}: assert에 mode가 없다`);
        if (["contains", "equals"].includes(st.assert.mode) && st.assert.value == null)
          errs.push(`${key}: ${st.assert.mode}인데 비교할 값이 없다`);
        checkValue(st.assert.value, key);
      }
    }
  };

  for (const s of scenarios) {
    if (!s.id) { errs.push("id 없는 시나리오"); continue; }
    if (ids.has(s.id)) errs.push(`시나리오 id가 겹친다 — ${s.id}`);
    unknown(s, SCEN, s.id);
    ids.add(s.id);
    if (s.transition && transitions.size && !transitions.has(s.transition))
      errs.push(`${s.id}: transitions에 없는 전이를 가리킨다 — ${s.transition}`);
    if (s.isolation === "reset" && !s.reset)
      errs.push(`${s.id}: isolation이 reset인데 무엇으로 되돌리는지가 없다 — 리셋했다고 적을 수 없다`);
    checkSteps(s.steps, s.id);
  }
  for (const [name, m] of Object.entries(macros)) checkSteps(m.steps, `macro:${name}`);
  for (const s of scenarios) for (const need of s.needs || [])
    if (!ids.has(need)) errs.push(`${s.id}: 없는 선행 시나리오를 기다린다 — ${need}`);

  // 의존이 순환하면 아무것도 실행되지 않는다. 실행 전에 잡는다.
  const state = new Map();
  const walk = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "walking") { errs.push(`시나리오 의존이 고리를 이룬다 — ${[...trail, id].join(" → ")}`); return; }
    state.set(id, "walking");
    for (const n of (scenarios.find((x) => x.id === id) || {}).needs || []) if (ids.has(n)) walk(n, [...trail, id]);
    state.set(id, "done");
  };
  for (const s of scenarios) if (s.id) walk(s.id, []);
  return errs;
}

// --------------------------------------------------------------------- 값

// 값을 추론하지 않는다. 계획이 분류를 선언하고 러너는 그 분류대로만 처리한다.
function resolveParams(plan, runId, scopeKey) {
  const out = {};
  for (const [name, p] of Object.entries(plan.params || {})) {
    if (p.kind === "plain") out[name] = { kind: "plain", value: String(p.value ?? "") };
    else if (p.kind === "generated") {
      const base = String(scopeKey || p.from || runId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
      out[name] = { kind: "generated", value: `${p.prefix || name}-${base}-${runId}`.slice(0, 64) };
    }
    else if (p.kind === "credential") out[name] = { kind: "credential", username: p.username || null };
    else if (p.kind === "human_only") out[name] = { kind: "human_only", prompt: p.prompt || `${name} 값을 입력해 주세요` };
  }
  return out;
}

function valueOf(v, params, where) {
  if (v == null) return { ok: false, error: `${where}: 값이 없다` };
  if (typeof v === "string") return { ok: true, value: v };
  const p = params[v.param];
  if (!p) return { ok: false, error: `${where}: 알 수 없는 슬롯 — ${v.param}` };
  if (p.kind === "credential") return { ok: false, credential: true, param: v.param, username: p.username };
  if (p.kind === "human_only") return { ok: false, human: true, param: v.param, prompt: p.prompt };
  return { ok: true, value: p.value };
}

// --------------------------------------------------------------------- locator

const LOC_KEYS = ["testid", "role", "name", "sel", "nth"];
const locatorOf = (o) => {
  const l = {};
  for (const k of LOC_KEYS) if (o[k] != null) l[k] = o[k];
  if (o.expect_url) l.expectUrl = o.expect_url;
  return l;
};
const describeLocator = (l) =>
  l.testid ? `testid=${l.testid}` : l.role && l.name ? `${l.role} "${l.name}"`
  : l.name ? `"${l.name}"` : l.role ? `role=${l.role}` : l.sel || "(빈 locator)";

// 조작 직전에 대상을 확정한다. 하나로 좁혀지지 않으면 고치지 않고 멈춘다.
//
// 다만 "아직 안 그려졌다"와 "잘못된 대상이다"는 다른 일이다. 화면이 그려지는 중에 본 것을
// 실패로 확정하면 러너는 사람보다 성급하게 매번 불필요하게 멈춘다. 그래서 짧게 다시 본다.
// 이것은 잘못 누른 것을 지나가게 하는 복구가 아니라, 아직 없는 것을 없다고 단정하지 않는 것이다.
// 시간이 지나도 하나로 안 좁혀지면 그때는 그대로 멈춘다.
// 아는 구간을 지나갈 때와 처음부터 다시 실행할 때는 대기 시간이 달라야 한다. 같으면 강등은
// 이름뿐이고, 매크로가 아낀 시간도 없다. 빠른 쪽은 짧게 보고 넘어가고, 느린 쪽은 화면이
// 안정될 때까지 기다리며 단계마다 증거를 남긴다.
const SETTLE = { fast: { tries: 2, ms: 250 }, careful: { tries: 6, ms: 500 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function confirmTarget(loc, runId, ctx, mark) {
  const S = SETTLE[ctx.fast ? "fast" : "careful"];
  let r, d;
  for (let i = 0; i < S.tries; i++) {
    r = await post("locate", { ...loc, mark: !!mark, tab: ctx.tab }, runId);
    if (!r.ok) return { ok: false, why: r.error };
    d = r.data || {};
    if (d.unique) break;
    if (i < S.tries - 1) await sleep(S.ms);
  }
  // 확정한 그 요소를 다음 명령이 그대로 집게 한다. 이름·역할로 찾은 요소는 선택자로 고정할 수
  // 없고, 고정하려고 경로를 계산하면 그 사이 화면이 다시 그려졌을 때 옆 요소를 누르게 된다.
  if (d.unique) return { ok: true, info: d, css: d.css || null };
  await journal(runId, {
    kind: "observation", source: "browser", step_id: ctx.stepId, scenario_id: ctx.scenarioId,
    note: `대상이 정해지지 않음 — ${describeLocator(loc)}: ${(d.reasons || []).join(" / ")}`.slice(0, 300),
    url: d.url,
  });
  return { ok: false, why: (d.reasons || ["대상을 정하지 못했다"]).join(" / "), detail: d };
}

// locate로 확정한 대상을 실제 명령에 넘길 선택자로 바꾼다. 서버 명령은 CSS·ref만 받는다.
// testid·role/name은 여기서 CSS로 변환해 넘긴다. locate가 이미 하나임을 확인한 뒤다.
function cssFor(loc, confirmed) {
  if (confirmed && confirmed.css) return confirmed.css;   // locate가 남긴 값이며 확정한 바로 그 요소
  if (loc.testid) {
    const q = JSON.stringify(loc.testid);
    return ["data-testid", "data-test-id", "data-test", "data-qa"].map((a) => `[${a}=${q}]`).join(",");
  }
  return loc.sel || null;
}

// --------------------------------------------------------------------- 실행

async function runStep(step, ctx) {
  const { runId, params, plan } = ctx;
  const sctx = { ...ctx, stepId: step.id, scenarioId: ctx.scenarioId };
  const tag = { step_id: step.id, scenario_id: ctx.scenarioId };

  if (step.assert) {
    const loc = locatorOf(step.assert);
    let css = cssFor(loc, null);
    // exists·absent는 "몇 개인가"가 곧 판정이라 확정 단계를 건너뛴다. 나머지는 어느 요소를
    // 보고 판정했는지가 결과를 바꾸므로 먼저 하나로 좁힌다.
    if (!["exists", "absent"].includes(step.assert.mode)) {
      const c = await confirmTarget(loc, runId, sctx, true);
      if (!c.ok) return { verdict: "BLOCKED", why: c.why };
      css = cssFor(loc, c);
    }
    if (!css) return { verdict: "BLOCKED", why: `${step.id}: 선택자로 굳힐 수 없는 locator다` };
    let want = null;
    if (step.assert.value != null) {
      const v = valueOf(step.assert.value, params, step.id);
      if (!v.ok) return { verdict: "BLOCKED", why: v.error || `${step.id}: 판정 값이 사람·비밀 슬롯이다` };
      want = v.value;
    }
    const r = await post("expect", { sel: css, mode: step.assert.mode, text: want, ...tag, tab: ctx.tab }, runId);
    if (!r.ok) return { verdict: "BLOCKED", why: r.error };
    return { verdict: r.data && r.data.pass ? "PASS" : "FAIL", receipt: r.data && r.data.receipt,
             got: r.data && r.data.got, shot: r.data && r.data.shot };
  }

  const verb = Object.keys(step.action)[0];
  const a = step.action[verb];

  if (verb === "goto") {
    // 계획도 사람 경로여야 한다. 같은 사이트 안을 주소로 건너뛰는 단계는 서버가 막고 BLOCKED로
    // 남는다. 그 경로 자체가 확인 대상이 아닐 때만 `goto: {url, reason}` 형태로 이유를 적는다.
    const url = a && typeof a === "object" ? a.url : a;
    const reason = a && typeof a === "object" && a.reason ? String(a.reason) : null;
    const r = await post("goto", { url, ...(reason ? { reason } : {}), ...tag, tab: ctx.tab }, runId);
    if (!r.ok) return { verdict: "BLOCKED", why: r.error };
    await post("wait", { ...tag, tab: ctx.tab }, runId);
    return { verdict: "PASS" };
  }
  if (verb === "wait") { const r = await post("wait", a ? { ms: a, ...tag, tab: ctx.tab } : { ...tag, tab: ctx.tab }, runId); return r.ok ? { verdict: "PASS" } : { verdict: "BLOCKED", why: r.error }; }
  if (verb === "scroll") { const r = await post("scroll", { amount: a, ...tag, tab: ctx.tab }, runId); return r.ok ? { verdict: "PASS" } : { verdict: "BLOCKED", why: r.error }; }
  if (verb === "key") { const r = await post("key", { key: a, ...tag, tab: ctx.tab }, runId); return r.ok ? { verdict: "PASS" } : { verdict: "BLOCKED", why: r.error }; }
  if (verb === "type") {
    const v = valueOf(a.value, params, step.id);
    if (v.human) { const r = await post("ask", { message: v.prompt, wait: 300, ...tag, tab: ctx.tab }, runId);
      return r.ok && r.data && r.data.answered ? { verdict: "PASS", human: true } : { verdict: "BLOCKED", why: "사람 응답 없음", human: true }; }
    if (!v.ok) return { verdict: "BLOCKED", why: v.error || "비밀 값은 type으로 넣지 않는다 — login을 쓴다" };
    const r = await post("type", { text: v.value, ...tag, tab: ctx.tab }, runId);
    return r.ok ? { verdict: "PASS" } : { verdict: "BLOCKED", why: r.error };
  }
  if (verb === "ask") {
    const r = await post("ask", { message: a.message, wait: a.wait || 300, ...tag, tab: ctx.tab }, runId);
    return r.ok && r.data && r.data.answered ? { verdict: "PASS", human: true } : { verdict: "BLOCKED", why: "사람 응답 없음", human: true };
  }
  if (verb === "login") {
    const p = a && a.param ? params[a.param] : null;
    const r = await post("login", { username: (p && p.username) || undefined, ...tag, tab: ctx.tab }, runId);
    return r.ok ? { verdict: "PASS", credential: true } : { verdict: "BLOCKED", why: r.error, credential: true };
  }

  // 여기서부터는 대상이 있는 조작이다.
  const loc = locatorOf(a);
  const c = await confirmTarget(loc, runId, sctx, true);
  if (!c.ok) return { verdict: "BLOCKED", why: c.why };
  const css = cssFor(loc, c);
  if (!css) return { verdict: "BLOCKED", why: `${step.id}: 선택자로 굳힐 수 없는 locator다` };

  if (verb === "click" || verb === "dblclick" || verb === "hover") {
    const r = await post(verb, { sel: css, ...tag, tab: ctx.tab }, runId);
    return r.ok ? { verdict: "PASS" } : { verdict: "BLOCKED", why: r.error };
  }
  if (verb === "fill" || verb === "select") {
    const v = valueOf(a.value, params, step.id);
    if (v.credential) {
      const r = await post("login", { username: v.username || undefined, ...tag, tab: ctx.tab }, runId);
      return r.ok ? { verdict: "PASS", credential: true } : { verdict: "BLOCKED", why: r.error, credential: true };
    }
    if (v.human) {
      const r = await post("ask", { message: v.prompt, wait: 300, ...tag, tab: ctx.tab }, runId);
      return r.ok && r.data && r.data.answered ? { verdict: "PASS", human: true } : { verdict: "BLOCKED", why: "사람 응답 없음", human: true };
    }
    if (!v.ok) return { verdict: "BLOCKED", why: v.error };
    const r = verb === "fill"
      ? await post("fill", { sel: css, text: v.value, ...tag, tab: ctx.tab }, runId)
      : await post("select", { sel: css, value: v.value, ...tag, tab: ctx.tab }, runId);
    return r.ok ? { verdict: "PASS" } : { verdict: "BLOCKED", why: r.error };
  }
  return { verdict: "BLOCKED", why: `${step.id}: 모르는 조작 — ${verb}` };
}

// --------------------------------------------------------------------- 매크로

function loadMacroStore() {
  try { return JSON.parse(fs.readFileSync(MACRO_STORE, "utf8")); } catch { return {}; }
}
function saveMacroStore(store) {
  fs.mkdirSync(path.dirname(MACRO_STORE), { recursive: true });
  fs.writeFileSync(MACRO_STORE, JSON.stringify(store, null, 2) + "\n");
}

// 매크로가 주장하는 것은 "이 구간을 확인했다"가 아니라 "아는 전제를 지나왔다"다. 그래서 판정은
// 그대로 다 실행한다. 생략하는 것은 중간 화면의 해석이지 판정이 아니다.
//
// 경계: 연결이 로컬이고 외부로 나가지 않을 때만. 실제로 결제가 나가면 해석 없이 지나가는 것이
// 정확히 하면 안 되는 일이다. credential·human_only가 낀 단계도 들어가지 않는다.
function macroAllowed(macro, ctx) {
  if (!ctx.local) return "배선이 로컬·비유출로 확인되지 않았다";
  const params = ctx.plan.params || {};
  for (const st of macro.steps || []) {
    const v = (st.action && Object.values(st.action)[0]) || st.assert;
    const ref = v && v.value && typeof v.value === "object" ? v.value.param : null;
    const kind = ref ? (params[ref] || {}).kind : null;
    if (kind === "credential" || kind === "human_only") return `사람·비밀 값이 낀 단계가 있다 (${st.id})`;
    if (st.action && (st.action.login || st.action.ask)) return `사람·비밀 단계가 있다 (${st.id})`;
  }
  return null;
}

// --------------------------------------------------------------------- 시나리오

async function resetScenario(s, ctx) {
  if (s.isolation !== "reset" || !s.reset) return { ok: true, skipped: true };
  if (s.reset.goto) {
    // 되돌리기는 확인하는 경로가 아니라 시나리오를 같은 지점에서 시작시키는 준비다. 사람 경로
    // 게이트를 통과시키되 이유를 실어 회차 장부에 "건너뜀"으로 남긴다. 이유 없이 통과시키지 않는다.
    const r = await post("goto", { url: s.reset.goto, reason: "시나리오 격리 되돌리기(reset)", tab: ctx.tab }, ctx.runId);
    if (!r.ok) return { ok: false, why: r.error };
    await post("wait", { tab: ctx.tab }, ctx.runId);   // 로드가 끝나기 전에 보면 빈 화면을 본다
  }
  if (s.reset.eval) { const r = await post("eval", { expression: s.reset.eval, tab: ctx.tab }, ctx.runId); if (!r.ok) return { ok: false, why: r.error }; }
  // command는 러너가 실행하지 않는다. 셸을 여는 순간 계획이 임의 코드 실행 통로가 된다.
  if (s.reset.command) return { ok: false, why: `이 격리는 셸로 되돌린다 — 러너가 실행하지 않는다: ${s.reset.command}` };
  return { ok: true };
}

async function runSteps(steps, ctx0, { fast }) {
  const ctx = { ...ctx0, fast };
  const out = [];
  for (const step of steps) {
    if (step.external) continue;      // 다른 계측기가 같은 회차 장부에 직접 합류한다
    if (step.macro) {
      const r = await runMacroStep(step, ctx);
      if (r.restart) return { restart: r.restart, results: out };   // 시나리오를 처음부터 다시
      out.push(...r);
      if (r.some((x) => x.verdict === "BLOCKED" && !x.optional)) return out;
      continue;
    }
    const res = await runStep(step, ctx);
    if (ctx.degraded && step.action && res.verdict === "PASS") {
      // 매크로가 빗나가 다시 실행하는 중이다. 무엇을 보고 지나갔는지 남겨야 나중에 원인을
      // 확인할 수 있다. 평소에는 찍지 않는다. 장면 한 장이 몇 초라 모든 단계에서 찍으면
      // 러너가 아낀 시간을 그대로 다시 쓴다(확인 결과: 1.7초 회차가 26초가 됐다).
      await post("screenshot", { caption: `${step.id} ${step.name}`, step_id: step.id,
                                 scenario_id: ctx.scenarioId, tab: ctx.tab }, ctx.runId);
    }
    out.push({ scenario: ctx.scenarioId, step: step.id, name: step.name,
               instrument: step.instrument || "journey-web", ...res, optional: !!step.optional, fast });
    if (res.verdict === "BLOCKED" && !step.optional) return out;
    if (res.verdict === "FAIL" && !step.optional) return out;
  }
  return out;
}

async function runMacroStep(step, ctx) {
  const macro = (ctx.plan.macros || {})[step.macro];
  const store = ctx.macroStore;
  const key = `${ctx.plan.project_id || ctx.plan.target}:${step.macro}`;
  const rec = store[key] || (store[key] = { misses: 0, stale: false });
  const denial = macroAllowed(macro, ctx);

  if (!denial && !rec.stale && !ctx.noMacro) {
    const res = await runSteps(macro.steps, { ...ctx, macroName: step.macro }, { fast: true });
    const bad = res.find((r) => r.verdict !== "PASS" && !r.optional);
    if (!bad) {
      rec.misses = 0; rec.lastOk = new Date().toISOString();
      return res.map((r) => ({ ...r, viaMacro: step.macro }));
    }
    // 빗나갔다. 중단이 아니라 강등이다. 다만 매크로가 중간까지 만든 상태를 안고 넘어가면
    // 어디서부터가 매크로 탓인지 구분되지 않으므로 먼저 되돌린다.
    rec.misses += 1;
    if (rec.misses >= 2) rec.stale = true;   // 화면이 바뀐 것을 매번 강등으로 흡수하면 느려지기만 한다
    const url = await post("url", { tab: ctx.tab }, ctx.runId);
    await journal(ctx.runId, {
      kind: "macro_miss", source: "browser", macro: step.macro,
      step_id: bad.step, scenario_id: ctx.scenarioId,
      expected_screen: `${bad.name} — ${bad.verdict === "FAIL" ? "판정 불일치" : bad.why || "실행 실패"}`.slice(0, 200),
      actual_screen: `${((url.data || {}).url) || ""} ${bad.got ? "본 것: " + String(bad.got).slice(0, 80) : ""}`.trim().slice(0, 200),
      note: rec.stale ? "두 번 연속 빗나가 stale로 표시했다 — 더 쓰지 않는다" : "해석 경로로 강등한다",
    });
    const r = await resetScenario(ctx.scenario, ctx);
    if (!r.ok) return [...res, { scenario: ctx.scenarioId, step: step.id, name: step.name,
      verdict: "BLOCKED", why: `매크로가 빗나갔는데 격리를 되돌리지 못했다: ${r.why}`, viaMacro: step.macro }];
    if (r.skipped) return [...res, { scenario: ctx.scenarioId, step: step.id, name: step.name,
      verdict: "BLOCKED", viaMacro: step.macro,
      why: "매크로가 빗나갔는데 이 시나리오에 격리 리셋이 없다 — 중간 상태를 안고 다시 밟으면 무엇이 매크로 탓인지 갈리지 않는다" }];
    // 격리를 되돌렸으므로 이 시나리오가 여기까지 만든 상태도 함께 사라졌다. 매크로 구간만
    // 다시 실행하면 앞 단계가 만든 것이 없는 상태가 되므로, 시나리오를 처음부터 다시 실행한다.
    return { restart: step.macro };
  }

  // 여기는 매크로를 처음부터 쓰지 않는 경로다(로컬이 아니거나·사람 값이 있거나·stale).
  const slow = await runSteps(macro.steps, { ...ctx, macroName: null }, { fast: false });
  if (slow.restart) return slow;
  return slow.map((r) => ({ ...r, macroSkipped: denial || (rec.stale ? "stale" : "다시 밟는 중") }));
}

async function runScenario(s, ctx) {
  const sctx = { ...ctx, scenarioId: s.id, scenario: s };
  const reset = await resetScenario(s, sctx);
  if (!reset.ok) return [{ scenario: s.id, step: "(reset)", name: "격리 되돌리기", verdict: "BLOCKED", why: reset.why }];
  let out = await runSteps(s.steps, sctx, { fast: false });
  if (out.restart) {
    // 매크로가 빗나가 격리를 되돌렸다. 이번에는 매크로 없이 처음부터 실행한다.
    const again = await runSteps(s.steps, { ...sctx, noMacro: true, degraded: true }, { fast: false });
    out = (Array.isArray(again) ? again : again.results || []).map((r) => ({ ...r, degradedFrom: out.restart }));
  }
  await post("locate", { clear: true, tab: ctx.tab }, ctx.runId);   // 검사 대상에 없던 속성을 남기지 않는다
  return out;
}

// --------------------------------------------------------------------- 배선

// 매크로는 되돌릴 수 있는 경우에만 쓴다. 선언값이 아니라 실제로 확인한 것에 근거해야 하므로,
// 러너는 현재 탭의 주소가 로컬인지 직접 본다. --local은 사람이 그 확인을 대신 서명했다는 뜻이다.
async function localWiring(ctx, forced) {
  if (forced) return { local: true, why: "호출자가 --local로 서명했다" };
  const r = await post("url", { tab: ctx.tab }, ctx.runId);
  const url = String(((r.data || {}).url) || "");
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
  return { local, why: local ? `현재 주소가 로컬이다 (${url})` : `현재 주소가 로컬이 아니다 (${url || "알 수 없음"})` };
}

// --------------------------------------------------------------------- 요약

// 전이를 실행해 어떤 상태에 도달하면, 그 상태에서 볼 수 있는 것을 그 자리에서 다 본다.
// 관찰마다 처음부터 다시 실행하면 같은 상태를 몇 번씩 다시 만든다. 확인할 것의 수는 그대로인데
// 도달 횟수만 늘어난다. 한 번 본 관찰은 다시 보지 않는다(seen).
async function sweepObservations(state, ctx, viaScenario, seen) {
  const out = [];
  for (const o of ctx.plan.observations || []) {
    if (String(o.at) !== String(state) || seen.has(o.id)) continue;
    seen.add(o.id);
    const r = await runStep({ id: o.id, name: o.name, assert: o.assert, optional: o.optional },
                            { ...ctx, scenarioId: viaScenario });
    out.push({ scenario: viaScenario, step: o.id, name: o.name || o.id,
               observation: true, at: String(state), optional: !!o.optional, ...r });
  }
  return out;
}

function summarize(results, plan) {
  // 매크로 안의 단계도 실제로 실행하는 단계다. 감싼 쪽만 세면 매크로로 지나간 구간이 통째로
  // "실행하지 않음"으로 잡히고, 파생(qa_derive)이 세는 것과도 일치하지 않는다.
  const planned = [];
  for (const s of plan.scenarios) for (const st of s.steps) {
    if (st.external) continue;        // 러너가 실행할 단계가 아니다. 파생이 장부에서 찾는다
    if (st.macro) for (const m of ((plan.macros || {})[st.macro] || {}).steps || []) planned.push(`${s.id}/${m.id}`);
    else planned.push(`${s.id}/${st.id}`);
  }
  const ran = new Set(results.map((r) => `${r.scenario}/${r.step}`));
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  // 계획에 있는데 장부에 없는 단계가 곧 미수행 coverage다. 실행 로그만 보면 이 빈자리가 사라진다.
  const notRun = planned.filter((p) => !ran.has(p));
  // 관찰은 어느 시나리오가 소진할지 실행 전에 정해지지 않으므로 따로 센다. 계획에 있는데
  // 한 번도 보지 않은 관찰이 곧 빠뜨린 확인이다. 이것을 세지 않으면 "실행한 것"만 남는다.
  const plannedObs = (plan.observations || []).map((o) => o.id);
  const ranObs = new Set(results.filter((r) => r.observation).map((r) => r.step));
  const notObserved = plannedObs.filter((id) => !ranObs.has(id));
  return { ...counts, planned: planned.length, notRun,
           observations: { planned: plannedObs.length, ran: ranObs.size, notObserved },
           macro: results.filter((r) => r.viaMacro).length,
           degraded: [...new Set(results.filter((r) => r.degradedFrom).map((r) => r.degradedFrom))] };
}

// --------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv.shift();
  let file = null, runId = null, tab = null, forceLocal = false, jsonOut = false, only = null, keepOpen = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run") runId = argv[++i];
    else if (argv[i] === "--tab") tab = String(argv[++i]).replace(/^@/, "");
    else if (argv[i] === "--local") forceLocal = true;
    else if (argv[i] === "--json") jsonOut = true;
    else if (argv[i] === "--no-end") keepOpen = true;
    else if (argv[i] === "--only") only = String(argv[++i]).split(",").map((x) => x.trim()).filter(Boolean);
    else if (!file) file = argv[i];
  }
  if (!sub || !["check", "digest", "run"].includes(sub) || !file) {
    console.error("사용: iris-browser plan <check|digest|run> <plan.json> [--run <runId>] [--tab @핸들] [--only S1,S2] [--local] [--no-end] [--json]");
    process.exit(2);
  }

  const { plan, digest } = loadPlan(file);
  if (sub === "digest") { console.log(digest); return; }

  const errs = checkPlan(plan);
  if (errs.length) {
    console.error(`계획이 성립하지 않는다 (${errs.length}건) — 실행하면 절반만 밟은 상태가 남는다:`);
    for (const e of errs) console.error("  · " + e);
    process.exit(1);
  }
  if (sub === "check") {
    const n = plan.scenarios.reduce((a, s) => a + s.steps.length, 0);
    console.log(`계획 OK — 시나리오 ${plan.scenarios.length}개 · 단계 ${n}개 · 전이 ${(plan.transitions || []).length}개`
      + ` · 관찰 ${(plan.observations || []).length}개 · 매크로 ${Object.keys(plan.macros || {}).length}개`);
    console.log(`digest ${digest}`);
    return;
  }

  if (!runId) { console.error("--run <runId>가 필요하다 — 회차에 묶이지 않은 실행은 증거를 남기지 않는다"); process.exit(2); }
  const begun = await post("run", { action: "begin", runId }, runId);
  if (!begun.ok) { console.error("회차를 열지 못했다:", begun.error); process.exit(1); }

  const ctx0 = { runId, tab, plan, macroStore: loadMacroStore() };
  const wiring = await localWiring(ctx0, forceLocal);
  const scopeKey = `${plan.project_id || plan.target}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  const ctx = { ...ctx0, local: wiring.local, params: resolveParams(plan, runId, scopeKey) };

  // digest를 서술이 아니라 필드로 남긴다. note에만 있으면 파생이 나중에 계획 파일을 다시 읽어
  // 계산하게 되고, 실행 뒤 계획을 고쳐도 새 계획과 새 digest가 서로 맞는 manifest가 나온다.
  // 그러면 "이 파일이 실제로 실행된 그 계획이었는가"를 확인할 수 없다.
  await journal(runId, { kind: "observation", source: "server",
    plan_digest: digest, plan_path: file,
    note: `계획 실행 시작 — ${path.basename(file)} · 매크로 ${wiring.local ? "허용" : "차단"}: ${wiring.why}`.slice(0, 300) });

  const results = [];
  const done = new Map();                       // 시나리오 id → 성공 여부
  const seenObs = new Set();                    // 이미 본 관찰. 같은 것을 두 번 보지 않는다
  for (const s of plan.scenarios) {
    if (only && !only.includes(s.id)) continue;
    const blockedBy = (s.needs || []).filter((n) => done.get(n) === false);
    if (blockedBy.length) {
      // 한 시나리오의 실패는 그 후속만 막는다. 독립 시나리오는 계속 돈다.
      results.push({ scenario: s.id, step: "(needs)", name: "선행 시나리오",
                     verdict: "BLOCKED", why: `선행이 실패했다 — ${blockedBy.join(", ")}` });
      done.set(s.id, false);
      continue;
    }
    // 출발 상태에서 볼 것도 여기서 본다. 도착 상태만 확인하면, 어느 전이도 도달하지 않는 상태
    // (대개 첫 화면)에 연결한 관찰은 계속 "못 봄"으로 남는다(확인 결과: 관찰 0/3).
    // 이 시나리오를 실행한다는 것은 그 전제가 성립했다는 뜻이므로 지금 그 상태에 있다.
    const from = (plan.transitions || []).find((t) => t && t.name === s.transition);
    if (from && from.from) results.push(...await sweepObservations(from.from, ctx, s.id, seenObs));
    const r = await runScenario(s, ctx);
    results.push(...r);
    const ok = r.length > 0 && !r.some((x) => x.verdict !== "PASS" && !x.optional);
    done.set(s.id, ok);
    // 도착한 상태에서 볼 것을 여기서 다 본다. 실패한 시나리오는 그 상태에 도달하지 못했으므로
    // 관찰도 하지 않는다. 도달하지 않은 화면을 봤다고 적을 수 없다.
    if (ok) {
      const trans = (plan.transitions || []).find((t) => t && t.name === s.transition);
      if (trans && trans.to) results.push(...await sweepObservations(trans.to, ctx, s.id, seenObs));
    }
  }

  saveMacroStore(ctx.macroStore);
  const summary = summarize(results, plan);
  // 회차는 이 러너의 것이 아니다. 저장소·API·코드 테스트가 같은 회차에 합류할 여지가 남아
  // 있어야 하므로, 닫는 시점을 부른 쪽이 정할 수 있게 한다.
  const ended = keepOpen ? { data: {} } : await post("run", { action: "end", runId }, runId);
  const report = { runId, plan: file, plan_digest: digest, target: plan.target,
                   project_id: plan.project_id || null, wiring, summary, results,
                   journal: (begun.data || {}).journal,
                   openCalls: (ended.data || {}).openCalls || 0 };

  if (jsonOut) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log(`\n회차 ${runId} · ${plan.target}`);
    for (const r of results) {
      const mark = r.verdict === "PASS" ? "됨  " : r.verdict === "FAIL" ? "안 됨" : "막힘";
      console.log(`  ${mark} ${r.scenario}/${r.step} ${r.name}${r.viaMacro ? "  (매크로 " + r.viaMacro + ")" : ""}${r.degradedFrom ? "  (강등 " + r.degradedFrom + ")" : ""}`);
      if (r.why) console.log(`        ${r.why}`);
    }
    console.log(`\n됨 ${summary.PASS} · 안 됨 ${summary.FAIL} · 막힘 ${summary.BLOCKED} / 계획 ${summary.planned}`);
    if (summary.notRun.length) console.log(`밟지 못한 단계 ${summary.notRun.length}개: ${summary.notRun.slice(0, 8).join(", ")}${summary.notRun.length > 8 ? " …" : ""}`);
    const ob = summary.observations;
    if (ob.planned) console.log(`관찰 ${ob.ran}/${ob.planned}${ob.notObserved.length ? ` — 못 본 것: ${ob.notObserved.slice(0, 8).join(", ")}${ob.notObserved.length > 8 ? " …" : ""}` : ""}`);
    if (summary.degraded.length) console.log(`강등된 매크로: ${summary.degraded.join(", ")}`);
    if (report.openCalls) console.log(`끝을 못 본 호출 ${report.openCalls}건 — 그 구간의 결과는 주장하지 않는다`);
    console.log(`장부 ${report.journal}`);
    if (keepOpen) console.log("회차는 열어 두었다 — 다른 계측기가 합류한 뒤 run end로 닫아라");
  }
  process.exit(summary.FAIL || summary.BLOCKED ? 1 : 0);
}

main().catch((e) => { console.error("실패:", e.message); process.exit(1); });
