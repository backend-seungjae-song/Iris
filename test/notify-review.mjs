import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 탭 지목 기록이 설치 앱 상태 폴더에 쓰이지 않게 검사용 폴더로
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "iris-notify-review-"));
process.env.IRIS_STATE_DIR = STATE_DIR;
test.after(() => fs.rmSync(STATE_DIR, { recursive: true, force: true }));
const { initBrowserCommands, notifyHostUser } = await import("../server/browser-commands.js");
const { regTab, grantTab, handleFor } = await import("../server/browser-runtime.js");

const sent = [];
initBrowserCommands({ broadcast: (message) => sent.push(message) });
const session = `notify-review-${process.pid}`;
const tabId = "review-tab-" + process.pid;
regTab(tabId, { space: "notify-review-space" });
grantTab(session, tabId);
const ref = handleFor(tabId);

test("review 알림은 확인할 탭이 없으면 거절한다", async () => {
  const none = await notifyHostUser({ level: "info", title: "확인", review: true }, session);
  assert.equal(none.ok, false);
  assert.match(none.error, /tab이 필요/);
  const missing = await notifyHostUser({ level: "info", title: "확인", review: true, tab: "@zzzzzz" }, session);
  assert.equal(missing.ok, false);
  assert.ok(!sent.some((message) => message.review));
});

test("review 알림은 연달아 보내도 합치지 않고 탭을 담아 보낸다", async () => {
  assert.ok(ref, "검사용 탭의 이름표");
  const ids = [];
  for (const title of ["보고서 1", "보고서 2", "보고서 3", "보고서 4", "보고서 5"]) {
    const res = await notifyHostUser({ level: "info", title, review: true, tab: ref }, session);
    assert.equal(res.ok, true);
    assert.notEqual(res.data.shown, "merged");
    assert.equal(res.data.tab, ref);
    ids.push(res.data.id);
  }
  assert.equal(new Set(ids).size, 5);
  const shown = sent.filter((message) => message.type === "ai-notify" && ids.includes(message.id));
  assert.equal(shown.length, 5);
  for (const message of shown) { assert.equal(message.review, true); assert.equal(message.tab, tabId); }
});

test("review 가 아닌 알림은 지금처럼 합친다", async () => {
  const other = session + "-plain";
  for (const title of ["하나", "둘", "셋"]) await notifyHostUser({ level: "info", title }, other);
  const fourth = await notifyHostUser({ level: "info", title: "넷" }, other);
  assert.equal(fourth.data.shown, "merged");
});
