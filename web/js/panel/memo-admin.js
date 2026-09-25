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
//   #mm-body DOM과 메모 관리 CSS. 이 모듈의 export나 init 계약을 바꾸면 import 하는
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
  <div class="mm-body" id="mm-body"></div>
`;

const MM_ICON = {
  refresh: '<svg class="i" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  caret: '<svg class="i mm-cv" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  back: '<svg class="i" viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></svg>',
};
// 보관 단축키의 수정 키. 단축키 표(keynav)는 mod 를 macOS 에서 ⌘, 그 밖에서 Ctrl 로 받는다.
const MM_MOD = /Mac|iPhone|iPad/.test((globalThis.navigator && navigator.platform) || "") ? "⌘" : "Ctrl";

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
  const head = `<div class="mm-ph"><h2>스페이스 메모</h2><span class="mm-sp"></span>
    <button class="mm-ib" data-mm="refresh" title="새로고침">${MM_ICON.refresh}</button></div>`;
  if (!sp) {
    body.innerHTML = `<div class="mm-main mm-main-empty"><div class="mm-col mm-col-a">${head}</div>
      <div class="mm-col mm-col-b"><div class="mm-empty"><b>스페이스를 선택하세요</b>
      <p>스페이스를 선택하면 그 스페이스의 메모가 열립니다.</p></div></div></div>`;
    return;
  }
  const away = !!(mmView && mmHome && mmView !== mmHome);
  const text = memoTextOf(sp);
  const arch = memoArch[sp] || [];
  const spaces = orderedSpaces();
  const stableSpace = spk(sp);
  const noteBucket = memoNoteBucketOf(sp, stableSpace);
  const noteList = (noteBucket.order || []).map((id) => noteBucket.notes?.[id]).filter(Boolean);
  const closedNotes = noteList.filter((note) => note.deletedAt == null && !(memoWindowOpenCounts[stableSpace + "\n" + note.id] || 0));
  const deletedNotes = noteList.filter((note) => note.deletedAt != null);
  // 보관본 원문에는 기록 묶음 경계 주석(<!-- ac:block … -->)이 들어 있다. 한 줄 미리보기에서는 글만 보인다.
  const oneLine = (t, n) => String(t || "").replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  // 왼쪽: 스페이스 목록과 이 스페이스의 닫아 둔 별도 메모. 고르면 가운데·오른쪽이 함께 바뀐다.
  const spaceRows = spaces.map((s) => {
    const t = oneLine(memoTextOf(s.id), 40), n = (memoArch[s.id] || []).length;
    return `<button class="mm-sprow${s.id === sp ? " on" : ""}" data-mm="go" data-space="${esc(s.id)}">
      <span class="mm-l1"><span class="mm-nm">${esc(s.label)}</span>${s.id === mmHome ? `<span class="mm-here">지금 작업 중</span>` : ""}<span class="mm-n">${n}</span></span>
      <span class="mm-l2">${t ? esc(t) : "메모 없음"}</span>
    </button>`;
  }).join("");
  const notes = `
    <div class="mm-sec">
      <div class="mm-sec-head"><h3>닫아 둔 별도 메모</h3><span class="mm-n">${closedNotes.length}</span></div>
      <div class="mm-list">
        ${closedNotes.length ? closedNotes.map((note) => `<div class="mm-nrow">
          <span class="mm-nm">${esc(note.name)}</span><span class="mm-pv">${note.text ? esc(oneLine(note.text, 36)) : "빈 메모"}</span>
          <button class="mm-btn sm" data-mm="note-open" data-note="${esc(note.id)}">열기</button>
        </div>`).join("") : `<div class="mm-hint">다시 열 메모 창이 없습니다.</div>`}
        ${deletedNotes.length ? `<details class="mm-deleted"><summary class="mm-nrow mm-del">${MM_ICON.caret}<span>삭제된 메모</span><span class="mm-n">${deletedNotes.length}</span></summary>${deletedNotes.map((note) => `<div class="mm-nrow">
          <span class="mm-nm">${esc(note.name)}</span><span class="mm-sp"></span><button class="mm-btn sm" data-mm="note-restore" data-note="${esc(note.id)}">복구</button>
        </div>`).join("")}</details>` : ""}
      </div>
    </div>`;
  const memoMdMode = getMemoMdMode();
  // 오른쪽: 날짜별 보관본. 펼친 날은 보관한 시점마다 한 묶음이라 그중 하나만 지울 수 있다.
  const days = arch.length ? arch.map((a) => {
    const open = mmOpen === a.date;
    return `<div class="mm-day${open ? " open" : ""}">
      <div class="mm-day-h" data-mm="open" data-date="${esc(a.date)}">${MM_ICON.caret}<span class="mm-d">${esc(a.date)}</span>${a.rev > 1 ? `<span class="mm-rv">${a.rev}회</span>` : ""}<span class="mm-pv">${open ? "" : esc(oneLine(a.text, 60))}</span></div>
      ${open ? `
        ${(a.blocks || []).map((b) => `
          <div class="mm-blk"><div class="mm-blk-h"><span class="mm-t">${esc(b.clock || "이전 기록")}</span>${b.name ? `<span class="mm-nm">· ${esc(b.name)}</span>` : ""}<span class="mm-sp"></span><button class="mm-btn txt sm" data-mm="bcopy" data-date="${esc(a.date)}" data-id="${esc(b.id)}">복사</button><button class="mm-btn txt sm dz" data-mm="bdel" data-date="${esc(a.date)}" data-id="${esc(b.id)}">이 기록만 삭제</button></div>
            <pre>${esc(b.text)}</pre></div>`).join("")}
        <div class="mm-dacts">
          <button class="mm-btn" data-mm="restore" data-date="${esc(a.date)}">지금 메모에 이어 붙이기</button>
          <span class="mm-sp"></span>
          <button class="mm-btn txt sm" data-mm="copy" data-date="${esc(a.date)}">하루치 복사</button>
          <button class="mm-btn txt sm dz" data-mm="del" data-date="${esc(a.date)}">하루치 삭제</button>
        </div>` : ""}
    </div>`;
  }).join("") : `<div class="mm-hint mm-hint-day">아직 보관한 것이 없습니다.</div>`;
  body.innerHTML = `
    <div class="mm-main">
      <div class="mm-col mm-col-a">
        ${head}
        <div class="mm-scroll">
          <div class="mm-sec">
            <div class="mm-sec-head"><h3>스페이스</h3><span class="mm-n">${spaces.length}</span></div>
            <div class="mm-list">${spaceRows || `<div class="mm-hint">스페이스가 없습니다.</div>`}</div>
          </div>
          ${notes}
        </div>
      </div>
      <div class="mm-col mm-col-b">
        <div class="mm-ph"><h2>${esc(mmSpaceLabel(sp))}의 메모</h2><span class="mm-sp"></span>
          ${away ? `<button class="mm-back" data-mm="home">${MM_ICON.back}${esc(mmSpaceLabel(mmHome))}(지금 작업 중)으로</button>` : ""}
          <div class="mm-seg" role="tablist"><button role="tab" data-memo-md="raw" class="${memoMdMode !== "preview" ? "on" : ""}">원문</button><button role="tab" data-memo-md="preview" class="${memoMdMode === "preview" ? "on" : ""}">미리보기</button></div>
        </div>
        <div class="mm-why">스페이스마다 따로 저장됩니다. 보관하면 오늘 날짜 장에 시각을 달고 이어 붙고, 본문은 지우지 않습니다.</div>
        <div class="mm-slot" id="mm-slot"${memoMdMode === "preview" ? ' style="display:none"' : ""}></div>
        <div class="md-body mm-edit-pv" id="mm-preview"${memoMdMode === "preview" ? "" : " hidden"}>${memoMdMode === "preview" ? mdToHtml(text) : ""}</div>
        <div class="mm-ebar">
          <button class="mm-btn pri" data-mm="archive">오늘 자로 보관</button><span class="kbd" title="단축키">${MM_MOD}⇧S</span>
          <span class="mm-sp"></span>
          <button class="mm-btn txt dz" data-mm="clear">본문 비우기</button>
        </div>
      </div>
      <div class="mm-col mm-col-c">
        <div class="mm-ph"><h2>날짜별 보관본</h2><span class="mm-n">${arch.length}</span></div>
        <div class="mm-scroll">${days}</div>
      </div>
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
      case "copy": if (a) copyText(a.text).then((ok) => showToast(ok ? "복사됨" : "복사하지 못했습니다")); break;
      // 하루치 안의 한 기록만 지운다. 잘못 담은 하나 때문에 하루를 버리지 않는다.
      case "bdel": { const bk = a && (a.blocks || []).find((x) => x.id === b.dataset.id); if (!bk) break;
        if (confirm(`${d} ${bk.clock || "이전 기록"}에 보관한 것만 삭제할까요?`)) wsSend({ type: "memo.archive.block.delete", space: sp, date: d, id: bk.id }); } break;
      case "bcopy": { const bk = a && (a.blocks || []).find((x) => x.id === b.dataset.id); if (bk) copyText(bk.text).then((ok) => showToast(ok ? "복사됨" : "복사하지 못했습니다")); } break;
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
      case "refresh": mmRefresh(); break;
    }
  });
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
