// 칸별 탭 소속·활성 탭·포커스·폭 비율, DOM과 저장 장치 의존 없음
const spaces = new Map();
const groupOf = (tab) => tab.kind === "browser" ? "browser" : "file";
const clamp = (ratio) => Number.isFinite(ratio) ? Math.max(0.2, Math.min(0.8, ratio)) : 0.5;
function state(space) {
  if (!spaces.has(space)) spaces.set(space, { active: undefined, ids: new Set(), layout: null, pending: null, recent: [] });
  return spaces.get(space);
}
function pane(ids, active) { return { ids: new Set(ids), active }; }
function remember(s, id) { s.recent = [id, ...s.recent.filter((x) => x !== id)].slice(0, 50); }
function remainingActive(s, p) { return [p.active, ...s.recent].find((id) => p.ids.has(id)) ?? [...p.ids].at(-1) ?? null; }
function collapseEmpty(space) {
  const s = state(space), layout = s.layout;
  if (!layout) return;
  const empty = layout.panes.findIndex((p) => !p.ids.size);
  if (empty < 0) return;
  layout.focus = 1 - empty;
  s.ids = new Set(layout.panes[layout.focus].ids);
  s.active = layout.panes[layout.focus].active;
  s.collapsedFrom = layout.focus;
  s.layout = null; s.pending = null;
}
function assignNew(layout, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  for (const tab of tabs) {
    if (layout.panes.some((p) => p.ids.has(tab.id))) continue;
    const matches = layout.panes.map((p) => [...p.ids].some((id) => groupOf(byId.get(id) || {}) === groupOf(tab)));
    const index = matches[0] !== matches[1] ? Number(matches[1]) : layout.focus;
    const p = layout.panes[index]; p.ids.add(tab.id);
    if (p.active == null) p.active = tab.id;
  }
}

export function paneTakeCollapsed(space) {
  const s = state(space), from = s.collapsedFrom;
  s.collapsedFrom = null;
  return from ?? null;
}
export function paneLayout(space) { return state(space).layout; }
export function paneActive(space) {
  const s = state(space);
  return s.layout ? s.layout.panes[s.layout.focus].active : s.active;
}
export function paneIndex(space, id) {
  const layout = paneLayout(space);
  if (!layout) return 0;
  return layout.panes[layout.focus].ids.has(id) ? layout.focus : layout.panes.findIndex((p) => p.ids.has(id));
}
export function paneHas(space, id) {
  const s = state(space);
  return s.layout ? s.layout.panes.some((p) => p.ids.has(id)) : s.ids.has(id);
}
export function paneSelect(space, id, index = paneIndex(space, id)) {
  const s = state(space);
  remember(s, id);
  if (s.layout && s.layout.panes[index]?.ids.has(id)) { s.layout.focus = index; s.layout.panes[index].active = id; }
  else if (!s.layout) s.active = id;
  return id;
}
export function paneFocus(space, index) {
  const layout = paneLayout(space);
  if (layout?.panes[index]) layout.focus = index;
}
export function paneRatio(space, ratio) {
  const layout = paneLayout(space);
  if (layout) layout.ratio = clamp(ratio);
}
export function paneVisible(space, id) {
  if (id == null) return false;
  const layout = paneLayout(space);
  return layout ? layout.panes.some((p) => p.active === id) : paneActive(space) === id;
}
export function paneTabs(space, tabs, index = paneLayout(space)?.focus || 0) {
  const layout = paneLayout(space);
  if (!layout) return tabs;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  return [...(layout.panes[index]?.ids || [])].map((id) => byId.get(id)).filter(Boolean);
}
export function paneActives(space) {
  const layout = paneLayout(space);
  return layout ? layout.panes.map((p) => p.active) : [paneActive(space)];
}
export function paneCanSplit(space, tabs, id, duplicable = false, source = paneIndex(space, id)) {
  const target = tabs.find((t) => t.id === id), layout = paneLayout(space);
  if (!target) return false;
  const copy = duplicable && target.kind === "file";
  if (!layout) return copy || tabs.length > 1;
  return source === 0 && layout.panes[0].ids.has(id) && (copy || layout.panes[0].ids.size > 1);
}
export function paneSplit(space, tabs, id, duplicable = false, source = paneIndex(space, id)) {
  if (!paneCanSplit(space, tabs, id, duplicable, source)) return false;
  const s = state(space), target = tabs.find((t) => t.id === id), copy = duplicable && target.kind === "file";
  if (s.layout) {
    if (copy) { s.layout.panes[1].ids.add(id); paneSelect(space, id, 1); return true; }
    return paneMove(space, tabs, id, 1, source);
  }
  const ids = tabs.filter((t) => copy || t.id !== id).map((t) => t.id);
  const left = pane(ids, null); left.active = remainingActive(s, left);
  s.ids = new Set(tabs.map((t) => t.id));
  s.layout = { panes: [left, pane([id], id)], focus: 1, ratio: 0.5 };
  s.pending = null; remember(s, id);
  return true;
}
export function paneMove(space, tabs, id, index, source = paneIndex(space, id)) {
  const s = state(space), layout = s.layout;
  if (index !== 0 && index !== 1) return false;
  if (!layout) return index === 1 && paneSplit(space, tabs, id);
  if (source === index || !layout.panes[source]?.ids.has(id)) return false;
  layout.panes[source].ids.delete(id);
  layout.panes[source].active = remainingActive(s, layout.panes[source]);
  layout.panes[index].ids.add(id); paneSelect(space, id, index);
  collapseEmpty(space);
  return true;
}
export function paneRemove(space, id, index = paneIndex(space, id)) {
  const s = state(space), p = s.layout?.panes[index];
  if (!s.layout) {
    if (!s.ids.delete(id)) return false;
    if (s.active === id) s.active = remainingActive(s, { ids: s.ids });
    return true;
  }
  if (!p?.ids.delete(id)) return false;
  p.active = remainingActive(s, p);
  collapseEmpty(space);
  return true;
}
export function paneSync(space, tabs, complete = false, canDuplicate = (tab) => tab.kind === "file") {
  const s = state(space), byId = new Map(tabs.map((t) => [t.id, t]));
  s.ids = new Set(byId.keys());
  if (s.pending && !s.layout) {
    const saved = s.pending;
    const expected = saved.panes ? saved.panes.flatMap((p) => p.ids) : [...saved.right, saved.leftActive, saved.rightActive].filter(Boolean);
    if (!complete && expected.some((id) => !byId.has(id))) return;
    const right = saved.panes ? saved.panes[1] : { ids: saved.right, active: saved.rightActive };
    const left = saved.panes ? saved.panes[0] : { ids: tabs.filter((t) => !saved.right.includes(t.id)).map((t) => t.id), active: saved.leftActive };
    s.layout = { panes: [left, right].map((p) => pane(p.ids.filter((id) => byId.has(id)), p.active)), focus: saved.focus, ratio: saved.ratio };
    s.pending = null;
    assignNew(s.layout, tabs);
  }
  const layout = s.layout;
  if (!layout) return;
  const other = layout.panes[1 - layout.focus];
  for (const id of layout.panes[layout.focus].ids) {
    const tab = byId.get(id);
    if (tab && other.ids.has(id) && !canDuplicate(tab)) other.ids.delete(id);
  }
  for (const p of layout.panes) {
    p.ids = new Set([...p.ids].filter((id) => byId.has(id)));
    p.active = remainingActive(s, p);
  }
  assignNew(layout, tabs);
  collapseEmpty(space);
}
export function paneRename(space, oldId, newId) {
  const s = state(space);
  const rename = (p) => {
    p.ids = new Set([...p.ids].map((id) => id === oldId ? newId : id));
    if (p.active === oldId) p.active = newId;
  };
  rename(s);
  for (const p of s.layout?.panes || []) rename(p);
  s.recent = s.recent.map((id) => id === oldId ? newId : id);
  if (s.pending) {
    if (s.pending.panes) for (const p of s.pending.panes) { p.ids = p.ids.map((id) => id === oldId ? newId : id); if (p.active === oldId) p.active = newId; }
    else { s.pending.right = s.pending.right.map((id) => id === oldId ? newId : id); for (const key of ["leftActive", "rightActive"]) if (s.pending[key] === oldId) s.pending[key] = newId; }
  }
}
export function paneRestore(space, saved) {
  const s = state(space);
  if (!saved) return;
  const base = { ratio: clamp(saved.ratio), focus: saved.focus === 1 ? 1 : 0 };
  const ids = (list) => [...new Set(list.filter((id) => typeof id === "string"))];
  if (Array.isArray(saved.panes) && saved.panes.length === 2 && saved.panes.every((p) => Array.isArray(p?.ids))) {
    s.pending = { ...base, panes: saved.panes.map((p) => ({ ids: ids(p.ids), active: p.active })) };
  } else if (Array.isArray(saved.right) && saved.right.length) {
    s.pending = { ...base, right: ids(saved.right), rightActive: saved.rightActive, leftActive: saved.leftActive };
  }
}
export function paneSnapshot(space) {
  const s = state(space), layout = s.layout;
  if (!layout) return s.pending;
  return { ratio: layout.ratio, focus: layout.focus, panes: layout.panes.map((p) => ({ ids: [...p.ids], active: p.active })) };
}
