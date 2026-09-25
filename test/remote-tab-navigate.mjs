// 원격 연결은 브라우저 상태를 열람만 한다.
//
// 탭 주소·북마크·기록은 로컬 창이 나중에 여는 주소가 된다. 원격이 이 값을 쓰면 로컬 기기의 주소를
// 로컬 창에서 열게 할 수 있다. 원격 창이 보기 위해 보내는 선택 op 만 통과해야 한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-remote-nav-"));
process.env.IRIS_STATE_DIR = dir;
const handlers = await import("../server/browser-message-handlers.js");
const owner = await import("../server/browser-state-owner.js");
const runtime = await import("../server/runtime-state.js");
const stored = await import("../server/browser-state.js");
runtime.replace({ ...runtime.snapshot(), workspaces: [{ id: "s1" }, { id: "s2" }] });
// 스페이스 이름은 저장 키로 바뀌어 저장되므로 파일로 심지 않고 소유 모듈로 연다.
assert.ok(owner.mutate({ op: "tab.open", space: "s1", id: "t1", url: "https://a.test/", title: "A", profile: "" }));
assert.ok(owner.mutate({ op: "tab.open", space: "s1", id: "t2", url: "https://b.test/", title: "B", profile: "" }));
assert.ok(owner.mutate({ op: "bookmark.add", space: "s1", url: "https://a.test/", title: "A" }));

const sent = [];
handlers.initBrowserMessageHandlers({ broadcast: (m) => sent.push(m), broadcastLocal: (m) => sent.push(m) });
const ws = (local) => ({ _local: local, replies: [], send(v) { this.replies.push(JSON.parse(v)); } });
const tab = () => owner.tabs("s1").find((t) => t.id === "t1");
const navigate = { type: "browser-sync", mutation: { op: "tab.navigate", space: "s1", id: "t1", url: "http://127.0.0.1:8080/x", title: "X" } };

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("원격 tab.navigate 는 주소·제목·브로드캐스트를 바꾸지 않고 오류도 보내지 않는다", () => {
  const remote = ws(false);
  handlers.handleBrowserSync(remote, navigate);
  assert.equal(tab().url, "https://a.test/");
  assert.equal(tab().title, "A");
  assert.equal(sent.length, 0);
  assert.deepEqual(remote.replies, [], "원격 창은 탐색마다 보내므로 오류를 알리면 토스트가 쏟아진다");
});

test("원격의 북마크·기록·그룹 쓰기와 모르는 op 는 상태를 바꾸지 않는다", () => {
  const before = JSON.stringify(owner.wire());
  const ops = [
    { op: "bookmark.edit", space: "s1", url: "https://a.test/", newUrl: "http://127.0.0.1:8080/x" },
    { op: "bookmark.add", space: "s1", url: "http://127.0.0.1:8080/y", title: "Y" },
    { op: "history.push", space: "s1", url: "http://127.0.0.1:8080/z" },
    { op: "group.create", space: "s1", id: "g1", name: "G" },
    { op: "future.op", space: "s1" },
  ];
  const remote = ws(false);
  for (const mutation of ops) handlers.handleBrowserSync(remote, { type: "browser-sync", mutation });
  assert.equal(JSON.stringify(owner.wire()), before);
  assert.equal(sent.length, 0);
  // history.push 는 탐색마다 자동으로 가므로 조용히 버리고, 사용자가 누른 쓰기는 이유를 알린다.
  assert.equal(remote.replies.length, ops.length - 1);
  assert.ok(remote.replies.every((r) => r.type === "control-error"));
});

test("원격 창의 탭 선택은 종전대로 반영한다", () => {
  handlers.handleBrowserSync(ws(false), { type: "browser-sync", mutation: { op: "tab.switch", space: "s1", id: "t1" } });
  assert.equal(sent.length, 1);
  sent.length = 0;
});

test("원격 space.active 는 실제 스페이스일 때만 반영한다", () => {
  const remote = ws(false);
  for (const space of ["__proto__", "constructor", "없는곳", 7, null]) {
    handlers.handleBrowserSync(remote, { type: "browser-sync", mutation: { op: "space.active", space } });
  }
  assert.equal(sent.length, 0, "실제 스페이스가 아닌 값은 activeSpace 가 되면 안 된다");
  handlers.handleBrowserSync(remote, { type: "browser-sync", mutation: { op: "space.active", space: "s2" } });
  assert.equal(sent.length, 1);
  sent.length = 0;
});

test("원격 선택 op 는 없는 스페이스·탭·그룹이면 저장 상태에 항목을 만들지 않는다", () => {
  const snap = () => { const st = stored.get(); return JSON.stringify([Object.keys(st.tabsBySpace || {}), Object.keys(st.groupsBySpace || {})]); };
  const before = snap();
  const remote = ws(false);
  for (const space of ["ghost", "__proto__", "constructor", 7, null]) {
    handlers.handleBrowserSync(remote, { type: "browser-sync", mutation: { op: "tab.switch", space, id: "missing" } });
    handlers.handleBrowserSync(remote, { type: "browser-sync", mutation: { op: "group.collapse", space, id: "missing", collapsed: true } });
  }
  handlers.handleBrowserSync(remote, { type: "browser-sync", mutation: { op: "tab.switch", space: "s1", id: { toString: () => "t1" } } });
  assert.equal(snap(), before);
  const st = stored.get();
  assert.equal(Object.getPrototypeOf(st.tabsBySpace), Object.prototype);
  assert.equal(Object.getPrototypeOf(st.groupsBySpace || {}), Object.prototype);
  assert.equal(sent.length, 0);
});

test("원격 스페이스 전환은 예전 북마크의 소속을 정하지 않는다", () => {
  const st = stored.get();
  st.bookmarksBySpace = { ...(st.bookmarksBySpace || {}), __legacy__: [{ url: "https://old.test/", title: "Old" }] };
  const before = JSON.stringify(st.bookmarksBySpace);
  // 이관은 북마크가 없는 스페이스로 전환할 때 일어난다. s1 에는 북마크가 있어 조건이 성립하지 않는다.
  assert.equal((st.bookmarksBySpace.s2 || []).length, 0);
  handlers.handleBrowserSync(ws(false), { type: "browser-sync", mutation: { op: "space.active", space: "s2" } });
  assert.equal(JSON.stringify(stored.get().bookmarksBySpace), before);
  delete stored.get().bookmarksBySpace.__legacy__;
  sent.length = 0;
});

test("원격은 경로 모양의 스페이스 이름으로 키 캐시를 채우지 않고, 공유 브라우저 탭은 고를 수 있다", async () => {
  const keys = await import("../server/space-key.js");
  const probe = fs.mkdtempSync(path.join(dir, "probe-"));
  // space-key.js keyForDir 과 같은 식으로 키를 만든다. keyForDir 을 부르면 그 호출이 캐시를 채운다.
  const st = fs.statSync(fs.realpathSync(probe), { bigint: true });
  const key = `folder:v2:${st.ino.toString(36)}:${(st.birthtimeNs > 0n ? st.birthtimeNs : 0n).toString(36)}`;
  assert.equal(keys.dirOfKey(key), null);
  handlers.handleBrowserSync(ws(false), { type: "browser-sync", mutation: { op: "tab.switch", space: probe, id: "missing" } });
  handlers.handleBrowserSync(ws(false), { type: "browser-sync", mutation: { op: "group.collapse", space: probe, id: "missing", collapsed: true } });
  assert.equal(keys.dirOfKey(key), null, "원격 입력으로 디렉터리를 조회하면 안 된다");
  assert.ok(owner.mutate({ op: "tab.open", space: "__shared__", id: "sh1", url: "https://s.test/", title: "S", profile: "" }));
  assert.ok(owner.mutate({ op: "tab.open", space: "__shared__", id: "sh2", url: "https://s2.test/", title: "S2", profile: "" }));
  sent.length = 0;
  handlers.handleBrowserSync(ws(false), { type: "browser-sync", mutation: { op: "tab.switch", space: "__shared__", id: "sh1" } });
  assert.equal(sent.length, 1, "공유 브라우저 탭 선택은 원격에서도 된다");
  sent.length = 0;
});

test("원격 ai-login-note 는 로컬 창에 알리지 않는다", () => {
  handlers.handleBrowserMessage(ws(false), { type: "ai-login-note", kind: "filled", origin: "https://bank.test", username: "me" });
  assert.equal(sent.length, 0);
  handlers.handleBrowserMessage(ws(true), { type: "ai-login-note", kind: "filled", origin: "https://bank.test", username: "me" });
  assert.equal(sent.at(-1).type, "ai-login-note");
  sent.length = 0;
});

test("로컬 tab.navigate 는 종전대로 반영하고 알린다", () => {
  handlers.handleBrowserSync(ws(true), navigate);
  assert.equal(tab().url, "http://127.0.0.1:8080/x");
  assert.equal(sent.at(-1).type, "browser-state");
});
