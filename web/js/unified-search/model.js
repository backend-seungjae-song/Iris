// 통합 검색 결과를 현재 Space·Agent·탭·파일 스냅샷에서 만든다.
//
// 소유 범위
//   결과의 출처·소속·중복 판정과 범위별 문자열 필터.
//
// 제공 API
//   collectResults, filterResults.
//
// 의존 대상
//   herdr snapshot과 center 탭 저장소의 읽기 함수.
//
// 유지 조건
//   서버 브라우저 탭과 center에 미러된 같은 탭은 하나만 보여 준다.
//
// 영향 범위
//   통합 검색 화면의 결과 목록과 이동에 필요한 원본 id.

import { getTabs } from "../center/tab-store.js";
import { getTabsForSpace, nameOf } from "../herdr/state.js";

const MAX_RESULTS = 160;

export function collectResults({ spaces, agents, browserState, filesByRoot }) {
  const rows = [];
  const browserTabs = browserState?.tabsBySpace || {};
  for (const space of spaces) {
    const owner = space.label || space.id;
    rows.push({ kind: "스페이스", id: space.id, spaceId: space.id, title: owner,
      detail: space.folder || space.id, path: space.folder || "" });
    for (const agent of agents.filter((a) => a.workspaceId === space.id && a.paneId)) {
      rows.push({ kind: "에이전트", id: agent.paneId, terminalId: agent.terminalId, spaceId: space.id,
        title: nameOf(agent), detail: `${owner} · ${agent.agent || "에이전트"}`, path: space.folder || "" });
    }
    const seen = new Set();
    for (const tab of getTabsForSpace(space.id)) {
      if (!tab.tabId) continue;
      seen.add(tab.tabId);
      rows.push({ kind: "탭", id: tab.tabId, tabType: "terminal", spaceId: space.id,
        title: tab.label || `터미널 ${tab.number || ""}`.trim(), detail: `${owner} · 터미널`, path: space.folder || "" });
    }
    const browserById = new Map((browserTabs[space.id] || []).map((t) => [t.id, t]));
    for (const tab of getTabs(space.id)) {
      if (!tab.id || seen.has(tab.id)) continue;
      seen.add(tab.id);
      const b = browserById.get(tab.id);
      rows.push({ kind: "탭", id: tab.id, tabType: "center", spaceId: space.id,
        title: b?.name || b?.title || tab.label || tab.path || "탭",
        detail: `${owner} · ${tab.path || b?.url || (tab.kind === "browser" ? "브라우저" : "파일")}`,
        path: tab.path || b?.url || "" });
    }
    for (const tab of browserTabs[space.id] || []) {
      if (!tab.id || seen.has(tab.id)) continue;
      seen.add(tab.id);
      rows.push({ kind: "탭", id: tab.id, tabType: "browser", spaceId: space.id,
        title: tab.name || tab.title || tab.url || "브라우저",
        detail: `${owner} · ${tab.url || "브라우저"}`, path: tab.url || "" });
    }
    const root = space.folder;
    if (root) for (const abs of filesByRoot.get(root) || []) {
      rows.push({ kind: "파일", id: abs, spaceId: space.id, title: abs.split("/").pop(),
        detail: `${owner} · ${abs.slice(root.length).replace(/^\//, "")}`, path: abs });
    }
  }
  return rows;
}

export function filterResults(rows, kind, input) {
  const q = input.trim().toLocaleLowerCase();
  const out = rows.filter((row) => (kind === "전체" || row.kind === kind)
    && (!q || `${row.title} ${row.detail}`.toLocaleLowerCase().includes(q)));
  return out.slice(0, MAX_RESULTS);
}
