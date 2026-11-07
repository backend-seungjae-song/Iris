import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// PRE_SC·PRE_DIFF·PRE_LD·PRE_KM·PRE_UST·PRE_AR: 고치기 전 판으로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({
  PRE_SC: "/js/devtool/source-control.js", PRE_DIFF: "/js/devtool/diff.js", PRE_LD: "/js/devtool/localdev.js",
  PRE_KM: "/js/devtool/keymap-page.js", PRE_UST: "/js/usagestats/page.js", PRE_AR: "/js/devtool/archive.js",
});
const run = (fn, body = "") => withWebPage(fn, { body, overrides });

test("C2 새로고침 응답 전에도 중첩 레포·워크트리 후보를 유지", async () => {
  const sent = await run((page) => page.evaluate(async () => {
    const sc = await import("/js/devtool/source-control.js");
    const sent = [];
    sc.initSourceControl({
      $: () => null, esc: String, wsSend: (m) => sent.push(m),
      getCurrentAgent: () => null, spaceRootFor: () => "/r", getSelectedSpaceId: () => "w1",
      getSpaces: () => [{ id: "w1", folder: "/r" }], getLastAgents: () => [],
    });
    sc.handleSourceControlMessage({ type: "git-repos", path: "/r", repos: ["/r/sub"], worktrees: ["/r/wt"] });
    sent.length = 0;
    sc.scRefresh();
    return sent.filter((m) => m.type === "git.status").map((m) => m.path).sort();
  }));
  assert.deepEqual(sent, ["/r", "/r/sub", "/r/wt"], "응답 전에도 모든 후보에 상태를 다시 물음");
});

const DIFF_BODY = `<style>#diffview{height:120px;display:flex;flex-direction:column}.dv-body{flex:1;min-height:0;overflow:auto}.dl{display:flex}</style><div id="diffview"></div>`;
const diffSetup = `
  const ts = await import("/js/center/tab-store.js");
  const d = await import("/js/devtool/diff.js");
  window.monaco = { languages: { getLanguages: () => [{ id: "javascript", extensions: [".js"] }] },
    editor: { setTheme() {}, colorize: async (t) => { await new Promise((r) => setTimeout(r, 40)); return t.split("\\n").map((l) => "<span class='tok'>" + l + "</span>").join("<br/>"); } } };
  const showActive = () => { const t = ts.getTabs("w1").find((x) => x.id === ts.getActiveTab?.("w1")) || ts.getTabs("w1")[0]; d.renderDiffView(t); };
  d.initDiff({ $: (q) => document.querySelector(q), esc: String, wsSend() {}, getSelectedSpaceId: () => "w1",
    renderTabs() {}, showActiveTab: showActive, ensureMonacoLib: async () => {}, monacoTheme: null });
  const patch = (tail) => "diff --git a/x.js b/x.js\\nindex 1..2 100644\\n--- a/x.js\\n+++ b/x.js\\n@@ -1,200 +1,200 @@\\n"
    + Array.from({ length: 200 }, (_, i) => " line" + i).join("\\n") + "\\n+" + tail + "\\n";
  const msg = (p) => ({ type: "git-diff", file: "/r/x.js", staged: false, root: "/r", patch: p });
`;

test("C4 열려 있는 diff 탭의 파일을 다시 누르면 보이던 diff 를 유지", async () => {
  const r = await run((page) => page.evaluate(`(async () => { ${diffSetup}
    d.openDiff("/r/x.js", { root: "/r", rel: "x.js" });
    d.handleGitDiffMessage(msg(patch("a")));
    await new Promise((r) => setTimeout(r, 120));
    d.openDiff("/r/x.js", { root: "/r", rel: "x.js" });
    return { loading: document.querySelector("#diffview").textContent.includes("불러오는 중"), hasBody: !!document.querySelector(".dv-body") };
  })()`), DIFF_BODY);
  assert.equal(r.loading, false, "다시 요청하는 동안 불러오는 중 문구 없음");
  assert.equal(r.hasBody, true);
});

test("C3 같은 탭의 diff 가 갱신돼도 스크롤 위치와 문법 색을 유지", async () => {
  const r = await run((page) => page.evaluate(`(async () => { ${diffSetup}
    d.openDiff("/r/x.js", { root: "/r", rel: "x.js" });
    d.handleGitDiffMessage(msg(patch("a")));
    await new Promise((r) => setTimeout(r, 150));
    const pre = document.querySelector(".dv-body");
    const hl1 = pre.classList.contains("hl");
    pre.scrollTop = 200;
    const at1 = pre.scrollTop;
    d.handleGitDiffMessage(msg(patch("b")));
    const during = document.querySelector(".dv-body");
    const keptColorWhileWaiting = !!during && during.classList.contains("hl");
    await new Promise((r) => setTimeout(r, 200));
    const post = document.querySelector(".dv-body");
    return { hl1, at1, keptColorWhileWaiting, scroll: post.scrollTop, hl: post.classList.contains("hl"), text: post.textContent.includes("+b") };
  })()`), DIFF_BODY);
  assert.equal(r.hl1, true, "처음에는 색이 입혀짐");
  assert.ok(r.at1 > 0, "스크롤이 내려가 있음");
  assert.equal(r.keptColorWhileWaiting, true, "새 색이 준비될 때까지 옛 색 화면 유지");
  assert.equal(r.scroll, r.at1, "스크롤 위치 유지");
  assert.equal(r.hl, true);
  assert.equal(r.text, true, "새 내용으로 바뀜");
});

const LD_BODY = `<div id="ld-body"></div><div id="ld-err" hidden></div><div id="ld-sys"></div><span id="ld-upd"></span>`;
test("C12 상태 조회가 한 번 실패해도 마지막 표 유지, 연속 실패면 오류 화면", async () => {
  const r = await run((page) => page.evaluate(async () => {
    const ld = await import("/js/devtool/localdev.js");
    const sent = [];
    const cap = ld.initCapability({ $: (q) => document.querySelector(q), esc: String, wsSend: (m) => sent.push(m) });
    const reply = (msg) => cap.ws["localdev.status"]({ type: "localdev.status", id: sent.at(-1).id, ...msg });
    const ask = () => cap.screen.enter();
    ask();
    reply({ ok: true, data: { updated: "t", routes: [{ name: "app", up: true, host: "app.test", port: 3000 }], projects: [], system: {} } });
    const shown = () => ({ err: !document.querySelector("#ld-err").hidden, body: !document.querySelector("#ld-body").hidden });
    const ok = shown();
    ask(); reply({ ok: false, reason: "unreachable" });
    const one = shown();
    ask(); reply({ ok: false, reason: "unreachable" });
    const two = shown();
    return { ok, one, two };
  }), LD_BODY);
  assert.deepEqual(r.ok, { err: false, body: true });
  assert.deepEqual(r.one, { err: false, body: true }, "한 번 실패에는 표 유지");
  assert.deepEqual(r.two, { err: true, body: false }, "연속 두 번 실패하면 오류 화면");
});

test("C6 설정 화면은 같은 내용이면 다시 그리지 않고 다시 그려도 스크롤 위치 유지", async () => {
  const r = await run((page) => page.evaluate(async () => {
    const km = await import("/js/devtool/keymap-page.js");
    const noop = () => {};
    km.initKeymapPage({ $: (q) => document.querySelector(q), wsSend: noop, showToast: noop });
    km.enterKeymapPage();
    const sc = document.querySelector(".km-scroll");
    sc.__mark = 1;
    sc.scrollTop = 40;
    const at = sc.scrollTop;
    km.renderKeymapPage();
    const same = document.querySelector(".km-scroll");
    const skipped = same.__mark === 1;
    document.querySelector("#km-body").appendChild(document.createElement("i"));   // 같은 내용 건너뛰기를 막아 다시 그리게 함
    km.renderKeymapPage();
    const after = document.querySelector(".km-scroll");
    return { at, skipped, rebuilt: after.__mark !== 1, scroll: after.scrollTop };
  }), `<style>.km-scroll{height:150px;overflow:auto}</style><div id="km-panel"><div id="km-body"></div></div>`);
  assert.ok(r.at > 0, "스크롤 가능한 길이");
  assert.equal(r.skipped, true, "같은 내용이면 DOM 유지");
  assert.equal(r.rebuilt, true);
  assert.equal(r.scroll, r.at, "다시 그려도 위치 유지");
});

test("C5 사용량 화면은 방송이 와도 스크롤과 입력 중인 값을 유지", async () => {
  const r = await run((page) => page.evaluate(async () => {
    const u = await import("/js/usagestats/page.js");
    const ctx = { $: (q) => document.querySelector(q), wsSend() {} };
    u.initUsagePage(ctx).screen.enter();
    [...document.querySelectorAll(".ust-tab")].find((b) => b.textContent.includes("계정")).click();
    const input = document.querySelector(".ust-input");
    input.value = "secret-cookie"; input.focus();
    const sc = document.querySelector(".ust-scroll");
    sc.scrollTop = 30;
    const at = sc.scrollTop;
    u.setHistory({ scanning: true, progress: { done: 1, total: 9 } });
    u.setPrefsFlags({ hasOpencodeCookie: true });
    const now = document.querySelector(".ust-input");
    return { at, value: now.value, focused: document.activeElement === now, scroll: document.querySelector(".ust-scroll").scrollTop };
  }), `<style>.ust-scroll{height:60px;overflow:auto}</style><div id="usage-panel"><div class="ust-page"></div></div>`);
  assert.ok(r.at > 0, "스크롤 가능한 길이");
  assert.equal(r.value, "secret-cookie", "입력 값 유지");
  assert.equal(r.focused, true, "포커스 유지");
  assert.equal(r.scroll, r.at, "스크롤 위치 유지");
});

test("C14 복원 진행 메시지가 와도 돌던 스피너를 다시 만들지 않음", async () => {
  const r = await run((page) => page.evaluate(async () => {
    const ar = await import("/js/devtool/archive.js");
    ar.initArchive({ $: (q) => document.querySelector(q), esc: (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])), wsSend() {}, showToast() {} });
    ar.handleArchiveMessage({ type: "archives", items: [{ id: "a1", kind: "agent", agent: "claude", name: "s", at: 1, cwd: "/r" }] });
    ar.handleArchiveMessage({ type: "archive-progress", spaceCwd: "/r", done: 0, total: 3, name: "a" });
    const spin = document.querySelector(".ar-spin"); spin.__mark = 1;
    ar.handleArchiveMessage({ type: "archive-progress", spaceCwd: "/r", done: 1, total: 3, name: "b" });
    const now = document.querySelector(".ar-spin");
    return { same: now.__mark === 1, text: document.querySelector(".ar-busy-t").textContent, width: document.querySelector(".ar-busy-bar i").style.width };
  }), `<div id="ar-busy"></div><div id="ar-count"></div><div id="ar-list"></div><div id="ar-detail"></div>`);
  assert.equal(r.same, true, "스피너 노드 유지");
  assert.match(r.text, /2\/3 — b/);
  assert.equal(r.width, "33%");
});
