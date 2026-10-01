export function returnPlace(home, layoutOn) {
  return home === "stage" ? "stage" : home === "column" && layoutOn ? "column" : "tab";
}

export function phoneControls(platform) {
  if (platform === "Android") return ["back", "home", "recents", "rotate", "volume_down", "volume_up", "lock"];
  if (platform === "iOS") return ["home", "rotate"];
  return [];
}

export function pickSurface(kind, insideScreen) {
  if (insideScreen) return false;
  return kind === "tab" || kind === "column" || kind === "stage" || kind === "window";
}

// 요소 선택 중에도 지정으로 가로채지 않는 곳: 기기 화면, 툴바 조작 요소(요소 선택 끄기 단추 포함)
export const PICK_PASS = ".emu-screen-surface, .emu-toolbar :is(button, input, select, textarea, [role=button], [role=menuitem], [role=combobox])";

export function pickTargetAt(el, entries, column, stageHost) {
  if (!el?.closest || el.closest(PICK_PASS)) return null;
  const tabEl = el.closest(".ctab");
  const tabId = tabEl?.dataset?.tab;
  const entry = tabId ? entries.find((item) => item.tab.id === tabId && !item.detached)
    : entries.find((item) => !item.detached && (item.el.contains(el) || item.tools?.contains(el)))
    || entries.find((item) => !item.detached && (
      item.inColumn && !item.el.hidden && column?.contains(el) || item.inStage && !item.el.hidden && stageHost?.contains(el) || item.el.contains(el)));
  if (!entry) return null;
  const where = tabEl ? "tab" : entry.inColumn ? "column" : entry.inStage ? "stage" : "tab";
  if (!pickSurface(where, false)) return null;
  return { entry, el: tabEl || (entry.el.contains(el) ? entry.el : entry.inColumn && column || entry.inStage && stageHost || entry.el), where };
}
