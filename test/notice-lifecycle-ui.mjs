import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const main = read("../web/js/main.js");
function sourceFunction(name) {
  const start = main.indexOf(`function ${name}(`);
  if (start < 0) return `function ${name}() {}`;
  return main.slice(start, main.indexOf("\n}", start) + 2);
}

async function fixture(run) {
  const browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><body></body>");
    await page.evaluate(async ({ noticeSource, wsSource, functions }) => {
      const moduleOf = (source) => import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      window.sent = [];
      window.WebSocket = class {
        constructor() { window.socket = this; this.readyState = 1; }
        send(text) { window.sent.push(JSON.parse(text)); }
      };
      const transport = await moduleOf(wsSource);
      transport.initWs({ url: "ws://test", onOpen() {}, onClose() {}, dispatch: {} });
      window.socket.onmessage({ data: JSON.stringify({ type: "caps", netPolicy: transport.EXPECTED_NET_POLICY }) });
      const notices = await moduleOf(noticeSource);
      Object.assign(window, { notices });
      const build = new Function("pushNotice", "expireNotice", "removeNotice", "hasNotice", "transportWsSend", "window", `
        const serverAskIds = new Set();
        ${functions}
        return { wsSend, showNotice, handleAiAskMessage, handleAiAskClosedMessage, handleUiAuthMessage };
      `);
      window.handlers = build(notices.pushNotice, notices.expireNotice, notices.removeNotice, notices.hasNotice, transport.wsSend, window);
    }, {
      noticeSource: read("../web/js/core/notice-center.js"), wsSource: read("../web/js/core/ws.js"),
      functions: ["wsSend", "showNotice", "handleAiAskMessage", "handleAiAskClosedMessage", "handleUiAuthMessage"].map(sourceFunction).join("\n"),
    });
    await run(page);
  } finally { await browser.close(); }
}

test("끊긴 동안 누른 답은 알림을 닫지 않고 다시 연결한 뒤 답할 수 있다", async () => fixture(async (page) => {
  await page.evaluate(() => { handlers.handleAiAskMessage({ id: "ask-offline", text: "끝내 주세요" }); socket.readyState = 3; });
  await page.click(".iris-notice-actions button");
  assert.equal(await page.evaluate(() => notices.hasNotice("ask-offline")), true);
  assert.equal(await page.evaluate(() => sent.some((m) => m.type === "ai-ask-answer")), false);
  assert.equal(await page.evaluate(() => handlers.wsSend({ type: "ai-ask-answer", id: "ask-offline", answer: "다 했음" })), false);
  await page.evaluate(() => { socket.readyState = 1; });
  await page.click(".iris-notice-actions button");
  assert.equal(await page.evaluate(() => sent.at(-1).answer), "다 했음");
  assert.equal(await page.evaluate(() => notices.hasNotice("ask-offline")), true, "서버가 수신을 확인하기 전에는 닫지 않는다");
  await page.evaluate(() => handlers.handleAiAskClosedMessage({ id: "ask-offline" }));
  assert.equal(await page.evaluate(() => notices.hasNotice("ask-offline")), false);
}));

test("명시한 선택지와 승인 단추의 응답은 원문을 보존한다", async () => fixture(async (page) => {
  for (const m of [
    { id: "ask-custom", text: "골라 주세요", choices: ["못 하겠어요", "다 했어요"] },
    { id: "approve-custom", kind: "approve", text: "승인해 주세요", approveLabel: "다 했어요", denyLabel: "못 하겠어요" },
  ]) {
    await page.evaluate((message) => handlers.handleAiAskMessage(message), m);
    await page.click(`[data-id="${m.id}"] .iris-notice-actions button`);
    const answer = await page.evaluate(() => sent.at(-1).answer);
    assert.equal(answer, m.choices?.[0] || m.approveLabel);
    await page.evaluate((id) => handlers.handleAiAskClosedMessage({ id }), m.id);
  }
}));

test("재연결 목록에서 빠진 서버 질문만 닫고 로컬 알림과 현재 질문은 남긴다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    notices.pushNotice({ id: "local", kind: "ask", title: "로컬 질문" });
    handlers.handleAiAskMessage({ id: "finished", text: "완료됨" });
    handlers.handleAiAskMessage({ id: "pending", text: "대기 중" });
    handlers.handleAiAskMessage({ id: "expired", kind: "approve", text: "만료됨" });
    handlers.handleUiAuthMessage({ ok: false, pendingAskIds: [] });
  });
  assert.equal(await page.evaluate(() => notices.hasNotice("pending")), true);
  await page.evaluate(() => handlers.handleUiAuthMessage({ ok: true, pendingAskIds: ["pending"] }));
  const visible = await page.evaluate(() => ["local", "finished", "pending", "expired"].map((id) => notices.hasNotice(id)));
  assert.deepEqual(visible, [true, false, true, false]);
  assert.match(main, /"ui-auth": dispatchWs\(consoleOnly\(handleUiAuthMessage\)\)/);
}));

test("일반 알림의 답은 즉시 닫고 전송 예외가 발생한 서버 질문은 남긴다", async () => fixture(async (page) => {
  await page.evaluate(() => handlers.showNotice({ id: "local-answer", hot: true, title: "확인", answer: () => true }));
  await page.click(".iris-notice-actions button");
  assert.equal(await page.evaluate(() => notices.hasNotice("local-answer")), false);
  await page.evaluate(() => {
    handlers.handleAiAskMessage({ id: "failed-send", text: "끝내 주세요" });
    socket.send = () => { throw new Error("socket closed"); };
  });
  await page.click(".iris-notice-actions button");
  assert.equal(await page.evaluate(() => notices.hasNotice("failed-send")), true);
  assert.equal(await page.evaluate(() => handlers.wsSend({ type: "ai-ask-answer", id: "failed-send", answer: "다 했음" })), false);
}));

test("서버 인증 응답에는 재전송할 질문 id의 전체 목록을 포함한다", () => {
  const source = read("../server/browser-message-handlers.js");
  const start = source.indexOf('else if (msg.type === "ui-auth")');
  const end = source.indexOf('else if (msg.type === "chat-submitted")', start);
  const branch = source.slice(start, end);
  const messages = [];
  const ws = { _local: true, send: (text) => messages.push(JSON.parse(text)) };
  new Function("msg", "ws", "uiTokenOk", "setUserInterfaceFocus", "pendingUserNotices", `if (false) {} ${branch}`)(
    { type: "ui-auth", token: "test", focused: true }, ws, () => true, () => {},
    () => [{ type: "ai-ask", id: "pending-1" }, { type: "ai-ask", id: "pending-2" }],
  );
  assert.deepEqual(messages[0].pendingAskIds, ["pending-1", "pending-2"]);
  assert.deepEqual(messages.slice(1).map((m) => m.id), messages[0].pendingAskIds);
});
