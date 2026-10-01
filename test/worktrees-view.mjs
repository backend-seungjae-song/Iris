// 사이드바 worktree 위치·변경량·안 쓰는 목록의 HTML 계약.
// 소유 범위: 앱 셸 에이전트 행 훅과 web/js/worktrees/boot.js 목록 HTML의 격리된 회귀 검사.
// 제공 API: node --test test/worktrees-view.mjs.
// 의존 대상: 실제 explorer/tree.js·herdr/agents.js·herdr/state.js. DOM은 최소 대역.
// 유지 조건: 네트워크·사용자 파일을 쓰지 않는다.
// 영향 범위: web/js/herdr/agents.js, web/js/worktrees/boot.js.

import test from "node:test";
import assert from "node:assert/strict";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const listeners = [];
const element = () => ({ innerHTML: "", hidden: false, addEventListener(type, fn, options) { listeners.push([type, fn, options]); },
  querySelector: () => null, querySelectorAll: () => [], classList: { contains: () => false }, after() {}, nextElementSibling: null,
  getBoundingClientRect: () => ({ top: 0, bottom: 400 }) });
const spaceList = element();
globalThis.document = { getElementById: (id) => (id === "space-list" ? spaceList : null), querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, createElement: () => ({ setAttribute() {}, classList: { contains: () => false }, remove() {} }) };

const { initTree, renderSpaces } = await import("../web/js/explorer/tree.js");
const { initAgents, revealAgentRow } = await import("../web/js/herdr/agents.js");
const { replaceHerdrState } = await import("../web/js/herdr/state.js");
const { callHook } = await import("../web/js/core/hooks.js");
const { initCapability } = await import("../web/js/worktrees/boot.js");

const REPO = "/r/project", WT = "/r/project-worktrees";
let spaces = [{ id: "s1", folder: REPO, label: "project" }];
let selectedPane = "";
const sent = [];
const focused = [];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const $ = (selector) => selector === "#space-list" ? spaceList : element();
initAgents({ $, esc, cssEsc: String, wsSend() {}, getIsLocal: () => true, getCurTarget: () => selectedPane,
  orderedSpaces: () => spaces, spk: String, saveCollapsed() {}, selectSession: (pane) => { selectedPane = pane; },
  copyText: async () => true, showToast() {}, getSelectedSpaceId: () => "s1", collapsed: { groups: new Set() }, renderSpaces });
initTree({ $, esc, wsSend() {}, orderedSpaces: () => spaces, getIsLocal: () => true, getSelectedSpaceId: () => "s1",
  getActiveFile: () => null, setActiveFile() {}, saveCollapsed() {}, syncWatchDirs() {}, collapsed: { dirs: new Set() }, dirCache: new Map() });
replaceHerdrState({ workspaces: spaces, agents: [{ paneId: "plain", workspaceId: "s1", tabId: "plain-tab", agent: "codex", status: "idle", tabLabel: "그대로" }] });
renderSpaces();
const featureOffHtml = spaceList.innerHTML;

const { ws } = initCapability({ esc, wsSend: (message) => sent.push(message), showToast() {}, orderedSpaces: () => spaces,
  getSelectedSpaceId: () => "s1", getIsLocal: () => true, selectSession: (pane) => { selectedPane = pane; },
  focusSpace: (id) => focused.push(id) });

const primary = (repo = REPO) => ({ path: repo, branch: "main", primary: true, managed: false });
const change = (fields = {}) => ({ base: "main", ahead: 0, added: 0, deleted: 0, uncommitted: 0,
  lastCommitAt: new Date().toISOString(), ...fields });
const wt = (name, fields = {}) => ({ path: `${WT}/${name}`, branch: `feat/${name}`, primary: false, prunable: false,
  managed: true, users: [], running: [], creator: null, change: change(), ...fields });

function answer(request, entries, extra = {}) {
  ws["worktrees.result"]({ type: "worktrees.result", requestId: request.requestId, op: "list", ok: true,
    repo: request.repo, primary: extra.primary || REPO, entries, branches: ["main"], ...extra });
}
function flush(responses) {
  renderSpaces();
  for (const request of sent.splice(0)) {
    if (request.type !== "worktrees.list") continue;
    const response = responses(request);
    if (response?.error) ws["worktrees.result"]({ type: "worktrees.result", requestId: request.requestId, op: "list", ok: false,
      code: response.error, message: "" });
    else answer(request, response.entries, response.extra);
  }
  renderSpaces();
  return spaceList.innerHTML;
}
function rowOf(html, name) {
  const at = html.indexOf(`data-wt-path="${WT}/${name}"`);
  assert.ok(at >= 0, `${name} 행`);
  const end = html.indexOf("</div></div>", at);
  return html.slice(at, end < 0 ? undefined : end + "</div></div>".length);
}
function agentRowOf(html, paneId) {
  return sliceBetween(html, `data-target="${paneId}"`, "</div>", `${paneId} 에이전트 행`);
}
function clickAction(dataset) {
  const button = { dataset, matches: () => false, closest: (selector) => selector === "[data-worktree-action]" ? button : null };
  const event = { target: button, stopPropagation() {}, stopImmediatePropagation() {}, preventDefault() {} };
  for (const [type, fn] of listeners) if (type === "click") fn(event);
}

function setup(entries, agents = [], extra = {}, tabs = []) {
  const spaceId = `space-${++fixtureSequence}`;
  const repo = extra.folder || `/fixture/${fixtureSequence}`;
  spaces = [{ id: spaceId, folder: repo, label: "작업" }];
  replaceHerdrState({ workspaces: spaces, agents: agents.map(agent => ({workspaceId:spaceId,agent:'codex',status:'idle',tabId:`tab-${agent.paneId}`, ...agent})), tabs: {[spaceId]: tabs} });
  const html = flush(() => ({entries, extra: {primary:repo, ...extra}}));
  return {html, spaceId, repo};
}
let fixtureSequence = 0;
function groupOf(html, path) {
  const at = html.indexOf(`class="wt-group" data-wt-group=`);
  const groups = html.slice(at).split('<div class="wt-group"');
  return groups.find(group => group.includes(`data-wt-path="${path}"`)) || '';
}

test("기능을 껐거나 목록을 받기 전에는 에이전트 HTML이 그대로다", () => {
  assert.equal(spaceList.innerHTML, featureOffHtml);
});

test("스페이스 아래 워크트리에 같은 경로의 세션과 그 하위 에이전트를 한 번씩 묶는다", () => {
  const entries = [primary('/fixture/1'), wt('search'), wt('review')];
  const {html} = setup(entries, [
    {paneId:'main',cwd:'/fixture/1'},
    {paneId:'search-a',cwd:`${WT}/search`},
    {paneId:'search-b',cwd:`${WT}/search/sub`},
    {paneId:'child',parentPaneId:'search-a',cwd:`${WT}/review`,lineageLabel:'검증 담당'},
  ]);
  const group = groupOf(html, `${WT}/search`);
  assert.match(group, /wt-group-name">search</);
  for (const pane of ['search-a','search-b','child']) {
    assert.match(group, new RegExp(`data-target="${pane}"`));
    assert.equal(html.split(`data-target="${pane}"`).length - 1, 1);
  }
  assert.match(groupOf(html, '/fixture/1'), /data-target="main"/);
  assert.doesNotMatch(html, /class="wt-loc"/);
  assert.match(group, /data-tree-parent="space-1:/);
});

test("동일 작업 폴더의 저장소별 워크트리는 묶고 같은 브랜치의 다른 경로는 분리한다", () => {
  const task='/multi/.working/sample-task';
  const repositories=['client','server','admin'].map(name=>({repo:`/multi/${name}`,primary:`/multi/${name}`,branches:['main'],entries:[
    primary(`/multi/${name}`), wt(name,{path:`${task}/worktrees/${name}`,branch:'feat/quest',taskUsers:[{paneId:'multi',sessionUuid:'session'}]}),
    wt('other',{path:`/other/${name}`,branch:'feat/quest'}),
  ]}));
  const {html}=setup([], [{paneId:'multi',sessionUuid:'session',cwd:'/multi'}], {folder:'/multi',primary:null,repositories});
  const group=groupOf(html,task);
  assert.match(group,/wt-group-name">sample-task</);
  assert.doesNotMatch(html,/저장소 \d+개|wt-repositor|repositories-toggle/);
  assert.match(group,/data-target="multi"/);
  assert.equal(html.split('data-target="multi"').length-1,1);
  for(const name of ['client','server','admin']) assert.ok(groupOf(html,`/other/${name}`));
  for(const name of ['client','server','admin']) assert.doesNotMatch(html,new RegExp(`data-wt-path="${task}/worktrees/${name}"`));
});

test("작업 폴더 바로 아래 저장소 워크트리도 같은 작업으로 묶는다", () => {
  const task='/direct/.working/sample-task';
  const repositories=['client','server'].map(name=>({repo:`/direct/${name}`,primary:`/direct/${name}`,entries:[primary(`/direct/${name}`),wt(name,{path:`${task}/${name}`,taskUsers:[{paneId:'direct',sessionUuid:'now'}]})]}));
  const {html}=setup([], [{paneId:'direct',sessionUuid:'now',cwd:'/direct'}], {folder:'/direct',primary:null,repositories});
  assert.match(groupOf(html,task), /data-target="direct"/);
  assert.equal(html.split('data-target="direct"').length-1,1);
});

test("이전 대화의 작업 기록은 현재 세션을 옮기지 않는다", () => {
  const {html,repo}=setup([wt('stale',{taskUsers:[{paneId:'reused',sessionUuid:'old'}]})], [{paneId:'reused',sessionUuid:'new'}]);
  assert.match(groupOf(html,repo),/data-target="reused"/);
  assert.doesNotMatch(groupOf(html,`${WT}/stale`),/data-target="reused"/);
});

test("서로 다른 작업에 연결된 세션은 기본 그룹에 한 번 표시한다", () => {
  const {html,repo}=setup(['a','b'].map(name=>wt(name,{taskUsers:[{paneId:'cross',sessionUuid:'s'}]})), [{paneId:'cross',sessionUuid:'s'}]);
  assert.match(groupOf(html,repo),/data-target="cross"/);
  assert.equal(html.split('data-target="cross"').length-1,1);
});

test("일반 터미널은 pane 경로에 따라 묶고 에이전트 탭은 중복하지 않는다", () => {
  const id=`space-${fixtureSequence+1}`;
  const {html}=setup([wt('shell')],[{paneId:'agent',cwd:`${WT}/shell`,tabId:'agent-tab'}],{panes:[
    {paneId:'shell',workspaceId:id,tabId:'shell-tab',cwd:`${WT}/shell/sub`},
    {paneId:'agent',workspaceId:id,tabId:'agent-tab',cwd:`${WT}/shell`},
  ]},[{tabId:'shell-tab',label:'개발 서버',focused:true},{tabId:'agent-tab',label:'에이전트'}]);
  assert.match(groupOf(html,`${WT}/shell`),/data-wt-tab="shell-tab"/);
  assert.match(html,/class="srow-name">개발 서버<\/span><span class="srow-mark wt-terminal-sign"/);
  assert.doesNotMatch(html,/data-wt-tab="agent-tab"/);
  sent.length=0;
  clickAction({worktreeAction:'terminal',wtTab:'shell-tab'});
  assert.deepEqual(sent.pop(),{type:'tab-focus',tabId:'shell-tab',origin:'sidebar'});
});

test("워크트리를 접어도 reveal 요청으로 고른 세션을 다시 표시한다", () => {
  const {spaceId}=setup([wt('fold')],[{paneId:'folded',cwd:`${WT}/fold`}]);
  clickAction({worktreeAction:'group-toggle',wtGroup:`${spaceId}:${WT}/fold`});
  assert.doesNotMatch(spaceList.innerHTML,/data-target="folded"/);
  assert.equal(callHook('worktrees.revealAgent',{spaceId,paneId:'folded'}),true);
  renderSpaces();
  assert.match(spaceList.innerHTML,/data-target="folded"/);
});

test("표시 이름은 폴더·브랜치 경로를 바꾸지 않고 HTML을 이스케이프한다", () => {
  const {html}=setup([wt('label',{label:'검색 <개선>',branch:'feat/original'})]);
  const group=groupOf(html,`${WT}/label`);
  assert.match(group,/검색 &lt;개선&gt;/);
  assert.match(group,/feat\/original/);
  assert.match(group,/data-wt-path="\/r\/project-worktrees\/label"/);
});

test("조회할 수 없는 스페이스는 기존 세션을 숨기지 않는다", () => {
  spaces=[{id:'no-git',folder:'/no-git',label:'문서'}];
  replaceHerdrState({workspaces:spaces,agents:[{paneId:'plain',workspaceId:'no-git',tabId:'plain',agent:'codex',status:'idle'}]});
  const html=flush(()=>({error:'REPO'}));
  assert.match(html,/data-target="plain"/);
  assert.doesNotMatch(html,/class="wt-group"/);
});

test("숨겨져 있던 새 하위 에이전트도 현재 부모의 워크트리를 펼친다", () => {
  const {spaceId}=setup([wt('new-child')],[{paneId:'parent',cwd:`${WT}/new-child`}]);
  clickAction({worktreeAction:'group-toggle',wtGroup:`${spaceId}:${WT}/new-child`});
  replaceHerdrState({workspaces:spaces,agents:[
    {paneId:'parent',workspaceId:spaceId,agent:'codex',cwd:`${WT}/new-child`},
    {paneId:'new-child',parentPaneId:'parent',workspaceId:spaceId,agent:'codex',cwd:'/elsewhere'},
  ]});
  assert.equal(callHook('worktrees.revealAgent',{spaceId,paneId:'new-child'}),true);
  renderSpaces();
  assert.match(spaceList.innerHTML,/data-target="new-child"/);
});


test("하위 폴더의 linked worktree를 다시 읽어도 같은 실제 경로는 한 번만 표시한다", () => {
  const repo='/duplicates/client', task='/duplicates/client-dice-levelup';
  const entries=[primary(repo),wt('dice',{path:task,branch:'fix/dice-levelup-popup'})];
  const {html}=setup([],[],{folder:'/duplicates',primary:null,repositories:[
    {repo,primary:repo,branches:['main'],entries},
    {repo:task,primary:repo,branches:['main'],entries},
  ]});
  assert.equal(html.split(`class="wt-group" data-wt-group="${spaces[0].id}:${task}"`).length-1,1);
  assert.doesNotMatch(html,/choose-repo/);
});
