// diff: 소스 제어에서 연 변경 내용을 center의 읽기 전용 탭으로 보여준다.
//
// 소유 범위
//   diffTabId, colorizeDiff: 레포·stage·Base 보기까지 포함한 탭 정체성과 patch 표시 규칙.
//   highlightDiff: 그린 diff 위에 Monaco 토큰 색을 입힌다.
//
// 제공 API
//   initDiff(deps): 전송·렌더 콜백을 받는다. 소스 제어 입구가 한 번 부른다.
//   openDiff(file, opts): diff 탭을 열고 서버에 내용을 요청한다.
//   renderDiffView(tab): 응답이 들어온 현재 diff 탭을 그린다.
//   handleGitDiffMessage(m): git-diff 응답을 받은 탭에 저장하고 보이는 탭이면 다시 그린다.
//
// 의존 대상
//   DOM·escape·전송과 center 렌더, source-control 레포 이름을 init 에서 받고 tab-store를 import한다.
//
// 유지 조건
//   탭 id에는 레포와 staged 여부, Base 보기면 mode·base 가 함께 들어가야 한다. 같은 파일의 다른
//   비교 결과가 한 탭에 섞이면 안 된다.
//   새 요청 때 patch를 null로 되돌리고, untracked/staged/mode/base 값을 git.diff 요청에 그대로 싣는다.
//
// 영향 범위
//   tab-store 와 devtool/source-control.js. 파일 클릭 연결과 git-diff 수신을 그쪽이 담당한다.
//   화면은 core/tab-views 표에 "diff" 로 등록되고, 그 줄도 source-control 이 적는다.
//   현재 목록 확인: node bin/importers.mjs web/js/devtool/diff.js

import { repoNameOf } from "../core/repo-name.js";
import {
  addTab, ensureTabSpace, getActiveTabId, getCenterSpace, getTabs, getTabSpaces,
  setActiveTab, setCenterSpace,
} from "../center/tab-store.js";

let dom = null;
let escapeHtml = null;
let send = null;
let getSelectedSpaceId = null;
let renderTabs = null;
let showActiveTab = null;
let ensureMonacoLib = null;
let monacoTheme = null;

export function initDiff(deps) {
  dom = deps.$;
  escapeHtml = deps.esc;
  send = deps.wsSend;
  getSelectedSpaceId = deps.getSelectedSpaceId;
  renderTabs = deps.renderTabs;
  showActiveTab = deps.showActiveTab;
  ensureMonacoLib = deps.ensureMonacoLib || null;
  monacoTheme = deps.monacoTheme || null;
}

// 변경 파일 클릭 → center에 diff 탭(읽기 전용, 색 구분). 레포가 여럿이라 어느 레포의 파일인지를
// 함께 들고 다닌다. 같은 이름의 파일이 레포마다 있어 탭 이름만으로는 구분되지 않는다.
function diffTabId(root, file, staged, mode, base) {
  const view = mode ? "b:" + mode + ":" + (base || "") + ":" : (staged ? "s:" : "");
  return "diff:" + view + (root ? root + ":" : "") + file;
}
const DIFF_TAG = { committed: "Base 대비", worktree: "Base+커밋 전" };
export function openDiff(file, opts) {
  const sp = getCenterSpace() || getSelectedSpaceId(); if (!sp) return;
  ensureTabSpace(sp);
  const root = opts.root || null;
  // 탭 라벨에 레포까지 넣는다. 중첩 레포(부모/서브모듈)는 같은 절대경로를 각자 추적할 수 있어
  // 경로만으로 탭을 가르면 나중 응답이 남의 탭 내용을 덮는다.
  const mode = opts.mode || "", base = opts.base || "";
  const id = diffTabId(root, file, opts.staged, mode, base);
  let t = getTabs(sp).find((x) => x.id === id);
  const suffix = mode ? " ◦" + (DIFF_TAG[mode] || "Base") : (opts.staged ? " ◦스테이지" : "");
  if (!t) { t = addTab(sp, { id, kind: "diff", label: file.split("/").pop() + suffix, path: file, root, rel: opts.rel || "", staged: !!opts.staged, untracked: !!opts.untracked, mode, base, oldRel: opts.oldRel || "", patch: null }); }
  else { t.patch = null; t.root = root || t.root; if (opts.rel) t.rel = opts.rel; }
  setCenterSpace(sp); setActiveTab(sp, id); renderTabs(); showActiveTab();
  send(mode
    ? { type: "git.diff", path: root || file, file, mode, base, untracked: !!opts.untracked, oldRel: opts.oldRel || "" }
    : { type: "git.diff", path: root || file, file, staged: !!opts.staged, untracked: !!opts.untracked });
}
// diff 한 장을 줄로 푼다. 번호는 hunk 머리(@@ -a,b +c,d @@)에서만 알 수 있고, 그 값을 놓치면
// 그 뒤 줄이 전부 잘못된 번호를 갖는다. 잘못된 번호는 번호가 없는 것보다 해롭다.
// 지운 줄은 옛 파일에만, 더한 줄은 새 파일에만 번호가 있다. 양쪽에 다 적으면 없는 줄을 가리킨다.
export function diffRows(patch) {
  const rows = [];
  let oldNo = 0, newNo = 0, inHunk = false;
  for (const line of String(patch == null ? "" : patch).split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      oldNo = Number(m[1]); newNo = Number(m[2]); inHunk = true;
      rows.push({ cls: "hunk", text: line, o: "", n: "" });
      continue;
    }
    if (/^(diff |index |new file|deleted file|similarity|rename|Binary )/.test(line)
      || line.startsWith("+++") || line.startsWith("---")) {
      rows.push({ cls: "meta", text: line, o: "", n: "" });
      continue;
    }
    if (!inHunk) { rows.push({ cls: "", text: line, o: "", n: "" }); continue; }
    if (line.startsWith("\\")) { rows.push({ cls: "meta", text: line, o: "", n: "" }); continue; } // "\ No newline at end of file"
    if (line.startsWith("+")) { rows.push({ cls: "add", text: line, o: "", n: String(newNo++) }); continue; }
    if (line.startsWith("-")) { rows.push({ cls: "del", text: line, o: String(oldNo++), n: "" }); continue; }
    rows.push({ cls: "", text: line, o: String(oldNo++), n: String(newNo++) });
  }
  return rows;
}
export function colorizeDiff(patch) {
  return diffRows(patch).map((r) =>
    `<span class="dl ${r.cls}"><span class="dn">${r.cls === "del" ? r.o : r.n}</span>`
    + `<span class="dt">${escapeHtml(r.text) || "​"}</span></span>`).join("");
}
export function renderDiffView(t) {
  const dv = dom("#diffview");
  const tag = t.mode ? `${t.base || "Base"} 대비${t.mode === "worktree" ? " · 커밋 전 포함" : ""}`
    : (t.untracked ? "새 파일" : (t.staged ? "스테이지됨" : "변경"));
  // 어느 레포의 어느 경로인지를 머리글에 적는다. 레포가 여럿이면 파일 이름만으로는 구분되지 않는다.
  const where = t.root ? repoNameOf(t.root) + (t.rel ? " / " + t.rel : "") : "";
  const bar = `<div class="dv-bar"><span class="dv-name">${escapeHtml(t.label)}</span>`
    + (where ? `<span class="dv-where">${escapeHtml(where)}</span>` : "")
    + `<span class="dv-tag">${tag}</span></div>`;
  if (t.patch == null) { dv.innerHTML = bar + `<div class="dv-empty">불러오는 중…</div>`; return; }
  dv.innerHTML = bar + (t.patch.trim() ? `<pre class="dv-body">${colorizeDiff(t.patch)}</pre>` : `<div class="dv-empty">표시할 diff가 없습니다.</div>`);
  if (t.patch.trim()) highlightDiff(dv.querySelector(".dv-body"), t);
}

// ── 문법 강조 ──
// 옛 파일(문맥+지운 줄)과 새 파일(문맥+더한 줄)을 각각 한 덩어리로 토큰화한다. 줄마다 따로 칠하면
// 여러 줄 주석·문자열 안의 줄이 코드로 칠해진다. 돌려받은 줄을 diffRows 의 같은 줄에 되돌려 넣는다.
// 큰 patch 는 토큰화가 화면을 멈추게 하므로 칠하지 않고 줄 배경만 남긴다.
const HL_MAX_LINES = 20000;
function langFor(monaco, filePath) {
  const base = String(filePath || "").split("/").pop();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  for (const l of monaco.languages.getLanguages()) {
    if (ext && (l.extensions || []).some((e) => e.toLowerCase() === ext)) return l.id;
    if ((l.filenames || []).some((f) => f === base)) return l.id;
  }
  return "plaintext";
}
// colorize 결과는 줄마다 <br/> 로 끝난다.
const splitColorized = (html) => String(html).split(/<br\s*\/?>/i);
export function diffSides(rows) {
  const oldLines = [], newLines = [], at = [];
  for (const r of rows) {
    const body = r.text.slice(1);
    if (r.cls === "add") { at.push({ side: "n", i: newLines.length }); newLines.push(body); }
    else if (r.cls === "del") { at.push({ side: "o", i: oldLines.length }); oldLines.push(body); }
    else if (r.cls === "" && (r.o || r.n)) { at.push({ side: "n", i: newLines.length }); oldLines.push(body); newLines.push(body); }
    else at.push(null);
  }
  return { oldLines, newLines, at };
}
async function highlightDiff(pre, t) {
  if (!pre || !ensureMonacoLib) return;
  const patch = t.patch;
  const rows = diffRows(patch);
  if (rows.length > HL_MAX_LINES) return;
  let lines = t.hl && t.hl.patch === patch ? t.hl.lines : null;
  if (!lines) {
    try { await ensureMonacoLib(); } catch { return; }
    const monaco = window.monaco; if (!monaco) return;
    // 토큰 색 규칙은 테마가 정한다. 파일 편집기를 한 번도 안 연 상태면 앱 테마가 아직 적용되지 않았다.
    if (monacoTheme) monaco.editor.setTheme(monacoTheme());
    const lang = langFor(monaco, t.path);
    if (lang === "plaintext") return;
    const { oldLines, newLines, at } = diffSides(rows);
    const [oh, nh] = await Promise.all([
      monaco.editor.colorize(oldLines.join("\n"), lang, { tabSize: 2 }),
      monaco.editor.colorize(newLines.join("\n"), lang, { tabSize: 2 }),
    ]);
    const o = splitColorized(oh), n = splitColorized(nh);
    lines = at.map((a) => (a ? (a.side === "o" ? o[a.i] : n[a.i]) : null));
    t.hl = { patch, lines };
  }
  // 기다리는 동안 다른 탭으로 바뀌었거나 새 patch 가 왔으면 지금 화면은 이 결과의 것이 아니다.
  if (t.patch !== patch || !pre.isConnected) return;
  const cells = pre.querySelectorAll(".dl > .dt");
  if (cells.length !== rows.length) return;
  rows.forEach((r, i) => {
    const html = lines[i];
    if (html == null) return;
    cells[i].innerHTML = `<span class="dp">${escapeHtml(r.text[0] || "")}</span>` + html;
  });
  pre.classList.add("hl");
}

// 서버가 보낸 diff 한 장. 어느 탭의 것인지는 레포·경로·스테이지 여부가 함께 정한다.
// 중첩 레포는 같은 절대경로를 각자 추적하므로 경로만으로 가르면 남의 탭을 덮는다.
// root 가 없는 응답(구버전 서버)도 받는다. 그때는 경로·스테이지 여부만으로 탭을 찾는다.
export function handleGitDiffMessage(m) {
  // Base 보기 응답은 mode·base 가 같은 탭에만 들어간다. 커밋 전 보기 탭은 둘 다 비어 있다.
  const hit = (t) => t.kind === "diff" && t.path === m.file && !!t.staged === !!m.staged
    && (t.mode || "") === (m.mode || "") && (!m.mode || (t.base || "") === (m.base || ""))
    && (!m.root || !t.root || t.root === m.root);
  const patch = m.error ? ("[오류] " + m.error) : (m.patch || "");
  for (const sp of getTabSpaces()) for (const t of getTabs(sp)) if (hit(t)) t.patch = patch;
  const sp = getCenterSpace();
  const at = getTabs(sp).find((x) => x.id === getActiveTabId(sp));
  if (at && hit(at)) renderDiffView(at);
}
