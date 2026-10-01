// Git Worktree 기능의 목록, 생성 대화상자, 관리 메뉴와 서버 응답을 연결한다.
//
// 소유 범위
//   스페이스·워크트리·세션 계층, 표시 이름, Worktree 생성·열기·삭제와 진행·오류 상태.
// 제공 API
//   initCapability(ctx) → { ws }; worktrees.* 훅을 등록한다.
// 의존 대상
//   Explorer의 기존 스페이스·에이전트 렌더러와 메뉴·대화상자, core dropdown, worktrees.* 서버 메시지.
// 유지 조건
//   실제 스페이스 행과 에이전트 HTML을 그대로 사용한다. 불확실한 쓰기 결과는 자동 재시도하지 않는다.
// 영향 범위
//   explorer/tree·context-menu의 worktrees 훅, main의 space-created 훅, 서버 Worktree handler.

import { provide } from "../core/hooks.js";
import { createDropdown } from "../core/dropdown.js";
import { renderSpaces } from "../explorer/tree.js";
import { askConfirm, askInfo, askText, showCtx } from "../explorer/context-menu.js";
import { getLastAgents, getTabsForSpace, nameOf } from "../herdr/state.js";
import { buildAgentForest } from "../herdr/agent-tree.js";

let app;
let sequence = 0;
const requests = new Map();
const byFolder = new Map();
const activeOps = new Set();
const uncertainRepos = new Set();
const pendingCreates = new Map();
const pendingBinds = new Map();
const BIND_WAIT_MS = 120000;
const REQUEST_TIMEOUT_MS = 90000;
const LIST_TTL_MS = 30000;
function id() { return `wt-${Date.now().toString(36)}-${++sequence}`; }
function request(op, data) {
  const requestId = id();
  const timer = setTimeout(() => {
    const pending = requests.get(requestId);
    if (!pending) return;
    requests.delete(requestId);
    if (op === "list") byFolder.set(data.repo, { error: "서버 응답이 없습니다", fetchedAt: Date.now() });
    else if (op === "launched") return;
    else {
      // 서버가 이미 Git 작업을 마쳤을 수 있어 같은 쓰기를 다시 보내지 않는다.
      uncertainRepos.add([...byFolder.values()].find((entry) => entry?.repo === data.repo)?.primary || data.repo);
      app.showToast("worktree 작업 결과를 받지 못했습니다. ⌘⇧R로 새로고침하세요", { level: "err", id: pending.toastId });
      if (op === "create") pendingCreates.delete([...byFolder.values()].find((entry) => entry?.repo === data.repo)?.primary || data.repo);
    }
    renderSpaces();
  }, REQUEST_TIMEOUT_MS);
  requests.set(requestId, { op, ...data, timer });
  app.wsSend({ type: `worktrees.${op}`, requestId, ...data });
  return requestId;
}
// 만들기·삭제 진행 알림. 결과·시간 초과 알림이 같은 id 로 이 알림을 바꿈
function progressFor(requestId, title) {
  const pending = requests.get(requestId);
  if (pending) pending.toastId = app.showToast(title, { level: "progress", ttl: Date.now() + REQUEST_TIMEOUT_MS + 10000 });
}
function samePath(a, b) { return a && b && a.replace(/\/$/, "") === b.replace(/\/$/, ""); }
function esc(s) { return app.esc(String(s ?? "")); }
// Claude Code 가 하위 에이전트마다 만드는 임시 worktree 다. 열린 스페이스가 아니면 목록에 세지 않는다.
const SUBAGENT_WORKTREE = /\/\.claude\/worktrees\/agent-[^/]+\/?$/;
let composing = null, draft = "", draftError = "", draftCaret = null;
const ICON = {
  caret: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
  terminal: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 6 6 6-6 6M13 18h6"/></svg>`,
  worktree: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-6 4-12 8"/></svg>`,
  plus: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
};
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function entryOf(space) {
  return byFolder.get(space.folder)?.entries?.find((entry) => samePath(entry.path, space.folder));
}
function folderName(path) { return path.replace(/\/$/, "").split("/").pop(); }
// 이 worktree 를 쓰는 세션. 서버 목록(TTL 30초)에 지금 에이전트 상태를 겹치고,
// 목록 뒤에 들어온 에이전트는 cwd 로 더한다. 서버가 모른다고 한 경우(null)는 그대로 null 이다.
function under(root, dir) { return !!dir && (samePath(dir, root) || dir.startsWith(root.replace(/\/$/, "") + "/")); }
function liveAgents() { return new Map(getLastAgents().filter((a) => a.paneId).map((a) => [a.paneId, a])); }
function asAgent(a) { return { kind: "agent", workspaceId: a.workspaceId, paneId: a.paneId, agent: a.agent, status: a.status, question: a.question, label: nameOf(a) }; }
function usersOf(item) {
  if (!Array.isArray(item?.users)) return null;
  const live = liveAgents();
  const out = [], seen = new Set();
  for (const user of item.users) {
    if (user.kind === "space") { out.push(user); continue; }
    const agent = live.get(user.paneId);
    seen.add(user.paneId);
    if (agent) out.push(asAgent(agent));
    else out.push(user);
  }
  for (const agent of live.values()) if (!seen.has(agent.paneId) && under(item.path, agent.cwd)) out.push(asAgent(agent));
  return out;
}
// 실행 중: 서버가 목록 요청 때 조사한 pane. 현재 목록에 없는 pane 도 터미널 줄에서 보존
function runningOf(item) {
  if (!Array.isArray(item?.running)) return null;
  const live = liveAgents();
  return item.running.flatMap((user) => {
    const agent = live.get(user.paneId);
    if (agent) return [asAgent(agent)];
    return [user];
  });
}
function includesPane(users, paneId) {
  return Array.isArray(users) && users.some((user) => user.paneId === paneId);
}
function taskIncludesPane(item, paneId) {
  const agent = getLastAgents().find((candidate) => candidate.paneId === paneId);
  return !!agent?.sessionUuid && (item.taskUsers || []).some((user) => user.paneId === paneId && user.sessionUuid === agent.sessionUuid);
}
// 폴더가 지워진 스페이스(지운 worktree 로 연 스페이스 등). 닫기는 사용자 몫
function markMissing(rowHtml) {
  const nameAt = rowHtml.indexOf('<span class="space-name">');
  const nameEnd = nameAt < 0 ? -1 : rowHtml.indexOf("</span>", nameAt) + "</span>".length;
  if (nameAt < 0 || nameEnd < nameAt) return rowHtml;
  return rowHtml.slice(0, nameEnd) + `<span class="wt-gone" title="스페이스 폴더가 지워졌습니다. 필요 없으면 스페이스를 닫으세요">폴더 없음</span>` + rowHtml.slice(nameEnd);
}
// 삭제 비활성 판정: 서버 삭제 거부와 같은 기준(스페이스·에이전트 cwd·pane cwd) + 실행 중
function busyOf(item) {
  const keys = new Set([...(usersOf(item) || []), ...(runningOf(item) || [])].map((user) => user.paneId || `space:${user.workspaceId}`));
  return keys.size;
}
function busyReason(item) {
  const count = busyOf(item);
  return count ? `세션 ${count}개가 쓰는 중이라 삭제할 수 없습니다` : "";
}
function usageKnown(item) { return Array.isArray(item.users) && Array.isArray(item.running); }
function deleteReason(item) {
  if (item.change?.uncommitted > 0) return "커밋하지 않은 변경이 있어 삭제할 수 없습니다";
  if (!usageKnown(item)) return "사용 여부 모름";
  return busyReason(item);
}
function defaultBase(data) {
  if (data.repositories) return "";
  const branches = data.branches || [];
  return branches.includes("main") ? "main" : branches[0];
}
function composeHtml(primary, data) {
  if (composing !== primary) {
    return `<div class="wt-new wt-add" role="button" tabindex="0" data-worktree-action="compose" data-wt-repo="${esc(primary)}">${ICON.plus}<span>새 worktree</span></div>`;
  }
  const slug = draft.trim() || "이름";
  const hint = draftError ? `<div class="wt-compose-hint wt-compose-error" role="alert">${esc(draftError)}</div>`
    : `<div class="wt-compose-hint" aria-live="polite"><span>브랜치 <b>feat/${esc(slug)}</b> · 기준 <b>${esc(data.repositories ? "저장소별 기본 브랜치" : defaultBase(data) || "")}</b></span><span>Enter 생성 · Esc 취소</span></div>`;
  return `<div class="wt-compose" data-wt-repo="${esc(primary)}"><input class="rename-input wt-compose-input" type="text" aria-label="새 worktree 이름" placeholder="이름 (예: review-search)" value="${esc(draft)}" autocomplete="off" spellcheck="false">${hint}</div>`;
}
// 목록 아래 한 줄: 고른 스페이스의 현재 브랜치. 목록은 이름만 표시하므로 브랜치는 여기서 본다.
function renderCurrent(spaces) {
  // 이 줄은 이 기능이 만들고 지운다. 목록 바로 뒤에 붙이므로 기능을 끄면 남지 않는다.
  const list = typeof document === "undefined" ? null : document.getElementById("space-list");
  if (!list) return;
  let line = list.nextElementSibling?.classList.contains("wt-current") ? list.nextElementSibling : null;
  const space = spaces.find((s) => s.id === app.getSelectedSpaceId());
  const data = space && byFolder.get(space.folder);
  let html = "";
  if (space && app.getIsLocal() && data?.ok && !data.repositories) {
    const item = entryOf(space) || data.entries?.find((entry) => samePath(entry.path, data.repo));
    const branch = item?.branch || "(브랜치 없음)";
    html = `${ICON.worktree}<span class="wt-current-name" title="${esc(branch)}">${esc(branch)}</span>`;
  } else if (space && app.getIsLocal() && data?.missing) {
    html = `<span class="wt-current-none">폴더 없음</span>`;
  } else if (space && app.getIsLocal() && data && !data.ok && !data.loading && !data.refreshing && !data.error) {
    html = `<span class="wt-current-none">Git 저장소가 아닙니다</span>`;
  }
  if (!html) { line?.remove(); return; }
  if (!line) {
    line = document.createElement("div");
    line.className = "wt-current";
    line.setAttribute("aria-live", "polite");
    list.after(line);
  }
  if (line.innerHTML !== html) line.innerHTML = html;
}
// 목록을 다시 그리면 입력칸이 새로 만들어진다. 적던 위치와 포커스를 이어 준다.
function restoreCompose() {
  if (composing === null || typeof document === "undefined") return;
  queueMicrotask(() => {
    const input = document.querySelector("#space-list .wt-compose-input");
    if (!input) return;
    if (document.activeElement !== input) input.focus();
    const at = draftCaret ?? input.value.length;
    input.setSelectionRange(at, at);
  });
}
// 목록 조회와 스페이스 행은 유지하고, 워크트리 계층은 에이전트 렌더 훅에서 만든다.
function renderGrouped(spaces, renderSpace) {
  bindLaunches();
  for (const space of spaces) if (space.folder && app.getIsLocal()) {
    const cached = byFolder.get(space.folder);
    const tabsKey = JSON.stringify(getTabsForSpace(space.id).map((tab) => tab.tabId));
    if (cached?.loading || cached?.refreshing || (cached && cached.tabsKey === tabsKey && Date.now() - cached.fetchedAt < LIST_TTL_MS)) continue;
    byFolder.set(space.folder, { ...cached, tabsKey, loading: !cached?.ok, refreshing: !!cached?.ok });
    request("list", { spaceId: space.id, repo: space.folder });
  }
  const html = spaces.map((space) => {
    const data = byFolder.get(space.folder);
    return data?.missing ? markMissing(renderSpace(space))
      : data?.error ? renderSpace(space, `<div class="wt-meta" role="status">Git 정보를 읽지 못했습니다: ${esc(data.error)}</div>`) : renderSpace(space);
  }).join("");
  renderCurrent(spaces);
  restoreCompose();
  return html;
}
const closedGroups = new Set();
const renderedGroups = new Map();
function taskFolder(target) {
  return /^(.*\/\.working\/[^/]+)\/(?:worktrees\/)?[^/]+\/?$/.exec(target || "")?.[1] || null;
}
function groupsFor(space, cached) {
  const repos = cached.repositories || [cached];
  const seenPaths = new Set();
  const items = repos.flatMap((data) => (data.entries || []).filter((item) => {
    const key = item.path?.replace(/\/$/, "");
    if (!key || item.prunable || SUBAGENT_WORKTREE.test(item.path) || seenPaths.has(key)) return false;
    seenPaths.add(key); return true;
  }).map((item) => ({ data, item })));
  const baseItems = cached.repositories ? items.filter(({ item }) => item.primary)
    : items.filter(({ item }) => samePath(item.path, space.folder));
  const base = { key: `${space.id}:base`, path: space.folder, primary: true, label: cached.label, members: baseItems, rows: [], terminals: [] };
  const groups = [base];
  const tasks = new Map();
  for (const member of items) {
    if (baseItems.includes(member) || member.item.primary) continue;
    const task = taskFolder(member.item.path);
    if (task) {
      if (!tasks.has(task)) tasks.set(task, []);
      tasks.get(task).push(member);
    }
  }
  const bundled = new Set();
  for (const [task, members] of tasks) if (cached.repositories || new Set(members.map(({ data }) => data.primary)).size > 1) {
    groups.push({ key: `${space.id}:${task}`, path: task, members, rows: [], terminals: [] });
    members.forEach((member) => bundled.add(member));
  }
  for (const member of items) if (!member.item.primary && !baseItems.includes(member) && !bundled.has(member)) {
    groups.push({ key: `${space.id}:${member.item.path}`, path: member.item.path, members: [member], rows: [], terminals: [] });
  }
  return groups;
}
function groupForAgent(groups, agent) {
  const nonbase = groups.filter((group) => !group.primary);
  const cwd = nonbase.filter((group) => under(group.path, agent.cwd) || group.members.some(({ item }) => under(item.path, agent.cwd)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (cwd) return cwd;
  const assigned = nonbase.filter((group) => group.members.some(({ item }) => taskIncludesPane(item, agent.paneId)
    || includesPane(runningOf(item), agent.paneId)
    || (item.creator?.session?.alive && item.creator.session.paneId === agent.paneId)
    || includesPane(usersOf(item), agent.paneId)));
  // 서로 다른 작업 묶음을 쓰는 세션은 한 곳을 임의로 고르지 않고 기본 작업 폴더에 둔다.
  return assigned.length === 1 ? assigned[0] : groups[0];
}
function groupTitle(group) {
  const label = group.members.length > 1
    ? (group.primary ? group.label : group.members.find(({ item }) => item.groupLabel)?.item.groupLabel)
    : group.members[0]?.item.label;
  return label || (group.primary && group.members.every(({ item }) => item.primary) ? "기본 워크트리" : folderName(group.path));
}
function groupAttributes(group) {
  return `data-wt-group="${esc(group.key)}" data-wt-path="${esc(group.path)}"`;
}
function groupButton(group, action, icon, title) {
  return `<button type="button" class="wt-action" data-worktree-action="${action}" ${groupAttributes(group)} aria-label="${esc(title)}" title="${esc(title)}">${icon}</button>`;
}
function groupHtml(group) {
  const open = !closedGroups.has(group.key);
  const members = group.members;
  const count = group.rows.filter((row) => row.agent.paneId === row.root.paneId).length + group.terminals.length;
  const branches = [...new Set(members.map(({ item }) => item.branch || "HEAD 분리됨"))];
  const branch = branches.length === 1 ? branches[0] : "브랜치 여러 개";
  const change = members.every(({ item }) => item.change) ? members.reduce((sum, { item }) => ({
    added: sum.added + (item.change.added || 0), deleted: sum.deleted + (item.change.deleted || 0),
    uncommitted: sum.uncommitted + (item.change.uncommitted || 0),
  }), { added: 0, deleted: 0, uncommitted: 0 }) : null;
  const changeLabel = change && (change.added + change.deleted ? `+${change.added} −${change.deleted}` : change.uncommitted ? `미커밋 ${change.uncommitted}` : "");
  const stats = changeLabel ? `<span class="wt-stat">${changeLabel}</span>` : "";
  return `<div class="wt-group" ${groupAttributes(group)}><div class="wt-group-head">`
    + `<button type="button" class="wt-group-toggle" data-worktree-action="group-toggle" ${groupAttributes(group)} aria-expanded="${open}" title="${esc(group.path)}"><span class="wt-caret${open ? " open" : ""}">${ICON.caret}</span>${ICON.worktree}<span class="wt-group-name">${esc(groupTitle(group))}</span></button>`
    + (!open && count ? `<span class="wt-stat">${count}</span>` : "")
    + (app.getIsLocal() ? groupButton(group, "group-add", ICON.plus, `${groupTitle(group)}에 추가`) : "")
    + groupButton(group, "group-menu", "···", `${groupTitle(group)} 메뉴`) + `</div>`
    + `<div class="wt-group-meta"><span class="wt-loc-branch">${esc(branch)}</span>${stats}</div>`
    + (open ? `<div class="wt-group-sessions">${group.rows.map((row) => row.html.replace('data-tree-parent=""', `data-tree-parent="${esc(group.key)}"`)).join("")}${group.terminals.map((tab) =>
      `<button type="button" class="wt-terminal-session${tab.focused ? " sel" : ""}" data-worktree-action="terminal" data-wt-tab="${esc(tab.tabId)}" title="${esc(tab.cwd || "작업 폴더 확인 중")}"><span class="wt-terminal-spacer" aria-hidden="true"></span><span class="srow-name">${esc(tab.label || `터미널 ${tab.number ?? ""}`)}</span><span class="srow-mark wt-terminal-sign" role="img" aria-label="터미널">${ICON.terminal}</span></button>`).join("")}</div>` : "") + `</div>`;
}
function groupAgents({ spaceId, open, rows, count }) {
  const space = app.orderedSpaces().find((candidate) => candidate.id === spaceId);
  const cached = space && byFolder.get(space.folder);
  if (!cached?.ok || (cached.repositories && !cached.repositories.length)) return undefined;
  const groups = groupsFor(space, cached);
  const roots = new Map();
  for (const row of rows) {
    if (!roots.has(row.root.paneId)) roots.set(row.root.paneId, groupForAgent(groups, row.root));
    const group = roots.get(row.root.paneId);
    group.rows.push(row);
  }
  const agentTabs = new Set(getLastAgents().filter((agent) => agent.workspaceId === spaceId).map((agent) => agent.tabId));
  for (const tab of getTabsForSpace(spaceId)) {
    if (agentTabs.has(tab.tabId)) continue;
    const panes = (cached.panes || []).filter((pane) => pane.workspaceId === spaceId && pane.tabId === tab.tabId);
    const pane = panes[0];
    const group = groups.filter((group) => !group.primary && under(group.path, pane?.cwd)).sort((a, b) => b.path.length - a.path.length)[0] || groups[0];
    group.terminals.push({ ...tab, cwd: pane?.cwd });
  }
  for (const group of groups) { group.space = space; renderedGroups.set(group.key, group); }
  const repositories = cached.repositories ? [{ ...cached, primary: cached.repo }] : [cached];
  const creation = repositories.some((data) => data.repositories?.length || data.branches?.length)
    ? composeHtml(cached.primary || cached.repo, cached) : "";
  const notes = repositories.map((data) => pendingCreates.has(data.primary)
    ? `<div class="wt-meta" role="status">${esc(pendingCreates.get(data.primary))} 생성 중…</div>`
    : uncertainRepos.has(data.primary) ? `<div class="wt-meta" role="status">작업 결과를 받지 못했습니다. ⌘⇧R로 새로고침하세요.</div>` : "").join("");

  return { count: count + groups.reduce((sum, group) => sum + group.terminals.length, 0), open, hasChildren: groups.length > 0,
    html: open ? `<div class="wt-space-groups">${groups.map(groupHtml).join("")}${notes}${app.getIsLocal() ? creation : ""}</div>` : "" };
}
function sessionItems(spaceId, cwd) {
  return [["", "새 터미널"], ["codex", "새 Codex 세션"], ["claude", "새 Claude 세션"]].map(([launch, label]) => ({
    label, disabled: !app.getIsLocal(), act: () => {
      if (app.getIsLocal()) app.wsSend({ type: "tab.create", workspaceId: spaceId, cwd, launch });
    },
  }));
}
let menuEvents = null;
function showWorktreeMenu(button, items) {
  menuEvents?.abort();
  const rect = button.getBoundingClientRect();
  showCtx(rect.left, rect.bottom, items);
  const menu = document.getElementById("ctxmenu");
  if (!menu) return;
  menu.setAttribute("role", "menu");
  menu.classList.add("wt-session-menu");
  const events = menuEvents = new AbortController();
  const close = (restore = false) => {
    events.abort(); menu.classList.remove("wt-session-menu");
    if (restore && button.isConnected) button.focus();
  };
  const options = [...menu.querySelectorAll(".ci:not(.disabled)")];
  options.forEach((option) => { option.tabIndex = -1; option.setAttribute("role", "menuitem"); });
  options[0]?.focus();
  menu.addEventListener("keydown", (event) => {
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); document.activeElement?.click();
    } else if (event.key === "Escape") close(true);
  }, { signal: events.signal });
  menu.addEventListener("click", () => close(), { signal: events.signal });
  document.addEventListener("pointerdown", (event) => { if (!menu.contains(event.target)) close(); }, { capture: true, signal: events.signal });
}
async function renameGroup(group) {
  const member = group.members[0];
  const grouped = group.members.length > 1;
  if (!member || !app.getIsLocal()) return;
  const current = grouped ? (group.primary ? group.label : member.item.groupLabel) : member.item.label;
  const label = await askText("워크트리 표시 이름", current || "", "비워 두면 기본 이름으로 표시합니다. 폴더와 브랜치 이름은 바뀌지 않습니다.");
  if (label === null) return;
  if (label.trim().length > 120) { app.showToast("표시 이름은 120자 이내로 입력하세요", { level: "err" }); return; }
  request("rename", { spaceId: group.space.id, repo: member.data.repo, path: member.item.path, label: label.trim(), ...(grouped ? { groupPath: group.path } : {}) });
}

function dataForSpace(spaceId) {
  const s = app.orderedSpaces().find((item) => item.id === spaceId);
  return s && byFolder.get(s.folder)?.ok ? { space: s, data: byFolder.get(s.folder) } : null;
}
function dataForPath(target) {
  for (const space of app.orderedSpaces()) {
    const data = byFolder.get(space.folder);
    if (!data?.ok) continue;
    for (const repository of data.repositories || [data]) {
      const item = repository.entries.find((entry) => samePath(entry.path, target));
      if (item) return { space, data: repository, item };
    }
  }
  return null;
}
function activeRepoData() {
  return dataForSpace(app.getSelectedSpaceId()) || [...app.orderedSpaces()].map((s) => dataForSpace(s.id)).find(Boolean);
}
function refreshRepo(spaceId) {
  const found = dataForSpace(spaceId);
  if (!found || found.data.refreshing) return;
  byFolder.set(found.space.folder, { ...found.data, refreshing: true });
  request("list", { spaceId: found.space.id, repo: found.space.folder });
}
function createDialog(spaceId) {
  if (!app.getIsLocal()) return false;
  const found = dataForSpace(spaceId);
  if (!found) { app.showToast("Git 저장소를 연 스페이스를 선택하세요", { level: "warn" }); return false; }
  const data = found.data;
  const branches = data.repositories?.length ? [""] : data.branches || [];
  if (!branches.length) { app.showToast("기준 브랜치가 없습니다", { level: "warn" }); return true; }
  const wrap = document.createElement("div");
  wrap.className = "askwrap wt-dialog";
  wrap.innerHTML = `<div class="askbox"><div class="asktitle">새 worktree</div>`
    + `<div class="asknote">${esc(data.primary || data.repo)}</div><label>폴더 이름<input class="wt-name" type="text" placeholder="예: review-search" /></label>`
    + `<label>기준 브랜치<span class="wt-base"></span></label>`
    + `<label>새 브랜치<input class="wt-branch" type="text" placeholder="예: feat/review-search" /></label>`
    + `<label>실행<span class="wt-launch"></span></label>`
    + `<div class="wt-error" role="alert" hidden></div>`
    + `<div class="askrow"><button type="button" data-wt-dialog="cancel">취소</button><button type="button" class="primary" data-wt-dialog="create">만들기</button></div></div>`;
  let base = branches.includes("main") ? "main" : branches[0];
  let launch = "";
  const baseDrop = createDropdown({ items: branches.map((value) => ({ value, label: value || "저장소별 기본 브랜치" })), value: base, ariaLabel: "기준 브랜치", onChange: (value) => { base = value; } });
  const launchDrop = createDropdown({ items: [{ value: "", label: "빈 터미널" }, { value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }], value: launch, ariaLabel: "실행", onChange: (value) => { launch = value; } });
  wrap.querySelector(".wt-base").append(baseDrop.el);
  wrap.querySelector(".wt-launch").append(launchDrop.el);
  const name = wrap.querySelector(".wt-name"), branch = wrap.querySelector(".wt-branch"), error = wrap.querySelector(".wt-error");
  name.addEventListener("input", () => { if (!branch.dataset.edited) branch.value = `feat/${name.value.trim()}`; });
  branch.addEventListener("input", () => { branch.dataset.edited = "true"; });
  const close = () => { baseDrop.destroy(); launchDrop.destroy(); wrap.remove(); };
  wrap.addEventListener("click", (event) => {
    const action = event.target.closest("[data-wt-dialog]")?.dataset.wtDialog;
    if (!action) return;
    if (action === "cancel") { close(); return; }
    const folderName = name.value.trim(), newBranch = branch.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(folderName) || !newBranch) {
      error.textContent = "폴더 이름과 새 브랜치를 확인하세요"; error.hidden = false; return;
    }
    const key = data.primary || data.repo;
    if (activeOps.has(key)) return;
    activeOps.add(key);
    pendingCreates.set(key, folderName);
    renderSpaces();
    progressFor(request("create", { spaceId, repo: data.repo, name: folderName, branch: newBranch, base, launch }), "worktree를 만드는 중…");
    close();
  });
  wrap.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
  document.body.append(wrap); name.focus();
  return true;
}
async function removeWorktree(spaceId, item, data) {
  if (!app.getIsLocal() || !item?.managed || item.primary) return;
  const key = data.primary;
  if (activeOps.has(key)) return;
  const yes = await askConfirm("worktree 삭제", `${item.path}\n커밋하지 않은 변경이 있거나 열린 스페이스가 있으면 삭제할 수 없습니다. 브랜치는 남습니다.`);
  if (!yes) return;
  activeOps.add(key);
  progressFor(request("remove", { spaceId, repo: data.repo, path: item.path }), "worktree를 삭제하는 중…");
}
function repoFound(primary) {
  for (const space of app.orderedSpaces()) {
    const cached = byFolder.get(space.folder);
    const data = cached?.repositories && samePath(cached.repo, primary) ? cached
      : (cached?.repositories || [cached]).find((repo) => repo?.primary === primary);
    if (data) return { space, data };
  }
  return null;
}
function openCompose(primary) {
  composing = primary; draft = ""; draftError = ""; draftCaret = null;
  renderSpaces();
}
function closeCompose(focusAdd) {
  const primary = composing;
  composing = null; draft = ""; draftError = ""; draftCaret = null;
  renderSpaces();
  if (focusAdd) document.querySelector(`#space-list .wt-add[data-wt-repo="${CSS.escape(primary)}"]`)?.focus();
}
function createFromCompose() {
  const primary = composing, found = repoFound(primary);
  if (!found) { closeCompose(false); return; }
  const name = draft.trim(), branch = `feat/${name}`;
  if (!NAME_PATTERN.test(name)) draftError = "영문이나 숫자로 시작하고, 영문, 숫자, . _ - 만 쓸 수 있습니다";
  else if ((found.data.branches || []).includes(branch)) draftError = `${branch} 브랜치가 이미 있습니다`;
  else if (activeOps.has(primary)) draftError = "다른 worktree 작업이 끝난 뒤 다시 시도하세요";
  if (draftError) { renderSpaces(); return; }
  activeOps.add(primary);
  pendingCreates.set(primary, name);
  composing = null; draft = ""; draftCaret = null;
  request("create", { spaceId: found.space.id, repo: found.data.repo, name, branch, base: defaultBase(found.data), launch: "" });
  renderSpaces();
}
function menuFor(spaceId, path, x, y) {
  const byPath = dataForPath(path);
  const found = byPath || dataForSpace(spaceId) || activeRepoData();
  if (!found) return;
  const item = byPath?.item || found.data.entries.find((entry) => samePath(entry.path, path));
  if (!item) return;
  const reason = deleteReason(item);
  // 이미 연 폴더에는 스페이스를 중복 생성하지 않는다.
  const opened = app.orderedSpaces().some((space) => samePath(space.folder, item.path));
  const workspaceId = app.orderedSpaces().find((space) => samePath(space.folder, item.path))?.id || found.space.id;
  showCtx(x, y, [
    ...[["", "새 터미널"], ["codex", "새 Codex 세션"], ["claude", "새 Claude 세션"]].map(([launch, label]) => ({
      label, disabled: !app.getIsLocal() || item.prunable,
      act: () => {
        if (!app.getIsLocal() || item.prunable) return;
        app.wsSend({ type: "tab.create", workspaceId, cwd: item.path, launch });
      },
    })),
    { sep: true },
    ...(item.primary || opened ? [] : [{ label: "스페이스로 열기", disabled: !app.getIsLocal(), act: () => app.wsSend({ type: "space.create", cwd: item.path }) }]),
    { label: "브랜치와 경로 보기", act: () => askInfo(item.branch, item.path) },
    { label: "새로고침", act: () => refreshRepo(found.space.id) },
    { label: "새 worktree", disabled: !app.getIsLocal(), act: () => createDialog(found.space.id) },
    { sep: true },
    { label: busyReason(item) ? "worktree 삭제 (쓰는 세션을 닫은 뒤)" : "worktree 삭제", danger: true,
      disabled: !app.getIsLocal() || !item.managed || item.primary || !!reason, act: () => removeWorktree(found.space.id, item, found.data) },
  ]);
}
function handleResult(message) {
  const pending = requests.get(message.requestId);
  if (!pending) return;
  requests.delete(message.requestId);
  clearTimeout(pending.timer);
  // 실행한 세션 기록은 보조 정보. 실패해도 알리지 않고 목록만 갱신
  if (pending.op === "launched") {
    if (message.ok) for (const [folder, data] of byFolder) if (data?.primary === message.primary) byFolder.set(folder, { ...data, entries: message.entries });
    renderSpaces(); return;
  }
  if (pending.op !== "list") {
    const key = message.primary || [...byFolder.values()].find((entry) => entry?.repo === pending.repo)?.primary || pending.repo;
    activeOps.delete(key);
    if (pending.op === "create") pendingCreates.delete(key);
  }
  if (!message.ok) {
    if (pending.op === "list" && message.code === "FOLDER") byFolder.set(pending.repo, { missing: true, tabsKey: byFolder.get(pending.repo)?.tabsKey, fetchedAt: Date.now() });
    else if (pending.op === "list") byFolder.set(pending.repo, { error: ["GIT", "REPO", "SPACE"].includes(message.code) ? null : message.message, tabsKey: byFolder.get(pending.repo)?.tabsKey, fetchedAt: Date.now() });
    else {
      app.showToast(message.message || "worktree 작업이 실패했습니다", { level: "err", id: pending.toastId });
      if (message.createdPath || message.createdPaths?.length) refreshRepo(pending.spaceId);
    }
    renderSpaces(); return;
  }
  if (pending.op === "list") {
    // 저장소 공통 정보만 옮긴다. repo 는 폴더마다 다르므로 덮어쓰지 않는다.
    for (const [folder, data] of byFolder) if (message.primary && data?.primary === message.primary)
      byFolder.set(folder, { ...data, entries: message.entries, branches: message.branches, ok: true, loading: false, refreshing: false, fetchedAt: Date.now() });
    byFolder.set(pending.repo, { ...message, tabsKey: byFolder.get(pending.repo)?.tabsKey, ok: true, fetchedAt: Date.now() });
  } else {
    for (const [folder, data] of byFolder) {
      if (message.repositories && data?.repo === message.repo) byFolder.set(folder, { ...data, ...message, ok: true, fetchedAt: Date.now() });
      else if (data?.repositories) byFolder.set(folder, { ...data, ...(message.groupPath === folder ? { label: message.label } : {}), repositories: data.repositories.map((repo) => repo.primary === message.primary
        ? { ...repo, entries: message.entries } : repo) });
      else if (data?.primary === message.primary || data?.repo === message.repo)
        byFolder.set(folder, { ...data, entries: message.entries, ok: true, fetchedAt: Date.now() });
    }
    if (pending.op === "create") {
      app.wsSend({ type: "tab.create", workspaceId: pending.spaceId, cwd: message.spaceCwd, launch: pending.launch || "" });
      if (pending.launch) pendingBinds.set(message.spaceCwd, { workspaceId: pending.spaceId, repo: pending.repo, launch: pending.launch, until: Date.now() + BIND_WAIT_MS });
      app.showToast("worktree를 만들었습니다", { level: "ok", id: pending.toastId });
    } else app.showToast(pending.op === "rename" ? "표시 이름을 바꿨습니다" : "worktree를 삭제했습니다", { level: "ok", id: pending.toastId });
  }
  renderSpaces();
}
// 생성한 워크트리에서 실행한 에이전트가 나타나면 만든 세션으로 기록한다.
function bindLaunches() {
  if (!pendingBinds.size) return;
  const agents = getLastAgents();
  for (const [path, bind] of pendingBinds) {
    if (Date.now() > bind.until) { pendingBinds.delete(path); continue; }
    const agent = agents.find((a) => a.workspaceId === bind.workspaceId && a.agent === bind.launch && a.paneId && under(path, a.cwd));
    if (!agent) continue;
    pendingBinds.delete(path);
    request("launched", { spaceId: bind.workspaceId, repo: bind.repo || path, path, paneId: agent.paneId });
  }
}
function attachEvents() {
  const list = document.getElementById("space-list");
  if (!list) return;
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-worktree-action]");
    if (!button) return;
    event.stopImmediatePropagation();
    const action = button.dataset.worktreeAction;
    const group = renderedGroups.get(button.dataset.wtGroup);
    if (action === "terminal") { app.wsSend({ type: "tab-focus", tabId: button.dataset.wtTab, origin: "sidebar" }); return; }
    if (group && action === "group-toggle") {
      if (closedGroups.has(group.key)) closedGroups.delete(group.key); else closedGroups.add(group.key);
      renderSpaces(); return;
    }
    if (group && ["group-add", "group-menu"].includes(action)) {
      const items = sessionItems(group.space.id, group.path);
      if (action === "group-menu") items.push({ sep: true },
        ...(group.members.length > 1 ? [{ label: "저장소별 작업", act: () => setTimeout(() => showWorktreeMenu(button,
          group.members.map(({ data, item }) => ({ label: folderName(data.primary), act: () => setTimeout(() => {
            const rect = button.getBoundingClientRect();
            menuFor(group.space.id, item.path, rect.left, rect.bottom);
          }, 0) }))), 0) }] : []),
        { label: "표시 이름 바꾸기", disabled: !app.getIsLocal(), act: () => renameGroup(group) },
        { label: "경로 보기", act: () => askInfo(groupTitle(group), group.path) },
        { label: "새로고침", act: () => refreshRepo(group.space.id) },
        ...(!group.primary && group.members.length === 1 ? [{ label: "worktree 삭제", danger: true,
          disabled: !app.getIsLocal() || !group.members[0].item.managed || !!deleteReason(group.members[0].item),
          act: () => removeWorktree(group.space.id, group.members[0].item, group.members[0].data) }] : []));
      showWorktreeMenu(button, items); return;
    }
    if (action === "sessions") {
      showWorktreeMenu(button, sessionItems(button.dataset.wtSpace, button.dataset.wtPath)); return;
    }
    const path = button.dataset.wtPath || button.closest(".wt-item")?.dataset.wtPath;
    const spaceId = button.dataset.wtSpace || app.orderedSpaces().find((s) => byFolder.get(s.folder)?.entries?.some((item) => samePath(item.path, path)))?.id;
    if (action === "compose") { openCompose(button.dataset.wtRepo); return; }
    if (action === "add") createDialog(spaceId);
    else if (action === "menu") menuFor(spaceId, path, button.getBoundingClientRect().left, button.getBoundingClientRect().bottom);
    else if (action === "open" && app.getIsLocal()) {
      // 이미 스페이스로 연 폴더는 그 스페이스로 이동. space.create 는 같은 폴더라도 새 스페이스를 만듦
      const opened = app.orderedSpaces().find((space) => samePath(space.folder, path));
      if (opened) app.focusSpace(opened.id);
      else app.wsSend({ type: "space.create", cwd: path });
    }
  }, true);
  list.addEventListener("contextmenu", (event) => {
    const terminal = event.target.closest(".wt-terminal-session[data-wt-tab]");
    if (terminal) {
      event.preventDefault(); event.stopImmediatePropagation();
      const group = renderedGroups.get(terminal.closest(".wt-group")?.dataset.wtGroup);
      const tab = group?.terminals.find((item) => item.tabId === terminal.dataset.wtTab);
      showCtx(event.clientX, event.clientY, [{ label: "터미널 닫기", danger: true,
        disabled: !app.getIsLocal() || !tab || tab.paneCount > 1,
        act: () => {
          if (app.getIsLocal() && tab && !(tab.paneCount > 1)) app.wsSend({ type: "tab-close", tabId: tab.tabId });
        } }]);
      return;
    }
    const header = event.target.closest(".wt-group-head");
    if (header) {
      event.preventDefault(); event.stopImmediatePropagation();
      header.querySelector('[data-worktree-action="group-menu"]')?.click(); return;
    }
  }, true);
  list.addEventListener("input", (event) => {
    if (!event.target.matches(".wt-compose-input")) return;
    draft = event.target.value; draftCaret = event.target.selectionStart;
    const hint = list.querySelector(".wt-compose-hint");
    if (draftError) { draftError = ""; renderSpaces(); return; }
    const name = hint?.querySelector("b");
    if (name) name.textContent = `feat/${draft.trim() || "이름"}`;
  });
  list.addEventListener("keydown", (event) => {
    if (event.target.matches(".wt-compose-input")) {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); createFromCompose(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCompose(true); }
      else draftCaret = null;
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && event.target.matches(".wt-add")) { event.preventDefault(); openCompose(event.target.dataset.wtRepo); }
  });
  list.addEventListener("keyup", (event) => { if (event.target.matches(".wt-compose-input")) draftCaret = event.target.selectionStart; });
  // 비운 채 입력칸을 벗어나면 닫는다. 다시 그리느라 잠깐 포커스를 잃은 경우는 새 입력칸이 포커스를 받는다.
  list.addEventListener("focusout", (event) => {
    if (!event.target.matches(".wt-compose-input")) return;
    setTimeout(() => {
      if (composing !== null && !draft.trim() && !document.activeElement?.matches(".wt-compose-input")) closeCompose(false);
    }, 0);
  });

}
export function initCapability(ctx) {
  app = ctx;
  provide("worktrees.renderSpaces", renderGrouped);
  provide("worktrees.groupAgents", groupAgents);
  provide("worktrees.revealAgent", ({ spaceId, paneId }) => {
    const space = app.orderedSpaces().find((candidate) => candidate.id === spaceId);
    const cached = space && byFolder.get(space.folder);
    if (!cached?.ok) return false;
    const forest = buildAgentForest(getLastAgents().filter((agent) => agent.workspaceId === spaceId));
    let node = forest.nodes.find((candidate) => candidate.agent.paneId === paneId);
    if (!node) return false;
    while (node.parent) node = node.parent;
    return closedGroups.delete(groupForAgent(groupsFor(space, cached), node.agent).key);
  });
  provide("worktrees.add", (event, openFolder) => {
    const selected = app.orderedSpaces().find((s) => s.id === app.getSelectedSpaceId());
    if (!selected || !app.getIsLocal()) return false;
    const data = byFolder.get(selected.folder);
    if (!data?.ok && !data?.loading) return false;
    const box = event.currentTarget.getBoundingClientRect();
    showCtx(box.left, box.bottom, [
      { label: "기존 폴더 열기", act: openFolder },
      { label: "새 worktree", disabled: !data?.ok, act: () => createDialog(selected.id) },
    ]);
    return true;
  });
  provide("worktrees.spaceItems", (id) => {
    const found = dataForSpace(id);
    if (!found) return [];
    const item = found.data.entries.find((entry) => samePath(entry.path, found.space.folder)
      || samePath(entry.path, found.data.repo));
    return [{ label: "새 worktree", disabled: !app.getIsLocal(), act: () => createDialog(id) },
      { label: "브랜치와 경로 보기", act: () => askInfo(item?.branch || "저장소", item?.path || found.space.folder) },
      { label: "새로고침", act: () => refreshRepo(id) },
      // 이 스페이스 자신이 그 폴더를 쓰므로 여기서는 삭제할 수 없다. 스페이스를 닫으면 목록 행에서 삭제한다.
      ...(item?.managed && !item.primary ? [{ label: "worktree 삭제 (스페이스를 닫은 뒤)", danger: true, disabled: true, act: () => {} }] : [])];
  });
  provide("worktrees.emptyItems", () => activeRepoData() ? [{ label: "새 worktree", disabled: !app.getIsLocal(), act: () => createDialog(app.getSelectedSpaceId()) }] : []);
  attachEvents();
  renderSpaces();
  provide("worktrees.spaceCreated", (message) => byFolder.delete(message.cwd));
  return { ws: { "worktrees.result": handleResult } };
}
