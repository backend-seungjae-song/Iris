// 소유 범위
//   파일·브라우저 분할 메뉴, 탭 드래그, 칸 너비 조절
// 제공 API
//   initCapability(), split.enabled·stripReady·bodyReady·tabItems 훅
// 의존 대상
//   core/hooks·drag-shield, center/pane-store·pane-view·tab-store·tabs
// 유지 조건
//   좌우 두 칸, split.* 훅 등록, webview 부모 유지
// 영향 범위
//   가운데 탭 메뉴·탭바·분할선, 칸 비율 저장, 43-center-split.css

import { callHook, provide } from "../core/hooks.js";
import { beginDrag } from "../core/drag-shield.js";
import { getCenterSpace, getTabs } from "../center/tab-store.js";
import { paneCanSplit, paneIndex, paneLayout, paneMove, paneRatio, paneSplit } from "../center/pane-store.js";
import { persistFileTabs, renderTabs, showActiveTab } from "../center/tabs.js";
import { syncPaneView } from "../center/pane-view.js";

function refresh() { renderTabs(); showActiveTab(); persistFileTabs(); }
const strips = new WeakSet();
let divider;
function stripReady(tabstrip, index) {
  if (strips.has(tabstrip)) return;
  strips.add(tabstrip);
  tabstrip.addEventListener("mousedown", (event) => {
    const chip = event.target.closest(".ctab");
    if (event.button !== 0 || !chip || event.target.closest("button,input")) return;
    const space = getCenterSpace(), id = chip.dataset.tab;
    const tab = getTabs(space).find((t) => t.id === id);
    if (!tab || (!paneLayout(space) && getTabs(space).length < 2)) return;
    const originX = event.clientX, originY = event.clientY;
    let target = index;
    const center = document.getElementById("center");
    const move = (e) => {
      const bounds = center.getBoundingClientRect();
      const ratio = paneLayout(space)?.ratio || 0.5;
      target = e.clientX >= bounds.left && e.clientX <= bounds.right && e.clientY >= bounds.top && e.clientY <= bounds.bottom
        ? Number(e.clientX > bounds.left + bounds.width * ratio) : -1;
      center.dataset.splitDrop = String(target);
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", start, true);
      document.removeEventListener("mouseup", cleanup, true);
      window.removeEventListener("blur", cleanup);
    };
    const start = (e) => {
      if (!(e.buttons & 1)) { cleanup(); return; }
      if (Math.hypot(e.clientX - originX, e.clientY - originY) < 6) return;
      cleanup(); move(e);
      beginDrag({ cursor: "grabbing", onMove: move, onEnd: () => {
        delete center.dataset.splitDrop;
        if (getCenterSpace() === space && paneMove(space, getTabs(space), id, target, index)) refresh();
      } });
    };
    document.addEventListener("mousemove", start, true);
    document.addEventListener("mouseup", cleanup, true);
    window.addEventListener("blur", cleanup);
  });
}
function bodyReady(body) {
  if (!divider) {
    divider = document.createElement("div"); divider.className = "csplit-divider";
    divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", "칸 너비 조절");
    divider.setAttribute("aria-orientation", "vertical"); divider.tabIndex = 0;
    body.appendChild(divider);
    divider.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const space = getCenterSpace(), rect = body.getBoundingClientRect();
      beginDrag({ cursor: "col-resize", onMove: (e) => {
        if (getCenterSpace() !== space || !paneLayout(space) || !rect.width) return;
        paneRatio(space, (e.clientX - rect.left) / rect.width); syncPaneView();
      }, onEnd: persistFileTabs });
    });
    divider.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      const space = getCenterSpace(), layout = paneLayout(space); if (!layout) return;
      event.preventDefault();
      paneRatio(space, event.key === "Home" ? 0.5 : layout.ratio + (event.key === "ArrowLeft" ? -0.05 : 0.05));
      syncPaneView(); persistFileTabs();
    });
  }
  const layout = paneLayout(getCenterSpace());
  divider.hidden = !layout;
  divider.setAttribute("aria-valuenow", String(Math.round((layout?.ratio || 0.5) * 100)));
  divider.setAttribute("aria-valuemin", "20"); divider.setAttribute("aria-valuemax", "80");
}
export function initCapability() {
  provide("split.enabled", () => true);
  provide("split.stripReady", stripReady);
  provide("split.bodyReady", bodyReady);
  provide("split.tabItems", (tab, space, index = paneIndex(space, tab.id)) => {
    const duplicable = tab.kind === "file" && !callHook("viewer.presentsTab", tab);
    return [{ label: "오른쪽으로 분할",
      disabled: !paneCanSplit(space, getTabs(space), tab.id, duplicable, index),
      act: () => { if (paneSplit(space, getTabs(space), tab.id, duplicable, index)) refresh(); },
    }];
  });
  renderTabs(); persistFileTabs();
  return {};
}
