import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../bin/slice-anchor.mjs";
const require = createRequire(import.meta.url);
const { createQaViewportCommands } = require("../native/electron/cdp-qa-viewport.cjs");

// 사용자가 호스트를 축소해 둔 탭(Cmd+- 두 번, 1.2^-2)
const ZOOM = 1/1.44;
const fixture = (zoom) => {
  const calls = [], notes = [], wc = { id: 7, zoom, getZoomFactor() { return this.zoom; } };
  const send = async (method, args) => { calls.push([method, args]); return {}; };
  const commands = createQaViewportCommands({ notify: (id, box) => notes.push(box) });
  return { calls, notes, wc, send, commands };
};

test("QA viewport scales the override by the host zoom so the page keeps the requested CSS size and DPR", async () => {
  const f = fixture(ZOOM);
  const result = await f.commands["qa-viewport"](f.send, f.wc, { width: 1180, height: 800, dpr: 1 });
  assert.deepEqual(result, { ok: true, width: 1180, height: 800, dpr: 1, reloaded: false });
  const [method, args] = f.calls.at(-1);
  assert.equal(method, "Emulation.setDeviceMetricsOverride");
  assert.equal(args.width, Math.round(1180*ZOOM));
  assert.equal(args.height, Math.round(800*ZOOM));
  // 페이지 배율 = deviceScaleFactor × 확대
  assert.ok(Math.abs(args.deviceScaleFactor*ZOOM - 1) < 1e-9);
  assert.ok(Math.abs(args.width/ZOOM - 1180) < 1);
  assert.deepEqual((await f.commands["qa-viewport-state"](f.send, f.wc)).viewport, { width: 1180, height: 800, dpr: 1 });
});

test("QA viewport sends the request unchanged at 100% zoom", async () => {
  const f = fixture(1);
  await f.commands["qa-viewport"](f.send, f.wc, { width: 1180, height: 800, dpr: 2 });
  assert.deepEqual(f.calls.at(-1), ["Emulation.setDeviceMetricsOverride", { width: 1180, height: 800, deviceScaleFactor: 2, mobile: false }]);
});

test("QA viewport reapplies after navigation changes the host zoom and stays quiet otherwise", async () => {
  const f = fixture(1);
  await f.commands["qa-viewport"](f.send, f.wc, { width: 1180, height: 800, dpr: 1 });
  const before = f.calls.length;
  assert.equal(await f.commands.reconcile(f.send, f.wc), false);
  assert.equal(f.calls.length, before);
  // about:blank 에서 크기를 정한 뒤 축소된 호스트로 이동
  f.wc.zoom = ZOOM;
  assert.equal(await f.commands.reconcile(f.send, f.wc), true);
  assert.equal(f.calls.at(-1)[1].width, Math.round(1180*ZOOM));
  assert.equal(await f.commands.reconcile(f.send, f.wc), false);
  await f.commands["qa-viewport"](f.send, f.wc, { clear: true });
  f.wc.zoom = 1;
  const cleared = f.calls.length;
  assert.equal(await f.commands.reconcile(f.send, f.wc), false);
  assert.equal(f.calls.length, cleared);
});

test("QA viewport leaves address-bar sizes it did not set alone and keeps reconcile out of the command table", async () => {
  const f = fixture(ZOOM);
  assert.equal(await f.commands.reconcile(f.send, f.wc), false);
  assert.equal(f.calls.length, 0);
  assert.equal(Object.keys(f.commands).includes("reconcile"), false);
});

test("QA commands on QA tabs reconcile the viewport before running", () => {
  const source = readFileSync(new URL("../native/electron/cdp-control.cjs", import.meta.url), "utf8");
  const ready = sliceBetween(source, "async function ensureQaReady", "function cdpExec(");
  assert.match(ready, /qaContents\.has\(wc\.id\)[\s\S]*qaViewportCommands\.reconcile\(send, wc\)/);
});

// 세션 안 qa_summary: 실행기 대조 결과는 세션이 끝난 뒤 생김
test("summary with runJson before the launcher writes verify.json shows a pending line instead of failing", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { createQaSummary } = await import("../server/qa-summary.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-regression10-"));
  try {
    const runDir = path.join(root, "run"); fs.mkdirSync(runDir);
    const runJson = path.join(runDir, "run.json");
    fs.writeFileSync(runJson, JSON.stringify({ repo: "/origin", fixTree: "/repo", fixBranch: "qa-fix/x" }));
    const events = [{ seq: 1, event: { kind: "run_begin", session: "s", build: { repo: "/repo" }, charter: {} } }];
    const ledger = { verify: async () => ({ events }), paths: () => ({ folder: root }) };
    const result = await createQaSummary(ledger, ["run"], { runJson });
    assert.equal(result.summary.unattendedVerify.pending, true);
    assert.ok(result.summary.humanTasks.some(line => line.includes(path.join(runDir, "verify.json"))));
    fs.writeFileSync(path.join(runDir, "verify.json"), "{");
    await assert.rejects(createQaSummary(ledger, ["run"], { runJson }), /verify\.json을 읽지 못했습니다/);
    fs.rmSync(runJson);
    await assert.rejects(createQaSummary(ledger, ["run"], { runJson }), /run\.json을 읽지 못했습니다/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("run_end rejection names the unwalked row paths", async () => {
  const { createQaChannel } = await import("../server/qa-channel.js");
  const { qaPlan, qaRowContract } = await import("./qa-fixtures.mjs");
  const events = [];
  const append = async (_id, event) => { const record = { seq: events.length + 1, event: structuredClone(event) }; events.push(record); return record; };
  const ledger = { begin: async ({ runId, session, plan, charter }) => append(runId, { kind: "run_begin", session, plan, charter }),
    verify: async () => ({ events: structuredClone(events), head: "h" }), end: async (id, { session }) => append(id, { kind: "run_end", sessionRecord: session }), append };
  const call = createQaChannel({ ledger, createEntry: async () => ({ ok: true, data: { tabId: "t" } }),
    execute: async () => ({ ok: true, data: { ok: true } }), release: async () => {}, ask: async () => ({ ok: true, data: { answer: "승인" } }),
    makeRoutes: () => ({ list: async () => [] }) });
  const charter = { question: "q", scope: "s", exclusions: "없음", environment: "로컬", sharedEnvironment: false, timebox: "10분", people: "없음", documents: "없음" };
  const begin = await call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter }, "s");
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const send = (cmd, args = {}) => call(cmd, args, "s", begin.data.runId);
  assert.equal((await send("open_entry", { url: "http://localhost:4321/start" })).ok, true);
  const declared = await send("row", { action: "declare", ...qaRowContract(), id: "save", what: "저장 결과 표시", given: "저장 화면을 연 사용자",
    basis: "spec", basisNote: "저장 후 결과 표시 명세", paths: ["정상"] });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const ended = await send("run_end", { session: { work: "w", curios: "없음", checked: "없음", unverified: { items: "없음", reason: "해당 없음" },
    blockers: "없음", outOfScope: "없음", risks: "없음", stopCriterion: "questions_answered", remainingQuestions: "없음" } });
  assert.equal(ended.ok, false);
  assert.match(ended.error, /미완료 확인 항목: save 정상/);
  assert.doesNotMatch(ended.error, /object Object/);
});

// 확대된 호스트: 페이지 배율 1(보정 뒤)·에뮬레이션 배율 1.44·CSS 화면 1179.36×800.64. 실측 결과 이미지 = clip × 에뮬레이션 배율 × scale
test("QA capture scales the clip by the host zoom and floors fractional CSS sizes", async () => {
  const { createQaCaptureCommands } = require("../native/electron/cdp-qa-capture.cjs");
  const calls = [];
  const send = async (method, args) => {
    calls.push([method, args]);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate") return { result: { value: { dpr: 1, masks: [] } } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1179.36, clientHeight: 800.64, pageY: 0 }, cssContentSize: { width: 1179.36, height: 900.5 } };
    if (method === "Page.captureScreenshot") {
      const clip = args.clip, emulated = 1/ZOOM;
      return { data: Buffer.from(JSON.stringify({ width: Math.round(clip.width*emulated*clip.scale), height: Math.round(clip.height*emulated*clip.scale) })).toString("base64") };
    }
    return {};
  };
  const commands = createQaCaptureCommands({ fs: { mkdirSync() {}, writeFileSync() {} }, path: require("node:path"), shotsDir: "/qa/shots",
    nativeImage: { createFromBuffer: (png) => ({ getSize: () => JSON.parse(png.toString()) }) }, captureHold: async () => true,
    renderImage: async (png) => png, observation: { observe: () => ({ console: [], network: [], moments: [], counts: {} }) } });
  const wc = { id: 3, getURL: () => "http://127.0.0.1:4398/", getTitle: () => "QA", getZoomFactor: () => ZOOM };
  const result = await commands["qa-screenshot"](send, wc, { stable: false });
  assert.equal(result.ok, true);
  const clip = calls.find(([method]) => method === "Page.captureScreenshot")[1].clip;
  assert.equal(clip.width, 1179);
  assert.equal(clip.height, 800);
  assert.ok(Math.abs(clip.scale - ZOOM) < 1e-9);
});

// 무인 실측 e2e3: 화면 설명을 surfaces 에 넣어 모든 판정이 보고서 검사 S2 에 걸림
test("web run_begin rejects descriptive surfaces and names the entry address to use", async () => {
  const { createQaChannel } = await import("../server/qa-channel.js");
  const { qaPlan } = await import("./qa-fixtures.mjs");
  const events = [];
  const append = async (_id, event) => { const record = { seq: events.length + 1, event }; events.push(record); return record; };
  const call = createQaChannel({ ledger: { begin: async ({ runId, session, plan, charter }) => append(runId, { kind: "run_begin", session, plan, charter }),
    verify: async () => ({ events, head: "h" }), end: async () => {}, append }, createEntry: async () => ({ ok: true, data: { tabId: "t" } }),
    execute: async () => ({ ok: true, data: { ok: true } }), release: async () => {}, ask: async () => ({ ok: true, data: { answer: "승인" } }), makeRoutes: () => ({ list: async () => [] }) });
  const charter = { question: "q", scope: "s", exclusions: "없음", environment: "로컬", sharedEnvironment: false, timebox: "10분", people: "없음", documents: "없음" };
  const entry = "http://127.0.0.1:4398/round8/";
  const rejected = await call("run_begin", { plan: qaPlan({ entries: [entry], surfaces: ["이름 저장 화면 /round8/"] }), charter }, "s");
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /surfaces에는 확인할 화면 주소의 앞부분/);
  assert.ok(rejected.error.includes(entry));
  assert.equal(events.length, 0);
  const accepted = await call("run_begin", { plan: qaPlan({ entries: [entry], surfaces: [entry, "http://127.0.0.1:4398/round8/summary/"] }), charter }, "s");
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});

test("summary names the report check that a run failed", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { createQaSummary } = await import("../server/qa-summary.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-regression10-"));
  try {
    const events = [{ seq: 1, event: { kind: "run_begin", session: "s", build: { repo: "/repo" }, charter: {} } }];
    const result = await createQaSummary({ verify: async () => ({ events }), paths: () => ({ folder: root }) }, ["run"]);
    assert.ok(result.summary.unverified.some(line => /보고 조건 미충족: \[session\]/.test(line)), JSON.stringify(result.summary.unverified));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 무인 실측 e2e3: 항목을 닫을 때 다시 쓰는 사진의 안정 측정이 빠져 보고서 방해 요인에 "측정 안 됨"이 쌓임
test("row close frame keeps the stability of the photo it reuses", async () => {
  const { createQaChannel } = await import("../server/qa-channel.js");
  const { qaPlan, qaRowContract } = await import("./qa-fixtures.mjs");
  const events = [];
  const append = async (_id, event) => { const record = { seq: events.length + 1, event: structuredClone(event) }; events.push(record); return record; };
  const stability = { waitedMs: 120, stable: true, remaining: [] };
  const call = createQaChannel({ ledger: { begin: async ({ runId, session, plan, charter }) => append(runId, { kind: "run_begin", session, plan, charter }),
    verify: async () => ({ events: structuredClone(events), head: "h" }), end: async () => {}, append },
    createEntry: async () => ({ ok: true, data: { tabId: "t" } }),
    execute: async () => ({ ok: true, data: { ok: true, pass: true, shot: "shots/assertion.png", path: "shots/capture.png", snapshot: "Save", stability,
      url: "http://localhost:4321/start", target: { role: "button", name: "Save" }, received: [{ type: "click", trusted: true }], trusted: true } }),
    release: async () => {}, ask: async () => ({ ok: true, data: { answer: "승인" } }), makeRoutes: () => ({ list: async () => [] }) });
  const charter = { question: "q", scope: "s", exclusions: "없음", environment: "로컬", sharedEnvironment: false, timebox: "10분", people: "없음", documents: "없음" };
  const begin = await call("run_begin", { plan: qaPlan({ entries: ["http://localhost:4321/start"] }), charter }, "s");
  const send = (cmd, args = {}) => call(cmd, args, "s", begin.data.runId);
  assert.equal((await send("open_entry", { url: "http://localhost:4321/start" })).ok, true);
  assert.equal((await send("row", { action: "declare", ...qaRowContract(), id: "save", what: "저장 결과 표시", given: "저장 화면을 연 사용자",
    basis: "spec", basisNote: "저장 후 결과 표시 명세", paths: ["정상"] })).ok, true);
  assert.equal((await send("row", { action: "open", row: "save", path: "정상" })).ok, true);
  assert.equal((await send("snapshot")).ok, true);
  const checked = await send("expect", { mode: "contains", text: "Saved" });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const closed = await send("row", { action: "close", row: "save", path: "정상", color: "green", note: "저장 결과 표시", sceneJudgment: "화면 전체 확인" });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const frame = events.findLast(r => r.event.kind === "frame" && r.event.claim?.kind === "S5");
  assert.ok(frame, "close frame");
  assert.deepEqual(frame.event.stability, stability);
});

// 무인 실측 e2e3: 재실행 거부 문구가 무엇이 빠졌는지 알려 주지 않아 세션이 여러 번 다시 시도함
test("retest rejection names the original row, failure and missing expectation", async () => {
  const { assertQaReplayContract } = await import("../server/qa-remediation.js");
  const header = { type: "change", sel: "#header", to: "저장 완료: 김하늘", oracle: "명세" };
  const keep = { type: "unchanged", role: "button", name: "저장", oracle: "명세", id: "unchanged-A3-1" };
  const events = [
    { seq: 1, event: { kind: "reaction", rowId: "A3", pass: false, expected: { effects: [header, keep] } } },
    { seq: 2, event: { kind: "defect", detail: { failureSeq: 1 } } },
  ];
  const steps = [{ target: { role: "button", name: "저장" }, action: "click", expect: { effects: [header] } }];
  assert.throws(() => assertQaReplayContract(events, "A3", steps, { fixSeq: 3, defect: 2 }),
    error => /원래 항목 A3의 실패 판정 1에서 빠진 기대값/.test(error.message) && error.message.includes('"type":"unchanged"') && !error.message.includes("unchanged-A3-1"));
  assert.doesNotThrow(() => assertQaReplayContract(events, "A3", [{ ...steps[0], expect: { effects: [header, { ...keep, id: "other" }] } }], { fixSeq: 3, defect: 2 }));
});

// 무인 실측 e2e4: 원래 실패 기대값에 도구가 더한 불변 조건(reason 포함)이 들어 있어 같은 단계로는 재실행이 거부됨
test("retest contract counts the invariants the tool adds and ignores their explanatory reason", async () => {
  const { assertQaReplayContract } = await import("../server/qa-remediation.js");
  const { unchangedExpectations } = await import("../server/qa-list-review.js");
  const row = { id: "A1", oracle: "명세나 대화에서 정한 내용", mustNotChange: [{ role: "textbox", name: "이름", reason: "저장해도 입력한 값은 그대로 남아야 함" }] };
  const header = { type: "change", sel: "#header", to: "저장 완료: 홍길동", oracle: "명세나 대화에서 정한 내용" };
  const events = [
    { seq: 1, event: { kind: "reaction", rowId: "A1", pass: false, expected: { effects: [header, ...unchangedExpectations(row)] } } },
    { seq: 2, event: { kind: "defect", detail: { failureSeq: 1 } } },
  ];
  const steps = [{ target: { role: "button", name: "저장" }, action: "click", expect: { effects: [header] } }];
  assert.throws(() => assertQaReplayContract(events, "A1", steps, { fixSeq: 3, defect: 2 }), /빠진 기대값/);
  assert.doesNotThrow(() => assertQaReplayContract(events, "A1", steps, { fixSeq: 3, defect: 2, addedEffects: unchangedExpectations(row) }));
  const copied = [{ ...steps[0], expect: { effects: [header, { type: "unchanged", role: "textbox", name: "이름", oracle: "명세나 대화에서 정한 내용" }] } }];
  assert.doesNotThrow(() => assertQaReplayContract(events, "A1", copied, { fixSeq: 3, defect: 2 }));
});

// 무인 실측 e2e4: "새 안내 문구 결정 필요"가 서술형으로 걸려 선택지 기록이 세 번 거부됨
test("label style check accepts nouns ending in 요 and still rejects polite endings", async () => {
  const { nominalFault } = await import("../server/qa-row-contract.js");
  for (const ok of ["새 안내 문구 결정 필요", "빈 값 저장 차단 / 안내 문구 내용 결정 필요", "보안상 중요", "변경 개요", "확인 불필요"]) assert.equal(nominalFault("선택지", ok), null, ok);
  for (const bad of ["결정이 필요해요", "제목이 바뀌지 않아요", "저장이 필요하다"]) assert.notEqual(nominalFault("선택지", bad), null, bad);
});

// 무인 실측 e2e4: 같은 주소로 다시 진입한 뒤 화면을 보지 않고 qa_click 해 보고서 검사 S0 에 걸림
test("single actions after a re-entry wait for qa_snapshot", async () => {
  const { createQaChannel } = await import("../server/qa-channel.js");
  const { qaPlan, qaRowContract, qaCharter } = await import("./qa-fixtures.mjs");
  const events = [];
  const append = async (_id, event) => { const r = { seq: events.length + 1, event: structuredClone(event) }; events.push(r); return r; };
  const ledger = { append, begin: args => append(args.runId, { kind: "run_begin", ...args }), verify: async () => ({ events: structuredClone(events), head: "h" }), end: async () => {} };
  const sent = [];
  const call = createQaChannel({ ledger, createEntry: async () => ({ ok: true, data: { tabId: "tab" } }), release: async () => {}, makeRoutes: () => ({ list: async () => [] }),
    ask: async () => ({ ok: true, data: { answer: "승인" } }),
    execute: async (_tab, cmd) => { sent.push(cmd); return { ok: true, data: { ok: true, pass: true, shot: "shots/a.png", path: "shots/a.png", snapshot: "저장", url: "http://localhost:4321/start",
      target: { role: "button", name: "저장" }, received: [{ type: "click", trusted: true }], trusted: true } }; } });
  const url = "http://localhost:4321/start";
  const begin = await call("run_begin", { plan: qaPlan({ entries: [url] }), charter: qaCharter() }, "owner");
  const send = (cmd, args = {}) => call(cmd, args, "owner", begin.data.runId);
  assert.equal((await send("open_entry", { url })).ok, true);
  assert.equal((await send("open_entry", { url })).ok, true);
  assert.equal((await send("row", { action: "declare", ...qaRowContract(), id: "r1", what: "저장 결과", given: "저장 화면", basis: "spec", basisNote: "저장 명세", paths: ["정상"] })).ok, true);
  assert.equal((await send("row", { action: "open", row: "r1", path: "정상" })).ok, true);
  const click = { x: 5, y: 5, expect: { effects: [{ type: "none", oracle: "기능의 용도" }] } };
  sent.length = 0;
  const blocked = await send("click", click);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /qa_snapshot/);
  assert.equal(sent.includes("qa-input"), false);
  assert.equal((await send("snapshot")).ok, true);
  assert.equal((await send("click", click)).ok, true);
  // 조작 뒤에도 화면을 본 다음 다음 조작(보고서 검사 L)
  const again = await send("click", click);
  assert.equal(again.ok, false);
  assert.match(again.error, /직전 조작 뒤/);
  assert.equal((await send("snapshot")).ok, true);
  assert.equal((await send("click", click)).ok, true);
});

// 무인 실측: 실행기가 회차마다 새 수정 worktree 를 만들어, 원격 없는 저장소는 반응 목록이 회차 사이에 이어지지 않음
test("reaction catalog identity is shared between a repository and its worktrees", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { appIdentity } = await import("../server/qa-catalog.js");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-regression10-catalog-"));
  try {
    const repo = path.join(root, "app"), tree = path.join(root, "fix-tree");
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(repo); git("init", "-q"); fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git("add", "a.txt"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    git("worktree", "add", "-q", "-b", "qa-fix/x", tree);
    assert.equal(appIdentity(tree), appIdentity(repo));
    assert.equal(appIdentity(repo), repo);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 무인 실측 e2e6: basisNote 없이 선언이 받아들여져 회차 끝 보고서 검사 basis 에서야 걸림
test("declare requires the basis note the report check needs", async () => {
  const { validateQaDeclaration } = await import("../server/qa-list-review.js");
  const { qaRowContract } = await import("./qa-fixtures.mjs");
  const { basisNote, ...withoutNote } = qaRowContract();
  assert.throws(() => validateQaDeclaration({ id: "A1", given: "저장 화면", ...withoutNote }), /declare\.basisNote/);
  assert.doesNotThrow(() => validateQaDeclaration({ id: "A1", given: "저장 화면", ...withoutNote, basisNote }));
});

// 무인 실측 e2e3·e2e4·e2e7: 입력할 칸을 mustNotChange 로 선언해 항목이 늘 실패하고, 선언을 고칠 수 없어 결함이 수정 확인으로 넘어가지 못함
test("qa_play rejects typing into a declared invariant before running, and the row can be redeclared until it runs", async () => {
  const { createQaChannel } = await import("../server/qa-channel.js");
  const { qaPlan, qaRowContract, qaCharter } = await import("./qa-fixtures.mjs");
  const events = [];
  const append = async (_id, event) => { const r = { seq: events.length + 1, event: structuredClone(event) }; events.push(r); return r; };
  const ledger = { append, begin: args => append(args.runId, { kind: "run_begin", ...args }), verify: async () => ({ events: structuredClone(events), head: "h" }), end: async () => {} };
  const sent = [];
  const call = createQaChannel({ ledger, createEntry: async () => ({ ok: true, data: { tabId: "tab" } }), release: async () => {}, makeRoutes: () => ({ list: async () => [] }),
    ask: async () => ({ ok: true, data: { answer: "승인" } }), execute: async (_tab, cmd) => { sent.push(cmd); return { ok: true, data: {} }; } });
  const url = "http://localhost:4321/start";
  const begin = await call("run_begin", { plan: qaPlan({ entries: [url] }), charter: qaCharter() }, "owner");
  const send = (cmd, args = {}) => call(cmd, args, "owner", begin.data.runId);
  await send("open_entry", { url });
  const base = { action: "declare", ...qaRowContract(), id: "A1", what: "이름 저장", given: "저장 화면", basis: "user", basisNote: "요청", paths: ["정상"] };
  assert.equal((await send("row", { ...base, mustNotChange: [{ role: "textbox", name: "이름", reason: "입력값 유지" }] })).ok, true);
  await send("row", { action: "open", row: "A1", path: "정상" });
  await send("list_review", { review: { information: [{ row: "A1", text: "이름 저장" }], duplicates: [], distribution: "저장", missingRisks: "없음" } });
  sent.length = 0;
  const steps = [{ target: { role: "textbox", name: "이름" }, action: "type", text: "홍길동", expect: { effects: [{ type: "change", role: "textbox", name: "이름", to: "홍길동", oracle: "기능의 용도" }] } }];
  const played = await send("play", { steps });
  assert.equal(played.ok, false);
  assert.match(played.error, /바뀌지 말아야 할 대상/);
  assert.equal(sent.includes("qa-input"), false);
  const redeclared = await send("row", { ...base, mustNotChange: [{ role: "button", name: "저장", reason: "버튼 유지" }] });
  assert.equal(redeclared.ok, true, redeclared.error);
});
