import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createGoogleAuthRules, staticRules, leaveRule, CHANNEL, WORKER } = require("../native/electron/google-auth-rules.cjs");
const { attachGoogleAuthUserAgent, googleAuthUserAgent, sendDeviceUserAgentOverride } = require("../native/electron/google-auth-user-agent.cjs");

const BASE_UA = "Mozilla/5.0 Iris/0.1 Chrome/140.0.0.0 Electron/43.2.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36";
const firefox = googleAuthUserAgent();

// 이 규칙들이 쓰는 declarativeNetRequest 조건·modifyHeaders 만 Chrome 규칙대로 평가(우선순위 높은 set 이 이김)
const hostOf = (raw) => { try { return new URL(raw).hostname; } catch { return ""; } };
const inDomains = (host, domains) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
function matches({ condition }, request) {
  const host = hostOf(request.url);
  if (condition.urlFilter === "|https://" && !request.url.startsWith("https://")) return false;
  if (condition.requestDomains && !inDomains(host, condition.requestDomains)) return false;
  if (condition.excludedRequestDomains && inDomains(host, condition.excludedRequestDomains)) return false;
  if (condition.initiatorDomains && !(request.initiator && inDomains(hostOf(request.initiator), condition.initiatorDomains))) return false;
  if (condition.resourceTypes && !condition.resourceTypes.includes(request.type)) return false;
  if (condition.excludedResourceTypes?.includes(request.type)) return false;
  if (condition.tabIds && !condition.tabIds.includes(request.tabId)) return false;
  return true;
}
function apply(rules, request, headers) {
  const result = { ...headers };
  const touched = new Set();
  for (const rule of rules.filter((candidate) => matches(candidate, request)).sort((a, b) => b.priority - a.priority)) {
    for (const { header, operation, value } of rule.action.requestHeaders) {
      if (touched.has(header)) continue;
      touched.add(header);
      const keys = Object.keys(result).filter((key) => key.toLowerCase() === header);
      for (const key of keys) delete result[key];
      if (operation === "set") result[keys[0] || header] = value;
    }
  }
  return result;
}

class FakeWebContents extends EventEmitter {
  constructor(id, session) {
    super();
    this.id = id; this.url = "https://example.com/"; this.session = session;
    this.debugger = Object.assign(new EventEmitter(), { sent: [], isAttached: () => true, attach() {}, sendCommand: async (method, params) => { this.debugger.sent.push({ method, params }); } });
  }
  getURL() { return this.url; }
  getUserAgent() { return BASE_UA; }
  isDestroyed() { return false; }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "iris-auth-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sent = [];
  const loaded = [];
  const session = {
    getUserAgent: () => BASE_UA, preload: [],
    registerPreloadScript: (script) => session.preload.push(script),
    extensions: { getAllExtensions: () => loaded, loadExtension: async (directory) => {
      const extension = { id: "g".repeat(32), path: directory }; loaded.push(extension);
      setImmediate(() => session.serviceWorkers.emit("registration-completed", {}, { scope: `chrome-extension://${extension.id}/` }));
      return extension;
    } },
    serviceWorkers: Object.assign(new EventEmitter(), { startWorkerForScope: async (scope) => ({ send: (channel, rules) => sent.push({ scope, channel, rules }) }) }),
  };
  const rules = createGoogleAuthRules({ stateHomeImpl: () => root, error: () => {} });
  t.after(() => rules.dispose());
  return { root, rules, session, sent };
}

test("인증 호스트 문서 요청은 첫 요청부터 Firefox 이고 중복 UA 키를 통일하며 sec-ch-ua 힌트를 모두 지움", () => {
  const headers = { "user-agent": "old-a", "USER-AGENT": "old-b", "Sec-CH-UA": "brands", "sec-ch-ua-platform": '"macOS"', "Sec-CH-UA-Arch": "arm", Accept: "text/html" };
  const result = apply(staticRules(), { url: "https://accounts.google.com/", type: "main_frame", tabId: 99 }, headers);
  assert.equal(Object.keys(result).filter((key) => key.toLowerCase() === "user-agent").map((key) => result[key]).join(), firefox);
  assert.equal(Object.keys(result).some((key) => key.toLowerCase().startsWith("sec-ch-ua")), false);
  assert.equal(result.Accept, "text/html");
  assert.deepEqual(apply(staticRules(), { url: "http://accounts.google.com/", type: "main_frame" }, { "User-Agent": BASE_UA }), { "User-Agent": BASE_UA });
});

test("일반 문서가 부르는 인증 호스트 iframe·XHR 와 일반 이동은 엔진 정체 그대로", () => {
  for (const type of ["sub_frame", "xmlhttprequest", "script"]) {
    const headers = { "User-Agent": BASE_UA, "sec-ch-ua": "stock" };
    assert.deepEqual(apply(staticRules(), { url: "https://accounts.google.com/embedded", type, initiator: "https://example.com" }, headers), headers);
  }
  const ordinary = { "User-Agent": BASE_UA, "sec-ch-ua": "stock" };
  assert.deepEqual(apply(staticRules(), { url: "https://example.com/", type: "main_frame" }, ordinary), ordinary);
});

test("인증 문서가 보내는 외부·하위 프레임 요청도 Firefox 이고 힌트 없음", () => {
  for (const [url, type] of [["https://www.gstatic.com/auth.js", "script"], ["https://accounts.youtube.com/CheckConnection", "sub_frame"], ["https://play.google.com/log", "ping"]]) {
    assert.deepEqual(apply(staticRules(), { url, type, initiator: "https://accounts.google.com" }, { "User-Agent": BASE_UA, "Sec-CH-UA-Mobile": "?0", Accept: "*/*" }),
      { "User-Agent": firefox, Accept: "*/*" });
  }
});

test("Firefox 정체 탭이 인증 밖으로 가는 첫 문서 요청은 그 탭의 원래 UA, 장치 미리보기면 장치 UA", async (t) => {
  const f = fixture(t);
  await f.rules.load(f.session);
  const wc = new FakeWebContents(5, f.session);
  attachGoogleAuthUserAgent(wc);
  wc.emit("did-start-navigation", {}, "https://accounts.google.com/", false, true);
  await flush();
  assert.equal(f.sent.at(-1).channel, CHANNEL);
  assert.equal(f.sent.at(-1).scope, `chrome-extension://${"g".repeat(32)}/`);
  const rules = () => [...staticRules(), ...f.sent.at(-1).rules];
  assert.deepEqual(apply(rules(), { url: "https://example.com/return", type: "main_frame", tabId: 5 }, { "User-Agent": firefox }), { "User-Agent": BASE_UA });
  assert.deepEqual(apply(rules(), { url: "https://example.com/return", type: "main_frame", tabId: 6 }, { "User-Agent": BASE_UA }), { "User-Agent": BASE_UA });
  assert.equal(apply(rules(), { url: "https://accounts.google.com/next", type: "main_frame", tabId: 5 }, { "User-Agent": firefox })["User-Agent"], firefox);
  await sendDeviceUserAgentOverride(wc, wc.debugger.sendCommand.bind(wc.debugger), { userAgent: MOBILE_UA });
  await flush();
  assert.deepEqual(apply(rules(), { url: "https://example.com/return", type: "main_frame", tabId: 5 }, { "user-agent": firefox, "USER-AGENT": "duplicate" }), { "user-agent": MOBILE_UA });
  // 인증 밖으로 정체가 돌아가면 그 탭 규칙 제거
  wc.emit("did-start-navigation", {}, "https://example.com/return", false, true);
  await flush();
  assert.deepEqual(f.sent.at(-1).rules, []);
});

test("내부 확장 파일을 한 번 쓰고 세션마다 한 번 올림", async (t) => {
  const f = fixture(t);
  await Promise.all([f.rules.load(f.session), f.rules.load(f.session)]);
  await f.rules.load(f.session);
  assert.equal(f.session.extensions.getAllExtensions().length, 1);
  assert.equal(f.session.preload.length, 1);
  const directory = f.rules.directory;
  assert.equal(directory, path.join(f.root, "browser-extensions", "internal", "google-auth"));
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.background.service_worker, WORKER);
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "rules.json"), "utf8")), staticRules());
  assert.equal(leaveRule(7, BASE_UA).condition.tabIds[0], 7);
  // 확장을 올릴 수 없는 세션은 파일도 쓰지 않음
  const other = createGoogleAuthRules({ stateHomeImpl: () => path.join(f.root, "none"), error: () => {} });
  t.after(() => other.dispose());
  await other.load({ getUserAgent: () => BASE_UA });
  assert.throws(() => readFileSync(path.join(f.root, "none", "browser-extensions", "internal", "google-auth", "manifest.json")));
});

test("내부 확장 워커는 올릴 때 한 번 깨워 작업 하나로 계속 살려 두고, 같은 버전이면 작업을 더 만들지 않음", async (t) => {
  const f = fixture(t);
  const tasks = [];
  let version = 1;
  f.session.serviceWorkers.startWorkerForScope = async (scope) => ({
    versionId: version, isDestroyed: () => false,
    startTask: () => { const task = { version, ended: false, end() { task.ended = true; } }; tasks.push(task); return task; },
    send: (channel, rules) => f.sent.push({ scope, channel, rules }),
  });
  await f.rules.load(f.session);
  await flush();
  assert.deepEqual(tasks.map((task) => task.version), [1]);
  const wc = new FakeWebContents(9, f.session);
  attachGoogleAuthUserAgent(wc);
  wc.emit("did-start-navigation", {}, "https://accounts.google.com/", false, true);
  await flush(); await flush();
  assert.equal(tasks.length, 1);
  // 렌더러가 죽어 새 버전 워커가 뜨면 새 작업으로 다시 붙잡음
  version = 2;
  wc.emit("did-start-navigation", {}, "https://example.com/", false, true);
  await flush(); await flush();
  assert.deepEqual(tasks.map((task) => [task.version, task.ended]), [[1, false], [2, false]]);
});

test("처음 설치하는 워커는 등록 완료 뒤에 깨우고, 응답 없는 시작 요청은 상한 뒤 넘겨 다음 규칙 전달을 막지 않음", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "iris-auth-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const sent = [];
  let hang = true;
  const loaded = [];
  const session = {
    getUserAgent: () => BASE_UA, registerPreloadScript() {},
    extensions: { getAllExtensions: () => loaded, loadExtension: async (directory) => { const extension = { id: "h".repeat(32), path: directory }; loaded.push(extension); return extension; } },
    serviceWorkers: Object.assign(new EventEmitter(), {
      startWorkerForScope: (scope) => { calls.push(scope); return hang ? new Promise(() => {}) : Promise.resolve({ versionId: 1, startTask: () => ({ end() {} }), send: (channel, rules) => sent.push(rules) }); },
    }),
  };
  const errors = [];
  const rules = createGoogleAuthRules({ stateHomeImpl: () => root, error: (...args) => errors.push(args.join(" ")), setTimer: (fn, ms) => setTimeout(fn, ms / 500) });
  t.after(() => rules.dispose());
  await rules.load(session);
  await flush();
  assert.equal(calls.length, 0);
  session.serviceWorkers.emit("registration-completed", {}, { scope: `chrome-extension://${"h".repeat(32)}/` });
  await flush();
  assert.equal(calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(errors.join(), /워커 시작 응답 없음/);
  hang = false;
  const wc = new FakeWebContents(3, session);
  attachGoogleAuthUserAgent(wc);
  wc.emit("did-start-navigation", {}, "https://accounts.google.com/", false, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
});
