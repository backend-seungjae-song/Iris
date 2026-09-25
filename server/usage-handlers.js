// 사용량의 주기 수집·보관·중계를 맡는 단일 소유자.
//
// 소유 범위
//   마지막 스냅샷 하나, 표시 취향(사용/남음 · 상세/간결)과 쿠키 설정, 그것을 담는 파일
//   (stateHome()/usage.json), 그리고 언제 다시 물어볼지의 판단.
//   Codex·Claude 초기화권 사용 지시를 수집기로 전달하는 것도 여기서 맡는다.
//
// 제공 API
//   initUsageHandlers({ broadcastLocal }) · handleUsage(ws, msg) · usageWire().
//
// 의존 대상
//   server/usage.js 의 수집기와 state-home 의 stateHome() 만. 경로를 직접 조합하지 않는다.
//   한 파일이라도 경로를 직접 지정하면 개발 환경과 설치 앱의 분리가 전부 깨진다.
//
// 유지 조건
//   쿠키는 창으로 내보내지 않는다. 설정에 들어 있는지 여부(hasOpencodeCookie 같은 참·거짓)만
//   내보낸다. 이 메시지는 열려 있는 모든 창으로 가고 로그에도 남는다.
//   usage.* 는 로컬 연결에서만 받는다. 사용량은 계정 상태를 드러내므로 원격에서 접근할 대상이 아니다.
//   수집이 도는 동안 또 부르지 않는다. 창이 여럿이면 뜰 때마다 여덟 번씩 밖으로 나간다.
//   스냅샷은 파일에 남긴다. 앱을 켠 직후 상태바가 비어 있으면 기능이 없는 것처럼 보인다.
//
// 영향 범위
//   server/index.js 의 초기화·usage. 네임스페이스 분기·연결 시 첫 스냅샷 전송,
//   web/js/statusbar/usage.js 가 받는 usage.state·usage.prefs 계약.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs server/usage-handlers.js

import fs from "node:fs";
import path from "node:path";

import { stateHome } from "./state-home.cjs";
import { consumeClaudeReset, consumeCodexReset, fetchAllUsage } from "./usage.js";

// 5분. 집계 창(5시간·7일)에 비해 충분히 촘촘하고, 제공자 여덟 곳을 호출하기에는 충분히 길다.
const POLL_MS = 5 * 60 * 1000;
// 사람이 새로고침을 연타해도 밖으로는 이만큼 간격을 둔다.
const MIN_GAP_MS = 10 * 1000;

const DEFAULT_PREFS = {
  display: "used",      // used | remaining
  mode: "verbose",      // verbose | compact
  opencodeCookie: "",
  opencodeWorkspace: "",
  minimaxCookie: "",
  minimaxGroupId: "",
};

let broadcastLocal = () => {};
let prefs = { ...DEFAULT_PREFS };
let snapshot = { providers: [], updatedAt: 0 };
let fetching = false;
let lastFetchAt = 0;
let timer = null;
let filePath = null;

function fileOf() {
  if (!filePath) filePath = path.join(stateHome(), "usage.json");
  return filePath;
}

// 형식만 확인한다. 파일이 깨져 있어도 기본값으로 시작한다. 설정 하나 때문에 상태바가 사라지면 안 된다.
function normalizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (raw.display === "used" || raw.display === "remaining") out.display = raw.display;
  if (raw.mode === "verbose" || raw.mode === "compact") out.mode = raw.mode;
  for (const key of ["opencodeCookie", "opencodeWorkspace", "minimaxCookie", "minimaxGroupId"]) {
    if (typeof raw[key] === "string") out[key] = raw[key].slice(0, 4096);
  }
  return out;
}

function load() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(fileOf(), "utf8")); } catch { saved = null; }
  // 저장은 새 파일에만 권한을 붙이므로, 이전 버전이 0644 로 남긴 파일은 여는 자리에서 맞춘다.
  // 내용이 깨져 있어도 쿠키가 남아 있을 수 있으니 파싱과 무관하게 맞춘다.
  try { fs.chmodSync(fileOf(), 0o600); } catch (error) {
    if (error && error.code !== "ENOENT") console.warn(`[usage] ${fileOf()} 권한을 0600 으로 못 맞췄다: ${error.code || error.message}`);
  }
  prefs = normalizePrefs(saved && saved.prefs);
  const kept = saved && saved.snapshot;
  if (kept && Array.isArray(kept.providers) && typeof kept.updatedAt === "number") {
    snapshot = { providers: kept.providers, updatedAt: kept.updatedAt };
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(fileOf()), { recursive: true });
    const tmp = `${fileOf()}.${process.pid}.tmp`;
    // OpenCode·MiniMax 쿠키가 평문으로 들어가므로 소유자만 읽는다. 새 파일에 붙은 권한이 rename 을 따라간다.
    fs.writeFileSync(tmp, JSON.stringify({ prefs, snapshot }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, fileOf());
  } catch { /* 저장 실패가 앱을 멈추지는 않는다. 다음 회차에 다시 쓴다 */ }
}

// 쿠키는 여기서 걸러진다. 창에는 "들어 있는가"만 간다.
function prefsWire() {
  return {
    type: "usage.prefs",
    display: prefs.display,
    mode: prefs.mode,
    hasOpencodeCookie: !!prefs.opencodeCookie,
    hasOpencodeWorkspace: !!prefs.opencodeWorkspace,
    hasMinimaxCookie: !!prefs.minimaxCookie,
    hasMinimaxGroupId: !!prefs.minimaxGroupId,
  };
}

export function usageWire() {
  return { type: "usage.state", providers: snapshot.providers, updatedAt: snapshot.updatedAt, fetching };
}

// 한 회차가 실패해도 앞서 받은 값을 지우지 않는다. 지우면 429 하나에 표시가 전부 비어
// 기능이 동작하지 않는 것처럼 보인다. 대신 stale 로 표시해 언제 받은 값인지 함께 보낸다.
// 다만 "계정이 없다"는 대답은 값을 들고 있을 이유가 아니므로 그대로 덮는다.
const KEEP_STALE_KINDS = new Set(["rate-limited", "server", "network", "stale-token", "usage-unavailable"]);
const STALE_MAX_MS = 24 * 60 * 60 * 1000;

// 내보내는 이유: 이 판정은 429·연결 끊김처럼 재현하기 어려운 상황에서만 실행되어,
// 검사가 직접 호출하지 않으면 검증할 수 없다(test/usage-stale-carry.mjs).
export function carryStale(next, prev) {
  if (next.status === "ok") return next;
  if (!prev || !prev.session && !prev.weekly && !prev.monthly && !prev.buckets) return next;
  if (!KEEP_STALE_KINDS.has(next.failureKind)) return next;
  const dataAt = prev.dataAt || prev.updatedAt;
  if (typeof dataAt !== "number" || Date.now() - dataAt > STALE_MAX_MS) return next;
  return {
    ...prev, dataAt, stale: true,
    updatedAt: next.updatedAt, error: next.error, failureKind: next.failureKind,
    ...(next.retryAt ? { retryAt: next.retryAt } : {}),
  };
}

// 아직 쉬는 중인 제공자는 다음 회차에서 부르지 않는다.
function backoffMap() {
  const out = {};
  for (const one of snapshot.providers) {
    if (typeof one.retryAt === "number" && one.retryAt > Date.now()) out[one.provider] = one.retryAt;
  }
  return out;
}

// 수집 중에 들어온 강제 조회. 버리면 초기화권을 쓴 직후의 조회가 사용 전 응답에 묻혀, 차감 전
// 개수와 잠기지 않은 버튼이 다음 주기(5분)까지 남는다. 끝난 뒤 한 번 더 조회한다.
let refreshAgain = false;

async function refresh(force) {
  if (fetching) { if (force) refreshAgain = true; return; }
  if (!force && Date.now() - lastFetchAt < MIN_GAP_MS) return;
  fetching = true;
  broadcastLocal(usageWire());
  try {
    const before = new Map(snapshot.providers.map((one) => [one.provider, one]));
    const fetched = await fetchAllUsage(prefs, backoffMap());
    snapshot = { providers: fetched.map((one) => carryStale(one, before.get(one.provider))), updatedAt: Date.now() };
    save();
  } catch { /* 수집기가 실패해도 앞선 스냅샷은 남는다 */ }
  lastFetchAt = Date.now();
  fetching = false;
  broadcastLocal(usageWire());
  if (refreshAgain) { refreshAgain = false; refresh(true); }
}

export function initUsageHandlers(deps) {
  broadcastLocal = deps.broadcastLocal;
  load();
  // 시작 직후 한 번 실행하고 이후에는 주기로 실행한다. unref 로 두어 이 타이머가 서버 종료를 막지 않게 한다.
  refresh(true);
  clearInterval(timer);
  timer = setInterval(() => refresh(false), POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function usageOnConnect(ws) {
  ws.send(JSON.stringify(usageWire()));
  ws.send(JSON.stringify(prefsWire()));
}

export function handleUsage(ws, msg) {
  if (!ws._local) return;
  if (msg.type === "usage.get") { usageOnConnect(ws); return; }
  // 사용자가 눌러도 최소 간격은 지킨다. 창이 여럿이면 클릭 한 번이 여러 요청이 된다.
  if (msg.type === "usage.refresh") { refresh(false); return; }
  if (msg.type === "usage.prefs") {
    // 이 경로로는 표시 설정만 바꾼다. 비밀 값은 usage.secret 경로로만 들어온다.
    const next = { ...prefs };
    if (msg.display === "used" || msg.display === "remaining") next.display = msg.display;
    if (msg.mode === "verbose" || msg.mode === "compact") next.mode = msg.mode;
    if (next.display === prefs.display && next.mode === prefs.mode) return;
    prefs = next;
    save();
    broadcastLocal(prefsWire());
    return;
  }
  // 초기화권 사용. 이 기능에서 외부 상태를 바꾸는 유일한 경로라 세 가지로 제한한다.
  // 로컬 연결만 허용하고, 사용자가 화면에서 두 번 눌러야 하며, 같은 요청 id 는 제공자가 한 번만
  // 처리한다. 창이 여럿이면 같은 클릭이 여러 번 도착하고, id 가 다르면 초기화권이 여러 개 소모된다.
  if (msg.type === "usage.codexReset") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 100) : "";
    consumeCodexReset(requestId).then((result) => {
      try { ws.send(JSON.stringify({ type: "usage.codexReset", ok: !!result.ok, outcome: result.outcome })); } catch { /* 창이 닫혔다 */ }
      // 사용 직후의 값이 화면에 반영돼야 한다. 그렇지 않으면 눌러도 아무것도 바뀌지 않은 것으로 보인다.
      refresh(true);
    });
    return;
  }
  // Claude 초기화권. 제한은 Codex 와 같다. grant id 도 화면이 보낸 값을 그대로 쓴다. 다시 보낼 때
  // 서버가 grant 를 새로 고르면 같은 요청 id 가 다른 grant 로 나가 중복 차감을 막지 못할 수 있다.
  if (msg.type === "usage.claudeReset") {
    const grantId = typeof msg.grantId === "string" ? msg.grantId.slice(0, 100) : "";
    const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 100) : "";
    consumeClaudeReset(grantId, requestId).then((result) => {
      try { ws.send(JSON.stringify({ type: "usage.claudeReset", ok: !!result.ok, outcome: result.outcome })); } catch { /* 창이 닫혔다 */ }
      refresh(true);
    });
    return;
  }
  // 쿠키가 없으면 opencode Go 와 MiniMax 는 계속 "쿠키 필요" 상태로 남는다. 화면에서 설정할 수
  // 없으면 사용자가 파일을 직접 고쳐야 한다.
  // 들어오기만 하고 나가지 않는 단방향 경로다. 저장 뒤에도 밖으로는 값의 존재 여부만 나간다.
  if (msg.type === "usage.secret") {
    const field = String(msg.field || "");
    if (!["opencodeCookie", "opencodeWorkspace", "minimaxCookie", "minimaxGroupId"].includes(field)) return;
    if (typeof msg.value !== "string") return;
    const value = msg.value.slice(0, 4096);
    if (prefs[field] === value) return;
    prefs = { ...prefs, [field]: value };
    save();
    broadcastLocal(prefsWire());
    // 방금 넣은 값이 먹히는지 사람이 바로 봐야 한다.
    refresh(true);
  }
}
