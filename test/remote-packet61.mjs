import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentStore } from "../server/remote/agents.js";
import { createTerminalFeature } from "../server/remote/features/terminal.js";
import { createBrowserFeature } from "../server/remote/features/browser.js";
import { isRemoteRequest } from "../server/remote/contract/requests.js";
import { projectFeature } from "../server/remote/projection.js";
import { mediaText, resolveMedia, safeMediaUrl } from "../server/remote/media-links.js";

test("일반 pane 목록·입력·키와 pane 재사용 거부", async () => {
  let panes = [{ pane_id: "pane", terminal_id: "term1", workspace_id: "work", tab_id: "tab" }];
  const calls = [];
  const herdr = { paneList: async () => panes, paneRead: async () => ({ text: "$", revision: 1 }),
    paneSendText: async (...args) => calls.push(args) };
  const agents = createAgentStore({ getSnapshot: () => ({ state: [], workspaces: [{ id: "work", label: "공간" }], tabs: { work: [{ tabId: "tab", label: "셸" }] } }), getHerdr: () => herdr, canMessage: () => true });
  await agents.refresh();
  const item = agents.list()[0];
  assert.equal(item.kind, "terminal"); assert.equal(item.name, "셸");
  assert.deepEqual(item.can, { stop: false, message: false }); assert.equal(item.question, false);
  const terminal = createTerminalFeature({ agents, getHerdr: () => herdr, send() {}, keyRows: {}, setTimer: () => ({ unref() {} }) });
  assert.ok(await terminal.watch({ connId: "phone" }, item.ref));
  assert.equal(await terminal.submit({ connId: "phone" }, "a".repeat(32), "bad"), false);
  assert.equal(await terminal.submit({ connId: "phone" }, item.ref, "a\r\nb"), true);
  assert.deepEqual(calls, [["pane", "\x1b[200~a\nb\x1b[201~\r"]]);
  panes = [{ ...panes[0], terminal_id: "term2" }];
  assert.equal(await terminal.key(item.ref, "Enter", {}), false);
  panes = [];
  assert.equal(await terminal.submit({ connId: "phone" }, item.ref, "bad"), false);
  assert.equal(calls.length, 1);
  terminal.close(); agents.close();
});

test("카탈로그는 홈 스페이스 ref와 세션 ref를 쓰고 이름 중복을 구분", () => {
  const runtime = { state: [{ paneId: "p1", workspaceId: "w1", agent: "codex", tabLabel: "동일" }, { paneId: "p2", workspaceId: "w2", agent: "codex", tabLabel: "동일" }], workspaces: [{ id: "w2", label: "둘" }, { id: "w1", label: "하나" }] };
  const agents = createAgentStore({ getSnapshot: () => runtime });
  const browser = createBrowserFeature({ agents, send() {}, runtimeSnapshot: () => runtime,
    browserState: () => ({ tabsBySpace: { w1: [{ id: "t1", group: "g1", url: "https://example.test" }, { id: "u1" }], w2: [{ id: "t2", group: "g2" }] } }),
    tabMeta: () => null, controlSnapshot: () => [], aiTargetsSnapshot: () => [{ pane: "p1", space: "w1", group: "g1", held: ["t1"] }, { pane: "p2", space: "w2", group: "g2" }] });
  const catalog = browser.catalog();
  assert.deepEqual(catalog.spaces.map((space) => space.name), ["둘", "하나"]);
  assert.equal(catalog.tabs[0].space, agents.resolvePane("p1").spaceRef);
  assert.deepEqual(catalog.tabs[0].sessions, [agents.resolvePane("p1").ref]);
  assert.deepEqual(catalog.tabs[1].sessions, []);
  assert.doesNotThrow(() => projectFeature({ type: "browser.tabs.result", rid: "x", ...catalog }));
  browser.close(); agents.close();
});

test("탭 그룹은 내부 id 대신 그룹 ref를 공개하고 새 탭 결과에 탭 ref를 준다", async () => {
  const space = "a".repeat(32), agentRef = "b".repeat(32);
  const state = { tabsBySpace: { work: [{ id: "t1", group: "secret-group", url: "https://example.test" }] }, groupsBySpace: { work: [{ id: "secret-group", name: "작업", collapsed: true, color: "#f00" }] } };
  const agent = { ref: agentRef, spaceRef: space, source: { workspaceId: "work" } };
  const browser = createBrowserFeature({ agents: { resolve: (ref) => ref === agentRef ? agent : null }, send() {}, browserState: () => state, runtimeSnapshot: () => ({ workspaces: [{ id: "work", label: "공간" }] }), mutateBrowserState: () => true });
  const catalog = browser.catalog();
  assert.equal(catalog.groups[0].name, "작업"); assert.equal(catalog.groups[0].collapsed, true);
  assert.equal(catalog.tabs[0].group, catalog.groups[0].ref); assert.notEqual(catalog.tabs[0].group, "secret-group");
  const result = await browser.newTab({ space, agent: agentRef, url: "https://example.test/new" });
  assert.equal(result.ok, true); assert.match(result.tab, /^[0-9a-f]{32}$/); browser.close();
});

test("파일 링크는 세션에 묶인 ref만 공개하고 허용 경로를 열 때 다시 검사", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iris61-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, "state"); fs.mkdirSync(stateDir);
  const doc = path.join(home, "문서.pdf"); fs.writeFileSync(doc, "pdf");
  const secret = path.join(stateDir, "secret.html"); fs.writeFileSync(secret, "secret");
  const outside = path.join(home, "outside.pdf"); fs.symlinkSync("/etc/hosts", outside);
  const options = { home, stateDir, cwd: home };
  for (const value of [doc, pathToFileURL(doc).href, "문서.pdf"]) assert.equal(safeMediaUrl(value, options), pathToFileURL(doc).href);
  for (const value of [secret, outside, "/etc/hosts", "javascript:alert(1)", "https://example.test", "x".repeat(2049)]) assert.equal(safeMediaUrl(value, options), null);
  const agent = { ref: "a".repeat(32), source: { cwd: home } };
  const text = mediaText(`[문서](${doc})\n${doc}\n[웹](https://example.test/a.pdf)`, agent);
  assert.ok(!text.includes(home)); assert.ok(text.includes("https://example.test/a.pdf"));
  const ref = /iris-media:([0-9a-f]{32})/.exec(text)[1];
  assert.equal(resolveMedia(ref, agent, options), pathToFileURL(doc).href);
  assert.equal(resolveMedia(ref, { ...agent, ref: "b".repeat(32) }, options), null);
  fs.unlinkSync(doc); assert.equal(resolveMedia(ref, agent, options), null);
});

test("사용자 새 탭 요청 URL 종류와 에이전트 스페이스 검사", async () => {
  const space = "a".repeat(32), agentRef = "b".repeat(32);
  const base = { type: "browser.tab.new", rid: "x", space, agent: agentRef };
  for (const url of ["https://example.test/a.pdf", "http://localhost:3000/a.html"]) assert.equal(isRemoteRequest({ ...base, url }), true);
  for (const url of ["file:///Users/you/x.pdf", "/Users/you/x.pdf", "../x.pdf", "javascript:alert(1)", "data:text/html,x", "https://example.test/" + "x".repeat(2048)]) assert.equal(isRemoteRequest({ ...base, url }), false);
  const mutations = [];
  const agent = { ref: agentRef, spaceRef: space, source: { workspaceId: "w" } };
  const browser = createBrowserFeature({ agents: { resolve: (ref) => ref === agentRef ? agent : null }, send() {}, browserState: () => ({}), runtimeSnapshot: () => ({}), controlSnapshot: () => [], mutateBrowserState: (value) => { mutations.push(value); return true; } });
  assert.equal((await browser.newTab({ ...base, url: "https://example.test/a.html" })).ok, true);
  assert.equal(mutations[0].space, "w");
  assert.equal((await browser.newTab({ ...base, space: "c".repeat(32), url: "https://example.test" })).code, "forbidden");
  assert.equal((await browser.newTab({ ...base, media: "f".repeat(32) })).code, "forbidden");
  assert.equal(mutations.length, 1); browser.close();
});
