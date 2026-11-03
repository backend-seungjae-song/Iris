import { qaRevision, qaRevisionMatches } from "./qa-revision.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { artifactDir } from "./artifacts-home.cjs";

const SAFE_ACTIONS = new Set(["click", "dblclick", "hover", "type", "key", "scroll"]);
const OBSERVATIONS = new Set(["snapshot", "observe"]);
const PARAM = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;
const SENSITIVE = /password|passwd|secret|token|credential|payment|checkout|credit.?card|purchase|confirm|approve|otp|2fa|비밀번호|비밀|결제|구매|승인|인증|사람 확인/i;
const RECEIPT = { click: "click", dblclick: "dblclick", hover: "mousemove", type: "input", key: "keydown", scroll: "wheel" };
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message) => { throw new Error(message); };
const receiverOf = (received, cmd) => received?.findLast((r) => r.type === RECEIPT[cmd] && r.trusted === true);
const receiverMatches = (received, cmd, target) => {
  const receiver = receiverOf(received, cmd);
  return !!receiver && eq({ role: receiver.role, name: receiver.name }, target);
};

function inputOf(event) {
  const input = event.input;
  if (event.cmd === "type") {
    if (input?.kind !== "text" || typeof input.param !== "string" || !PARAM.test(input.param) || SENSITIVE.test(input.param))
      fail("문자열 입력 경로에는 비밀 값이 아닌 매개변수 이름이 필요합니다.");
    return { param: input.param };
  }
  if (event.cmd === "key") {
    if (input?.kind !== "key" || typeof input.key !== "string" || !input.key.trim() || SENSITIVE.test(input.key))
      fail("키 입력 경로에는 사용할 키가 필요합니다.");
    return { key: input.key };
  }
  if (event.cmd === "scroll") {
    if (input?.kind !== "scroll" || !Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY) || (!input.deltaX && !input.deltaY))
      fail("스크롤 경로에는 유효한 이동량이 필요합니다.");
    return { deltaX: input.deltaX, deltaY: input.deltaY };
  }
  if (input && input.kind !== "none") fail("이 조작에는 입력값을 저장할 수 없습니다.");
}

function replayParams(steps, params) {
  if (params === undefined) params = {};
  if (!params || typeof params !== "object" || Array.isArray(params)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(params))) fail("경로 매개변수는 객체여야 합니다.");
  const required = new Set(steps.filter((step) => step.cmd === "type").map((step) => step.input.param));
  for (const [name, value] of Object.entries(params)) {
    if (!PARAM.test(name) || !required.has(name) || SENSITIVE.test(name)
      || typeof value !== "string" || !value.trim() || SENSITIVE.test(value))
      fail("경로 매개변수에는 필요한 일반 문자열만 사용할 수 있습니다.");
  }
  for (const name of required) if (!Object.hasOwn(params, name)) fail("경로 재생에 필요한 매개변수가 없습니다.");
  return { ...params };
}

function derive(events, fromSeq, toSeq) {
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || fromSeq < 1 || toSeq < fromSeq)
    fail("경로 구간 순번이 잘못됐습니다.");
  const before = events.filter((r) => r.seq < fromSeq);
  const entry = before.findLast((r) => r.event.kind === "entry");
  if (!entry || !LOCAL.test(entry.event.url || "")) fail("로컬 화면에서 밟은 경로만 저장할 수 있습니다.");
  const selected = events.filter((r) => r.seq >= fromSeq && r.seq <= toSeq);
  const steps = [];
  const accepted = new Map();
  let pending;
  for (const record of selected) {
    const e = record.event;
    if (e.kind === "frame") {
      if (e.pass === false) fail("실패한 촬영이 든 경로는 저장할 수 없습니다.");
      continue;
    }
    if (e.kind === "accepted") {
      if (!SAFE_ACTIONS.has(e.cmd) && !OBSERVATIONS.has(e.cmd)) fail("이 경로에는 저장할 수 없는 조작이 섞여 있습니다.");
      accepted.set(record.seq, e.cmd);
      continue;
    }
    if (e.kind === "action" || e.kind === "observation") {
      if (accepted.has(e.acceptedSeq)) {
        if (accepted.get(e.acceptedSeq) !== e.cmd) fail("접수한 경로 조작과 실행 결과가 다릅니다.");
        accepted.delete(e.acceptedSeq);
      }
    }
    if (e.kind === "observation") {
      if (!OBSERVATIONS.has(e.cmd) || e.pass !== true) fail("경로 중간의 관찰이 실패했거나 저장할 수 없는 관찰입니다.");
      continue;
    }
    if (e.kind === "action") {
      if (pending) fail("각 조작 뒤에 도착 확인점이 필요합니다.");
      if (!SAFE_ACTIONS.has(e.cmd)) fail("이 조작은 저장할 수 없습니다.");
      if (e.pass !== true || !e.target?.role || !e.target?.name
        || !receiverMatches(e.received, e.cmd, e.target))
        fail("통과하고 실제 수신 대상이 일치한 조작만 저장할 수 있습니다.");
      if (SENSITIVE.test(`${e.target.role} ${e.target.name} ${e.cmd}`)) fail("비밀·결제·사람 확인 단계는 저장할 수 없습니다.");
      pending = { cmd: e.cmd, target: e.target, origin: new URL(entry.event.url).origin };
      const input = inputOf(e);
      if (input) pending.input = input;
      continue;
    }
    if (e.kind === "assertion") {
      if (!pending || e.pass !== true || !e.arrival?.mode || !e.arrival?.sel)
        fail("조작마다 통과한 도착 확인점이 필요합니다.");
      if (SENSITIVE.test(`${e.arrival.sel} ${e.arrival.text || ""}`)) fail("비밀·결제·사람 확인 단계는 저장할 수 없습니다.");
      pending.arrival = e.arrival;
      steps.push(pending);
      pending = null;
      continue;
    }
    fail("경로 구간에 준비·사람 확인·막힌 단계가 섞여 있습니다.");
  }
  if (pending || accepted.size || !steps.length) fail("통과한 조작과 도착 확인점이 없거나 실행하지 않은 단계가 있습니다.");
  return steps;
}

export function createQaRoutes({ ledger, executor, dir, revisionOf = qaRevision } = {}) {
  if (!ledger || typeof executor !== "function") fail("QA 장부와 경로 실행기가 필요합니다.");
  const root = dir || artifactDir("qa");
  const indexPath = path.join(root, "validated-routes.json");
  const currentRevisionMatches = saved => qaRevisionMatches(saved, revisionOf());
  const readIndex = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      return Array.isArray(parsed) ? parsed : fail("경로 목록 형식이 잘못됐습니다.");
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  };
  const writeIndex = (list) => {
    fs.mkdirSync(root, { recursive: true });
    const tmp = path.join(root, `validated-routes-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(tmp, indexPath);
  };
  const checked = async (record) => {
    const verified = await ledger.verify(record.sourceRunId);
    const saved = verified.events.find((e) => e.seq === record.savedSeq)?.event;
    if (!saved || saved.kind !== "route_saved" || saved.name !== record.name || saved.fromSeq !== record.fromSeq
      || saved.toSeq !== record.toSeq || saved.digest !== record.digest || (saved.revision || null) !== (record.revision || null))
      fail("저장 경로의 장부 근거가 맞지 않습니다.");
    const steps = derive(verified.events, record.fromSeq, record.toSeq);
    if (digest(steps) !== record.digest) fail("저장 경로가 장부에서 나온 단계와 다릅니다.");
    return steps;
  };
  const missesOf = async (record) => {
    const verified = await ledger.verify(record.sourceRunId);
    const attempts = verified.events.filter((r) => r.seq > record.savedSeq
      && r.event.kind === "route_replay" && r.event.route === record.name && currentRevisionMatches(r.event.revision)).map((r) => r.event.pass);
    let misses = 0;
    for (let i = attempts.length - 1; i >= 0 && attempts[i] !== true; i--) misses++;
    return Math.min(2, misses);
  };
  const save = async ({ runId, name, fromSeq, toSeq, target, revision, currentUrl } = {}) => {
    if (typeof name !== "string" || !name.trim() || name.length > 100 || SENSITIVE.test(name))
      fail("경로 이름이 잘못됐습니다.");
    if (!LOCAL.test(String(currentUrl || ""))) fail("현재 로컬 화면에서만 경로를 저장할 수 있습니다.");
    const verified = await ledger.verify(runId);
    const steps = derive(verified.events, fromSeq, toSeq);
    revision = revisionOf();
    const stepDigest = digest(steps);
    const marker = await ledger.append(runId, { kind: "route_saved", mode: "route_replay", name,
      fromSeq, toSeq, digest: stepDigest, revision });
    const record = { name, sourceRunId: runId, fromSeq, toSeq, savedSeq: marker.seq,
      digest: stepDigest, target: target || null, revision: revision || null, misses: 0, stale: false };
    const list = readIndex().filter((r) => r.name !== name);
    list.push(record);
    writeIndex(list);
    return { name, steps, sourceRunId: runId, target: record.target, revision: record.revision };
  };
  const list = async () => {
    const records = readIndex();
    const output = [];
    for (const { name, target, revision, ...record } of records) {
      try {
        const steps = await checked({ name, target, revision, ...record });
        const misses = await missesOf({ name, ...record });
        output.push({ name, target, revision, misses, stale: misses >= 2, revalidationRequired: !currentRevisionMatches((await ledger.verify(record.sourceRunId)).events.findLast(r=>r.event.kind === "route_replay" && r.event.route === name && r.event.pass)?.event.revision) && !currentRevisionMatches(revision),
          params: [...new Set(steps.filter((step) => step.cmd === "type").map((step) => step.input.param))] });
      } catch (error) { output.push({ name, stale: true, unavailable: true, reason: error.message }); }
    }
    return output;
  };
  const replay = async ({ runId, name, params } = {}) => {
    const records = readIndex();
    const record = records.find((r) => r.name === name);
    if (!record) fail("저장된 경로가 없습니다.");
    if (await missesOf(record) >= 2) return { ok: false, stale: true, error: "두 번 빗나간 경로입니다." };
    await ledger.verify(runId);
    const steps = await checked(record);
    const values = replayParams(steps, params);
    const revision = revisionOf();
    const revalidationRequired = !qaRevisionMatches(record.revision, revision);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let result;
      try { result = await executor({ runId, step, params: { ...values } }); }
      catch (error) {
        if (error.qaHumanResult) throw error;
        result = { ok: false, error: "경로 입력 실행에 실패했습니다." };
      }
      const pass = result?.ok === true && result.pass === true
        && receiverMatches(result.received, step.cmd, step.target)
        && eq(result.topTarget, step.target) && eq(result.arrival, step.arrival);
      const reason = pass ? undefined : "대상 또는 도착 화면이 저장 경로와 다릅니다.";
      await ledger.append(runId, { kind: "route_step", mode: "route_replay", route: name, cmd: step.cmd,
        target: step.target, topTarget: result?.topTarget, arrival: result?.arrival, pass,
        ...(step.input ? { input: { kind: step.cmd === "type" ? "text" : step.cmd,
          ...step.input, ...(step.cmd === "type" ? { length: values[step.input.param].length } : {}) } } : {}),
        reason });
      if (!pass) {
        await ledger.append(record.sourceRunId, { kind: "route_replay", mode: "route_replay", route: name, pass: false, revision });
        record.misses = await missesOf(record);
        record.stale = record.misses >= 2;
        writeIndex(records);
        return { ok: false, step: i + 1, stale: record.stale, error: "대상 또는 도착 화면 불일치" };
      }
    }
    await ledger.append(record.sourceRunId, { kind: "route_replay", mode: "route_replay", route: name, pass: true, revision });
    record.misses = 0;
    record.stale = false;
    writeIndex(records);
    return { ok: true, steps: steps.length, revalidated: revalidationRequired, revision };
  };
  return { save, list, replay };
}
