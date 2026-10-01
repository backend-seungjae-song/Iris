// 소유 범위: Git 패널의 PR 상태와 가운데 PR 탭, 응답별 표시 상태.
// 제공 API: initCapability(ctx)가 상태·로그·초안 응답을 등록한다.
// 의존 대상: core hook·tab view, center tab store, 브라우저 열기, 자체 상세 보기.
// 유지 조건: 기능을 끄면 이 파일이 로드되지 않는다. 초안은 명시한 에이전트와 스페이스에만 요청한다.
// 영향 범위: source-control의 githubpr.branch hook, 서버 githubpr.* 메시지.
import { provide, callHook, hasHook } from "../core/hooks.js";
import { registerTabView } from "../core/tab-views.js";
import { addTab, ensureTabSpace, getActiveTabId, getCenterSpace, getTabs, setActiveTab, setCenterSpace } from "../center/tab-store.js";
import { openInSpaceBrowser } from "../center/file-routing.js";
import { esc, prState, renderGithubPrView } from "./view.js";

const CACHE_MS = 30000;
let ctx;
let sequence = 0;
let current = null;
const cache = new Map();
const requests = new Map();
const latestStatus = new Map();

function keyOf(root, branch) { return `${root}\n${branch}`; }
function requestId() { return `gpr-${Date.now()}-${++sequence}`; }
function visible(tab) { return getCenterSpace() === tab.spaceId && getActiveTabId(tab.spaceId) === tab.id; }
function redraw(tab) { if (visible(tab)) renderTab(tab); }


function paintBranch() {
  const { row, root, branch, spaceId } = current || {};
  const had = document.getElementById("gpr-branch");
  if (!row || !root || !branch || !spaceId) { had?.remove(); return; }
  let line = had;
  if (!line) {
    line = document.createElement("div");
    line.id = "gpr-branch";
    line.className = "gpr-branch";
    row.after(line);
  } else if (line.previousElementSibling !== row) row.after(line);
  const record = cache.get(keyOf(root, branch));
  const signature = `${root}\n${branch}\n${spaceId}\n${record?.loading ? "loading" : record?.pr?.number || record?.error?.code || "empty"}\n${record?.pr?.title || record?.error?.message || ""}\n${record?.pr?.checks.map((x) => x.conclusion || x.status).join(",") || ""}`;
  if (line.dataset.signature === signature) return;
  line.dataset.signature = signature;
  line.replaceChildren();
  const text = document.createElement("span");
  text.className = record?.error ? "gpr-branch-error" : "gpr-branch-text";
  if (record?.pr) {
    const failures = record.pr.checks.filter((x) => /FAILURE|ERROR|TIMED_OUT|CANCELLED/i.test(x.conclusion)).length;
    const pending = record.pr.checks.filter((x) => /PENDING|QUEUED|IN_PROGRESS/i.test(x.conclusion || x.status)).length;
    const succeeded = record.pr.checks.filter((x) => /SUCCESS/i.test(x.conclusion)).length;
    const pr = record.pr, state = prState(pr);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gpr-branch-open";
    button.innerHTML = `<span class="gpr-card-top"><span class="gpr-card-number">#${pr.number}</span><span class="gpr-state" data-state="${state.key}">${state.label}</span></span>`
      + `<span class="gpr-card-title">${esc(pr.title)}</span>`
      + `<span class="gpr-card-checks">${failures ? `<span class="failed">✕ ${failures}</span>` : ""}<span class="passed">✓ ${succeeded}</span>`
      + `${pending ? `<span class="running">◷ ${pending}</span>` : ""}<span>${state.key} → ${esc(pr.base)}</span></span>`;
    button.setAttribute("aria-label", `PR #${pr.number} ${pr.title} · 검사 실패 ${failures}, 통과 ${succeeded}, 진행 중 ${pending}`);
    button.onclick = () => openPr(record.pr, spaceId);
    line.append(button);
  } else {
    text.textContent = record?.loading ? "PR 확인 중…" : record?.error?.message || "PR 없음";
    line.append(text);
    if (record?.error) {
      const retry = document.createElement("button");
      retry.type = "button"; retry.className = "cc-btn cc-btn-txt"; retry.textContent = "새로고침";
      retry.onclick = () => readPr(root, branch, true);
      line.append(retry);
    }
  }
}

function readPr(root, branch, force = false, tab = null) {
  const key = keyOf(root, branch), prior = cache.get(key);
  if (!force && prior && (prior.loading || Date.now() - prior.at < CACHE_MS)) return;
  if (!ctx.wsIsOpen?.()) {
    cache.set(key, { error: { code: "offline", message: "서버에 연결되지 않았습니다." }, at: Date.now() });
    paintBranch();
    if (tab) { tab.error = "서버에 연결되지 않았습니다."; redraw(tab); }
    return;
  }
  const id = requestId();
  cache.set(key, { ...prior, loading: true, error: null, at: Date.now() });
  latestStatus.set(key, id);
  track(id, { kind: "status", key, root, branch, tab });
  paintBranch();
  try { ctx.wsSend({ type: "githubpr.status", requestId: id, path: root, expectRoot: root, branch }); }
  catch { clearRequest(id); latestStatus.delete(key); cache.set(key, { error: { code: "offline", message: "서버에 연결되지 않았습니다." }, at: Date.now() }); paintBranch(); }
}

function clearRequest(id) {
  const pending = requests.get(id);
  if (pending?.timer) clearTimeout(pending.timer);
  requests.delete(id);
  return pending;
}

function track(id, pending) {
  pending.timer = setTimeout(() => {
    if (!requests.has(id)) return;
    const message = { requestId: id, ok: false, error: { code: "timeout", message: pending.kind === "draft"
      ? "입력됐는지 확인하지 못했습니다. 터미널을 확인하세요." : "응답 시간이 초과되었습니다. 다시 시도하세요." } };
    receive(message);
  }, pending.kind === "draft" ? 20000 : 45000);
  requests.set(id, pending);
}

function openPr(pr, spaceId) {
  const space = spaceId || getCenterSpace() || ctx.getSelectedSpaceId();
  if (!space) return;
  ensureTabSpace(space);
  const id = `githubpr:${pr.root}:${pr.branch}`;
  let tab = getTabs(space).find((x) => x.id === id);
  if (!tab) tab = addTab(space, { id, kind: "pullrequest", label: `PR #${pr.number}`, root: pr.root,
    branch: pr.branch, spaceId: space, pr, section: "conversation", logs: new Map(), notice: "", error: "" });
  else { tab.pr = pr; tab.error = ""; }
  setCenterSpace(space); setActiveTab(space, id); ctx.renderTabs(); ctx.showActiveTab();
}

function renderTab(tab) {
  const host = document.getElementById("githubprview");
  renderGithubPrView(tab, {
    host,
    onRefresh: () => { tab.notice = ""; readPr(tab.root, tab.branch, true, tab); },
    onLog: (runId) => {
      if (!ctx.wsIsOpen?.()) { tab.notice = "서버에 연결되지 않았습니다."; redraw(tab); return; }
      const id = requestId();
      tab.logs.set(runId, { loading: true });
      track(id, { kind: "log", tab, runId });
      try { ctx.wsSend({ type: "githubpr.log", requestId: id, path: tab.root, expectRoot: tab.root, branch: tab.branch, runId }); }
      catch { receive({ requestId: id, ok: false, error: { message: "서버에 연결되지 않았습니다." } }); }
      redraw(tab);
    },
    onFile: (file) => {
      if (!hasHook("git.openPatchDiff")) { tab.notice = "소스 제어 기능을 켜면 diff를 볼 수 있습니다."; redraw(tab); return; }
      if (!ctx.wsIsOpen?.()) { tab.notice = "서버에 연결되지 않았습니다."; redraw(tab); return; }
      const id = requestId();
      const target = { root: tab.root, file, number: tab.pr.number, base: tab.pr.base, spaceId: tab.spaceId, requestId: id };
      if (!callHook("git.openPatchDiff", { ...target, patch: null })) {
        tab.notice = "변경 내용을 열지 못했습니다."; redraw(tab); return;
      }
      tab.notice = "";
      track(id, { kind: "diff", tab, target });
      try { ctx.wsSend({ type: "githubpr.diff", requestId: id, path: tab.root, expectRoot: tab.root,
        branch: tab.branch, number: tab.pr.number, file }); }
      catch { receive({ requestId: id, ok: false, error: { message: "서버에 연결되지 않았습니다." } }); }
      redraw(tab);
    },
    onDraft: (text) => {
      if (tab.draftPending) return;
      const agent = ctx.getCurrentAgent?.();
      const paneId = ctx.getCurTarget?.();
      if (!ctx.getIsLocal?.() || !ctx.wsIsOpen?.() || !agent?.paneId || agent.paneId !== paneId
        || !agent.terminalId || agent.workspaceId !== tab.spaceId || !(agent.cwd === tab.root || agent.cwd?.startsWith(tab.root + "/"))) {
        tab.notice = "이 PR의 스페이스에서 에이전트를 선택하세요."; redraw(tab); return;
      }
      const id = requestId();
      tab.draftPending = true;
      tab.notice = "입력창에 넣는 중…";
      track(id, { kind: "draft", tab, text });
      try { ctx.wsSend({ type: "githubpr.draft", requestId: id, paneId, terminalId: agent.terminalId,
        spaceId: tab.spaceId, text }); }
      catch { receive({ requestId: id, ok: false, error: { message: "서버에 연결되지 않았습니다." } }); }
      redraw(tab);
    },
    onOpenUrl: () => {
      try {
        const url = new URL(tab.pr?.url);
        if (url.protocol !== "https:") throw new Error("invalid URL");
        openInSpaceBrowser(url.href);
      } catch { tab.notice = "GitHub 주소를 열 수 없습니다."; redraw(tab); }
    },
  });
}

function receive(message) {
  const pending = clearRequest(message.requestId);
  if (!pending) return;
  if (pending.kind === "status") {
    if (latestStatus.get(pending.key) !== message.requestId) return;
    latestStatus.delete(pending.key);
    const record = message.ok ? { pr: message.pr, at: Date.now() }
      : { error: message.error || { code: "unknown", message: "PR을 읽지 못했습니다." }, at: Date.now() };
    cache.set(pending.key, record);
    if (pending.tab) {
      if (message.ok) { pending.tab.pr = message.pr; pending.tab.error = ""; }
      else if (!pending.tab.pr) pending.tab.error = record.error.message;
      else pending.tab.notice = record.error.message;
      redraw(pending.tab);
    }
    paintBranch();
  } else if (pending.kind === "log") {
    pending.tab.logs.set(pending.runId, message.ok ? { text: message.log } : { error: message.error?.message || "로그를 읽지 못했습니다." });
    redraw(pending.tab);
  } else if (pending.kind === "diff") {
    callHook("git.openPatchDiff", { ...pending.target, activate: false,
      patch: message.ok ? message.patch : null,
      error: message.ok ? "" : message.error?.message || "변경 내용을 읽지 못했습니다." });
  } else if (pending.kind === "draft") {
    pending.tab.draftPending = false;
    pending.tab.notice = message.ok ? "입력창에 넣었습니다. 확인한 뒤 Enter를 누르세요."
      : (message.error?.message || "입력됐는지 확인하지 못했습니다.");
    redraw(pending.tab);
  }
}

export function initCapability(context) {
  ctx = context;
  provide("githubpr.branch", (info) => {
    current = info;
    paintBranch();
    if (info.root && info.branch) readPr(info.root, info.branch);
  });
  registerTabView({ kind: "pullrequest", panelId: "githubprview", fileLike: false, render: renderTab });
  return { ws: { "githubpr-status": receive, "githubpr-log": receive, "githubpr-diff": receive, "githubpr-draft": receive } };
}
