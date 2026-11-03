import { assertQaRemediationComplete } from "./qa-remediation.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateQaCharter, validateQaSession, validateQaStoredSession } from "./qa-session-contract.js";
import { artifactDir } from "./artifacts-home.cjs";
import { captureQaBuild } from "./qa-build.js";

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (message) => { throw new Error(message); };
const safeText = (value, max = 500) => typeof value === "string" ? value.slice(0, max) : undefined;
const pair = (value) => value && typeof value === "object"
  ? { role: safeText(value.role, 80), name: safeText(value.name, 200) } : undefined;
const receivers = (value) => Array.isArray(value) ? value.slice(0, 100).map((item) => ({
  type: safeText(item?.type, 40), trusted: item?.trusted === true,
  role: safeText(item?.role, 80), name: safeText(item?.name, 200),
})) : undefined;
const arrival = (value) => value && typeof value === "object"
  ? { mode: safeText(value.mode, 40), sel: safeText(value.sel, 300), text: safeText(value.text, 500),
    label: safeText(value.label, 300), type: safeText(value.type, 80) } : undefined;

function sanitize(event) {
  if (!event || typeof event !== "object") fail("QA 기록이 없습니다.");
  const kind = safeText(event.kind, 40);
  if (!new Set(["run_begin", "run_end", "entry", "accepted", "action", "assertion", "row", "observation", "blocked", "route_step", "route_saved", "route_replay", "frame", "diff", "defect", "fix", "session_note", "charter_change", "failure", "reaction", "unexpected", "unexpected_undo", "unexpected_defect", "catalog_begin", "catalog_update", "background_reaction", "unknown_occlusion", "list_review", "play_step", "play_failure", "obstacle_action", "obstacle_seen", "play_result", "human_review", "retest_required", "start_approval", "run_key"]).has(kind))
    fail("허용되지 않은 QA 기록 종류입니다.");
  const out = { kind, mode: ["agent_action", "route_replay", "preparation"].includes(event.mode) ? event.mode : "preparation" };
  for (const key of ["cmd", "action", "rowId", "name", "url", "reason", "session", "tab", "route", "acceptedSeq", "fromSeq", "toSeq", "digest", "revision", "path", "surface", "phase", "observed"])
    if (event[key] != null) out[key] = ["acceptedSeq", "fromSeq", "toSeq"].includes(key)
      ? Number(event[key]) : safeText(String(event[key]), key === "url" ? 1000 : 500);
  for (const key of ["pass", "trusted"])
    if (own(event, key)) out[key] = event[key] === true;
  // 판정이 아닌 반응(전달 안 된 입력, 다시 누를 첫 클릭)은 pass 없음. false 로 바꾸면 제품 실패로 읽힘
  if (event.pass === null) out.pass = null;
  if (event.tries != null) out.tries = Math.max(1, Math.min(100, Number(event.tries) || 1));
  if (Number.isSafeInteger(event.sameSceneSeq)) out.sameSceneSeq = event.sameSceneSeq;
  if (Number.isFinite(event.capturedAt)) out.capturedAt = Number(event.capturedAt);
  for (const key of ["target", "selected", "topTarget"]) if (event[key]) out[key] = pair(event[key]);
  if (event.received) out.received = receivers(event.received);
  if (event.scrollNote) out.scrollNote = safeText(String(event.scrollNote), 1000);
  if (event.input) out.input = {
    kind: safeText(event.input.kind, 40),
    ...(typeof event.input.delivered === "boolean" ? {delivered:event.input.delivered}:{}),
    ...(event.input.length != null ? { length: Math.max(0, Math.min(1000000, Number(event.input.length) || 0)) } : {}),
    ...(event.input.param ? { param: safeText(event.input.param, 100) } : {}),
    ...(event.input.key ? {key:safeText(event.input.key,80)} : {}),
    ...(event.input.valueOmitted ? { valueOmitted: safeText(event.input.valueOmitted, 100) } : {}),
    ...Object.fromEntries(["x", "y", "toX", "toY", "x1", "y1", "x2", "y2", "duration", "keycode"]
      .filter(key => Number.isFinite(event.input[key])).map(key => [key, event.input[key]])),
    ...(Number.isFinite(event.input.deltaX) ? {deltaX:event.input.deltaX} : {}),
    ...(Number.isFinite(event.input.deltaY) ? {deltaY:event.input.deltaY} : {}),
  };
  if (event.expected) {
    out.expected = event.expected.effects ? structuredClone(event.expected) : arrival(event.expected);
    out.expectedDigest = hash(JSON.stringify(event.expected.effects ? event.expected : ["mode", "sel", "text", "label", "type"].map(key => event.expected[key])));
  }
  if (event.arrival) out.arrival = arrival(event.arrival);
  if (event.plan) out.plan = {
    ...(event.plan.risks ? {risks:structuredClone(event.plan.risks),listRationale:event.plan.listRationale} : {}),
    ...(event.plan.preconditions ? {preconditions:structuredClone(event.plan.preconditions)} : {}),
    ...(event.plan.name ? {name:safeText(event.plan.name,1000)} : {}),
    surfaces: Array.isArray(event.plan.surfaces) ? event.plan.surfaces.map(x => safeText(String(x),1000)) : event.plan.entries,
    entries: Array.isArray(event.plan.entries) ? event.plan.entries.map((x) => safeText(String(x), 1000)) : [],
    ...(event.plan.build ? { build: { repo: safeText(event.plan.build.repo, 4000),
      ...(Array.isArray(event.plan.build.related) ? { related: event.plan.build.related.slice(0, 8).map(dir => safeText(String(dir), 4000)) } : {}) } } : {}),
  };
  if (event.build) out.build = { repo: safeText(event.build.repo, 4000), head: safeText(event.build.head, 64),
    branch: event.build.branch === null ? null : safeText(event.build.branch, 300), dirty: event.build.dirty === true, at: event.build.at,
    ...(Array.isArray(event.build.related) ? { related: event.build.related.slice(0, 8).map(item => ({ repo: safeText(item?.repo, 4000), head: safeText(item?.head, 64),
      branch: item?.branch == null ? null : safeText(item.branch, 300), dirty: item?.dirty === true })) } : {}) };
  if (event.stability) out.stability = { waitedMs: Math.max(0, Number(event.stability.waitedMs) || 0),
    stable: event.stability.stable === true, remaining: JSON.parse(JSON.stringify(event.stability.remaining ?? [])) };
  if (event.charter) out.charter = validateQaCharter(event.charter);
  if (event.sessionRecord) out.sessionRecord = validateQaStoredSession(event.sessionRecord);
  if (event.rowData) out.rowData = structuredClone(event.rowData);
  if (event.lanes) out.lanes = structuredClone(event.lanes);
  for(const key of ["caption","moment"]) if(event[key]) out[key] = safeText(String(event[key]),4000);
  for(const key of ["marks","detail","viewport","device","captureTarget","claim"]) if(event[key]) out[key] = JSON.parse(JSON.stringify(event[key]));
  if (event.shot) out.shotSource = String(event.shot);
  return out;
}

function summarize(events) {
  const rows = new Map(), receipts = [];
  for (const rec of events) {
    const e = rec.event;
    if (e.kind === "row" && e.action === "begin") {
      if (rows.has(e.rowId)) { rows.get(e.rowId).ended = false; continue; }
      rows.set(e.rowId, { id: e.rowId, name: e.name || e.rowId, status: "gray", assertions: 0, blocked: false,
        ended: false, failedAction: false, accepted: 0, completed: 0 });
    }
    if (e.kind === "row" && e.action === "end" && rows.has(e.rowId)) rows.get(e.rowId).ended = true;
    if (e.kind === "blocked" && rows.has(e.rowId)) rows.get(e.rowId).blocked = true;
    if (e.kind === "accepted" && rows.has(e.rowId)) rows.get(e.rowId).accepted++;
    if (["action", "observation"].includes(e.kind) && rows.has(e.rowId)) {
      if (e.acceptedSeq) rows.get(e.rowId).completed++;
      if (e.kind === "action" && e.pass !== true) rows.get(e.rowId).failedAction = true;
    }
    if (e.kind === "assertion") {
      const receipt = { seq: rec.seq, rowId: e.rowId, pass: e.pass === true, tries: e.tries || 1,
        expected: e.expected, shot: e.shot, shotHash: e.shotHash };
      receipts.push(receipt);
      if (rows.has(e.rowId)) rows.get(e.rowId).assertions++;
    }
  }
  for (const row of rows.values()) {
    const ownReceipts = receipts.filter((r) => r.rowId === row.id);
    if (!row.ended || row.blocked || !ownReceipts.length || row.accepted > row.completed) row.status = "gray";
    else if (!ownReceipts.at(-1).pass) row.status = "red";
    else if (row.failedAction || ownReceipts.some((r) => !r.pass || r.tries > 1)) row.status = "flaky";
    else row.status = "green";
  }
  const list = [...rows.values()];
  return { rows: list, receipts, summary: {
    total: list.length,
    green: list.filter((r) => r.status === "green").length,
    flaky: list.filter((r) => r.status === "flaky").length,
    red: list.filter((r) => r.status === "red").length,
    gray: list.filter((r) => r.status === "gray").length,
  } };
}

export function createQaLedger({ anchor, dir, activity } = {}) {
  if (typeof anchor !== "function") fail("QA 메인 프로세스 앵커가 필요합니다.");
  const root = dir || artifactDir("qa");
  const queues = new Map();
  // 이 프로세스가 머리 해시 확인 없이 남긴 줄. 늦게 도착한 갱신이 있을 수 있어 같은 프로세스에서는 분리하지 않음
  const unsettled = new Set();
  const serial = (id, fn) => {
    const invoke = () => activity
      ? activity.run("journalWrites", `${id}:${crypto.randomUUID()}`, fn, { detail: { runId: id } })
      : fn();
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(invoke);
    queues.set(id, next);
    return next.finally(() => { if (queues.get(id) === next) queues.delete(id); });
  };
  const paths = (runId) => {
    if (!RUN_ID.test(String(runId || ""))) fail("QA 회차 ID가 잘못됐습니다.");
    const folder = path.join(root, runId);
    return { folder, journal: path.join(folder, "journal.jsonl"), report: path.join(folder, "report.json") };
  };
  const anchorData = async (request) => {
    let response = await anchor(request);
    // "실행기 없음"은 요청을 보내지 못한 경우라 다시 보내도 두 번 적용되지 않음. 메인 프로세스가 끊고 다시 붙는 1~5초 동안 대기
    for (let wait = 0; response?.error === "실행기 없음" && wait < 8; wait++) {
      await new Promise(resolve => setTimeout(resolve, 750));
      response = await anchor(request);
    }
    if (!response?.ok) fail(response?.error || "QA 메인 프로세스 앵커가 응답하지 않았습니다.");
    const data = response.data?.data || response.data;
    if (!data || !HASH.test(String(data.hash || "")) || !Number.isSafeInteger(data.seq))
      fail("QA 메인 프로세스 머리 해시가 잘못됐습니다.");
    return data;
  };
  // 회차별 확인 완료 위치. 줄 추가·명령마다 journal 58MB 파싱과 사진 945MB 해시를 반복해 서버 RSS 가 1.5GB 까지 커진 사례
  // 같은 파일 뒤에 붙은 줄만 확인. 이미 확인한 줄·사진의 변조는 첫 확인·회차 종료·보고서의 전체 확인(full)에서 검출
  const checked = new Map();
  // retain:false·photos:false 는 다른 회차의 통계용 읽기. 사진 해시와 줄 보관 없이 장부 사슬·머리 해시만 확인
  // 회차 시작마다 모든 회차(244개, 사진 5GB)를 전체 확인하고 줄을 서버가 끝날 때까지 보관해 설치본 서버가 600MB 를 넘은 사례
  const verify = async (runId, { full = false, retain = true, photos = true } = {}) => {
    const options = { retain, photos };
    const base = full ? null : checked.get(runId);
    if (!base) return verifyFrom(runId, null, options);
    // 이어서 확인하다 실패하면 처음부터 다시 확인. 앞부분을 고쳐 길이가 바뀐 기록도 전체 확인과 같은 오류로 거부
    try { return await verifyFrom(runId, base, options); } catch { return verifyFrom(runId, null, options); }
  };
  const verifyFrom = async (runId, base, { retain = true, photos = true } = {}) => {
    const { folder, journal } = paths(runId);
    const anchorHead = await anchorData({ op: "read", runId });
    let stat;
    try { stat = fs.statSync(journal); } catch { fail("QA 장부 파일이 없습니다."); }
    // 다른 파일·줄어든 파일·크기 그대로 다시 쓴 파일은 처음부터 확인
    if (base && (base.ino !== stat.ino || stat.size < base.size || (stat.size === base.size && stat.mtimeMs !== base.mtimeMs))) base = null;
    let raw;
    try { raw = readTail(journal, base ? base.size : 0, stat.size); } catch { fail("QA 장부 파일이 없습니다."); }
    if (raw && !raw.endsWith("\n")) fail("QA 장부 마지막 줄이 잘렸습니다.");
    let head = base ? base.head : hash(`iris-qa/v1:${runId}`), seq = base ? base.seq : 0;
    const events = base ? base.events.slice() : [];
    // 20ms 마다 이벤트 루프에 양보. 사진 900MB 회차를 한 번에 확인하면 서버가 25초 넘게 멈춰
    // 메인 프로세스가 앵커 연결을 끊고, 요약에서 그 뒤 회차가 "실행기 없음"으로 빠진 사례(qa-92771d8c)
    let slice = performance.now();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      if (performance.now() - slice > 20) { await new Promise(resolve => setImmediate(resolve)); slice = performance.now(); }
      let rec;
      try { rec = JSON.parse(line); } catch { fail("QA 장부 줄을 읽지 못했습니다."); }
      if (rec.seq !== seq + 1 || rec.prevHash !== head || !rec.event || typeof rec.event !== "object")
        fail("QA 장부 순번 또는 이전 해시가 변조됐습니다.");
      const expected = hash(JSON.stringify({ seq: rec.seq, prevHash: rec.prevHash, event: rec.event }));
      if (rec.hash !== expected) fail("QA 장부 해시가 변조됐습니다.");
      if (rec.event.shot && photos) {
        const shot = path.resolve(folder, rec.event.shot);
        if (!shot.startsWith(path.join(folder, "shots") + path.sep)) fail("QA 사진 경로가 잘못됐습니다.");
        let bytes;
        try { bytes = fs.readFileSync(shot); } catch { fail("QA 사진이 없습니다."); }
        if (hash(bytes) !== rec.event.shotHash) fail("QA 사진 해시가 변조됐습니다.");
        if (rec.event.shotSeq != null) {
          const first = rec.event.shotSeq === rec.seq ? rec : events.find(item => item.seq === rec.event.shotSeq);
          if (!first || rec.event.shotHash !== first.event.shotHash || rec.event.shot !== first.event.shot) fail("QA 사진 최초 순번이 다릅니다.");
        }
      }
      head = rec.hash; seq = rec.seq; events.push(rec);
    }
    if (anchorHead.hash !== head || anchorHead.seq !== seq) fail("QA 머리 해시가 장부와 다릅니다.");
    if (!retain) return { runId, head, seq, events };
    checked.set(runId, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, head, seq, events });
    return { runId, head, seq, events: events.slice() };
  };
  const appendUnqueued = async (runId, event) => {
    const before = await verify(runId);
    const { folder, journal } = paths(runId);
    const clean = {...sanitize(event), at:Date.now()};
    if (clean.shotSource) {
      const source = clean.shotSource;
      delete clean.shotSource;
      const bytes = fs.readFileSync(source);
      fs.mkdirSync(path.join(folder, "shots"), { recursive: true });
      clean.shotHash = hash(bytes);
      clean.shotSeq = before.seq + 1;
      clean.shot = path.join("shots", `${before.seq + 1}-${crypto.randomUUID()}.png`);
      fs.writeFileSync(path.join(folder, clean.shot), bytes, { flag: "wx" });
    }
    const seq = before.seq + 1;
    const rec = { seq, prevHash: before.head, event: clean };
    rec.hash = hash(JSON.stringify(rec));
    const size = fs.statSync(journal).size;
    fs.appendFileSync(journal, JSON.stringify(rec) + "\n");
    // 머리 해시 갱신 실패 시 방금 쓴 줄·사진 되돌림. 앱 종료 중 메인 프로세스가 응답하지 않아 장부만 한 줄 앞선 채 회차 재개가 막힌 사례
    try {
      const advanced = await anchorData({ op: "advance", runId, previousHash: before.head, hash: rec.hash, seq });
      if (!same(advanced, { hash: rec.hash, seq })) fail("QA 메인 프로세스가 새 머리 해시를 확인하지 않았습니다.");
    } catch (error) {
      // 되돌림은 앵커가 이전 머리 그대로임을 읽어서 확인했을 때만. 다시 읽지 못하면 늦게 도착한 갱신으로 앵커만 앞설 수 있어 줄 유지
      const current = await anchorData({ op: "read", runId }).catch(() => null);
      if (current && same(current, { hash: rec.hash, seq })) return { runId, head: rec.hash, seq, event: clean };
      if (current && same(current, { hash: before.head, seq: before.seq })) {
        try { fs.truncateSync(journal, size); if (clean.shot) fs.rmSync(path.join(folder, clean.shot), { force: true }); } catch {}
      } else unsettled.add(`${runId}:${seq}`);
      throw error;
    }
    return { runId, head: rec.hash, seq, event: clean };
  };
  const append = (runId, event) => serial(runId, () => appendUnqueued(runId, event));
  const begin = async ({ runId, session, tab, plan, charter } = {}) => serial(runId, async () => {
    charter = validateQaCharter(charter);
    const build = captureQaBuild(plan?.build);
    const { folder, journal } = paths(runId);
    fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(folder)) fail("이미 장부가 있는 QA 회차입니다.");
    const head = hash(`iris-qa/v1:${runId}`);
    await anchorData({ op: "begin", runId, hash: head, seq: 0 });
    fs.mkdirSync(folder);
    fs.writeFileSync(journal, "", { flag: "wx" });
    const first = await appendUnqueued(runId, { kind: "run_begin", mode: "preparation", session, tab, plan, charter, build });
    return { runId, head: first.head, seq: first.seq, path: journal };
  });
  // 앞선 서버 프로세스가 머리 해시를 갱신하지 못하고 남긴 마지막 한 줄을 journal.unanchored.jsonl 로 옮김. 앱 종료 중 창 연결이 먼저 끊긴 사례
  // 정확히 한 줄 앞서고 해시가 앵커 머리에 이어질 때만. 그 밖의 불일치는 verify 가 변조로 거부
  const recoverUnanchored = (runId) => serial(runId, async () => {
    const { folder, journal } = paths(runId);
    const anchorHead = await anchorData({ op: "read", runId });
    // 회차 시작 줄은 분리하지 않음. 분리하면 회차 자체가 사라짐
    if (anchorHead.seq < 1) return null;
    let buf;
    try { buf = fs.readFileSync(journal); } catch { return null; }
    if (!buf.length || buf[buf.length - 1] !== 10) return null;
    // 자를 위치는 바이트로 계산. 문자열 길이는 깨진 바이트가 섞이면 실제 파일 크기와 달라짐
    const cut = buf.lastIndexOf(10, buf.length - 2) + 1;
    const line = buf.subarray(cut, buf.length - 1).toString("utf8");
    let last;
    try { last = JSON.parse(line); } catch { return null; }
    if (!last?.event || last.seq !== anchorHead.seq + 1 || last.prevHash !== anchorHead.hash || unsettled.has(`${runId}:${last.seq}`)) return null;
    if (last.hash !== hash(JSON.stringify({ seq: last.seq, prevHash: last.prevHash, event: last.event }))) return null;
    const side = path.join(folder, "journal.unanchored.jsonl");
    const sideSize = fs.existsSync(side) ? fs.statSync(side).size : 0;
    if (fs.statSync(journal).size !== buf.length) return null;
    fs.appendFileSync(side, line + "\n");
    fs.truncateSync(journal, cut);
    const unanchored = { seq: last.seq, hash: last.hash, file: "journal.unanchored.jsonl" };
    // 분리 사실은 같은 직렬 처리 안에서 바로 기록. 기록하지 못하면 옮긴 줄을 되돌림
    try {
      await appendUnqueued(runId, { kind: "observation", mode: "preparation", cmd: "ledger_recovery", pass: true,
        detail: { unanchored, reason: "앞선 서버 프로세스가 머리 해시를 갱신하지 못하고 남긴 마지막 줄을 분리함" } });
    } catch (error) {
      if (fs.statSync(journal).size === cut) { fs.appendFileSync(journal, line + "\n"); fs.truncateSync(side, sideSize); }
      throw error;
    }
    return unanchored;
  });
  const end = (runId, { session } = {}) => serial(runId, async () => {
    const input = validateQaSession(session);
    const verified = await verify(runId, { full: true });
    assertQaRemediationComplete(verified.events);
    const build = captureQaBuild(verified.events.find(r => r.event.kind === "run_begin")?.event.plan?.build);
    const defects = verified.events.filter(r => r.event.kind === "defect").map(r => `${r.seq}. ${r.event.detail.problem}`);
    return appendUnqueued(runId, { kind: "run_end", mode: "preparation", build, sessionRecord: { ...input, defects: defects.join("\n") || "없음" } });
  });
  const report = async (runId) => {
    const verified = await verify(runId, { full: true });
    const { report: reportPath } = paths(runId);
    const derived = summarize(verified.events);
    const output = { runId, head: verified.head, events: verified.events.map((r) => ({ seq: r.seq, ...r.event })),
      ...derived, path: reportPath };
    fs.writeFileSync(reportPath, JSON.stringify(output, null, 2) + "\n");
    return output;
  };
  // 실행기 보고서에 넣을 회차를 서버가 찾음: 그 세션이 그 저장소로 since 이후에 연 회차 전부
  const runIds = ({ session, repo, since = 0 } = {}) => {
    let names = [];
    try { names = fs.readdirSync(root).filter((name) => RUN_ID.test(name)); } catch { return []; }
    const real = (value) => { const full = path.resolve(String(value || "")); try { return fs.realpathSync(full); } catch { return full; } };
    const target = real(repo);
    return names.filter((name) => {
      const { journal } = paths(name);
      try {
        if (fs.statSync(journal).mtimeMs < since) return false;
        const first = JSON.parse(firstLine(journal)).event;
        return first?.kind === "run_begin" && first.session === session && real(first.plan?.build?.repo) === target;
      } catch { return false; }
    });
  };
  // 장부 앞 몇 줄만 확인 없이 읽음. 회차 시작 정보로 다른 회차를 고를 때 장부 전체(가장 큰 것 369MB)를 읽지 않기 위함
  const head = (runId, count = 1) => {
    const { journal } = paths(runId);
    const fd = fs.openSync(journal, "r"), chunk = Buffer.alloc(65536), parts = [];
    try {
      let position = 0, text = "";
      while ((text.match(/\n/g) || []).length < count) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, position);
        if (!read) break;
        parts.push(Buffer.from(chunk.subarray(0, read))); position += read;
        text = Buffer.concat(parts).toString("utf8");
      }
      return text.split("\n").slice(0, count).filter(Boolean).map(line => JSON.parse(line));
    } finally { fs.closeSync(fd); }
  };
  return { begin, append, verify, end, report, paths, runIds, recoverUnanchored, head };
}

// start 부터 end 바이트까지의 글자
function readTail(file, start, end) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (!n) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function firstLine(file) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [], buf = Buffer.alloc(65536);
    for (let pos = 0; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) { chunks.push(Buffer.from(buf.subarray(0, nl))); break; }
      chunks.push(Buffer.from(buf.subarray(0, n))); pos += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { fs.closeSync(fd); }
}
