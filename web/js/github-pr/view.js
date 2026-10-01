// 소유 범위: GitHub PR의 대화·검사·변경 파일 표시와 로그 열기 버튼.
// 제공 API: renderGithubPrView(tab, actions).
// 의존 대상: boot.js가 전달한 탭 상태와 DOM 이벤트 함수.
// 유지 조건: 본문은 HTML을 이스케이프하는 Markdown 처리기로 표시하고 로그는 이스케이프한다.
// 영향 범위: githubprview 가운데 탭과 40-github-pr.css.
import { mdToHtml } from "../core/markdown.js";

export const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const time = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString("ko-KR");
};
export function prState(pr) {
  if (pr.isDraft) return { key: "draft", label: "Draft" };
  if (/MERGED/i.test(pr.state)) return { key: "merged", label: "Merged" };
  if (/CLOSED/i.test(pr.state)) return { key: "closed", label: "Closed" };
  return { key: "open", label: "Open" };
}
const isFailed = (check) => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/i.test(check.conclusion);
const checkLabel = (check) => {
  const state = check.conclusion || check.status || "대기";
  if (/SUCCESS/i.test(state)) return "통과";
  if (isFailed(check)) return "실패";
  if (/PENDING|QUEUED|IN_PROGRESS/i.test(state)) return "진행 중";
  return state;
};

function conversation(pr) {
  const events = [
    ...pr.comments.map((x) => ({ ...x, when: x.createdAt, kind: "comment" })),
    ...pr.reviews.map((x) => ({ ...x, when: x.submittedAt, kind: "review" })),
    ...(pr.reviewComments || []).map((x) => ({ ...x, when: x.createdAt, kind: "inline" })),
  ].sort((a, b) => String(a.when).localeCompare(String(b.when)));
  return `<section class="gpr-description"><h3>설명</h3><div class="gpr-markdown">${mdToHtml(pr.body || "설명이 없습니다.")}</div></section>`
    + `<section class="gpr-conversation"><h3>대화 · ${events.length}</h3>${events.length ? events.map((item, index) => `
      <article class="gpr-event"><div class="gpr-event-head"><strong>${esc(item.author || "GitHub 사용자")}</strong>
      <span>${esc(item.kind === "review" ? `리뷰 ${item.state || ""}` : item.kind === "inline" ? `줄 의견 · ${item.path}${item.line ? `:${item.line}` : ""}` : "댓글")}</span><time>${esc(time(item.when))}</time></div>
      ${item.body ? `<div class="gpr-markdown">${mdToHtml(item.body)}</div>` : ""}
      ${item.body ? `<button type="button" class="cc-btn cc-btn-txt" data-gpr-draft="event:${index}">에이전트에게 전달</button>` : ""}</article>`).join("") : '<p class="gpr-empty">대화가 없습니다.</p>'}
      ${pr.reviewCommentsError ? `<p class="gpr-error" role="alert">${esc(pr.reviewCommentsError)}</p>` : ""}
      ${pr.reviewCommentsLimited ? '<p class="gpr-hint">줄 의견은 100개까지만 표시합니다.</p>' : ""}</section>`;
}

function checks(pr, logs) {
  if (!pr.checks.length) return '<p class="gpr-empty">검사가 없습니다.</p>';
  const count = (label) => pr.checks.filter((check) => checkLabel(check) === label).length;
  const summary = `<p class="gpr-check-summary"><span class="failed"><b>${count("실패")}</b>실패</span><span><b>${count("통과")}</b>통과</span><span><b>${count("진행 중")}</b>진행 중</span></p>`;
  const glyph = { "실패": "✕", "통과": "✓", "진행 중": "◷" };
  return `${summary}<div class="gpr-checks">${pr.checks.map((check) => {
    const log = check.runId ? logs.get(check.runId) : null;
    const label = checkLabel(check), key = label === "실패" ? "failed" : label === "통과" ? "passed" : "running";
    return `<section class="gpr-check ${key}"><div class="gpr-check-head"><span class="gpr-check-state ${key}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${glyph[label] || "·"}</span>
      <strong>${esc(check.name)}</strong>${isFailed(check) && check.runId ? `<button type="button" class="cc-btn cc-btn-txt" data-gpr-log="${esc(check.runId)}">실패 로그 ${log?.text ? "새로고침" : "보기"}</button>` : ""}</div>
      ${log?.loading ? '<p class="gpr-hint">실패 로그를 불러오는 중…</p>' : ""}
      ${log?.error ? `<p class="gpr-error" role="alert">${esc(log.error)}</p>` : ""}
      ${log?.text != null ? `<div class="gpr-log"><pre>${esc(log.text || "실패 로그가 비어 있습니다.")}</pre><button type="button" class="cc-btn cc-btn-txt" data-gpr-draft="log:${esc(check.runId)}">에이전트에게 전달</button></div>` : ""}
      </section>`;
  }).join("")}</div>`;
}

function files(pr) {
  return pr.files.length ? `<div class="gpr-files">${pr.files.map((item) => `<button type="button" class="gpr-file" data-gpr-file="${esc(item.path)}"><span>${esc(item.path)}</span>
    <span class="gpr-file-count">+${item.additions} −${item.deletions}</span></button>`).join("")}</div>`
    : '<p class="gpr-empty">변경 파일이 없습니다.</p>';
}

export function renderGithubPrView(tab, { host, onRefresh, onLog, onDraft, onOpenUrl, onFile }) {
  if (!host) return;
  const pr = tab.pr;
  if (!pr) {
    host.innerHTML = `<div class="gpr-page"><p class="${tab.error ? "gpr-error" : "gpr-empty"}" ${tab.error ? 'role="alert"' : ""}>
      ${esc(tab.error || "PR을 불러오는 중…")}</p><button type="button" class="cc-btn" data-gpr-refresh>다시 읽기</button></div>`;
    host.querySelector("[data-gpr-refresh]").onclick = onRefresh;
    return;
  }
  const selected = ["conversation", "checks", "files"].includes(tab.section) ? tab.section : "conversation";
  host.innerHTML = `<div class="gpr-page"><header class="gpr-head"><div class="gpr-eyebrow">${esc(pr.root.split("/").pop())} / PR #${pr.number}</div>
    <h2>${esc(pr.title)}</h2><div class="gpr-meta"><span class="gpr-state" data-state="${prState(pr).key}">${prState(pr).label}</span>
    <span class="gpr-branches">${esc(pr.head)} → ${esc(pr.base)}</span><span>${esc(pr.author)}</span>
    <button type="button" class="cc-btn cc-btn-txt" data-gpr-open>GitHub에서 열기</button>
    <button type="button" class="cc-btn cc-btn-txt" data-gpr-refresh>새로고침</button></div></header>
    <nav class="gpr-tabs" role="tablist" aria-label="PR 상세">${[
      ["conversation", "대화", pr.comments.length + pr.reviews.length + (pr.reviewComments?.length || 0)],
      ["checks", "검사", pr.checks.length], ["files", "변경 파일", pr.files.length],
    ].map(([id, title, n]) => `<button type="button" role="tab" aria-selected="${selected === id}" class="gpr-tab${selected === id ? " on" : ""}" data-gpr-section="${id}">${title} <span>${n}</span></button>`).join("")}</nav>
    <div class="gpr-body">${selected === "conversation" ? conversation(pr) : selected === "checks" ? checks(pr, tab.logs || new Map()) : files(pr)}</div>
    ${tab.notice ? `<p class="gpr-notice" role="status">${esc(tab.notice)}</p>` : ""}</div>`;
  host.querySelector("[data-gpr-refresh]").onclick = onRefresh;
  host.querySelector("[data-gpr-open]").onclick = onOpenUrl;
  host.querySelectorAll("[data-gpr-section]").forEach((button) => button.onclick = () => {
    tab.section = button.dataset.gprSection;
    renderGithubPrView(tab, { host, onRefresh, onLog, onDraft, onOpenUrl, onFile });
    host.querySelector(`[data-gpr-section="${tab.section}"]`)?.focus();
  });
  host.querySelectorAll("[data-gpr-file]").forEach((button) => button.onclick = () => onFile?.(button.dataset.gprFile));
  host.querySelectorAll("[data-gpr-log]").forEach((button) => button.onclick = () => onLog(button.dataset.gprLog));
  host.querySelectorAll("[data-gpr-draft]").forEach((button) => button.onclick = () => {
    const key = button.dataset.gprDraft;
    if (key.startsWith("log:")) {
      const runId = key.slice(4), check = pr.checks.find((x) => x.runId === runId), log = tab.logs?.get(runId);
      if (check && log?.text) onDraft(`PR #${pr.number}: ${pr.title}\n실패한 검사: ${check.name}\n${pr.url}\n\n${log.text}`.slice(0, 12000));
    } else {
      const events = [...pr.comments.map((x) => ({ ...x, when: x.createdAt })), ...pr.reviews.map((x) => ({ ...x, when: x.submittedAt })),
        ...(pr.reviewComments || []).map((x) => ({ ...x, when: x.createdAt }))]
        .sort((a, b) => String(a.when).localeCompare(String(b.when)));
      const item = events[Number(key.slice(6))];
      if (item?.body) onDraft(`PR #${pr.number}: ${pr.title}\n${pr.url}\n${item.path ? `${item.path}${item.line ? `:${item.line}` : ""}\n` : ""}${item.author}:\n${item.body}`.slice(0, 12000));
    }
  });
}
