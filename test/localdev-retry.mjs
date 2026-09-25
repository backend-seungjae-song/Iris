import assert from "node:assert/strict";
import { test, mock } from "node:test";

// 로컬 데브 연결 실패 화면의 "다시 연결". 상태 응답은 요청 id 를 돌려주므로, 이전 요청의 타이머나
// 응답(시간 초과 뒤 늦게 온 것 포함)이 새 요청을 끝내 버튼을 먼저 되살리면 안 된다.
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
const { initCapability } = await import("../web/js/devtool/localdev.js");

const el = (extra = {}) => ({ hidden: false, textContent: "", innerHTML: "", ...extra });
const retryText = { textContent: "" };
const retryBtn = {
  attrs: {},
  setAttribute(k, v) { this.attrs[k] = v; },
  getAttribute(k) { return this.attrs[k] ?? null; },
  querySelector: (q) => (q === ".ld-retry-t" ? retryText : null),
  closest(q) { return q === "#ld-retry" ? retryBtn : null; },
};
let errHtml = "", errWrites = 0, errClick = null;
const err = {
  hidden: true,
  get innerHTML() { return errHtml; },
  set innerHTML(v) { errHtml = v; errWrites++; retryText.textContent = /다시 연결/.test(v) ? "다시 연결" : ""; },
  get firstChild() { return errHtml ? {} : null; },
  addEventListener(_t, fn) { errClick = fn; },
};
const nodes = {
  "#ld-body": el({ addEventListener() {} }), "#ld-err": err, "#ld-sys": el(), "#ld-upd": el(),
  "#ld-reload": el(), "#ld-open": el(),
};
const sent = [];
const cap = initCapability({
  $: (q) => (q === "#ld-retry" ? (/id="ld-retry"/.test(errHtml) ? retryBtn : null) : nodes[q] || null),
  esc: (s) => s, wsSend: (m) => sent.push(m),
});
const onStatusMsg = cap.ws["localdev.status"];
const FAIL = { type: "localdev.status", ok: false, reason: "unreachable" };
const OK = { type: "localdev.status", ok: true, data: { updated: "t", routes: [], projects: [], system: {} } };
// 서버처럼 요청 id 를 돌려준다. 기본은 마지막에 보낸 요청의 응답이다.
const onStatus = (msg, req = sent.at(-1)) => onStatusMsg({ ...msg, id: req.id });
const busyNow = () => retryBtn.attrs["aria-disabled"] === "true";
const clickRetry = () => errClick({ target: retryBtn });

test("실패 화면에서 다시 연결을 누르면 연결 중으로 바뀌고 실패 응답에 버튼이 돌아온다", () => {
  cap.screen.enter();
  assert.equal(sent.length, 1);
  onStatus(FAIL);
  assert.equal(err.hidden, false);
  assert.equal(busyNow(), false);
  assert.equal(retryText.textContent, "다시 연결");
  clickRetry();
  assert.equal(sent.length, 2);
  assert.equal(busyNow(), true);
  assert.equal(retryText.textContent, "연결 중…");
  onStatus(FAIL);
  assert.equal(busyNow(), false);
  assert.equal(retryText.textContent, "다시 연결");
});

test("같은 실패가 되풀이되면 본문을 다시 쓰지 않는다(버튼 포커스 유지)", () => {
  const before = errWrites;
  mock.timers.tick(3000); onStatus(FAIL);
  mock.timers.tick(3000); onStatus(FAIL);
  assert.equal(errWrites, before);
});

test("응답이 오지 않으면 시간 초과로 버튼이 돌아온다", () => {
  clickRetry();
  assert.equal(busyNow(), true);
  mock.timers.tick(5999);
  assert.equal(busyNow(), true);
  mock.timers.tick(1);
  assert.equal(busyNow(), false);
});

test("누르기 전에 보낸 요청의 늦은 실패 응답은 새 요청을 끝내지 않는다", () => {
  mock.timers.tick(3000);              // 주기 조회가 하나 나가 응답을 기다린다
  const n0 = sent.length;
  const periodic = sent.at(-1);
  clickRetry();                        // 그 사이에 다시 연결
  assert.equal(sent.length, n0 + 1);
  onStatus(FAIL, periodic);            // 앞선 주기 조회의 응답
  assert.equal(busyNow(), true, "이전 요청의 응답이 다시 연결을 끝냈다");
  onStatus(FAIL);                      // 다시 연결의 응답
  assert.equal(busyNow(), false);
});

test("이전 요청의 타이머는 새 요청을 끝내지 않는다", () => {
  mock.timers.tick(3000);              // 주기 조회 A
  const a = sent.at(-1);
  mock.timers.tick(1000);
  clickRetry();                        // A 가 끝나기 전에 다시 연결 B
  onStatus(FAIL, a);                   // A 의 응답
  assert.equal(busyNow(), true);
  mock.timers.tick(5000);              // A 를 보낸 지 6초가 지난다(B 는 5초)
  assert.equal(busyNow(), true, "이전 타이머가 새 요청을 끝냈다");
  onStatus(OK);
  assert.equal(err.hidden, true);
});

test("시간 초과로 끝난 요청의 늦은 응답은 다음 요청의 응답으로 세지 않는다", () => {
  mock.timers.tick(3000);              // 주기 조회의 실패 응답으로 실패 화면에 돌린다
  onStatus(FAIL);
  assert.equal(err.hidden, false);
  mock.timers.tick(3000);              // 주기 조회 A
  const a = sent.at(-1);
  mock.timers.tick(6000);              // A 가 시간 초과로 끝난다
  clickRetry();                        // 다시 연결 B
  assert.equal(busyNow(), true);
  onStatus(FAIL, a);                   // A 의 응답이 늦게 온다
  assert.equal(busyNow(), true, "늦게 온 A 의 응답이 B 를 끝냈다");
  onStatus(FAIL);
  assert.equal(busyNow(), false);
});

test("상태 요청마다 서로 다른 id 를 보낸다", () => {
  const ids = sent.filter((m) => m.type === "localdev.status").map((m) => m.id);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, ids.length);
});
