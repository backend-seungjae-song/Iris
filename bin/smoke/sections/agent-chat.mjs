// 에이전트 채팅 보기와 Spaces · Agents 줄 접기의 검사.
//
// 소유 범위
//   채팅 보기가 기능 표로만 실리는가, 앱 셸이 이름으로만 부르는가, 서버가 경로를 창에서 받지 않는가,
//   스페이스 줄·하위 있는 에이전트 줄을 누를 때마다 접힘이 바뀌는가, 서브에이전트 줄이 대화를 여는가.
//
// 설계 이유
//   접기는 소스 모양이 아니라 실제 클릭 처리기를 가짜 DOM 위에서 불러 접힘 상태를 센다. 포커스
//   이동이 접힌 그룹을 다시 펴는 것이 원래 결함이었으므로, 가짜 포커스도 같은 revealAgentRow 를 부른다.
//
// 영향 범위
//   러너(bin/smoke.mjs)가 default run 을 부른다. 현재 목록 확인: node bin/importers.mjs bin/smoke/sections/agent-chat.mjs
import { check, checkAsync, read, ROOT } from "../core.mjs";

const url = (rel) => new URL(`file://${ROOT}/${rel}`).href;

function fakeEl() {
  const listeners = {};
  return {
    listeners, innerHTML: "", hidden: false, scrollTop: 0, dataset: {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0 }; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function clickEvent(match) {
  return { target: { closest: (sel) => match(sel) }, stopPropagation() {}, preventDefault() {}, button: 0 };
}

export default async function run() {
  console.log("[에이전트 채팅 보기 · 목록 접기]");

  const { CAPABILITIES } = await import(url("web/js/core/capabilities.js"));
  check("채팅 보기는 기능 표에 있고 동적 import 로만 실린다", () => {
    const cap = CAPABILITIES.find((c) => c.id === "agentchat");
    if (!cap) throw new Error("agentchat 항목이 없다");
    if (!/import\(\s*["']\.\.\/agentchat\/boot\.js["']\s*\)/.test(String(cap.load))) throw new Error("load 가 agentchat/boot.js 동적 import 가 아니다");
    const shell = ["web/js/main.js", "web/js/herdr/agents.js", "web/js/herdr/sync.js", "web/js/explorer/context-menu.js", "web/index.html"];
    const leak = shell.filter((f) => /agentchat\/(?:boot|view|fold)\.js/.test(read(f)));
    if (leak.length) throw new Error(`앱 셸이 채팅 모듈을 직접 참조한다: ${leak.join(", ")}`);
    return true;
  });

  check("앱 셸은 채팅 보기를 이름으로만 부르고 기능이 그 이름을 채운다", () => {
    const calls = {
      "agentchat.sync": ["web/js/main.js", "web/js/herdr/sync.js"],
      "agentchat.openSubagent": ["web/js/herdr/agents.js"],
      "agentchat.toggle": ["web/js/browser/dock.js"],   // 웹뷰에 포커스가 있을 때 main 이 중계한 ⌘⇧J
    };
    if (!/"agent-chat": \{ mod: true, shift: true, key: "j" \}/.test(read("native/electron/main-window.cjs"))) throw new Error("main 중계표에 agent-chat 이 없다 — 웹뷰 포커스에서 ⌘⇧J 가 안 된다");
    const boot = read("web/js/agentchat/boot.js");
    for (const [name, files] of Object.entries(calls)) {
      for (const f of files) if (!read(f).includes(`callHook("${name}"`)) throw new Error(`${f} 가 ${name} 을 부르지 않는다`);
      if (!boot.includes(`provide("${name}"`)) throw new Error(`채팅 보기가 ${name} 을 채우지 않는다`);
    }
    return true;
  });

  // 창이 보낸 값 중 서버가 읽는 칸은 네 개뿐이어야 한다. 경로·파일 칸을 읽기 시작하면 이 메시지가
  // 임의 파일 읽기 통로가 된다.
  check("채팅 서버는 기록 파일 경로를 창에서 받지 않는다", () => {
    const src = read("server/agent-chat.js");
    const fields = new Set([...src.matchAll(/\bmsg\.(\w+)/g)].map((m) => m[1]));
    if (!fields.size) throw new Error("msg 칸을 하나도 세지 못했다");
    const extra = [...fields].filter((f) => !["type", "key", "paneId", "agentId"].includes(f));
    if (extra.length) throw new Error(`창에서 받는 칸: ${extra.join(", ")}`);
    return true;
  });

  await checkAsync("채팅 서버는 원격 연결과 경로 모양의 서브에이전트 id 를 거절한다", async () => {
    const { handleAgentChat } = await import(url("server/agent-chat.js"));
    const sent = [];
    const ws = (local) => ({ _local: local, readyState: 1, send: (s) => sent.push(JSON.parse(s)), once() {} });
    handleAgentChat(ws(false), { type: "agentchat.open", key: "k1", paneId: "w1:p1" });
    handleAgentChat(ws(true), { type: "agentchat.open", key: "k2", paneId: "w1:p1", agentId: "../../etc/passwd" });
    const kinds = sent.map((m) => `${m.key}:${m.kind}`);
    if (kinds.join(",") !== "k1:error,k2:error") throw new Error(`받은 답: ${kinds.join(",")}`);
    return true;
  });

  await checkAsync("스페이스 줄과 하위 있는 에이전트 줄은 누를 때마다 접힘이 바뀐다", async () => {
    const saved = { document: globalThis.document, window: globalThis.window };
    globalThis.document = { addEventListener() {} };
    globalThis.window = { addEventListener() {} };
    try {
      const els = new Map();
      const $ = (sel) => { if (!els.has(sel)) els.set(sel, fakeEl()); return els.get(sel); };
      const state = await import(url("web/js/herdr/state.js"));
      const tree = await import(url("web/js/explorer/tree.js"));
      const cm = await import(url("web/js/explorer/context-menu.js"));
      const agents = await import(url("web/js/herdr/agents.js"));
      const hooks = await import(url("web/js/core/hooks.js"));
      state.replaceHerdrState({
        agents: [
          { paneId: "w1:p1", workspaceId: "w1", agent: "claude", status: "idle", tabId: "t1",
            subagents: [{ agentId: "sub1", description: "리뷰", agentType: "general", children: [] }] },
          { paneId: "w1:p2", workspaceId: "w1", agent: "codex", status: "idle", tabId: "t2" },
        ],
        workspaces: [{ id: "w1", label: "one" }], tabs: {},
      });
      const collapsed = { groups: new Set(), dirs: new Set() };
      let cur = "w1:p2";
      const esc = (s) => String(s ?? "");
      const spaces = () => [{ id: "w1", label: "one", folder: "/w" }];
      tree.initTree({ $, esc, wsSend() {}, statusClass: () => "", orderedSpaces: spaces, getIsLocal: () => true,
        getSelectedSpaceId: () => "w1", getActiveFile: () => null, setActiveFile() {}, saveCollapsed() {},
        syncWatchDirs() {}, collapsed, dirCache: new Map() });
      // 앱의 focusSpace 처럼 그 스페이스의 에이전트를 고르며 드러낸다(접힌 그룹을 편다).
      const selectSession = (pane) => { cur = pane; agents.revealAgentRow(pane); };
      cm.initContextMenu({ $, esc, wsSend() {}, showToast() {}, copyText: async () => true, isFileLikeKind: () => true,
        getIsLocal: () => true, getSelectedSpaceId: () => "w1", orderedSpaces: spaces, saveOrder() {},
        focusSpace: () => selectSession("w1:p1") });
      agents.initAgents({ $, esc, cssEsc: esc, statusClass: () => "", wsSend() {}, getIsLocal: () => true,
        getCurTarget: () => cur, orderedSpaces: spaces, spk: (id) => id, saveCollapsed() {}, selectSession,
        copyText: async () => true, showToast() {}, getSelectedSpaceId: () => "w1", collapsed, renderSpaces: tree.renderSpaces });
      const list = $("#space-list");
      const fire = (match) => { for (const fn of list.listeners.click || []) fn(clickEvent(match)); };

      const spaceRow = { dataset: { space: "w1" } };
      const spaceSeen = [];
      for (let i = 0; i < 4; i++) {
        fire((sel) => (sel === ".space-row" ? spaceRow : null));
        spaceSeen.push(collapsed.groups.has("w1") ? "접힘" : "펴짐");
      }
      if (spaceSeen.join(",") !== "접힘,펴짐,접힘,펴짐") throw new Error(`스페이스 줄 4번: ${spaceSeen.join(",")}`);

      const agentRow = { dataset: { target: "w1:p1" } };
      cur = "w1:p2";
      const branchSeen = [];
      for (let i = 0; i < 4; i++) {
        fire((sel) => (sel === ".srow" ? agentRow : null));
        tree.renderSpaces();
        branchSeen.push(/data-sub-agent="sub1"/.test(list.innerHTML) ? "펴짐" : "접힘");
      }
      if (cur !== "w1:p1") throw new Error("고르지 않은 줄을 눌렀는데 선택이 옮겨지지 않았다");
      if (branchSeen.join(",") !== "접힘,펴짐,접힘,펴짐") throw new Error(`에이전트 줄 4번: ${branchSeen.join(",")}`);

      let opened = null;
      hooks.provide("agentchat.openSubagent", (info) => { opened = info; });
      const info = { dataset: { subPane: "w1:p1", subAgent: "sub1", subDesc: "리뷰", subType: "general" } };
      fire((sel) => (sel === ".agent-info-row[data-sub-agent]" ? info : null));
      if (!opened || opened.paneId !== "w1:p1" || opened.agentId !== "sub1") throw new Error(`서브에이전트 줄이 연 것: ${JSON.stringify(opened)}`);
      return true;
    } finally {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
    }
  });

  const km = await import(url("web/js/core/keymap.js"));
  check("채팅 보기 단축키는 키맵의 다른 항목과 겹치지 않는다", () => {
    const list = km.resolvedKeymap();
    if (!list.some((x) => x.id === "agent-chat")) throw new Error("agent-chat 항목이 없다");
    const hit = km.findConflicts(list).find((c) => c.ids.includes("agent-chat"));
    if (hit) throw new Error(`${hit.keys} 가 ${hit.ids.join(", ")} 와 겹친다`);
    if (!read("web/js/agentchat/boot.js").includes('bindingOf("agent-chat")')) throw new Error("채팅 보기가 표의 바인딩으로 판정하지 않는다");
    return true;
  });
}
