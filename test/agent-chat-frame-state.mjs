import assert from "node:assert/strict";
import test from "node:test";
import { withWebPage } from "./lib/web-page.mjs";

test("대화 본문은 바뀌거나 프레임이 다시 준비될 때 전송", async () => {
  const result = await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const agent = { paneId: "p", sessionUuid: "s", agent: "codex" };
      const agents = [agent, { paneId: "other", agent: "shell" }];
      const { callHook } = await import("/js/core/hooks.js");
      window.removeOther = () => { agents.pop(); callHook("agentchat.sync"); };
      window.startRunning = () => { agent.status = "working"; callHook("agentchat.sync"); };
      window.ws = initCapability({ getCurTarget: () => "p", getLastAgents: () => agents,
        wsSend() {}, esc: (s) => s }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
    });
    await page.waitForFunction(() => document.querySelector(".achat-frame")?.contentWindow?.states?.length);
    return page.evaluate(async () => {
      const frame = document.querySelector(".achat-frame").contentWindow;
      const key = frame.states.at(-1).key;
      const messages = Array.from({ length: 300 }, (_, i) => ({ id: String(i), text: "a".repeat(1024) }));
      const update = (kind, extra) => ws["agentchat." + kind]({ key, ...extra });
      const flush = () => new Promise((resolve) => {
        frame.addEventListener("message", function done(e) {
          if (e.data !== "flush") return;
          frame.removeEventListener("message", done);
          resolve();
        });
        frame.postMessage("flush", location.origin);
      });
      frame.states.length = 0;
      update("frame", { kind: "snapshot", messages });
      for (let i = 0; i < 20; i++) update("meta", { draft: { text: String(i) } });
      await flush();
      const count = frame.states.length;
      removeOther();
      await flush();
      if (frame.states.length !== count) throw Error("다른 터미널이 닫힐 때 열린 대화를 다시 전송했습니다");
      startRunning();
      await flush();
      if (!frame.states.at(-1).running) throw Error("현재 대화의 실행 상태를 갱신하지 않았습니다");
      const full = frame.states.filter((s) => s.messages).length;
      const bytes = frame.states.reduce((n, s) => n + new TextEncoder().encode(JSON.stringify(s)).length, 0);
      const draft = frame.states.at(-1).draft.text;
      update("older", { messages: [{ id: "older" }] });
      update("frame", { kind: "append", messages: [{ id: "new" }] });
      await flush();
      const ids = frame.states.at(-1).messages.map((m) => m.id);
      for (const supports of [true, false]) {
        const ready = new MessageEvent("message", { source: frame, origin: location.origin,
          data: { type: "iris-chat.ready", reuseMessages: supports } });
        window.dispatchEvent(ready);
        await flush();
        if (frame.states.at(-1).messages?.length !== 302) throw Error("프레임 재시작 후 기록 누락");
      }
      update("meta", {});
      await flush();
      return { full, bytes, draft, first: ids[0], last: ids.at(-1), legacy: frame.states.at(-1).messages.length };
    });
  }, {
    body: '<div id="right"><div class="right-head"></div></div><div id="terminal"></div>',
    overrides: { "/frame.html": `<script>
      window.states = [];
      addEventListener("message", e => { if (e.data?.type === "iris-chat.state") states.push(e.data.state); });
      parent.postMessage({type:"iris-chat.ready", reuseMessages:true}, location.origin);
    </script>` },
  });
  console.log("본문 전송 횟수와 상태 JSON 바이트", result.full, result.bytes);
  assert.equal(result.full, 1);
  assert.deepEqual([result.draft, result.first, result.last, result.legacy], ["19", "older", "new", 302]);
});

test("임베디드 대화의 원본 행과 권한 요청을 해당 pane에 전달한다", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const agents = [{ paneId: "A", sessionUuid: "a", embeddedProvider: "gemini", status: "blocked" },
        { paneId: "B", sessionUuid: "b", agent: "codex" }];
      let target = "A";
      window.sent = [];
      window.ws = initCapability({ getCurTarget: () => target, getLastAgents: () => agents, esc: String,
        wsSend(message) { sent.push(message); return true; } }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      window.select = (id) => { target = id; callHook("agentchat.sync"); };
    });
    const item = { type: "tool_call", callId: "read-1", name: "read", status: "completed", detail: { type: "plain_text", text: "read result" } };
    const request = { id: "permission-1", provider: "gemini", name: "Ask", kind: "question", title: "Continue?" };
    const row = { item, seqStart: 7, timestamp: "2026-11-25T00:00:00Z", turnId: "turn-A" };
    const response = { behavior: "allow", updatedInput: { answers: { Choice: "First" } } };
    const settings = { options: { future_option: "enabled" }, features: [{ type: "toggle", id: "future_option", label: "New option", value: true }], lastUsage: { contextWindowUsedTokens: 9200, contextWindowMaxTokens: 200000 }, model: "model-a", thinkingOptionId: "medium", modeId: "plan", controls: [],
      availableModes: [{ id: "plan", label: "Plan" }], models: [{ id: "model-a", provider: "gemini", label: "Model A" }] };
    await page.evaluate(({ item, request, row, settings }) => {
      const update = (sessionUuid) => ws["agentchat.frame"]({ key: "pane:A:a", embedded: true, kind: "snapshot", sessionUuid,
        provider: "gemini", timeline: [item], timelineRows: [row], permissions: [request], status: "running", ...settings });
      update("other");
      if (!document.querySelector(".achat-frame").hidden) throw Error("다른 세션의 대화가 열렸습니다");
      update("a");
    }, { item, request, row, settings });
    await page.waitForFunction(() => document.querySelector(".achat-frame")?.contentWindow?.state?.embedded);
    const state = await page.evaluate(() => {
      window.a = document.querySelector(".achat-frame").contentWindow;
      return a.state;
    });
    assert.equal(state.kind, "gemini");
    assert.equal(state.running, true);
    assert.deepEqual(state.embedded.timelineRows, [row]);
    assert.deepEqual(state.embedded.permissions, [request]);
    for (const [field, value] of Object.entries(settings)) assert.deepEqual(state.embedded[field], value);
    await page.evaluate((item) => ws["agentchat.frame"]({ key: "pane:A:a", embedded: true, sessionUuid: "a",
      provider: "gemini", timeline: [item], permissions: [], status: "idle" }), item);
    await page.waitForFunction(() => a.state.embedded?.timeline);
    assert.deepEqual(await page.evaluate(() => a.state.embedded.timeline), [item]);

    await page.evaluate(({ response }) => {
      a.emit({ type: "iris-chat.permission", id: "reply-A", requestId: "permission-1", response });
      a.emit({ type: "iris-chat.setting", id: "model-A", setting: "model", value: "model-b" });
      a.emit({ type: "iris-chat.setting", id: "thinking-A", setting: "thinking", value: null });
      a.emit({ type: "iris-chat.setting", id: "config-A", setting: "config", value: { options: { future_option: "enabled" } } });
      a.emit({ type: "iris-chat.send", id: "text-A", text: "next" });
      a.emit({ type: "iris-chat.cancel" });
    }, { response });
    await page.waitForFunction(() => sent.some((message) => message.type === "agentchat.cancel"));
    await page.evaluate(() => {
      select("B");
      ws["agentchat.frame"]({ key: "pane:B:b", kind: "snapshot", messages: [] });
      a.emit({ type: "iris-chat.permission", id: "inactive-A", requestId: "permission-1", response: { behavior: "deny" } });
      ws["agentchat.permission"]({ type: "agentchat.permission", key: "pane:A:a", id: "reply-A", ok: true });
      ws["agentchat.setting"]({ type: "agentchat.setting", key: "pane:A:a", id: "model-A", ok: false, reason: "모델을 바꿀 수 없습니다" });
    });
    await page.waitForFunction(() => a.replies.some((message) => message.id === "model-A"));
    const result = await page.evaluate(() => ({ writes: sent.filter(({ type }) =>
      ["agentchat.permission", "agentchat.setting", "agentchat.send", "agentchat.cancel"].includes(type)), replies: a.replies }));
    assert.deepEqual(result, { writes: [
      { type: "agentchat.permission", key: "pane:A:a", id: "reply-A", requestId: request.id, response },
      { type: "agentchat.setting", key: "pane:A:a", id: "model-A", setting: "model", value: "model-b" },
      { type: "agentchat.setting", key: "pane:A:a", id: "thinking-A", setting: "thinking", value: null },
      { type: "agentchat.setting", key: "pane:A:a", id: "config-A", setting: "config", value: { options: { future_option: "enabled" } } },
      { type: "agentchat.send", key: "pane:A:a", id: "text-A", text: "next" },
      { type: "agentchat.cancel", key: "pane:A:a" },
    ], replies: [
      { type: "iris-chat.permission", id: "reply-A", ok: true },
      { type: "iris-chat.setting", id: "model-A", ok: false, reason: "모델을 바꿀 수 없습니다" },
    ] });
  }, {
    body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": `<script>
      window.replies = [];
      window.emit = (data) => parent.postMessage({ key: state.key, ...data }, location.origin);
      addEventListener("message", ({data}) => {
        if (data?.type === "iris-chat.state") window.state = data.state;
        else if (["iris-chat.permission", "iris-chat.setting"].includes(data?.type)) replies.push(data);
      });
      parent.postMessage({ type: "iris-chat.ready", reuseMessages: true }, location.origin);
    </script>` },
  });
});

test("새 탭 메뉴는 준비된 대화 제공자와 기본 보기를 확인한다", async () => {
  await withWebPage(async (page) => {
    const result = await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const { initHerdrTabs, createItems } = await import("/js/panel/herdr-tabs.js");
      const sent = [];
      const opts = { $: (selector) => document.querySelector(selector), getIsLocal: () => true,
        getSelectedSpaceId: () => "w", getCurTarget: () => null, getLastAgents: () => [], esc: String,
        wsSend: (msg) => { sent.push(msg); return true; } };
      initHerdrTabs(opts);
      const fallback = createItems("w").map((item) => item.label);
      createItems("w").find((item) => item.label.includes("Antigravity")).act();
      const { ws } = initCapability(opts);
      const providers = ["claude", "codex", "antigravity"].map((id) => ({ id, label: id, embedded: true }));
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html", providers });
      for (const item of createItems("w")) item.act();
      callHook("agentchat.settingsSection").set("defaultView", "term");
      createItems("w").find((item) => item.label.includes("claude")).act();
      return { fallback, sent };
    });
    assert.deepEqual(result.fallback, ["새 Claude 세션", "새 Codex 세션", "새 Antigravity 세션", "새 터미널"]);
    assert.deepEqual(result.sent, [
      { type: "tab.create", workspaceId: "w", launch: "antigravity", name: "antigravity" },
      { type: "tab.create", workspaceId: "w", launch: "claude", name: "claude" },
      { type: "tab.create", workspaceId: "w", launch: "codex", name: "codex" },
      { type: "tab.create", workspaceId: "w", launch: "antigravity", name: "antigravity" },
      { type: "tab.create", workspaceId: "w" },
      { type: "tab.create", workspaceId: "w", launch: "claude", name: "claude" },
    ]);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="htabs"></div><div id="terminal"></div>' });
});

test("임베디드 대화의 터미널 버튼은 성공 응답 뒤에만 보기를 전환한다", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      window.sent = [];
      window.toasts = [];
      const claude = { paneId: "A", sessionUuid: "a", agent: "claude", embeddedProvider: "claude", embeddedNative: true, focused: true };
      const codex = { paneId: "B", sessionUuid: "b", agent: "codex", embeddedProvider: "codex", sharedCodex: true, focused: true };
      let current = claude;
      window.ws = initCapability({ getCurTarget: () => current.paneId, getLastAgents: () => [claude, codex], esc: String,
        showToast: (text) => toasts.push(text), wsSend: (message) => sent.push(message) }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      ws["agentchat.frame"]({ key: "pane:A:a", sessionUuid: "a", embedded: true, provider: "claude", status: "idle", timeline: [], permissions: [] });
      window.reply = (ok, reason, id) => ws["agentchat.terminal"]({ type: "agentchat.terminal", key: "pane:A:a",
        id: id ?? sent.findLast((message) => message.type === "agentchat.terminal").id, ok, reason });
      window.shared = () => { current = codex; callHook("agentchat.sync"); };
    });
    await page.waitForFunction(() => document.querySelector(".achat-loading").hidden);
    await page.click(".achat-toggle");
    assert.equal(await page.$eval(".achat-toggle", (el) => el.disabled), true);
    await page.evaluate(() => reply(true, undefined, "different-request"));
    assert.equal(await page.$eval(".achat", (el) => el.hidden), false);
    await page.evaluate(() => reply(false, "대화에서 작업 중입니다"));
    assert.deepEqual(await page.evaluate(() => toasts), ["대화에서 작업 중입니다"]);
    assert.equal(await page.$eval(".achat", (el) => el.hidden), false);
    await page.click(".achat-toggle");
    await page.evaluate(() => reply(true));
    assert.equal(await page.$eval(".achat", (el) => el.hidden), true);
    await page.evaluate(() => shared());
    await page.click(".achat-toggle");
    const requests = await page.evaluate(() => sent.filter((message) => message.type === "agentchat.terminal"));
    assert.deepEqual(requests.map(({ key }) => key), ["pane:A:a", "pane:A:a"]);
    assert.notEqual(requests[0].id, requests[1].id);
    assert.equal(await page.$eval(".achat", (el) => el.hidden), true);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": '<script>parent.postMessage({type:"iris-chat.ready"},location.origin)</script>' } });
});

test("ACP 대화에서 같은 pane의 셸로 바꿨다가 대화로 돌아올 수 있다", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const agent = { paneId: "A", sessionUuid: "a", embeddedProvider: "opencode", embeddedNative: false, focused: true };
      window.sent = [];
      const { ws } = initCapability({ getCurTarget: () => agent.paneId, getLastAgents: () => [agent], esc: String,
        wsSend: (message) => sent.push(message) });
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      ws["agentchat.frame"]({ key: "pane:A:a", sessionUuid: "a", embedded: true, provider: "opencode", status: "running", timeline: [], permissions: [] });
    });
    await page.click(".achat-toggle");
    assert.equal(await page.$eval(".achat", (el) => el.hidden), true);
    await page.click(".achat-toggle");
    assert.equal(await page.$eval(".achat", (el) => el.hidden), false);
    assert.deepEqual(await page.evaluate(() => sent.filter((message) => message.type === "agentchat.terminal")), []);
    assert.deepEqual(await page.evaluate(() => sent.filter((message) => message.type === "agentchat.open").map(({ key }) => key)), ["pane:A:a", "pane:A:a"]);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": '<script>parent.postMessage({type:"iris-chat.ready"},location.origin)</script>' } });
});

test("Gemini 터미널 종료 뒤 같은 대화 기록을 새로 구독한다", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      window.sent = [];
      window.toasts = [];
      const agent = { paneId: "A", sessionUuid: "a", agent: "gemini", embeddedProvider: "gemini", embeddedNative: true, focused: true };
      window.ws = initCapability({ getCurTarget: () => agent.paneId, getLastAgents: () => [agent], esc: String,
        showToast: (text) => toasts.push(text), wsSend: (message) => sent.push(message) }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      window.frame = (items = [], sessionUuid = "a") => ws["agentchat.frame"]({ key: "pane:A:a", sessionUuid,
        embedded: true, provider: "gemini", status: "idle", timeline: items, permissions: [] });
      window.phase = (phase) => { agent.embeddedTerminalPhase = phase; callHook("agentchat.sync"); };
      window.handoff = () => {
        const request = sent.findLast((m) => m.type === "agentchat.terminal");
        ws["agentchat.terminal"]({ ...request, ok: true });
        phase("dispatched");
      };
      window.frame([{ text: "before-terminal" }]);
    });
    await page.waitForFunction(() => document.querySelector(".achat-loading").hidden);
    await page.click(".achat-toggle");
    await page.evaluate(() => handoff());
    await page.click(".achat-toggle");
    assert.equal(await page.evaluate(() => sent.filter((m) => m.type === "agentchat.open").length), 2);
    await page.evaluate(() => ws["agentchat.frame"]({ key: "pane:A:a", kind: "error", reason: "터미널 대화를 종료한 뒤 다시 여세요" }));
    assert.equal(await page.$eval(".achat", (el) => el.hidden), true);
    assert.deepEqual(await page.evaluate(() => toasts), ["터미널 대화를 종료한 뒤 다시 여세요"]);
    for (const [index, text] of ["native first", "native second"].entries()) {
      await page.evaluate(() => phase("exited"));
      await page.click(".achat-toggle");
      if (index === 0) assert.deepEqual(await page.evaluate(() => ({
        visible: !document.querySelector(".achat-frame").hidden,
        marker: document.querySelector(".achat-frame").contentWindow.state?.embedded?.timeline?.[0]?.text,
        loading: !document.querySelector(".achat-loading").hidden,
      })), { visible: true, marker: "before-terminal", loading: false });
      await page.evaluate(() => frame([{ text: "other session" }], "wrong"));
      assert.deepEqual(await page.evaluate(() => ({
        visible: !document.querySelector(".achat-frame").hidden,
        marker: document.querySelector(".achat-frame").contentWindow.state?.embedded?.timeline?.[0]?.text,
      })), { visible: true, marker: index === 0 ? "before-terminal" : "native first" });
      await page.evaluate((text) => frame([{ text }]), text);
      await page.waitForFunction((text) => document.querySelector(".achat-frame").contentWindow.state?.embedded?.timeline?.[0]?.text === text, {}, text);
      await page.evaluate(() => phase(undefined));
      await page.click(".achat-toggle");
      await page.evaluate(() => handoff());
      assert.equal(await page.$eval(".achat", (el) => el.hidden), true);
    }
    assert.deepEqual(await page.evaluate(() => sent.filter((m) => m.type === "agentchat.open").map(({ key }) => key)),
      ["pane:A:a", "pane:A:a", "pane:A:a", "pane:A:a"]);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": '<script>addEventListener("message",e=>{if(e.data.type==="iris-chat.state")window.state=e.data.state});parent.postMessage({type:"iris-chat.ready"},location.origin)</script>' } });
});

test("분기한 대화는 서버가 돌려준 pane에만 원래 대화 첨부를 보낸다", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const agents = [{ paneId: "source", sessionUuid: "source", workspaceId: "w", cwd: "/worktree", embeddedProvider: "gemini" }];
      let target = "source";
      window.sent = [];
      window.ws = initCapability({ getCurTarget: () => target, getLastAgents: () => agents, esc: String,
        wsSend: (msg) => sent.push(msg) }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      window.selectPane = (id) => {
        if (!agents.some((item) => item.paneId === id)) agents.push({ ...agents[0], paneId: id, sessionUuid: id });
        target = id;
        callHook("agentchat.sync");
        ws["agentchat.frame"]({ key: `pane:${id}:${id}`, sessionUuid: id, embedded: true, provider: "gemini", status: "idle", timeline: [], permissions: [] });
      };
      selectPane("source");
    });
    const stateReady = (pane) => page.waitForFunction((id) => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.paneId === id, {}, pane);
    await stateReady("source");
    await page.evaluate(() => document.querySelector(".achat-frame").contentWindow.sendFork());
    await page.waitForFunction(() => sent.some((m) => m.type === "tab.create"));
    const { forkId, ...request } = await page.evaluate(() => sent.find((m) => m.type === "tab.create"));
    assert.ok(forkId);
    assert.deepEqual(request, { type: "tab.create", workspaceId: "w", cwd: "/worktree", launch: "gemini" });
    await page.evaluate(() => selectPane("unrelated"));
    await stateReady("unrelated");
    assert.deepEqual(await page.evaluate(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.attachments), []);
    await page.evaluate((id) => {
      ws["agentchat.fork-opened"]({ id, paneId: "target", ok: true });
      selectPane("target");
    }, forkId);
    await stateReady("target");
    await page.waitForFunction(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.attachments.length);
    assert.deepEqual(await page.evaluate(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.attachments), [
      { type: "iris-chat.fork-attach", key: "pane:target:target", sourceKey: "pane:source:source", attachment: { text: "history" } },
    ]);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": `<script>
      window.attachments = [];
      window.sendFork = () => parent.postMessage({ type: "iris-chat.fork", key: state.key, attachment: { text: "history" } }, location.origin);
      addEventListener("message", ({data}) => {
        if (data?.type === "iris-chat.state") window.state = data.state;
        else if (data?.type === "iris-chat.fork-attach") attachments.push(data);
      });
      parent.postMessage({ type: "iris-chat.ready" }, location.origin);
    </script>` } });
});

test("대화 탭 왕복 뒤에는 마지막 대화에만 보내고 읽던 위치를 복원", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const agents = ["A", "B"].map((id) => ({ paneId: id, tabId: id, agent: "codex", sessionUuid: id }));
      let target = "A";
      window.sent = [];
      window.hook = callHook;
      window.ws = initCapability({
        getCurTarget: () => target, getLastAgents: () => agents, esc: String,
        selectSession(id) { target = id; callHook("agentchat.navigate", { type: "focus", target }); callHook("agentchat.sync"); },
        wsSend(m) { sent.push(m); },
      }).ws;
      window.go = (tabId) => callHook("agentchat.navigate", { type: "tab-focus", origin: "tabstrip", tabId });
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      window.snapshot = (id) => ws["agentchat.frame"]({ key: "pane:" + id + ":" + id, kind: "snapshot", messages: [{ id }] });
      snapshot("A");
    });
    await page.waitForFunction(() => document.querySelector("iframe").contentWindow.key === "pane:A:A");
    assert.equal(await page.evaluate(() => {
      const frame = document.querySelector("iframe").contentWindow;
      frame.scrollTo(0, 300);
      return go("B");
    }), true);
    await page.evaluate(() => snapshot("B"));
    await page.waitForFunction(() => document.querySelector("iframe:not([hidden])").contentWindow.key === "pane:B:B");
    const result = await page.evaluate(() => {
      const b = document.querySelector("iframe:not([hidden])").contentWindow;
      go("A");
      const a = document.querySelector("iframe:not([hidden])").contentWindow;
      for (const frame of [b, a]) window.dispatchEvent(new MessageEvent("message", { origin: location.origin, source: frame,
        data: { type: "iris-chat.send", key: frame.key, text: "hello", id: frame.key } }));
      return { position: a.scrollY, loading: !document.querySelector(".achat-loading").hidden,
        tab: hook("agentchat.selectedTab"), writes: sent.filter(m => m.type === "agentchat.send").map(m => m.key) };
    });
    assert.deepEqual(result, { position: 300, loading: false, tab: "A", writes: ["pane:A:A"] });
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": '<body style="height:3000px"><script>onmessage=e=>{if(e.data.state)window.key=e.data.state.key};parent.postMessage({type:"iris-chat.ready"},location.origin)</script>' } });
});

test("다섯 세션 왕복 시 화면을 재로드하지 않고 유휴 해제 후 기록·초안·스크롤을 복원", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const providers = ["codex", "claude", "agy", "provider-d", "provider-e"];
      const agents = ["A", "B", "C", "D", "E"].map((id, index) => ({
        paneId: id, sessionUuid: id, terminalId: "terminal-" + id, agent: providers[index],
      }));
      let target = "A";
      let otherPanel = false;
      window.hook = callHook;
      window.opened = [];
      const nativeSetTimeout = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) => ms === 5 * 60 * 1000 ? (window.release = fn, 0) : nativeSetTimeout(fn, ms, ...args);
      window.ws = initCapability({ getCurTarget: () => target, getLastAgents: () => agents, herdrShowsOther: () => otherPanel, esc: String,
        wsSend(message) { if (message.type === "agentchat.open") opened.push(message.key); } }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html", build: "build-1", chatProviders: providers });
      window.go = (id) => { target = id; callHook("agentchat.sync"); };
      window.closePanel = () => { otherPanel = true; callHook("agentchat.sync"); };
      window.reopenPanel = () => { otherPanel = false; };
      window.snapshot = (id) => ws["agentchat.frame"]({ key: `pane:${id}:${id}`, kind: "snapshot", messages: [{ id, text: `${id}-last` }] });
      window.draft = (id) => ws["agentchat.meta"]({ key: `pane:${id}:${id}`, draft: { text: `${id}-draft` } });
    });
    await page.waitForFunction(() => document.querySelector(".achat-frame")?.contentWindow?.state?.key === "pane:A:A");
    await page.evaluate(() => {
      snapshot("A");
      draft("A");
      document.querySelector(".achat-frame").contentWindow.scrollTo(0, 320);
    });
    await page.waitForFunction(() => document.querySelector(".achat-frame").contentWindow.state?.messages?.[0]?.text === "A-last");
    for (const id of ["B", "C", "D", "E"]) {
      await page.evaluate((next) => go(next), id);
      await page.waitForFunction((next) => document.querySelector(".achat-frame:not([hidden])")?.contentWindow?.state?.key === `pane:${next}:${next}`, {}, id);
      await page.evaluate((next) => { snapshot(next); draft(next); }, id);
      await page.waitForFunction((next) => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.messages?.[0]?.text === `${next}-last`, {}, id);
    }
    const sequence = ["A", "B", "C", "D", "E", "C", "A", "E"];
    const visible = await page.evaluate((sequence) => sequence.map((id, index) => {
      if (index === 0) { closePanel(); reopenPanel(); }
      go(id);
      const frame = document.querySelector(".achat-frame:not([hidden])");
      return [frame?.contentWindow.state?.messages?.[0]?.text, document.querySelector(".achat-loading").hidden];
    }), sequence);
    assert.deepEqual(visible, sequence.map(id => [id + "-last", true]));
    await page.evaluate(() => { window.framesBeforeRelease = document.querySelectorAll(".achat-frame").length; closePanel(); window.release?.(); reopenPanel(); go("A"); });
    await page.waitForFunction(() => {
      const frame = document.querySelector(".achat-frame:not([hidden])")?.contentWindow;
      return frame?.state?.key === "pane:A:A" && frame.state.messages?.[0]?.text === "A-last";
    });
    const result = await page.evaluate(() => {
      const frame = document.querySelector(".achat-frame:not([hidden])");
      ws["agentchat.frame"]({ key: "pane:B:B", kind: "snapshot", messages: [{ id: "B-new" }] });
      return { message: frame.contentWindow.state.messages[0].text, draft: frame.contentWindow.state.draft?.text,
        scroll: frame.contentWindow.scrollY, frames: document.querySelectorAll(".achat-frame").length,
        framesBeforeRelease, opened };
    });
    assert.deepEqual(result, { message: "A-last", draft: "A-draft", scroll: 320, frames: 1,
      framesBeforeRelease: 5, opened: ["A", "B", "C", "D", "E", ...sequence, "A"].map(id => `pane:${id}:${id}`) });
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": `<body style="height:5000px"><script>
      window.states = [];
      addEventListener("message", ({data}) => { if (data?.type === "iris-chat.state") { window.state = data.state; states.push(data.state); } });
      parent.postMessage({ type: "iris-chat.ready" }, location.origin);
    </script>` } });
});

test("세션·빌드가 바뀌면 익명 또는 이전 대화 캐시를 재사용하지 않는다", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const agent = { paneId: "A", sessionUuid: "one", agent: "codex" };
      const other = { paneId: "B", sessionUuid: "b", agent: "codex" };
      let build = "build-1";
      let target = "A";
      window.ws = initCapability({ getCurTarget: () => target, getLastAgents: () => [agent, other], esc: String, wsSend() {} }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html", build });
      window.snapshot = (text, pane = "A", session = agent.sessionUuid) => ws["agentchat.frame"]({ key: `pane:${pane}:${session}`, kind: "snapshot", messages: [{ text }] });
      window.changeSession = (sessionUuid) => { agent.sessionUuid = sessionUuid; callHook("agentchat.sync"); };
      window.changeBuild = () => { build = "build-2"; ws["agentchat.ui"]({ phase: "ready", url: "/frame.html", build }); };
      window.go = (pane) => { target = pane; callHook("agentchat.sync"); };
      snapshot("one");
    });
    await page.waitForFunction(() => document.querySelector(".achat-frame").contentWindow.state?.messages?.[0]?.text === "one");
    await page.evaluate(() => changeSession(""));
    await page.waitForFunction(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.key === "pane:A:");
    assert.equal(await page.evaluate(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.messages?.[0]?.text), undefined);
    await page.evaluate(() => { snapshot("anonymous"); changeSession("two"); });
    await page.waitForFunction(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.key === "pane:A:two");
    assert.equal(await page.evaluate(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.messages?.[0]?.text), undefined);
    await page.evaluate(() => snapshot("two"));
    await page.waitForFunction(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.messages?.[0]?.text === "two");
    await page.evaluate(() => { go("B"); snapshot("B", "B", "b"); });
    await page.waitForFunction(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.key === "pane:B:b");
    await page.evaluate(() => changeBuild());
    await page.evaluate(() => go("A"));
    await page.waitForFunction(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.key === "pane:A:two");
    assert.equal(await page.evaluate(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.messages?.[0]?.text), undefined);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": `<script>
      addEventListener("message", ({data}) => { if (data?.type === "iris-chat.state") window.state = data.state; });
      parent.postMessage({ type: "iris-chat.ready" }, location.origin);
    </script>` } });
});

test("준비되지 않은 다음 iframe은 캐시된 이전 iframe을 다시 열 때 제거한다", async () => {
  await withWebPage(async (page) => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const agents = ["A", "B"].map((id) => ({ paneId: id, sessionUuid: id, agent: "codex" }));
      let target = "A";
      window.ws = initCapability({ getCurTarget: () => target, getLastAgents: () => agents, esc: String, wsSend() {} }).ws;
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      window.go = (id) => { target = id; callHook("agentchat.sync"); };
      window.snapshot = (id) => ws["agentchat.frame"]({ key: `pane:${id}:${id}`, kind: "snapshot", messages: [{ id }] });
      snapshot("A");
    });
    await page.waitForFunction(() => document.querySelector(".achat-frame").contentWindow.state?.messages?.[0]?.id === "A");
    await page.evaluate(() => go("B"));
    await page.evaluate(() => go("A"));
    await page.waitForFunction(() => document.querySelector(".achat-frame:not([hidden])").contentWindow.state?.messages?.[0]?.id === "A");
    assert.equal(await page.$$eval(".achat-frame", (frames) => frames.length), 1);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": `<script>
      addEventListener("message", ({data}) => { if (data?.type === "iris-chat.state") window.state = data.state; });
      setTimeout(() => parent.postMessage({ type: "iris-chat.ready" }, location.origin), 500);
    </script>` } });
});

test("대화 화면을 확인한 완료 세션에만 읽음 처리를 한 번 요청", async () => {
  await withWebPage(async (page) => {
    await page.bringToFront();
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const agents = [{ paneId: "A", status: "working" }, { paneId: "B", status: "done" }]
        .map((agent) => ({ ...agent, agent: "codex", sessionUuid: agent.paneId }));
      let target = "A";
      window.sent = [];
      const app = initCapability({ getCurTarget: () => target, getLastAgents: () => agents, esc: String,
        wsSend(message) { sent.push(message); return true; } });
      app.ws["agentchat.ui"]({ phase: "ready", url: "/frame.html" });
      window.selectPane = (id) => {
        target = id;
        callHook("agentchat.sync");
        app.ws["agentchat.frame"]({ key: `pane:${id}:${id}`, kind: "snapshot", messages: [] });
      };
      selectPane("A");
    });
    await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.key === "pane:A:A");
    await page.evaluate(() => { selectPane("B"); selectPane("B"); });
    await page.waitForFunction(() => document.querySelector("iframe:not([hidden])")?.contentWindow?.key === "pane:B:B");
    assert.deepEqual(await page.evaluate(() => sent.filter((message) => message.type === "agentchat.seen")),
      [{ type: "agentchat.seen", key: "pane:B:B", session: "B" }]);
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": '<script>onmessage=e=>{if(e.data.state)window.key=e.data.state.key};parent.postMessage({type:"iris-chat.ready"},location.origin)</script>' } });
});

test("일반 실행 중 뒤늦게 받은 카탈로그의 제공자를 기존 패널에서 연다", async () => {
  await withWebPage(async page => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const target = { paneId: "A", terminalId: "term", sessionUuid: "id", agent: "codex-adjacent", focused: true };
      window.sent = [];
      const { ws } = initCapability({ getCurTarget: () => "A", getLastAgents: () => [target], esc: String,
        wsSend: message => sent.push(message) });
      ws["agentchat.ui"]({ phase: "ready", url: "/frame.html", providers: [], chatProviders: ["example"], chatProviderAliases: { "codex-adjacent": "example" } });
      window.frame = () => ws["agentchat.frame"]({ embedded: true, key: "pane:A:id", sessionUuid: "id",
        status: "idle", provider: "example", permissions: [], timeline: [{ type: "notification", level: "info", message: "live" }] });
    });
    assert.equal(await page.$eval(".achat-toggle", el => el.hidden), false);
    if (!await page.evaluate(() => sent.some(m => m.type === "agentchat.open"))) await page.click(".achat-toggle");
    await page.evaluate(() => window.frame());
    await page.waitForFunction(() => document.querySelector(".achat-frame")?.contentWindow?.state?.embedded?.provider === "example");
    assert.equal(await page.evaluate(() => document.querySelector(".achat-frame").contentWindow.state.kind), "example");
    assert.equal(await page.evaluate(() => document.querySelector(".achat-frame").contentWindow.state.embedded.timeline[0].message), "live");
  }, { body: '<div id="right"><header class="right-head"></header></div><div id="terminal"></div>',
    overrides: { "/frame.html": '<script>addEventListener("message",e=>{if(e.data.state?.embedded) window.state=e.data.state});parent.postMessage({type:"iris-chat.ready"},location.origin)</script>' } });
});

test("대화 안의 CLI 입력과 늦게 도착한 종료 이벤트는 연 패널에만 적용된다", async () => {
  await withWebPage(async page => {
    await page.evaluate(async () => {
      const { initCapability } = await import("/js/agentchat/boot.js");
      const { callHook } = await import("/js/core/hooks.js");
      const agents = ["A", "B"].map(id => ({ paneId: id, agent: "claude", sessionUuid: id, terminalId: id }));
      let target = "A";
      window.selectPane = id => { target = id; callHook("agentchat.sync"); };
      window.sent = [];
      window.ws = initCapability({ getCurTarget: () => target, getLastAgents: () => agents,
        wsSend(msg) { sent.push(msg); return true; }, esc: String }).ws;
      window.enable = id => ws["agentchat.cli-available"]({ key: "pane:" + id + ":" + id, available: true });
      enable("A");
    });
    const toggle = "[data-achat-cli]";
    await page.click(toggle);
    await page.keyboard.type("a");
    await page.evaluate(() => {
      selectPane("B");
      enable("B");
      const frame = document.querySelector(".achat-frame:not(.achat-previous)");
      const requestCli = key => window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow, origin: location.origin, data: { type: "iris-chat.open-cli", key },
      }));
      requestCli("pane:A:A");
      if (!document.querySelector(".achat-cli").hidden) throw Error("이전 대화의 요청으로 CLI가 열렸습니다");
      requestCli("pane:B:B");
    });
    await page.evaluate(() => {
      const old = sent.find(m => m.action === "open");
      ws["agentchat.cli"]({ ...old, ended: true });
    });
    await page.keyboard.type("b");
    await page.click(toggle);
    const events = await page.evaluate(() => sent.filter(m => m.type === "agentchat.cli" && m.action !== "resize")
      .map(m => [m.action, m.key, m.data ?? ""]));
    assert.deepEqual(events, [["open","pane:A:A",""], ["input","pane:A:A","a"], ["close","pane:A:A",""],
      ["open","pane:B:B",""], ["input","pane:B:B","b"], ["close","pane:B:B",""]]);
  }, { body: '<link rel="stylesheet" href="/vendor/xterm.css"><link rel="stylesheet" href="/css/35-agent-chat.css"><script src="/vendor/xterm.js"></script><script src="/vendor/addon-fit.js"></script><div id="right"><div class="right-head"></div></div><div id="terminal"></div>' });
});
