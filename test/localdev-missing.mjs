import assert from "node:assert/strict";
import { test } from "node:test";

// localdev 는 Iris 와 함께 배포되지 않는 별도 도구. 없는 Mac 에서 로컬 데브 화면이 없는 명령
// (sudo localdev setup)을 안내하지 않고, 설치 안 됨과 끄는 곳을 안내해야 한다.
const { handleLocaldev } = await import("../server/localdev-bridge.js");

function statusWith(fetchError) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw fetchError; };
  return new Promise((resolve) => {
    const ws = { _local: true, readyState: 1, send: (raw) => resolve(JSON.parse(raw)) };
    handleLocaldev(ws, { type: "localdev.status", id: "s1" });
  }).finally(() => { globalThis.fetch = realFetch; });
}
const netError = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

test("localdev.test 이름이 안 풀리면 설치 안 됨(missing)으로 알린다", async () => {
  const m = await statusWith(netError("ENOTFOUND"));
  assert.equal(m.ok, false);
  assert.equal(m.reason, "missing");
});

test("라우터가 내려가 있으면 그대로 연결 실패(unreachable)다", async () => {
  const m = await statusWith(netError("ECONNREFUSED"));
  assert.equal(m.reason, "unreachable");
});

test("설치 안 됨 화면은 끄는 곳을 안내하고 setup 명령을 안내하지 않는다", async () => {
  const { initCapability } = await import("../web/js/devtool/localdev.js");
  let html = "";
  const err = { hidden: true, get innerHTML() { return html; }, set innerHTML(v) { html = v; },
    get firstChild() { return html ? {} : null; }, addEventListener() {} };
  const el = () => ({ hidden: false, textContent: "", innerHTML: "", addEventListener() {} });
  const nodes = { "#ld-body": el(), "#ld-err": err, "#ld-sys": el(), "#ld-upd": el(), "#ld-reload": el(), "#ld-open": el() };
  const sent = [];
  const cap = initCapability({ $: (q) => nodes[q] || null, esc: (s) => s, wsSend: (m) => sent.push(m) });
  cap.screen.enter();
  cap.ws["localdev.status"]({ type: "localdev.status", ok: false, reason: "missing", id: sent.at(-1).id });
  cap.screen.leave?.();
  assert.equal(err.hidden, false);
  assert.match(html, /설정되어 있지 않습니다/);
  assert.match(html, /편의 기능/);
  assert.doesNotMatch(html, /sudo localdev setup/);
});
