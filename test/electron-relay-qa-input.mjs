import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createElectronRelay } = require("../native/electron/relay/index.cjs");
const GENERATION = "boot:1";
const target = { wcId: 7, documentGeneration: 1, debuggerGeneration: 1 };
const ORIGIN = "https://example.test";
const idOf = (username) => crypto.createHash("sha256").update(ORIGIN + "\n" + username).digest("hex").slice(0, 24);
const PASSWORD = "qa-secret-pw";

function harness({ provider = null, url = `${ORIGIN}/login` } = {}) {
  const log = { provider: [], secrets: [], cdp: [], chars: [], focusReturns: 0, unsubscribed: 0 };
  const listeners = new Set();
  let currentUrl = url;
  const guest = {
    id: 7,
    hostWebContents: {},
    getType: () => "webview",
    isDestroyed: () => false,
    getURL: () => currentUrl,
    sendInputEvent: (event) => { log.chars.push(event); },
    debugger: { isAttached: () => true, sendCommand: async (method, params) => { log.cdp.push([method, params]); return {}; } },
  };
  const relay = createElectronRelay({
    webContents: { fromId: (id) => (Number(id) === 7 ? guest : null) },
    targetState: { generations: () => ({ documentGeneration: 1, debuggerGeneration: 1 }), ownsChildSession: () => false },
    currentUrl: () => currentUrl,
    pendingUrl: () => "",
    blockedUrl: () => false,
    redact: (_wcId, value) => value,
    rememberSecret: (wcId, secret, options) => { log.secrets.push([wcId, secret, options]); },
    observation: { subscribeEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); log.unsubscribed += 1; }; } },
    loginProvider: async (_wc, options) => {
      log.provider.push(options);
      return provider ? provider(options) : { origin: ORIGIN, accounts: [{ username: "u@example.test", password: PASSWORD, allowed: true }, { username: "locked@example.test", password: "other", allowed: false }],
        unavailable: [{ username: "gone@example.test", allowed: false }] };
    },
    focus: { state: async () => ({}), prepare: async () => "borrowed", return: async () => { log.focusReturns += 1; return "returned"; } },
    emitEvent: () => true,
    codedError: (code, message) => Object.assign(new Error(message), { code }),
  });
  let sequence = 0;
  const run = (commandId, command, args = {}) => relay.execute({ workerGeneration: GENERATION, commandId: `${GENERATION}/${commandId}`, callId: ++sequence, command, target, args });
  return { relay, run, log, listeners, setUrl: (value) => { currentUrl = value; } };
}

test("login.accounts(qa)는 옛 accountsFor 와 같은 id 를 주고 공개 필드만 돌려주며 비밀번호를 기억한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration(GENERATION);
  const out = await h.run("a", "login.accounts", { qa: true });
  assert.deepEqual(out, { origin: ORIGIN,
    accounts: [{ id: idOf("u@example.test"), username: "u@example.test", allowed: true, local: false }, { id: idOf("locked@example.test"), username: "locked@example.test", allowed: false, local: false }],
    unavailable: [{ id: idOf("gone@example.test"), username: "gone@example.test", allowed: false, local: false }] });
  assert.equal(JSON.stringify(out).includes(PASSWORD), false);
  assert.deepEqual(h.log.secrets.map((entry) => entry[1]), [PASSWORD, "other"]);
  assert.deepEqual(h.log.secrets[0][2], { allowShort: true });
  assert.deepEqual(h.log.provider, [{ qaAccounts: true, qaApproved: false }]);
  await h.run("b", "login.accounts", { qa: true, approved: true });
  assert.deepEqual(h.log.provider.at(-1), { qaAccounts: true, qaApproved: true });
});

test("login.accounts(qa)는 조회 실패와 출처 불일치를 옛 문구로 알린다", async () => {
  for (const [provider, message] of [[() => ({ error: "잠김" }), "로그인 계정 조회 실패"], [() => ({ origin: "https://other.test", accounts: [] }), "로그인 계정의 출처가 다릅니다"]]) {
    const h = harness({ provider });
    await h.relay.acceptGeneration(GENERATION);
    await assert.rejects(() => h.run("a", "login.accounts", { qa: true }), (error) => error.message === message);
  }
});

test("login.input(qa)는 값을 메인 안에서 넣고 길이만 돌려준다(cdp · chars)", async () => {
  const h = harness();
  await h.relay.acceptGeneration(GENERATION);
  await h.run("a", "login.accounts", { qa: true });
  const args = { accountId: idOf("u@example.test"), origin: ORIGIN, field: "password" };
  assert.deepEqual(await h.run("a", "login.input", { ...args, qa: "check" }), { ok: true, length: PASSWORD.length });
  assert.deepEqual(h.log.cdp, []);
  assert.deepEqual(await h.run("a", "login.input", { ...args, qa: "cdp" }), { ok: true, length: PASSWORD.length });
  assert.deepEqual(h.log.cdp, [["Input.insertText", { text: PASSWORD }]]);
  await h.run("c", "login.accounts", { qa: true });
  assert.deepEqual(await h.run("c", "login.input", { ...args, qa: "chars" }), { ok: true, length: PASSWORD.length });
  assert.equal(h.log.chars.map((event) => event.keyCode).join(""), PASSWORD);
  assert.equal(h.log.chars.every((event) => event.type === "char"), true);
  const username = await h.run("d", "login.input", { ...args, field: "username", qa: "check" });
  assert.equal(username.length, "u@example.test".length);
});

test("login.input(qa)는 옛 qa-login-input 과 같은 순서로 거절한다", async () => {
  const h = harness();
  await h.relay.acceptGeneration(GENERATION);
  const base = { accountId: idOf("u@example.test"), origin: ORIGIN, field: "password", qa: "cdp" };
  const reject = (args, message, commandId = "x") => assert.rejects(() => h.run(commandId, "login.input", args), (error) => error.message === message);
  await reject({ ...base, field: "otp" }, "로그인 필드가 올바르지 않습니다", "e1");
  await reject({ ...base, origin: "https://moved.test" }, "로그인 승인 후 출처가 바뀌었습니다", "e2");
  await reject({ ...base, accountId: "nope" }, "허용된 로그인 계정이 아닙니다", "e3");
  await reject({ ...base, accountId: idOf("locked@example.test") }, "허용된 로그인 계정이 아닙니다", "e4");
  await assert.rejects(() => h.run("e5", "login.input", { ...base, qa: "bogus" }), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => h.run("e5", "login.input", { ...base, extra: 1 }), (error) => error.code === "INVALID_REQUEST");
  assert.deepEqual(h.log.cdp, []);
  // 1회 승인은 목록 조회에도 입력에도 함께 적용
  const approved = await h.run("e6", "login.input", { ...base, accountId: idOf("locked@example.test"), approved: true });
  assert.equal(approved.length, "other".length);
  assert.deepEqual(h.log.provider.at(-1), { qaAccounts: true, qaApproved: true });
  // 입력 직전에 출처가 바뀌면 넣지 않음
  await h.run("e7", "login.accounts", { qa: true });
  h.setUrl("https://moved.test/");
  await assert.rejects(() => h.run("e7", "login.input", { ...base, qa: "cdp" }), (error) => error.message === "로그인 입력 전 출처가 바뀌었습니다");
  assert.equal(h.log.cdp.filter(([method]) => method === "Input.insertText").length, 1, "승인 입력 한 번뿐");
});

test("login.input(qa)는 입력값이 없으면 넣기 전에 실패한다", async () => {
  const h = harness({ provider: () => ({ origin: ORIGIN, accounts: [{ username: "u@example.test", password: "", allowed: true }] }) });
  await h.relay.acceptGeneration(GENERATION);
  await assert.rejects(() => h.run("a", "login.input", { accountId: idOf("u@example.test"), origin: ORIGIN, field: "password", qa: "check" }),
    (error) => error.message === "로그인 입력값이 없습니다");
  assert.deepEqual(h.log.cdp, []);
});

test("계정 목록은 명령 단위 안에서 한 번만 읽고 단위가 닫히면 버린다", async () => {
  const h = harness();
  await h.relay.acceptGeneration(GENERATION);
  const args = { accountId: idOf("u@example.test"), origin: ORIGIN, field: "password" };
  await h.run("unit", "login.accounts", { qa: true });
  await h.run("unit", "login.input", { ...args, qa: "check" });
  await h.run("unit", "login.input", { ...args, qa: "cdp" });
  assert.equal(h.log.provider.length, 1, "옛 처리기도 계정을 한 번만 읽음");
  // 입력을 마치면 캐시가 사라져 다음 입력은 다시 읽음
  await h.run("unit", "login.input", { ...args, qa: "check" });
  assert.equal(h.log.provider.length, 2);
  // 단위가 닫히면 남은 캐시도 버림
  await h.run("unit", "login.accounts", { qa: true });
  await h.relay.releaseCommand(GENERATION, `${GENERATION}/unit`);
  const before = h.log.provider.length;
  await h.run("unit", "login.input", { ...args, qa: "check" });
  assert.equal(h.log.provider.length, before + 1);
  // 다른 승인 상태의 캐시는 쓰지 않음
  await h.run("approved", "login.accounts", { qa: true, approved: false });
  await h.run("approved", "login.input", { ...args, qa: "check", approved: true });
  assert.deepEqual(h.log.provider.at(-1), { qaAccounts: true, qaApproved: true });
});

test("cdp.subscribe(scoped)는 단위가 닫힐 때 거두고 scoped 가 아니면 그대로 둔다", async () => {
  const h = harness();
  await h.relay.acceptGeneration(GENERATION);
  await h.run("unit", "cdp.subscribe", { subscriptionId: "scoped-1", methods: ["Runtime.bindingCalled"], scoped: true });
  await h.run("unit", "cdp.subscribe", { subscriptionId: "plain-1", methods: ["Runtime.bindingCalled"] });
  assert.equal(h.listeners.size, 2);
  await h.relay.releaseCommand(GENERATION, `${GENERATION}/unit`);
  assert.equal(h.listeners.size, 1);
  await assert.rejects(() => h.run("other", "cdp.unsubscribe", { subscriptionId: "scoped-1" }), (error) => error.code === "NOT_FOUND");
  await h.run("other", "cdp.unsubscribe", { subscriptionId: "plain-1" });
  assert.equal(h.listeners.size, 0);
  // 직접 풀면 단위가 다시 풀지 않음
  await h.run("unit2", "cdp.subscribe", { subscriptionId: "scoped-2", methods: [], scoped: true });
  await h.run("unit2", "cdp.unsubscribe", { subscriptionId: "scoped-2" });
  const unsubscribed = h.log.unsubscribed;
  await h.relay.releaseCommand(GENERATION, `${GENERATION}/unit2`);
  assert.equal(h.log.unsubscribed, unsubscribed);
});

test("단위가 닫힐 때 돌려주지 못한 사용자 포커스를 반환한다(빌렸다가 돌려준 경우는 두 번 반환하지 않는다)", async () => {
  const h = harness();
  await h.relay.acceptGeneration(GENERATION);
  assert.deepEqual(await h.run("lent", "focus.prepare"), { state: "borrowed" });
  await h.relay.releaseCommand(GENERATION, `${GENERATION}/lent`);
  assert.equal(h.log.focusReturns, 1);
  await h.run("paired", "focus.prepare");
  assert.deepEqual(await h.run("paired", "focus.return"), { state: "returned" });
  assert.equal(h.log.focusReturns, 2);
  await h.relay.releaseCommand(GENERATION, `${GENERATION}/paired`);
  assert.equal(h.log.focusReturns, 2, "이미 돌려준 포커스는 다시 반환하지 않음");
  // 다른 단위가 빌린 포커스는 건드리지 않음
  await h.run("a", "focus.prepare");
  await h.relay.releaseCommand(GENERATION, `${GENERATION}/b`);
  assert.equal(h.log.focusReturns, 2);
});
