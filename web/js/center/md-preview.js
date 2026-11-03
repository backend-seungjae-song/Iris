// 소유 범위: 칸별 마크다운 모드·미리보기·입력 지연 갱신
// 제공 API: initCapability와 mdpreview 막대·본문·모드·변경·정리 훅
// 의존 대상: hooks·markdown·탭과 칸 상태·파일 확장자
// 유지 조건: 기능 해제 시 원문 편집, 칸별 모드, draft 우선, 해당 칸 안 DOM 탐색
// 영향 범위: center/text-editor.js·tabs.js의 렌더·외부 변경·모델 폐기
import { provide } from "../core/hooks.js";
import { mdToHtml, isMarkdownExtension } from "../core/markdown.js";
import { extOf } from "../explorer/tree.js";
import { getCenterSpace, getCurrentTabs } from "./tab-store.js";
import { paneLayout } from "./pane-store.js";

const modes = new WeakMap();
const previews = new Map();
const pending = new Map();
const focusedPane = () => paneLayout(getCenterSpace())?.focus || 0;
const isMd = (t) => isMarkdownExtension(extOf(String(t?.path || "")));
function mode(t, pane) { return modes.get(t)?.get(pane) ?? t.mdMode ?? "raw"; }
function draw(entry) {
  if (entry.preview.isConnected === false || mode(entry.tab, entry.pane) !== "preview") return;
  entry.preview.innerHTML = mdToHtml(entry.tab.draft != null ? entry.tab.draft : entry.tab.content);
}

export function initCapability() {
  provide("mdpreview.barHtml", (t, pane = focusedPane()) => (isMd(t)
    ? `<button data-md="raw" class="${mode(t, pane) !== "preview" ? "on" : ""}">원문</button>`
      + `<button data-md="preview" class="${mode(t, pane) === "preview" ? "on" : ""}">미리보기</button>`
    : ""));

  provide("mdpreview.paneHtml", (t) => (isMd(t) ? `<div class="md-body" data-md-preview hidden></div>` : ""));

  provide("mdpreview.render", (t, wrap, pane = focusedPane()) => {
    previews.delete(pane);
    if (!isMd(t) || mode(t, pane) !== "preview") return false;
    const preview = wrap?.parentElement?.querySelector("[data-md-preview]");
    if (!preview) return false;
    const entry = { tab: t, preview, pane };
    previews.set(pane, entry);
    preview.hidden = false;
    draw(entry);
    wrap.classList.add("hidden");
    return true;
  });

  provide("mdpreview.presents", (t, pane = focusedPane()) => isMd(t) && mode(t, pane) === "preview");

  provide("mdpreview.click", (target, t, pane = focusedPane()) => {
    const md = target?.closest?.("[data-md]");
    if (!md || !isMd(t)) return false;
    if (!modes.has(t)) modes.set(t, new Map());
    modes.get(t).set(pane, md.dataset.md);
    return true;
  });

  provide("mdpreview.changed", (t) => {
    if (!isMd(t)) return;
    clearTimeout(pending.get(t.path));
    pending.set(t.path, setTimeout(() => {
      pending.delete(t.path);
      for (const entry of previews.values()) if (entry.tab.path === t.path) draw(entry);
    }, 120));
  });
  provide("mdpreview.paneCollapsed", (from) => {
    for (const tab of getCurrentTabs()) {
      if (!isMd(tab)) continue;
      const previous = mode(tab, from);
      if (!modes.has(tab)) modes.set(tab, new Map());
      modes.get(tab).set(0, previous);
    }
    previews.delete(from);
  });
  provide("mdpreview.closed", (path) => {
    clearTimeout(pending.get(path)); pending.delete(path);
    for (const [pane, entry] of previews) if (entry.tab.path === path) previews.delete(pane);
  });
  return {};
}
