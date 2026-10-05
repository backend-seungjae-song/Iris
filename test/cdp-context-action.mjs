import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { createContextActionCommand } = require("../native/electron/cdp-context-action.cjs");
const { createWebviewContextActions } = require("../native/electron/webview-context-actions.cjs");

function fixture() {
  const registry = createWebviewContextActions();
  class Host extends EventEmitter {
    constructor(id) { super(); this.id = id; this.scripts = []; }
    isDestroyed() { return false; }
    async executeJavaScript(code) { this.scripts.push(code); return { ok: true, code: "translated", detail: "ja" }; }
  }
  const owner = new Host(1), other = new Host(2);
  const guest = { id: 7, hostWebContents: owner, getType: () => "webview", isDestroyed: () => false,
    get debugger() { throw Error("must not attach CDP"); } };
  registry.register(owner, { name: "pagetranslate.page", label: "번역" });
  registry.register(other, { name: "other.action", label: "다른 창" });
  return { registry, owner, other, guest, command: createContextActionCommand(host => registry.get(host)) };
}

test("현재 guest의 호스트에 등록된 action만 고정 hook 호출로 실행한다", async () => {
  const f = fixture();
  assert.deepEqual(await f.command(f.guest, { name: "pagetranslate.page", expression: "arbitrary code", target: "ko" }), { ok: true, code: "translated", detail: "ja" });
  assert.equal(f.owner.scripts.length, 1); assert.equal(f.other.scripts.length, 0);
  const script = f.owner.scripts[0];
  assert.match(script, /import\('\/js\/core\/hooks\.js'\)/);
  assert.match(script, /hasHook\(name\)/);
  assert.match(script, /"guestWebContentsId":7/);
  assert.equal(script.includes("arbitrary code"), false);
  assert.equal(script.includes('"target"'), false, "언어 선택은 화면 controller가 소유한다");
});

test("등록되지 않은 action·다른 창의 action·잘못된 guest는 실행하지 않는다", async () => {
  const f = fixture(), unavailable = { ok: false, code: "unavailable" };
  for (const name of ["unknown.action", "other.action", "pagetranslate.page');evil()", null]) assert.deepEqual(await f.command(f.guest, { name }), unavailable);
  f.guest.hostWebContents = null;
  assert.deepEqual(await f.command(f.guest, { name: "pagetranslate.page" }), unavailable);
  f.guest.hostWebContents = f.owner; f.guest.getType = () => "window";
  assert.deepEqual(await f.command(f.guest, { name: "pagetranslate.page" }), unavailable);
  assert.equal(f.owner.scripts.length, 0); assert.equal(f.other.scripts.length, 0);
});

test("호스트 reload·없는 controller·호출 오류는 실패로 반환한다", async () => {
  const f = fixture(), unavailable = { ok: false, code: "unavailable" };
  f.owner.emit("did-start-loading");
  assert.deepEqual(await f.command(f.guest, { name: "pagetranslate.page" }), unavailable);
  f.registry.register(f.owner, { name: "pagetranslate.page", label: "번역" });
  for (const value of [undefined, {}, { ok: false, code: "unavailable" }]) {
    f.owner.executeJavaScript = async () => value;
    assert.deepEqual(await f.command(f.guest, { name: "pagetranslate.page" }), unavailable);
  }
  f.owner.executeJavaScript = async () => { throw Error("host gone"); };
  assert.deepEqual(await f.command(f.guest, { name: "pagetranslate.page" }), unavailable);
});

test("CDP dispatch는 contextaction을 디버거 연결과 session 변경 전에 처리한다", async () => {
  const source = readFileSync(new URL("../native/electron/cdp-control.cjs", import.meta.url), "utf8");
  const start = source.indexOf("async function cdpExecRaw(");
  const end = source.indexOf("\n// goto handler ", start);
  assert.ok(start >= 0 && end > start);
  const f = fixture();
  const context = vm.createContext({ contextActionCommand: f.command, ERROR_CODES: { TAB_GONE: "tab_gone" }, codedError: (_code, message) => Error(message), commandWebContentsMods: { set() { throw Error("must not enter CDP path"); } } });
  vm.runInContext(source.slice(start, end) + ";globalThis.dispatch=cdpExecRaw", context);
  assert.deepEqual(await context.dispatch({ fromId: id => id === 7 ? f.guest : null }, 7, "contextaction", { name: "pagetranslate.page" }), { ok: true, code: "translated", detail: "ja" });
});
