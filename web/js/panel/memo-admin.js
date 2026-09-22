// rail 메모: 스페이스 메모 본문과 날짜별 보관본, 닫힌 별도 메모를 관리한다.
//
// 소유 범위
//   서버가 준 날짜별 보관본, 펼친 날짜·잠깐 보는 스페이스·돌아갈 스페이스,
//   별도 메모 창 open count와 rail 관리 화면의 DOM 연결.
//
// 제공 API
//   initMemoAdmin, rail 진입 enterMemoAdmin, mmRefresh·mmSpaceLabel·archiveMemo,
//   WebSocket 수신용 setMemoArchives.
//
// 의존 대상
//   Markdown 변환은 core/markdown, 중앙 본문·초안은 panel/memo-store, 공유 편집 화면은 panel/memo,
//   별도 메모 창 상태 반영은 panel/memo-window에서 import 한다. main 소유 $·esc·wsSend·toast·
//   copyText·MEMO_MODE·스페이스 목록/열쇠·request id는 init에서 받고, 창 목록은 acHost에 기대한다.
//
// 유지 조건
//   다른 스페이스 보기는 작업 스페이스를 바꾸지 않는다. 복원은 현재 본문에 이어 붙이고,
//   비우기는 보관본을 지우지 않는다. 중앙 메모와 별도 메모 창은 revision·보관 명령이 서로 다르므로
//   상태나 저장 경로를 합치지 않는다. listener 등록과 host 구독 순서를 바꾸지 않는다.
//
// 영향 범위
//   main의 WebSocket memo-archives/memo-notes 수신·rail/단축키 배선, panel/memo-store의 본문·초안·
//   별도 메모 목록, panel/memo.js의 공유 model·미리보기, panel/memo-window의 창 상태 IPC,
//   core/markdown, 서버 memo.archive·memo.note.* 계약,
//   #mm-body/#mm-refresh DOM과 메모 관리 CSS. 이 모듈의 export나 init 계약을 바꾸면 import 하는
//   main.js도 함께 바뀌어야 한다.
//   현재 목록 확인: node bin/importers.mjs web/js/panel/memo-admin.js

import { mdToHtml } from "../core/markdown.js";
import {
  advanceMemoRevision, getMemoShownSpace, memoNoteBucketOf, memoSpace, memoTextOf,
  setMemoShownSpace, updateMemoText,
} from "./memo-store.js";
import { syncMemoWindowState } from "./memo-window.js";
import { getMemoMdMode, renderMemo, renderMemoPreview, setMemoValue } from "./memo.js";
import { provide } from "../core/hooks.js";

// 이 기능의 영역. index.html 이 이 마크업을 항상 그리면 기능을 꺼도
// 셸이 파싱되므로 여기서 만든다. 셸(aside 의 id·class)은 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="scr-bar"><span class="scr-bar-title">스페이스 메모</span><button class="scr-ico" id="mm-refresh" title="새로고침">↻</button></div>
  <div class="scr-body" id="mm-body"></div>
`;

let $, esc, wsSend, showToast, copyText;
let MEMO_MODE = false;
let orderedSpaces, spk;
let memoReqId;

let memoArch = {}; // spaceId → [{date, text, at, rev}]
let mmOpen = null; // 펼쳐 본 아카이브 날짜
// 이 화면에서 다른 스페이스를 보는 것은 임시 조회이고, 작업 스페이스를 옮기는
// 것이 아니다. 어디서 왔는지 기억해 두고 되돌아올 경로를 제공한다.
let mmView = null, mmHome = null;
let memoWindowOpenCounts = {};

export function initMemoAdmin(deps) {
  ({
    $, esc, wsSend, showToast, copyText, MEMO_MODE, orderedSpaces, spk,
    memoReqId,
  } = deps);
  wireMemoAdmin();
}

export function setMemoArchives(value) { memoArch = value; }
// 메모 화면이 로드됐을 때만 채워지는 훅. 로드되지 않았으면 알림 처리는 그대로 동작하고 이 훅만 비어 있다.
provide("memo.refresh", () => mmRefresh());
provide("memo.setArchives", (v) => setMemoArchives(v));

export function mmSpaceLabel(id) { const s = orderedSpaces().find((x) => x.id === id); return (s && s.label) || id; }

export function mmRefresh() {
  const body = $("#mm-body"); if (!body) return;
  if (!mmHome) mmHome = memoSpace();                 // 이 화면에 들어왔을 때의 스페이스가 기준이다
  const sp = mmView || mmHome || memoSpace();
  if (!sp) { body.innerHTML = `<div class="scr-empty">스페이스를 선택하면 그 스페이스의 메모가 열립니다.</div>`; return; }
  const away = !!(mmView && mmHome && mmView !== mmHome);
  const text = memoTextOf(sp);
  const arch = memoArch[sp] || [];
  const others = orderedSpaces().filter((s) => s.id !== sp);
  const stableSpace = spk(sp);
  const noteBucket = memoNoteBucketOf(sp, stableSpace);
  const noteList = (noteBucket.order || []).map((id) => noteBucket.notes?.[id]).filter(Boolean);
  const closedNotes = noteList.filter((note) => note.deletedAt == null && !(memoWindowOpenCounts[stableSpace + "\n" + note.id] || 0));
  const deletedNotes = noteList.filter((note) => note.deletedAt != null);
  const detachedNotes = `
    <section class="mm-notes">
      <div class="mm-arch-h">닫힌 별도 메모<span class="scr-sec-c">${closedNotes.length}</span></div>
      ${closedNotes.length ? closedNotes.map((note) => `<div class="mm-note-row">
        <span class="mm-note-name">${esc(note.name)}</span><span class="mm-note-meta">${note.text ? esc(note.text.replace(/\s+/g, " ").slice(0, 36)) : "빈 메모"}</span>
        <button class="scr-chip" data-mm="note-open" data-note="${esc(note.id)}">열기</button>
      </div>`).join("") : `<div class="scr-empty">다시 열 메모 창이 없습니다.</div>`}
      ${deletedNotes.length ? `<details class="mm-deleted"><summary>삭제된 메모 ${deletedNotes.length}</summary>${deletedNotes.map((note) => `<div class="mm-note-row">
        <span class="mm-note-name">${esc(note.name)}</span><button class="scr-chip" data-mm="note-restore" data-note="${esc(note.id)}">복구</button>
      </div>`).join("")}</details>` : ""}
    </section>`;
  const memoMdMode = getMemoMdMode();
  body.innerHTML = `
    <div class="scr-head">
      <div class="scr-sum"><b>${esc(mmSpaceLabel(sp))}</b><span>의 메모</span>
        ${away ? `<button class="scr-chip" data-mm="home">← ${esc(mmSpaceLabel(mmHome))}(지금 작업 중)으로</button>` : ""}</div>
      <div class="scr-why">메모는 스페이스마다 따로 돕니다. 보관하면 오늘 날짜로 한 장에 쌓이고, 같은 날 다시 보관하면 그 장 아래에 시각을 달고 이어 붙습니다. 본문은 지우지 않습니다.</div>
    </div>
    <div class="mm-main">
      <section class="mm-now">
        <div class="mm-now-h"><b>지금 메모</b><span class="mm-sp">${esc(mmSpaceLabel(sp))}</span>
          <span class="memo-modes"><button data-memo-md="raw" class="${memoMdMode !== "preview" ? "on" : ""}">원문</button><button data-memo-md="preview" class="${memoMdMode === "preview" ? "on" : ""}">미리보기</button></span></div>
        <div class="mm-slot" id="mm-slot"${memoMdMode === "preview" ? ' style="display:none"' : ""}></div>
        <div class="md-body mm-edit-pv" id="mm-preview"${memoMdMode === "preview" ? "" : " hidden"}>${memoMdMode === "preview" ? mdToHtml(text) : ""}</div>
        <div class="mm-bar">
          <button class="scr-chip" data-mm="archive">오늘 자로 보관</button>
          <button class="scr-chip" data-mm="clear">본문 비우기</button>
          <span class="mm-hint">Ctrl/⌘ ⇧S</span>
        </div>
      </section>
      <section class="mm-arch">
        <div class="mm-arch-h">보관함<span class="scr-sec-c">${arch.length}</span></div>
        ${arch.length ? arch.map((a) => `
          <div class="mm-item">
            <div class="mm-item-h" data-mm="open" data-date="${esc(a.date)}">
              <span class="mm-date">${esc(a.date)}</span>
              ${a.rev > 1 ? `<span class="mm-rev">${a.rev}회</span>` : ""}
              <span class="mm-prev">${esc(String(a.text || "").replace(/\s+/g, " ").slice(0, 60))}</span>
            </div>
            ${mmOpen === a.date ? `
              ${(a.blocks || []).map((b) => `
                <div class="mm-blk">
                  <div class="mm-blk-h">
                    <span class="mm-blk-t">${b.name ? esc(b.name) + " · " : ""}${esc(b.clock || "이전 기록")}</span>
                    <span class="mm-blk-acts">
                      <button class="scr-chip" data-mm="bcopy" data-date="${esc(a.date)}" data-id="${esc(b.id)}">복사</button>
                      <button class="scr-chip danger" data-mm="bdel" data-date="${esc(a.date)}" data-id="${esc(b.id)}">이 기록만 삭제</button>
                    </span>
                  </div>
                  <div class="mm-body-txt">${esc(b.text)}</div>
                </div>`).join("")}
              <div class="mm-acts">
                <button class="scr-chip" data-mm="restore" data-date="${esc(a.date)}">지금 메모에 이어 붙이기</button>
                <button class="scr-chip" data-mm="copy" data-date="${esc(a.date)}">하루치 복사</button>
                <button class="scr-chip danger" data-mm="del" data-date="${esc(a.date)}">하루치 삭제</button>
              </div>` : ""}
          </div>`).join("")
          : `<div class="scr-empty">아직 보관한 것이 없습니다.</div>`}
      </section>
    </div>
    ${detachedNotes}
    <div class="mm-others">
      <div class="scr-sec-h">다른 스페이스<span class="scr-sec-c">${others.length}</span></div>
      <div class="mm-oth-grid">${others.map((s) => {
        const t = memoTextOf(s.id).trim(), n = (memoArch[s.id] || []).length;
        return `<div class="mm-oth" data-mm="go" data-space="${esc(s.id)}">
          <div class="mm-oth-n">${esc(s.label)}</div>
          <div class="mm-oth-m">${t ? esc(t.replace(/\s+/g, " ").slice(0, 40)) : "메모 없음"} · 보관 ${n}</div>
        </div>`;
      }).join("") || `<div class="scr-empty">다른 스페이스가 없습니다.</div>`}</div>
    </div>`;
  // 도크와 메모 화면의 편집기는 같은 본문 model을 본다. 같은 메모를 두 벌로 갖지 않는다.
  if (getMemoShownSpace() !== sp) { setMemoShownSpace(sp); setMemoValue(memoTextOf(sp)); }
  renderMemoPreview();
}

// 단축키 코드가 이 모듈을 import 하면 메모를 끈 사용자에게도 로드된다. 이름만 등록한다.
provide("memo.archive", () => archiveMemo());

export function archiveMemo() {
  const sp = memoSpace(); if (!sp) { showToast("스페이스를 먼저 선택하세요."); return; }
  wsSend({ type: "memo.archive", space: sp, text: memoTextOf(sp) });
}

export function enterMemoAdmin() {
  mmHome = memoSpace(); mmView = null; mmOpen = null; mmRefresh();
}

function wireMemoAdmin() {
  const body = $("#mm-body"); if (!body) return;
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mm]"); if (!b) return;
    const sp = mmView || mmHome || memoSpace(), d = b.dataset.date;
    const a = d ? (memoArch[sp] || []).find((x) => x.date === d) : null;
    switch (b.dataset.mm) {
      case "archive": wsSend({ type: "memo.archive", space: sp, text: memoTextOf(sp) }); break; // 보고 있는 스페이스 것을 담는다
      case "open": mmOpen = mmOpen === d ? null : d; mmRefresh(); break;
      case "del": if (confirm(`${d} 보관본을 통째로 삭제할까요?`)) wsSend({ type: "memo.archive.delete", space: sp, date: d }); break;
      case "copy": if (a) { copyText(a.text); showToast("복사됨"); } break;
      // 하루치 안의 한 기록만 지운다. 잘못 담은 하나 때문에 하루를 버리지 않는다.
      case "bdel": { const bk = a && (a.blocks || []).find((x) => x.id === b.dataset.id); if (!bk) break;
        if (confirm(`${d} ${bk.clock || "이전 기록"}에 보관한 것만 삭제할까요?`)) wsSend({ type: "memo.archive.block.delete", space: sp, date: d, id: bk.id }); } break;
      case "bcopy": { const bk = a && (a.blocks || []).find((x) => x.id === b.dataset.id); if (bk) { copyText(bk.text); showToast("복사됨"); } } break;
      case "restore": if (a) { // 덮지 않고 이어 붙인다. 작성 중인 내용을 잃지 않기 위한 것이다
        const cur = memoTextOf(sp);
        const next = (cur ? cur.replace(/\s+$/, "") + "\n\n" : "") + a.text;
        advanceMemoRevision();
        updateMemoText(sp, next, { immediate: true });
        setMemoShownSpace(null); renderMemo(); mmRefresh(); showToast(`${d} 보관본을 이어 붙였습니다.`);
      } break;
      case "clear": if (confirm("지금 메모 본문을 비웁니다. 보관본은 그대로 남습니다. 계속할까요?")) {
        advanceMemoRevision();
        updateMemoText(sp, "", { immediate: true });
        setMemoShownSpace(null); renderMemo(); mmRefresh();
      } break;
      case "note-open": {
        const noteId = b.dataset.note, label = mmSpaceLabel(sp);
        if (noteId) Promise.resolve(window.acHost?.openLocalMemo?.({ spaceKey: spk(sp), noteId, spaceLabel: label }))
          .then((result) => { if (!result?.ok) showToast(result?.error || "메모 창을 열지 못했습니다."); });
      } break;
      case "note-restore": if (b.dataset.note) wsSend({ type: "memo.note.restore", requestId: memoReqId("memo-restore"), space: sp, noteId: b.dataset.note }); break;
      // 조회만 한다. 작업 스페이스는 그대로 두고 이 화면의 보기만 옮긴다.
      case "go": { const id = b.dataset.space; if (!id) break; mmView = id; mmOpen = null; mmRefresh(); } break;
      case "home": mmView = null; mmOpen = null; mmRefresh(); break;
    }
  });
  const r = $("#mm-refresh"); if (r) r.addEventListener("click", mmRefresh);
  const applyMemoWindowState = (value) => {
    memoWindowOpenCounts = value?.openCounts || {};
    if (MEMO_MODE) syncMemoWindowState(value);
    if (document.body.classList.contains("mm-active")) mmRefresh();
  };
  try {
    Promise.resolve(window.acHost?.memoWindows?.()).then(applyMemoWindowState);
    window.acHost?.onMemoWindowsChanged?.(applyMemoWindowState);
  } catch {}
}
