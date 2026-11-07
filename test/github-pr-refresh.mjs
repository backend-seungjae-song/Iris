import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// GPR_BOOT_SRC·GPR_VIEW_SRC: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ GPR_BOOT_SRC: "/js/github-pr/boot.js", GPR_VIEW_SRC: "/js/github-pr/view.js" });

test("PR 카드는 30초 뒤 다시 확인하는 동안에도 이전 결과를 그대로 보여 줌", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const gpr = await import("/js/github-pr/boot.js");
    const { callHook } = await import("/js/core/hooks.js");
    const sent = [];
    const { ws } = gpr.initCapability({ wsIsOpen: () => true, wsSend: (m) => sent.push(m) });
    const row = document.getElementById("row");
    const info = { row, root: "/r", branch: "main", spaceId: "s1" };
    callHook("githubpr.branch", info);
    ws["githubpr-status"]({ requestId: sent.at(-1).requestId, ok: true, pr: null });
    const first = document.getElementById("gpr-branch").textContent;
    const now = Date.now(); Date.now = () => now + 31000;
    callHook("githubpr.branch", info);
    return { first, during: document.getElementById("gpr-branch").textContent, asked: sent.length };
  }), { body: `<div id="row"></div>`, overrides });
  assert.equal(r.first, "PR 없음");
  assert.equal(r.asked, 2, "다시 확인 요청");
  assert.equal(r.during, "PR 없음", "응답 전에도 이전 결과");
});

test("PR 화면은 내용이 바뀌어 다시 그려도 스크롤 위치를 유지하고, 탭을 바꾸면 맨 위", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const { renderGithubPrView } = await import("/js/github-pr/view.js");
    (await import("/js/core/markdown.js")).initMarkdown({ esc: (v) => String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]) });
    const host = document.getElementById("host");
    const pr = { root: "/r", number: 7, title: "t", head: "h", base: "main", author: "a", state: "OPEN", body: "x\n\n".repeat(200),
      comments: [], reviews: [], reviewComments: [], checks: [], files: [] };
    const tab = { pr, section: "conversation", logs: new Map(), notice: "" };
    const hooks = { host, onRefresh() {}, onLog() {}, onDraft() {}, onOpenUrl() {}, onFile() {} };
    renderGithubPrView(tab, hooks);
    host.querySelector(".gpr-page").scrollTop = 500;
    tab.notice = "전달했습니다"; renderGithubPrView(tab, hooks);
    const kept = host.querySelector(".gpr-page").scrollTop;
    host.querySelector('[data-gpr-section="files"]').click();
    return { kept, switched: host.querySelector(".gpr-page").scrollTop };
  }), { body: `<link rel="stylesheet" href="/css/40-github-pr.css"><div id="host" style="height:300px;display:flex;flex-direction:column"></div>`, overrides });
  assert.equal(r.kept, 500, "다시 그려도 위치 유지");
  assert.equal(r.switched, 0, "다른 탭으로 바꾸면 맨 위");
});
