// 작업 화면 배치 트리. 영역을 어디에 어떤 크기로 둘지를 계산하는 순수 함수만 둔다(DOM 없음).
//
// 소유 범위
//   트리 모양(split · stack · leaf), 기본 배치, 정규화, 영역 옮기기, 크기 바꾸기, 사각형 계산.
//   요소에 적용하고 저장하고 편집 화면을 그리는 일은 layout-engine.js 가 한다.
//
// 제공 API
//   defaultTree(sizes) · normalizeTree(tree, opts) · computeLayout(tree, box, ctx) · moveRegion(tree, id, target, zone, size)
//   · setKidSize(tree, path, index, key, px) · leafIds(tree) · SPLIT_PX
//
// 유지 조건
//   split 의 자식 하나만 늘어나고 나머지는 px 이다. 늘어나는 자식은 center 를 보이는 자식, 없으면 tools 를
//   보이는 자식, 없으면 마지막 자식이다. 이 규칙이 "채팅 폭은 그대로, 가운데가 늘어난다"와 전체형 화면이
//   가운데까지 늘어나는 동작을 낸다.
//   크기는 자식마다 키별로 둔다. 그 자식에서 지금 도구 화면이 보이면 "tools:<화면 id>", 아니면 "base".
//   도구마다 폭을 따로 기억하던 동작과 같다.
//   트리는 값으로만 다룬다. 바꾸는 함수는 새 트리를 돌려준다.
//
// 영향 범위
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/core/layout-tree.js

export const SPLIT_PX = 6;
const MIN_FLEX = 160;
const MIN_FIXED = 60;
const DEFAULT_SIZE = { row: 300, col: 220 };

export const SHELL_REGIONS = ["explorer", "spaces", "agents", "tools", "center", "chat"];

const leaf = (id) => ({ t: "leaf", id });
const kid = (node, base) => ({ node, size: base == null ? {} : { base } });

// 지금 화면과 같은 배치. sizes 는 옛 저장값에서 옮겨 온 px 이다.
export function defaultTree(sizes = {}) {
  const left = kid({ t: "stack", kids: [leaf("tools"), { t: "split", dir: "col", kids: [
    kid(leaf("explorer"), sizes.explorerH ?? 270),
    kid(leaf("spaces"), sizes.spacesH ?? 182),
    kid(leaf("agents"), null),
  ] }] }, sizes.sidebarW ?? 280);
  for (const [panel, px] of Object.entries(sizes.toolW || {})) left.size["tools:" + panel] = px;
  return { t: "split", dir: "row", kids: [
    left,
    kid(leaf("center"), null),
    kid(leaf("chat"), sizes.chatW ?? 420),
  ] };
}

export function leafIds(node, out = []) {
  if (!node) return out;
  if (node.t === "leaf") out.push(node.id);
  else for (const k of node.kids || []) leafIds(node.t === "split" ? k.node : k, out);
  return out;
}

// 저장본을 믿을 수 있는 모양으로 되돌린다. 앱 셸 영역이 하나라도 없거나 모양이 깨졌으면 기본 배치로
// 돌아간다. 기능 영역은 등록된 것만 기본 자리에 더하고, 등록되지 않은 id 는 지우지 않는다(기능을 잠시 꺼도
// 자리가 남도록). 보이지 않는 영역은 계산에서 빠지므로 자리를 차지하지 않는다.
export function normalizeTree(tree, { registered = [], fallback } = {}) {
  const seen = new Set();
  const clean = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.t === "leaf") {
      if (typeof node.id !== "string" || !/^[\w.-]{1,40}$/.test(node.id) || seen.has(node.id)) return null;
      seen.add(node.id); return leaf(node.id);
    }
    if (node.t === "stack") {
      const kids = (Array.isArray(node.kids) ? node.kids : []).map(clean).filter(Boolean);
      return kids.length === 0 ? null : kids.length === 1 ? kids[0] : { t: "stack", kids };
    }
    if (node.t === "split" && (node.dir === "row" || node.dir === "col")) {
      const kids = (Array.isArray(node.kids) ? node.kids : [])
        .map((k) => ({ node: clean(k && k.node), size: cleanSize(k && k.size) }))
        .filter((k) => k.node);
      if (kids.length === 0) return null;
      if (kids.length === 1) return kids[0].node;
      return { t: "split", dir: node.dir, kids };
    }
    return null;
  };
  let out = clean(tree);
  const base = fallback || defaultTree();
  if (!out || SHELL_REGIONS.some((id) => !seen.has(id))) { seen.clear(); out = clean(base); }
  for (const reg of registered) {
    const id = typeof reg === "string" ? reg : reg.id;
    const px = (reg && reg.size) || DEFAULT_SIZE.row;
    if (seen.has(id)) continue;
    seen.add(id);
    // 기능 영역의 기본 자리는 채팅 왼쪽 열이다.
    out = seen.has("chat") ? moveRegion(out, id, "chat", "left", px, true) : appendRoot(out, id, px);
  }
  return out;
}

function cleanSize(size) {
  const out = {};
  if (size && typeof size === "object") {
    for (const [k, v] of Object.entries(size)) if (/^[\w:.-]{1,60}$/.test(k) && Number.isFinite(v) && v > 0) out[k] = Math.round(v);
  }
  return out;
}

function appendRoot(tree, id, px) {
  if (tree.t === "split" && tree.dir === "row") return { ...tree, kids: [...tree.kids, kid(leaf(id), px)] };
  return { t: "split", dir: "row", kids: [kid(tree, null), kid(leaf(id), px)] };
}

// ---- 계산 ----

// ctx: { visible(id), collapsedPx(id) → px|null, toolKey: "tools:<id>"|null, pick: Map(pathKey → 자식 번호),
//        prefer(id) }. 편집 화면은 모든 영역을 visible 로 계산하고, 겹친 자리에서는 prefer(실제로 보이는 것)를
//        먼저 고른다.
function makeQuery(ctx) {
  const pickOf = (node, path) => {
    const forced = ctx.pick && ctx.pick.get(path.join("."));
    if (forced != null && forced < node.kids.length) return forced;
    let i = ctx.prefer ? node.kids.findIndex((k, j) => hasBy(ctx.prefer, k, [...path, j])) : -1;
    if (i < 0) i = node.kids.findIndex((k, j) => has(k, [...path, j]));
    return i < 0 ? 0 : i;
  };
  const hasBy = (vis, node, path) => {
    if (node.t === "leaf") return !!vis(node.id);
    if (node.t === "stack") return node.kids.some((k, j) => hasBy(vis, k, [...path, j]));
    return node.kids.some((k, j) => hasBy(vis, k.node, [...path, j]));
  };
  const has = (node, path) => hasBy(ctx.visible, node, path);
  const shows = (node, path, id) => {
    if (node.t === "leaf") return node.id === id && !!ctx.visible(id);
    if (node.t === "stack") { const i = pickOf(node, path); return shows(node.kids[i], [...path, i], id); }
    return node.kids.some((k, j) => shows(k.node, [...path, j], id));
  };
  return { has, shows, pickOf };
}

export function sizeKey(q, node, path, ctx) {
  return ctx.toolKey && q.shows(node, path, "tools") ? ctx.toolKey : "base";
}

// 결과: rects(id → {x,y,w,h}), splits(끌 수 있는 경계), stacks(겹친 자리, 편집 화면용).
export function computeLayout(tree, box, ctx) {
  const q = makeQuery(ctx);
  const rects = {}, splits = [], stacks = [];
  const place = (node, r, path) => {
    if (node.t === "leaf") { if (ctx.visible(node.id)) rects[node.id] = r; return; }
    if (node.t === "stack") {
      const i = q.pickOf(node, path);
      stacks.push({ path, rect: r, pick: i, members: node.kids.map((k) => leafIds(k)) });
      place(node.kids[i], r, [...path, i]);
      return;
    }
    const row = node.dir === "row";
    const vis = node.kids.map((k, j) => ({ k, j })).filter(({ k, j }) => q.has(k.node, [...path, j]));
    if (!vis.length) return;
    if (vis.length === 1) { place(vis[0].k.node, r, [...path, vis[0].j]); return; }
    const along = row ? r.w : r.h;
    let flex = vis.findIndex(({ k, j }) => q.shows(k.node, [...path, j], "center"));
    if (flex < 0) flex = vis.findIndex(({ k, j }) => q.shows(k.node, [...path, j], "tools"));
    if (flex < 0) flex = vis.length - 1;
    const items = vis.map(({ k, j }, n) => {
      const p = [...path, j];
      const fixed = !row && k.node.t === "leaf" && ctx.collapsedPx ? ctx.collapsedPx(k.node.id) : null;
      const key = sizeKey(q, k.node, p, ctx);
      const px = fixed ?? k.size[key] ?? k.size.base ?? DEFAULT_SIZE[node.dir];
      return { j, p, node: k.node, key, px: n === flex ? 0 : px, fixed: fixed != null, flex: n === flex };
    });
    // 고정 크기의 합이 자리를 넘으면 늘어나는 자식에게 최소폭을 남기고 비율대로 줄인다.
    const fixedSum = items.reduce((s, it) => s + (it.flex ? 0 : it.px), 0);
    const room = Math.max(0, along - MIN_FLEX);
    if (fixedSum > room && fixedSum > 0) {
      const scale = room / fixedSum;
      for (const it of items) if (!it.flex && !it.fixed) it.px = Math.max(MIN_FIXED, Math.floor(it.px * scale));
    }
    const used = items.reduce((s, it) => s + (it.flex ? 0 : it.px), 0);
    const flexIt = items.find((it) => it.flex);
    flexIt.px = Math.max(0, along - used);
    let at = row ? r.x : r.y;
    items.forEach((it, n) => {
      const cr = row ? { x: at, y: r.y, w: it.px, h: r.h } : { x: r.x, y: at, w: r.w, h: it.px };
      place(it.node, cr, it.p);
      at += it.px;
      if (n === items.length - 1) return;
      // 경계를 끌면 이 경계를 실제로 움직이는 칸의 크기를 바꾼다. 늘어나는 칸이 뒤에 있으면 앞쪽에서 가장
      // 가까운 칸, 앞에 있으면 뒤쪽에서 가장 가까운 칸이다. 접힌 칸은 머리 높이로 고정이라 건너뛴다.
      const flexN = items.indexOf(flexIt);
      const resizable = (x) => x && !x.flex && !x.fixed;
      let target = null, sign = 1;
      if (flexN > n) { for (let m = n; m >= 0 && !target; m--) if (resizable(items[m])) target = items[m]; sign = 1; }
      else { for (let m = n + 1; m < items.length && !target; m++) if (resizable(items[m])) target = items[m]; sign = -1; }
      if (!target) return;
      splits.push({
        path, dir: node.dir, index: target.j, key: target.key, sign, start: target.px,
        max: target.px + (flexIt.px - MIN_FLEX),
        rect: row ? { x: at - SPLIT_PX / 2, y: r.y, w: SPLIT_PX, h: r.h } : { x: r.x, y: at - SPLIT_PX / 2, w: r.w, h: SPLIT_PX },
      });
    });
  };
  place(tree, box, []);
  return { rects, splits, stacks };
}

// ---- 바꾸기 ----

const clone = (v) => JSON.parse(JSON.stringify(v));

function nodeAt(tree, path) {
  let n = tree;
  for (const i of path) n = n.t === "split" ? n.kids[i].node : n.kids[i];
  return n;
}

export function setKidSize(tree, path, index, key, px) {
  const out = clone(tree);
  const split = nodeAt(out, path);
  if (!split || split.t !== "split" || !split.kids[index]) return tree;
  split.kids[index].size[key] = Math.max(MIN_FIXED, Math.round(px));
  return out;
}

function removeLeaf(node, id) {
  if (node.t === "leaf") return node.id === id ? null : node;
  if (node.t === "stack") {
    const kids = node.kids.map((k) => removeLeaf(k, id)).filter(Boolean);
    return kids.length === 0 ? null : kids.length === 1 ? kids[0] : { t: "stack", kids };
  }
  const kids = node.kids.map((k) => ({ node: removeLeaf(k.node, id), size: k.size })).filter((k) => k.node);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0].node;
  return { t: "split", dir: node.dir, kids };
}

// id 영역을 target 영역의 zone(left·right·top·bottom·stack) 쪽으로 옮긴다. size 는 새로 생기는 칸의 px.
// keepIfMissing 은 정규화에서 아직 트리에 없는 id 를 더할 때 쓴다.
export function moveRegion(tree, id, target, zone, size, keepIfMissing = false) {
  if (id === target) return tree;
  const present = leafIds(tree).includes(id);
  if (!present && !keepIfMissing) return tree;
  let out = present ? removeLeaf(clone(tree), id) : clone(tree);
  if (!out) return tree;
  const dir = zone === "left" || zone === "right" ? "row" : zone === "top" || zone === "bottom" ? "col" : null;
  const before = zone === "left" || zone === "top";
  const px = size ?? (dir ? DEFAULT_SIZE[dir] : null);
  const insert = (node) => {
    if (node.t === "leaf") {
      if (node.id !== target) return null;
      if (!dir) return { t: "stack", kids: [node, leaf(id)] };
      const kids = before ? [kid(leaf(id), px), kid(node, null)] : [kid(node, null), kid(leaf(id), px)];
      return { t: "split", dir, kids };
    }
    if (node.t === "stack") {
      const i = node.kids.findIndex((k) => leafIds(k).includes(target));
      if (i < 0) return null;
      if (!dir && node.kids[i].t === "leaf") return { t: "stack", kids: [...node.kids, leaf(id)] };
      const r = insert(node.kids[i]); if (!r) return null;
      const kids = node.kids.slice(); kids[i] = r; return { t: "stack", kids };
    }
    const i = node.kids.findIndex((k) => leafIds(k.node).includes(target));
    if (i < 0) return null;
    const child = node.kids[i];
    // 같은 방향의 split 안에서 형제로 더한다. 새 split 을 한 겹 더 만들지 않는다.
    if (dir === node.dir && child.node.t === "leaf") {
      const kids = node.kids.slice();
      kids.splice(before ? i : i + 1, 0, kid(leaf(id), px));
      return { ...node, kids };
    }
    const r = insert(child.node); if (!r) return null;
    const kids = node.kids.slice(); kids[i] = { node: r, size: child.size };
    return { ...node, kids };
  };
  const res = insert(out);
  return res || tree;
}
