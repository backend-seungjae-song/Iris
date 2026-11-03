// Google 인증 요청 헤더 규칙. 세션에 session.webRequest 리스너가 하나라도 있으면 Electron 이 확장 요청 처리
// (declarativeNetRequest·확장 webRequest)를 통째로 건너뜀. 그래서 헤더 변경은 Iris 내부 확장의 규칙으로 처리
const fs = require("node:fs");
const path = require("node:path");
const { stateHome } = require("../../server/state-home.cjs");
const { GOOGLE_AUTH_HOSTS, googleAuthUserAgent, onIdentityChange } = require("./google-auth-user-agent.cjs");

const CLIENT_HINTS = ["sec-ch-ua", "sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-form-factors", "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list", "sec-ch-ua-mobile", "sec-ch-ua-model", "sec-ch-ua-platform", "sec-ch-ua-platform-version", "sec-ch-ua-wow64"];
const WORKER = "iris-google-auth.js";
const CHANNEL = "iris-google-auth-rules";
// 탭별 이탈 규칙 id. 정적 규칙(1·2)과 겹치지 않는 범위
const LEAVE_RULE_BASE = 1000;

function firefoxHeaders() {
  return [{ header: "user-agent", operation: "set", value: googleAuthUserAgent() }, ...CLIENT_HINTS.map((header) => ({ header, operation: "remove" }))];
}

// 인증 호스트로 가는 문서 요청은 첫 요청부터 Firefox. 인증 문서가 보내는 하위 요청도 같은 정체
function staticRules() {
  return [
    { id: 1, priority: 1, action: { type: "modifyHeaders", requestHeaders: firefoxHeaders() },
      condition: { urlFilter: "|https://", requestDomains: [...GOOGLE_AUTH_HOSTS], resourceTypes: ["main_frame"] } },
    { id: 2, priority: 1, action: { type: "modifyHeaders", requestHeaders: firefoxHeaders() },
      condition: { initiatorDomains: [...GOOGLE_AUTH_HOSTS], excludedResourceTypes: ["main_frame"] } },
  ];
}

// Firefox 정체인 탭이 인증 밖으로 가는 첫 문서 요청. CDP 정체 전환보다 요청이 먼저 나가므로 그 탭의 원래 UA(장치 미리보기면 장치 UA)로
function leaveRule(tabId, userAgent) {
  return { id: LEAVE_RULE_BASE + tabId, priority: 2, action: { type: "modifyHeaders", requestHeaders: [{ header: "user-agent", operation: "set", value: userAgent }] },
    condition: { tabIds: [tabId], resourceTypes: ["main_frame"], excludedRequestDomains: [...GOOGLE_AUTH_HOSTS] } };
}

const WORKER_SOURCE = `let queue = Promise.resolve();
globalThis.__irisGoogleAuthRules?.listen((rules) => {
  queue = queue.then(async () => {
    const current = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: current.map((rule) => rule.id), addRules: rules });
  }).catch((error) => console.error("Iris Google 인증 규칙:", error));
});
`;

function extensionFiles() {
  return {
    "manifest.json": JSON.stringify({
      manifest_version: 3, name: "Iris Google 로그인 호환", version: "1.0.0",
      background: { service_worker: WORKER },
      permissions: ["declarativeNetRequest"], host_permissions: ["<all_urls>"],
      declarative_net_request: { rule_resources: [{ id: "google_auth", enabled: true, path: "rules.json" }] },
    }, null, 2),
    "rules.json": JSON.stringify(staticRules(), null, 2),
    [WORKER]: WORKER_SOURCE,
  };
}

let written = null;
function writeExtension(directory) {
  if (written === directory) return directory;
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(extensionFiles())) {
    const file = path.join(directory, name);
    let current = null;
    try { current = fs.readFileSync(file, "utf8"); } catch {}
    if (current === content) continue;
    const temporary = `${file}.${process.pid}.tmp`;
    try { fs.writeFileSync(temporary, content); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  written = directory;
  return directory;
}

// 처음 설치 중인 워커에 시작을 요청하면 Electron 43.7 이 답하지 않음(실측 55초 무응답). 등록 완료를 기다린 뒤 요청하고,
// 이미 등록된 확장은 완료 이벤트가 없으므로 대기 상한 뒤 진행. 시작 요청에도 상한을 둬 규칙 전달 줄이 막히지 않게 함
const REGISTRATION_WAIT_MS = 5000;
const START_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, message, setTimer) {
  return new Promise((resolve, reject) => {
    const timer = setTimer(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (failure) => { clearTimeout(timer); reject(failure); });
  });
}

function createGoogleAuthRules({ stateHomeImpl = stateHome, error = console.error, setTimer = setTimeout } = {}) {
  const directory = path.join(stateHomeImpl(), "browser-extensions", "internal", "google-auth");
  const sessions = new Map();

  // 워커를 멈추지 않게 붙잡음. 쉬다 멈춘 워커를 규칙 전달 때 다시 띄우는 순간 Electron 43.7 메인 프로세스가
  // "Unsuitable process reused for site"(render_process_host_impl.cc) 로 죽었음
  function keepAlive(state, worker) {
    if (state.kept && state.kept.versionId === worker.versionId && !worker.isDestroyed?.()) return worker;
    state.kept = { versionId: worker.versionId, task: worker.startTask?.() || null };
    return worker;
  }

  function startWorker(state) {
    const scope = `chrome-extension://${state.extension.id}/`;
    return withTimeout(state.session.serviceWorkers.startWorkerForScope(scope), START_TIMEOUT_MS, `워커 시작 응답 없음: ${scope}`, setTimer)
      .then((worker) => keepAlive(state, worker));
  }

  // 등록 완료 또는 대기 상한 중 먼저 오는 것
  function registration(session) {
    return new Promise((resolve) => {
      const events = session.serviceWorkers;
      const done = () => { clearTimeout(timer); events.removeListener?.("registration-completed", onDone); resolve(); };
      const onDone = (_event, details) => { if (String(details?.scope || "").startsWith("chrome-extension://")) done(); };
      const timer = setTimer(done, REGISTRATION_WAIT_MS);
      events.on?.("registration-completed", onDone);
    });
  }

  function sendRules(state) {
    if (!state.extension) return;
    const rules = [...state.leave.values()];
    state.sending = state.sending.then(() => startWorker(state))
      .then((worker) => worker.send(CHANNEL, rules))
      .catch((failure) => error("[google-auth-rules]", String(failure?.message || failure)));
  }

  const stopIdentity = onIdentityChange((wc, identity) => {
    let state;
    try { state = sessions.get(wc.session); } catch { return; }
    if (!state) return;
    const before = JSON.stringify(state.leave.get(wc.id) || null);
    if (identity?.firefox && identity.base) state.leave.set(wc.id, leaveRule(wc.id, identity.base));
    else state.leave.delete(wc.id);
    if (JSON.stringify(state.leave.get(wc.id) || null) !== before) sendRules(state);
  });

  function load(session) {
    if (typeof session?.extensions?.loadExtension !== "function") return Promise.resolve();
    if (sessions.has(session)) return sessions.get(session).ready;
    const state = { session, extension: null, leave: new Map(), sending: Promise.resolve(), ready: null, kept: null };
    sessions.set(session, state);
    state.ready = (async () => {
      writeExtension(directory);
      session.registerPreloadScript({ type: "service-worker", filePath: path.join(__dirname, "google-auth-worker-preload.cjs") });
      const existing = session.extensions.getAllExtensions().find((item) => path.resolve(item.path) === path.resolve(directory));
      const registered = existing ? null : registration(session);
      state.extension = existing || await session.extensions.loadExtension(directory);
      if (registered) state.sending = state.sending.then(() => registered);
      if (state.leave.size) sendRules(state);
      else state.sending = state.sending.then(() => startWorker(state))
        .catch((failure) => error("[google-auth-rules]", String(failure?.message || failure)));
    })().catch((failure) => { error("[google-auth-rules]", String(failure?.message || failure)); });
    return state.ready;
  }

  return { load, dispose: stopIdentity, directory };
}

let shared = null;
function googleAuthRules() { return (shared ||= createGoogleAuthRules()); }

module.exports = { createGoogleAuthRules, googleAuthRules, staticRules, leaveRule, CLIENT_HINTS, CHANNEL, WORKER };
