import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  consoleAsk, initBrowserCommands, notifyHostUser, pendingUserNotices, progressHostUser,
} from "../server/browser-commands.js";
import {
  createHostIdentityAuthority, createIndexUserPorts, createMcpHostDispatcher, createMcpHostHandlers,
} from "../server/mcp-host/index.js";
import { createWorkerBrowserService } from "../server/mcp-worker/browser-service.js";

const sent = [];
initBrowserCommands({ broadcast: (message) => sent.push(message) });
const session = (name) => `notice-test-${name}-${process.pid}`;
let commandSequence = 0;
const identityAuthority = createHostIdentityAuthority();
const hostHandlers = createMcpHostHandlers({
  browser: { commandGuard: () => ({ qaOwned: false }) },
  user: createIndexUserPorts({ consoleAsk, notifyHostUser, progressHostUser }),
});
const host = createMcpHostDispatcher({ workerGeneration: "notice:1", identityAuthority, handlers: hostHandlers });
let workerContext = null;
const worker = createWorkerBrowserService({
  hostApi: {
    withCommand: (command, run) => {
      const previous = workerContext;
      workerContext = { ...command, callId: 0 };
      return Promise.resolve(run()).finally(() => { workerContext = previous; });
    },
    call: async (operation, input) => {
      workerContext.callId += 1;
      const response = await host.dispatch({ protocol: 1, type: "host.request",
        requestId: `notice-host-${commandSequence}-${workerContext.callId}`,
        workerGeneration: "notice:1", commandId: workerContext.commandId,
        callId: workerContext.callId, operation, identity: workerContext.identity, input });
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
      return response.output;
    },
  },
  activity: { run: (_kind, _id, run) => run() },
});
let workerIdentity = { session: "" };
async function runWorkerCmd(command, args, skey) {
  workerIdentity = { session: skey, commandId: `notice-command-${++commandSequence}` };
  identityAuthority.allowSession(skey);
  return worker.dispatch({ command, args, identity: workerIdentity, commandId: workerIdentity.commandId });
}
// 사람에게 묻는 요청은 세션 콘솔에서(사용자 2026-10-28). 화면·폰 알림 없이 바로 반환
test("ask는 알림을 보내지 않고 대화에서 물을 내용을 바로 돌려준다", async () => {
  const skey = session("console-ask");
  const before = sent.length;
  const result = await runWorkerCmd("ask", { message: "결제해 주세요", choices: ["다 했어요", "못 해요"] }, skey);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.console, true);
  assert.equal(result.data.answered, false);
  assert.equal(result.data.done, false);
  assert.match(result.data.note, /이 세션 대화에서 사용자에게 직접 물으세요: "결제해 주세요" \(선택지: 다 했어요 \/ 못 해요\)/);
  assert.equal(sent.slice(before).some((message) => message.type === "ai-ask"), false);
  assert.equal(pendingUserNotices().length, 0);
  const empty = await runWorkerCmd("ask", { message: " " }, skey);
  assert.equal(empty.ok, false);
});

test("approve는 알림 없이 거절 상태로 돌려주고 대화에서 승인받게 한다", async () => {
  const skey = session("console-approve");
  const before = sent.length;
  const result = await runWorkerCmd("approve", { title: "삭제", summary: "주문 3건 삭제" }, skey);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.approved, false);
  assert.deepEqual(result.data.choices, ["승인", "취소"]);
  assert.match(result.data.note, /"주문 3건 삭제"/);
  assert.equal(sent.slice(before).some((message) => message.type === "ai-ask"), false);
  assert.equal((await runWorkerCmd("approve", { title: "삭제" }, skey)).ok, false);
});

test("notify는 같은 key와 빈도 초과를 합치고 관련 기기를 전달", async () => {
  const skey = session("notify");
  const first = await runWorkerCmd("notify", { level: "info", title: "첫 알림", key: "build", device: "sim-1" }, skey);
  const merged = await runWorkerCmd("notify", { level: "ok", title: "완료", key: "build", device: "sim-1" }, skey);
  assert.equal(merged.data.id, first.data.id);
  assert.equal(merged.data.shown, "merged");
  const keyed = sent.findLast((message) => message.type === "ai-notify" && message.id === first.data.id);
  assert.equal(keyed.device, "sim-1");
  for (const title of ["둘", "셋"]) await runWorkerCmd("notify", { level: "info", title }, skey);
  const overflow = await runWorkerCmd("notify", { level: "info", title: "넷" }, skey);
  assert.equal(overflow.data.shown, "merged");
  assert.ok(sent.some((message) => message.type === "ai-notify" && message.id === overflow.data.id && message.title === "외 1건"));
  const badTarget = await runWorkerCmd("notify", { level: "warn", title: "대상 오류", tab: "@missing", device: "sim-1" }, skey);
  assert.equal(badTarget.ok, false);
});

test("progress는 시작·갱신·완료에 같은 id를 쓰고 TTL 뒤 경고", async () => {
  const skey = session("progress");
  const nativeSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms, ...rest) => ms === 1000 ? (timers.push(fn), { fake: true }) : nativeSetTimeout(fn, ms, ...rest);
  try {
    const first = await runWorkerCmd("progress", { op: "start", title: "작업 중", ttl: 1 }, skey);
    const id = first.data.id;
    const update = await runWorkerCmd("progress", { op: "update", id, p: 0.5 }, skey);
    assert.equal(update.data.ok, true);
    const end = await runWorkerCmd("progress", { op: "end", id, result: "ok" }, skey);
    assert.equal(end.data.ok, true);
    assert.ok(sent.filter((message) => message.type === "ai-progress" && message.id === id).every((message) => message.id === id));
    const stale = await runWorkerCmd("progress", { op: "start", title: "응답 대기", ttl: 1 }, skey);
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
