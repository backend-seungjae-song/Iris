import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  answerUserAsk, initBrowserCommands, pendingUserNotices, runBrowserCmd,
} from "../server/browser-commands.js";

const sent = [];
initBrowserCommands({ broadcast: (message) => sent.push(message) });
const session = (name) => `notice-test-${name}-${process.pid}`;
const turn = () => new Promise((resolve) => setImmediate(resolve));
// 30초 대기 타이머. 서버가 마감 시각에서 남은 시간을 계산해 1ms 지나면 29999
const isWaitTimer = (ms) => ms > 29000 && ms <= 30000;
// 대기 타이머 등록까지. 부하가 크면 파일 쓰기 뒤로 수 ms 밀림. 2초 넘으면 그대로 진행해 검사가 실패
async function until(ready) {
  const end = Date.now() + 2000;
  while (!ready() && Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
}

test("ask는 선택지 없이 대상이 없으면 거절하고 선택한 첫 답만 완료로 판정", async () => {
  const skey = session("choice");
  const missing = await runBrowserCmd("ask", { message: "골라 주세요", wait: 30 }, skey);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /choices/);
  const pending = runBrowserCmd("ask", { message: "골라 주세요", choices: ["네", "아니오"], wait: 30 }, skey);
  await turn();
  const notice = sent.findLast((message) => message.type === "ai-ask" && message.session === skey);
  assert.ok(notice);
  assert.deepEqual(notice.choices, ["네", "아니오"]);
  answerUserAsk(notice.id, "네");
  const result = await pending;
  assert.equal(result.data.id, notice.id);
  assert.equal(result.data.done, true);
  assert.equal(result.data.answer, "네");
  assert.equal(pendingUserNotices().some((item) => item.id === notice.id), false);
});

test("ask는 잘못된 이어받기 id와 대기 범위 밖 값을 거절", async () => {
  const skey = session("ask-validation");
  const missing = await runBrowserCmd("ask", { message: "이어 주세요", device: "smoke-device", ask_id: "없는-id", wait: 30 }, skey);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /찾을 수 없습니다/);
  const tooLong = await runBrowserCmd("ask", { message: "기다려 주세요", choices: ["계속", "취소"], wait: 241 }, skey);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /30~240초/);
  const twoTargets = await runBrowserCmd("ask", { message: "기다려 주세요", tab: "@tab", device: "sim-1", wait: 30 }, skey);
  assert.equal(twoTargets.ok, false);
  assert.match(twoTargets.error, /tab과 device/);
});

test("같은 질문을 동시에 요청하면 알림과 대기 호출을 하나만 만든다", async () => {
  const skey = session("concurrent");
  const args = { message: "계속할까요", choices: ["계속", "취소"], wait: 30 };
  const first = runBrowserCmd("ask", args, skey);
  const second = runBrowserCmd("ask", args, skey);
  await turn();
  const notices = pendingUserNotices().filter((item) => item.session === skey);
  for (const notice of notices) answerUserAsk(notice.id, "계속");
  const results = await Promise.all([first, second]);
  assert.equal(notices.length, 1);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  const next = runBrowserCmd("ask", args, skey);
  await turn();
  const nextNotice = pendingUserNotices().find((item) => item.session === skey);
  assert.ok(nextNotice);
  assert.notEqual(nextNotice.id, notices[0].id);
  answerUserAsk(nextNotice.id, "취소");
  assert.equal((await next).data.answer, "취소");
});

test("사용자 지정 두 번째 답이 다 했음이어도 진행으로 판정하지 않는다", async () => {
  const skey = session("custom-done");
  const pending = runBrowserCmd("ask", { message: "답을 고르세요", choices: ["진행", "다 했음"], wait: 30 }, skey);
  await turn();
  const notice = pendingUserNotices().find((item) => item.session === skey);
  answerUserAsk(notice.id, "다 했음");
  const result = await pending;
  assert.equal(result.data.answer, "다 했음");
  assert.equal(result.data.done, false);
});

test("서버를 새로 시작한 뒤 이전 질문의 답으로 새 질문을 닫지 않는다", async () => {
  const oldServer = await import("../server/browser-commands.js?notice-before-restart");
  const newServer = await import("../server/browser-commands.js?notice-after-restart");
  const oldSent = [], newSent = [];
  oldServer.initBrowserCommands({ broadcast: (m) => oldSent.push(m) });
  newServer.initBrowserCommands({ broadcast: (m) => newSent.push(m) });
  const args = { message: "끝내 주세요", device: "smoke-device", wait: 30 };
  const oldPending = oldServer.runBrowserCmd("ask", args, session("restart"));
  const newPending = newServer.runBrowserCmd("ask", args, session("restart"));
  const oldId = oldSent.find((m) => m.type === "ai-ask").id;
  const newId = newSent.find((m) => m.type === "ai-ask").id;
  try {
    newServer.answerUserAsk(oldId, "다 했음");
    assert.equal(newServer.pendingUserNotices().some((m) => m.id === newId), true);
    assert.notEqual(oldId, newId);
  } finally {
    oldServer.answerUserAsk(oldId, "다 했음");
    newServer.answerUserAsk(newId, "못 했음");
    await Promise.all([oldPending, newPending]);
  }
});

test("id 없이 같은 질문을 이어받아도 최초 선택지로 완료를 판정한다", async () => {
  const skey = session("implicit-resume");
  const nativeSetTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (fn, ms, ...rest) => isWaitTimer(ms) ? (expire = fn, { fake: true }) : nativeSetTimeout(fn, ms, ...rest);
  try {
    const args = { message: "골라 주세요", device: "smoke-device", choices: ["진행", "취소"], wait: 30 };
    const first = runBrowserCmd("ask", args, skey);
    await until(() => expire);
    expire();
    const timeout = await first;
    answerUserAsk(timeout.data.id, "진행");
    const result = await runBrowserCmd("ask", { ...args, choices: undefined }, skey);
    assert.equal(result.data.id, timeout.data.id);
    assert.equal(result.data.answer, "진행");
    assert.equal(result.data.done, true);
  } finally { globalThis.setTimeout = nativeSetTimeout; }
});

test("ask 시간 초과 뒤 같은 id와 알림을 이어받고 사이에 누른 답을 전달", async () => {
  const skey = session("resume");
  const nativeSetTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (fn, ms, ...rest) => isWaitTimer(ms) ? (expire = fn, { fake: true }) : nativeSetTimeout(fn, ms, ...rest);
  try {
    const first = runBrowserCmd("ask", { message: "끝내 주세요", device: "smoke-device", wait: 30 }, skey);
    await until(() => expire);
    const notice = sent.findLast((message) => message.type === "ai-ask" && message.session === skey);
    assert.ok(notice);
    answerUserAsk(notice.id, "갔음");
    assert.equal(typeof expire, "function");
    expire();
    const timeout = await first;
    assert.equal(timeout.data.answered, false);
    assert.equal(timeout.data.id, notice.id);
    assert.equal(timeout.data.waitLimitSeconds, 30);
    assert.match(timeout.data.resume, /ask_id/);
    assert.equal(pendingUserNotices().filter((item) => item.id === notice.id).length, 1);
    answerUserAsk(notice.id, "다 했음");
    assert.equal(pendingUserNotices().some((item) => item.id === notice.id), false,
      "답한 질문은 포커스 변경과 재연결 때 다시 보내지 않는다");
    assert.ok(sent.some((message) => message.type === "ai-ask-closed" && message.id === notice.id),
      "다른 창에서도 답한 질문을 닫는다");
    answerUserAsk(notice.id, "못 했음");
    answerUserAsk(notice.id, "갔음");
    const beforeResume = sent.length;
    const again = await runBrowserCmd("ask", { message: "끝내 주세요", device: "smoke-device", ask_id: notice.id, wait: 30 }, skey);
    assert.equal(again.data.id, notice.id);
    assert.equal(again.data.round, 2);
    assert.equal(again.data.done, true);
    assert.equal(again.data.answer, "다 했음", "다른 창의 늦은 답이 첫 답을 바꾸지 않는다");
    assert.equal(again.data.went, true);
    assert.equal(sent.slice(beforeResume).some((message) => message.type === "ai-ask"), false,
      "보관된 답을 전달할 때 질문을 다시 띄우지 않는다");
    assert.equal(pendingUserNotices().some((item) => item.id === notice.id), false);
  } finally { globalThis.setTimeout = nativeSetTimeout; }
});

test("approve 시간 초과는 거절하고 화면에 만료 신호를 보냄", async () => {
  const skey = session("approve");
  const nativeSetTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (fn, ms, ...rest) => isWaitTimer(ms) ? (expire = fn, { fake: true }) : nativeSetTimeout(fn, ms, ...rest);
  try {
    const pending = runBrowserCmd("approve", { title: "대량 입력", summary: "열 칸에 입력", wait: 30 }, skey);
    // 부하가 크면 대기 타이머 등록이 한 턴 뒤로 밀림
    await until(() => expire);
    const notice = sent.findLast((message) => message.type === "ai-ask" && message.session === skey);
    assert.equal(notice.kind, "approve");
    expire();
    const result = await pending;
    assert.equal(result.data.approved, false);
    assert.equal(result.data.answered, false);
    assert.ok(sent.some((message) => message.type === "ai-ask-closed" && message.id === notice.id && message.expired));
    assert.equal(pendingUserNotices().some((item) => item.id === notice.id), false);
  } finally { globalThis.setTimeout = nativeSetTimeout; }
});

test("approve는 제목을 요구하고 시간 초과 결과에 실제 대기 상한을 기록", async () => {
  const skey = session("approve-validation");
  const missing = await runBrowserCmd("approve", { summary: "한 칸에 입력", wait: 30 }, skey);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /title/);
  const twoTargets = await runBrowserCmd("approve", { title: "입력 승인", summary: "한 칸에 입력", tab: "@tab", device: "sim-1", wait: 30 }, skey);
  assert.equal(twoTargets.ok, false);
  assert.match(twoTargets.error, /tab과 device/);
  const nativeSetTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (fn, ms, ...rest) => isWaitTimer(ms) ? (expire = fn, { fake: true }) : nativeSetTimeout(fn, ms, ...rest);
  try {
    const pending = runBrowserCmd("approve", { title: "입력 승인", summary: "한 칸에 입력", wait: 30 }, skey);
    await until(() => expire);
    expire();
    const result = await pending;
    assert.equal(result.data.approved, false);
    assert.equal(result.data.waitLimitSeconds, 30);
    assert.equal(typeof result.data.waitedSeconds, "number");
  } finally { globalThis.setTimeout = nativeSetTimeout; }
});

test("notify는 같은 key와 빈도 초과를 합치고 관련 기기를 전달", async () => {
  const skey = session("notify");
  const first = await runBrowserCmd("notify", { level: "info", title: "첫 알림", key: "build", device: "sim-1" }, skey);
  const merged = await runBrowserCmd("notify", { level: "ok", title: "완료", key: "build", device: "sim-1" }, skey);
  assert.equal(merged.data.id, first.data.id);
  assert.equal(merged.data.shown, "merged");
  const keyed = sent.findLast((message) => message.type === "ai-notify" && message.id === first.data.id);
  assert.equal(keyed.device, "sim-1");
  for (const title of ["둘", "셋"]) await runBrowserCmd("notify", { level: "info", title }, skey);
  const overflow = await runBrowserCmd("notify", { level: "info", title: "넷" }, skey);
  assert.equal(overflow.data.shown, "merged");
  assert.ok(sent.some((message) => message.type === "ai-notify" && message.id === overflow.data.id && message.title === "외 1건"));
  const badTarget = await runBrowserCmd("notify", { level: "warn", title: "대상 오류", tab: "@missing", device: "sim-1" }, skey);
  assert.equal(badTarget.ok, false);
});

test("progress는 시작·갱신·완료에 같은 id를 쓰고 TTL 뒤 경고", async () => {
  const skey = session("progress");
  const nativeSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms, ...rest) => ms === 1000 ? (timers.push(fn), { fake: true }) : nativeSetTimeout(fn, ms, ...rest);
  try {
    const first = await runBrowserCmd("progress", { op: "start", title: "작업 중", ttl: 1 }, skey);
    const id = first.data.id;
    const update = await runBrowserCmd("progress", { op: "update", id, p: 0.5 }, skey);
    assert.equal(update.data.ok, true);
    const end = await runBrowserCmd("progress", { op: "end", id, result: "ok" }, skey);
    assert.equal(end.data.ok, true);
    assert.ok(sent.filter((message) => message.type === "ai-progress" && message.id === id).every((message) => message.id === id));
    const stale = await runBrowserCmd("progress", { op: "start", title: "응답 대기", ttl: 1 }, skey);
    timers.at(-1)();
    assert.ok(sent.some((message) => message.type === "ai-progress" && message.id === stale.data.id && message.result === "warn"));
  } finally { globalThis.setTimeout = nativeSetTimeout; }
});

test("앱 안 진행 알림은 성공과 실패를 시작 알림 id로 끝냄", () => {
  const archive = readFileSync(new URL("../web/js/devtool/archive.js", import.meta.url), "utf8");
  const sketch = readFileSync(new URL("../web/js/browser/sketch.js", import.meta.url), "utf8");
  assert.match(archive, /level: "progress"[\s\S]*id: arToastId[\s\S]*arToastId = null/);
  assert.match(sketch, /level: "progress"[\s\S]*id: captureToastId[\s\S]*id: completedToastId/);
  const worktrees = readFileSync(new URL("../web/js/worktrees/boot.js", import.meta.url), "utf8");
  assert.match(worktrees, /pending\.toastId = app\.showToast\(title, \{ level: "progress"/);
  assert.equal((worktrees.match(/progressFor\(request\("create"/g) || []).length, 1);
  assert.equal((worktrees.match(/progressFor\(request\("remove"/g) || []).length, 1);
  for (const title of ["worktree 작업 결과를 받지 못했습니다", "worktree 작업이 실패했습니다", "worktree를 만들었습니다", "worktree를 삭제했습니다"])
    assert.match(worktrees, new RegExp(`${title}[^\\n]*id: pending\\.toastId`), title);
});

test("토스트 생성과 창 연결은 한 부품을 거침", () => {
  const main = readFileSync(process.env.IRIS_NOTICE_TEST_MAIN || new URL("../web/js/main.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/css/19-terminal.css", import.meta.url), "utf8");
  const handler = readFileSync(new URL("../server/browser-message-handlers.js", import.meta.url), "utf8");
  assert.match(main, /import \{[^}]*pushNotice[^}]*\} from "\.\/core\/notice-center\.js"/);
  assert.match(html, /<script type="module" src="\/js\/main\.js"><\/script>/);
  assert.doesNotMatch(html, /id="copied-toast"|id="noticestack"/);
  assert.doesNotMatch(css, /\.copied-toast\b|\.noticestack\b|\.notice \/?\{/);
  assert.match(css, /\.iris-notices \{ position:fixed/);
  assert.match(main, /"toast": dispatchWs\(handleServerToastMessage\)/);
  assert.match(main, /"ai-ask-closed": dispatchWs\(consoleOnly\(handleAiAskClosedMessage\)\)/);
  assert.match(handler, /pendingUserNotices\(\)/);
  assert.match(handler, /const notices = ws\._ui \? pendingUserNotices\(\) : \[\]/);
  assert.match(handler, /for \(const notice of notices\) ws\.send\(JSON\.stringify\(notice\)\)/);
  assert.match(handler, /pendingAskIds: notices\.map/);
  assert.match(handler, /msg\.type === "ui-auth"/);
});

test("모달 네 곳은 같은 창 디자인과 취소·포커스 복귀 계약을 씀", () => {
  const groups = [["../web/js/explorer/context-menu.js"], ["../web/js/center/tab-close.js"],
    ["../web/js/center/text-editor.js"], ["../web/js/devtool/keymap-page.js", "../web/js/devtool/settings-view.js"]];
  for (const files of groups) {
    const source = files.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
    assert.match(source, /class="dim"/);
    assert.match(source, /role="dialog" aria-modal="true"/);
    assert.match(source, /previous\?\.focus\?\.\(\)/);
    assert.match(source, /key === "Escape"/);
  }
});

test("macOS 알림은 앱이 뒤에 있을 때만 띄우고 누르면 같은 알림을 찾음", () => {
  const main = readFileSync(new URL("../native/electron/main.cjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../native/electron/preload.cjs", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.on\("ac-notify"[\s\S]*BrowserWindow\.getFocusedWindow\(\)[\s\S]*Notification\.isSupported\(\)/);
  assert.match(main, /target\.webContents\.send\("ac-notice-activate", \{ id \}\)/);
  assert.match(preload, /onNoticeActivated: \(cb\) => ipcRenderer\.on\("ac-notice-activate"/);
});

// 사이드바 머리의 알림 입구는 알림 기능(notifications)의 종 버튼 하나. 토스트 부품이 두 번째 입구를 만들지 않음
test("토스트 부품은 사이드바 머리에 알림 기록 버튼을 붙이지 않음", () => {
  const center = readFileSync(new URL("../web/js/core/notice-center.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/css/19-terminal.css", import.meta.url), "utf8");
  assert.doesNotMatch(center, /sidebar-head|알림 기록/);
  assert.doesNotMatch(css, /iris-notices-history/);
});
