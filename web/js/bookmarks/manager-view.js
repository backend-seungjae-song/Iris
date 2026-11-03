// 북마크 관리 화면의 목록 계산과 마크업(값만 받고 값만 돌려줌)
//
// 소유 범위
//   북마크 상태 → 구역별 줄 목록, 검색·거르기, "자동" 계정의 실제 계정 설명, 화면 마크업.
//
// 제공 API
//   collectBookmarks(input) · filterSections(sections, query, mode) · autoAccount(row, ctx) ·
//   managerSummary(sections) · sectionsMarkup(sections, ctx) · rowKey(row) · escapeHtml(s).
//
// 의존 대상
//   browser/link-rules.js 의 matchLinkRule 만. DOM 도 window 도 보지 않음(Node 테스트에서 그대로 호출).
//
// 유지 조건
//   북마크의 profile 칸이 없으면 "자동"(링크 규칙, 없으면 스페이스 기본). "" 는 기본 계정을 고른 것이라 자동과 다름.
//   계정 드롭다운 자리는 빈 span(data-bkm-acct)만 그림. 드롭다운은 화면 모듈이 붙임.
//
// 영향 범위
//   bookmarks/manager.js 의 렌더, web/css/44-bookmark-manager.css 의 bkm-* 규칙, test/bookmark-manager-view.mjs.

import { matchLinkRule } from "../browser/link-rules.js";

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SHARED = "__shared__";

export function rowKey(row) { return `${row.scope}|${row.space || ""}|${row.url}`; }

// input: { common: [항목], bySpace: { [space]: [항목] }, spaces: [{ id, label }] }
// 항목은 { url, title, profile? } 또는 폴더 { folder, title, items: [...] }
export function collectBookmarks({ common, bySpace, spaces } = {}) {
  const rowsOf = (list, scope, space) => {
    const rows = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (!x) continue;
      if (x.folder) {
        for (const b of Array.isArray(x.items) ? x.items : []) if (b && b.url) rows.push(rowOf(b, scope, space, { id: x.folder, title: x.title || "폴더" }));
      } else if (x.url) rows.push(rowOf(x, scope, space, null));
    }
    return rows;
  };
  const rowOf = (b, scope, space, folder) => ({
    scope, space, url: String(b.url), title: String(b.title || b.url),
    profile: typeof b.profile === "string" ? b.profile : undefined, folder,
  });
  const out = [];
  const commonRows = rowsOf(common, "common", null);
  if (commonRows.length) out.push({ key: "common", scope: "common", space: null, label: "공통", rows: commonRows });
  const map = bySpace && typeof bySpace === "object" ? bySpace : {};
  const known = new Set();
  for (const s of Array.isArray(spaces) ? spaces : []) {
    if (!s || !s.id || known.has(s.id)) continue;
    known.add(s.id);
    const rows = rowsOf(map[s.id], "space", s.id);
    if (rows.length) out.push({ key: s.id, scope: "space", space: s.id, label: s.label || s.id, rows });
  }
  if (!known.has(SHARED)) {
    known.add(SHARED);
    const rows = rowsOf(map[SHARED], "space", SHARED);
    if (rows.length) out.push({ key: SHARED, scope: "space", space: SHARED, label: "공유 브라우저", rows });
  }
  // 목록에 없는 스페이스(닫은 스페이스·옛 저장분)의 북마크도 관리할 수 있게 뒤에 둠
  for (const id of Object.keys(map)) {
    if (known.has(id)) continue;
    const rows = rowsOf(map[id], "space", id);
    if (rows.length) out.push({ key: id, scope: "space", space: id, label: "지금 없는 스페이스", sub: id, rows });
  }
  return out;
}

// mode: "all" | "set"(계정 지정) | "auto"(자동). query 는 이름·주소·폴더 이름에서 찾음(대소문자 무시)
export function filterSections(sections, query, mode = "all") {
  const q = String(query || "").trim().toLowerCase();
  return sections.map((s) => ({
    ...s,
    rows: s.rows.filter((r) => {
      if (mode === "set" && r.profile === undefined) return false;
      if (mode === "auto" && r.profile !== undefined) return false;
      if (!q) return true;
      return [r.title, r.url, r.folder && r.folder.title].some((v) => v && String(v).toLowerCase().includes(q));
    }),
  })).filter((s) => s.rows.length);
}

// "자동"일 때 실제로 열릴 계정. ctx: { rules, spaceDefaults, profileName(id) }
export function autoAccount(row, ctx) {
  const rule = matchLinkRule(row.url, ctx.rules);
  if (rule) return { profile: rule.profile, name: ctx.profileName(rule.profile), why: `규칙 ${rule.pattern}` };
  if (row.scope === "common") return { profile: null, name: "스페이스 기본", why: "보고 있는 스페이스의 기본 계정" };
  const def = (ctx.spaceDefaults || {})[row.space];
  return { profile: def ?? "", name: ctx.profileName(def ?? ""), why: "스페이스 기본" };
}

export function managerSummary(sections) {
  const rows = sections.flatMap((s) => s.rows);
  const set = rows.filter((r) => r.profile !== undefined).length;
  return { total: rows.length, set };
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function initialOf(row) { const h = hostOf(row.url) || row.title; return (h.trim()[0] || "?").toUpperCase(); }

// ctx: { selected: Set(rowKey), editing: rowKey|null, fresh: rowKey|null }
export function sectionsMarkup(sections, ctx = {}) {
  const esc = escapeHtml;
  const sel = ctx.selected || new Set();
  return sections.map((s) => {
    let lastFolder = null;
    const rows = s.rows.map((r) => {
      const k = rowKey(r);
      const folderHead = r.folder && r.folder.id !== lastFolder
        ? `<div class="bkm-folder"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>${esc(r.folder.title)}</div>` : "";
      if (!r.folder && lastFolder) lastFolder = null;
      if (r.folder) lastFolder = r.folder.id;
      const title = ctx.editing === k
        ? `<input class="bkm-rename" data-bkm-rename="${esc(k)}" value="${esc(r.title)}" maxlength="60" aria-label="북마크 이름">`
        : `<button class="bkm-title" data-bkm-edit="${esc(k)}" title="눌러서 이름 바꾸기">${esc(r.title)}</button>`;
      return folderHead + `<div class="bkm-row${sel.has(k) ? " on" : ""}${r.folder ? " in-folder" : ""}${ctx.fresh === k ? " bkm-fresh" : ""}" data-bkm-row="${esc(k)}">
        <label class="bkm-ck" title="고르기"><input type="checkbox" data-bkm-sel="${esc(k)}"${sel.has(k) ? " checked" : ""} aria-label="${esc(r.title)} 고르기"><span class="bkm-box"><svg class="i" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg></span></label>
        <span class="bkm-av" aria-hidden="true">${esc(initialOf(r))}</span>
        <div class="bkm-tx">${title}<span class="bkm-url" title="${esc(r.url)}">${esc(r.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</span></div>
        <span class="bkm-acct" data-bkm-acct="${esc(k)}"></span>
        <button class="bkm-del" data-bkm-del="${esc(k)}" title="지우기" aria-label="${esc(r.title)} 지우기"><svg class="i" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
      </div>`;
    }).join("");
    return `<section class="bkm-sec" data-bkm-sec="${esc(s.key)}">
      <div class="bkm-shead"><h2>${esc(s.label)}</h2>${s.sub ? `<span class="bkm-ssub">${esc(s.sub)}</span>` : ""}<span class="bkm-cnt">${s.rows.length}</span></div>
      <div class="bkm-list">${rows}</div></section>`;
  }).join("");
}
