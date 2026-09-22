// 파일 검색 팔레트. 현재 스페이스의 파일 트리를 fuzzy 검색해 여는 Quick Open을 맡는다.
//
// 소유 범위
//   팔레트 DOM·검색 결과·선택 상태와 15초 파일 트리 캐시.
//
// 제공 API
//   initFilePalette(deps), openFilePalette, spaceRootFor, handleFilePaletteTree.
//
// 의존 대상
//   main의 esc·wsSend·lastAgents 접근자와 center의 consoleSpace·openFile을 init에서 주입받는다.
//
// 유지 조건
//   파일명 우선 fuzzy 점수, 최대 200개 표시, 15초 캐시, 비동기 tree 응답의 root 일치 조건.
//
// 영향 범위
//   main 소유 lastAgents와 center 소유 centerSpace를 읽는 consoleSpace 경계,
//   Explorer의 파일 reveal root 판정, WebSocket tree 응답 라우팅, sheet 파일 메뉴의 열기 동작.

import { consoleSpace, openFile } from "./file-routing.js";

let esc, wsSend, getLastAgents;

let palEl = null, palInput = null, palListEl = null;
let palRoot = null, palFiles = [], palTrunc = false, palMatches = [], palSel = 0, palOpen = false;
const treeCache = new Map(); // root → {at, files, truncated}

export function initFilePalette(deps) {
  ({ esc, wsSend, getLastAgents } = deps);
}

export function spaceRootFor(sp) {
  sp = sp || consoleSpace();
  const a = getLastAgents().find((x) => x.workspaceId === sp && x.cwd);
  return a ? a.cwd : null;
}

function ensurePaletteDom() {
  if (palEl) return;
  palEl = document.createElement("div"); palEl.className = "palette-backdrop"; palEl.hidden = true;
  palEl.innerHTML = `<div class="palette"><input class="pal-input" type="text" placeholder="파일 이름으로 검색…  (스페이스 내 전체)" spellcheck="false" autocomplete="off"><ul class="pal-list"></ul><div class="pal-hint"></div></div>`;
  document.body.appendChild(palEl);
  palInput = palEl.querySelector(".pal-input"); palListEl = palEl.querySelector(".pal-list");
  palEl.addEventListener("mousedown", (e) => { if (e.target === palEl) closePalette(); });
  palInput.addEventListener("input", () => { palSel = 0; computePaletteMatches(); });
  palInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); palSel = Math.min(palSel + 1, palMatches.length - 1); renderPaletteList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); palSel = Math.max(palSel - 1, 0); renderPaletteList(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); openPaletteSel(); }
  });
  palListEl.addEventListener("click", (e) => { const li = e.target.closest("[data-i]"); if (li) { palSel = +li.dataset.i; openPaletteSel(); } });
}

export function openFilePalette() {
  ensurePaletteDom();
  const root = spaceRootFor();
  if (!root) { palRoot = null; palFiles = []; palTrunc = false; }
  else {
    palRoot = root; const c = treeCache.get(root);
    if (c && Date.now() - c.at < 15000) { palFiles = c.files; palTrunc = c.truncated; }
    else { palFiles = []; palTrunc = false; wsSend({ type: "fs.tree", path: root }); }
  }
  palOpen = true; palEl.hidden = false; palInput.value = ""; palSel = 0;
  computePaletteMatches(); setTimeout(() => palInput.focus(), 0);
}

function closePalette() { palOpen = false; if (palEl) palEl.hidden = true; }

function fuzzyScore(q, target) {
  const t = target.toLowerCase(); let qi = 0, score = 0, pos = [], prev = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { let s = 1; if (i === prev + 1) s += 4; if (i === 0 || /[\/_.\- ]/.test(t[i - 1])) s += 6; score += s; pos.push(i); prev = i; qi++; }
  }
  return qi === q.length ? { score, pos } : null;
}

function computePaletteMatches() {
  const q = (palInput.value || "").trim().toLowerCase();
  const rootLen = palRoot ? palRoot.replace(/\/$/, "").length + 1 : 0;
  if (!q) { palMatches = palFiles.slice(0, 200).map((abs) => ({ abs, rel: abs.slice(rootLen), pos: [] })); }
  else {
    const out = [];
    for (const abs of palFiles) {
      const rel = abs.slice(rootLen), base = rel.split("/").pop();
      const mb = fuzzyScore(q, base), mr = mb ? null : fuzzyScore(q, rel);
      if (!mb && !mr) continue;
      if (mb) { const off = rel.length - base.length; out.push({ abs, rel, score: mb.score + 100, pos: mb.pos.map((p) => p + off) }); }
      else { out.push({ abs, rel, score: mr.score, pos: mr.pos }); }
    }
    out.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    palMatches = out.slice(0, 200);
  }
  if (palSel >= palMatches.length) palSel = Math.max(0, palMatches.length - 1);
  renderPaletteList();
}

function highlightMatch(base, pos, off) {
  const set = new Set(pos.map((p) => p - off).filter((p) => p >= 0 && p < base.length));
  let out = ""; for (let i = 0; i < base.length; i++) out += set.has(i) ? `<b>${esc(base[i])}</b>` : esc(base[i]);
  return out;
}

function renderPaletteList() {
  if (!palListEl) return;
  const hint = palEl.querySelector(".pal-hint");
  if (!palRoot) { palListEl.innerHTML = `<li class="pal-empty">열린 스페이스가 없습니다</li>`; hint.textContent = ""; return; }
  if (!palFiles.length) { palListEl.innerHTML = `<li class="pal-empty">불러오는 중…</li>`; hint.textContent = ""; return; }
  palListEl.innerHTML = palMatches.map((m, i) => {
    const base = m.rel.split("/").pop(), dir = m.rel.slice(0, m.rel.length - base.length);
    return `<li class="pal-item${i === palSel ? " sel" : ""}" data-i="${i}"><span class="pal-name">${highlightMatch(base, m.pos, m.rel.length - base.length)}</span><span class="pal-dir">${esc(dir)}</span></li>`;
  }).join("") || `<li class="pal-empty">일치하는 파일 없음</li>`;
  hint.textContent = `${palMatches.length}${palMatches.length >= 200 ? "+" : ""} 결과${palTrunc ? " · 목록 일부만(대형 트리)" : ""}`;
  const sel = palListEl.querySelector(".pal-item.sel"); if (sel) sel.scrollIntoView({ block: "nearest" });
}

function openPaletteSel() { const m = palMatches[palSel]; if (!m) return; closePalette(); openFile(m.abs); }

export function handleFilePaletteTree(m) {
  const files = m.error ? [] : (m.files || []);
  treeCache.set(m.root, { at: Date.now(), files, truncated: !!m.truncated });
  if (palOpen && palRoot === m.root) { palFiles = files; palTrunc = !!m.truncated; computePaletteMatches(); }
}
