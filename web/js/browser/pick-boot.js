// 요소 지목·녹화 기능의 진입점.
//
// 소유 범위
//   화면의 요소를 사람이 눌러서 고르는 일(요소 지목)과, 그 뒤의 조작을 순서대로 받아 적는
//   일(녹화). 둘은 한 모듈 집합이다. 지목이 녹화에 줄을 추가하고(pick.js → recPush), 녹화 중에는
//   지목이 다르게 기록된다. 그래서 표에도 한 줄로 등록된다.
//   ws 소유자 일곱 개(pick-mode · pickrec.deliver · app-pick · app-pick-note · rec-relay ·
//   rec-toggle-relay · target-pending)를 든다.
//   화면 이름은 25-pick-record.css 가 정의한다.
//
// 제공 API
//   initCapability(ctx). 연결과 훅과 메시지 소유자를 여기서 등록한다.
//   훅: pick.mode · pick.toggle · pick.deliver · pick.sheetContext · pick.docxContext ·
//       pick.orcaSource · record.on · record.set · record.tracked · record.push ·
//       record.inject · record.adopt
//
// 의존 대상
//   앱 셸의 DOM 과 통로(ctx 의 $ · wsSend · showToast · fileview · getCurTarget · uiToken ·
//   getLastAgents · orderedSpaces),
//   터미널의 getXterm, 브라우저의 activeWv, 그리고 touch-drag 의 setOrca·injectAllFrames.
//   ctx 로 받을 수 있는 것은 import 하지 않는다.
//
// 유지 조건
//   앱 셸이 이 모듈 집합의 함수를 정적으로 import 하면 "끈 기능은 로드되지 않는다"가 깨진다.
//   앱 셸에서 부르는 지점은 전부 훅이다. 끄면 그 지점은 아무 일도 하지 않는다.
//   끈 상태에서 ⌘⇧E·⌘⇧A 를 눌러도 아무 일이 없어야 하고, 오류가 나서도 안 된다.
//   앱 셸의 ws 표에 같은 이름이 남아 있으면 나중에 등록하는 이쪽이 거절된다.
//
// 영향 범위
//   훅 이름을 바꾸면 부르는 쪽 넷도 함께 바꿔야 한다: main.js · panel/touch-drag.js ·
//   browser/dock.js · browser/webview-factory.js.
//   ws 소유자를 더하거나 빼면 서버 쪽 같은 이름과 짝이 맞아야 한다.
import { provide } from "../core/hooks.js";
import { getXterm } from "../panel/terminal.js";
import { activeWv } from "./webview.js";
import { initAppPick, deliverAppPickLocal } from "./app-pick.js";
import {
  ORCA_INJECT, deliverGroupPickLocal, deliverSitePickLocal, deliverTabPickLocal, initPickHost,
} from "./pick-host.js";
import { noticeBlock } from "../panel/xterm-wiring.js";
import {
  applyPickMode, completePendingPick, deliverPick, deliverPickLocal, hasDocxContext, hasSheetContext,
  pickMode, togglePickMode,
} from "./pick.js";
import {
  recAdoptTab, recDeliverLocal, recPush, recTracked, recording, setRecInject, setRecording,
} from "./record.js";

export function initCapability(ctx) {
  const {
    $, wsSend, showToast, browserMode: BROWSER_MODE, fileview, getCurTarget, uiToken,
    getLastAgents, orderedSpaces,
  } = ctx;
  const bNote = $("#browser-note");

  // 호스트 쪽 지목(탭·그룹·사이트)과 앱 쪽 지목·녹화는 각자 연결을 가진다. 기존 최상위 연결이
  // main 에 있던 위치다.
  initPickHost({ wsSend, BROWSER_MODE, bNote, fileview, getCurTarget, getXterm, getLastAgents, orderedSpaces });
  initAppPick({ $, BROWSER_MODE, bNote, wsSend, fileview, getCurTarget, uiToken });

  provide("pick.mode", () => pickMode);
  provide("pick.toggle", () => togglePickMode());
  provide("pick.deliver", (pick, tabId) => deliverPick(pick, tabId));
  provide("pick.sheetContext", () => hasSheetContext());
  provide("pick.docxContext", () => hasDocxContext());
  // 주입할 스크립트는 이 모듈 집합이 만든다. 앱 셸(touch-drag)은 그것을 받아 주입만 한다. 끄면
  // 받을 것이 없어 아무것도 주입하지 않는다.
  provide("pick.orcaSource", (on) => "window.__orcaDesired=" + (on ? "true" : "false") + ";" + ORCA_INJECT);

  provide("record.on", () => recording);
  provide("record.hasTarget", () => !!activeWv());
  provide("record.set", (on) => setRecording(on));
  provide("record.tracked", (tabId) => recTracked(tabId));
  provide("record.push", (ev) => recPush(ev));
  provide("record.inject", (el, on) => setRecInject(el, on));
  provide("record.adopt", (tabId) => recAdoptTab(tabId));

  // 사람이 앱에서 탭·그룹을 지목해 준 사실을 프롬프트에 붙인다. 제출하지 않고 남겨서 사용자가
  // 이어서 지시한다. 요소 지목과 같은 bracketed paste 경로다.
  const paste = (block) => {
    wsSend({ type: "pty.input", data: "\x1b[200~" + block + "\x1b[201~" });
    if (getXterm()) setTimeout(() => getXterm().focus(), 0);
  };
  return {
    ws: {
      "pick-mode": (m) => applyPickMode(!!m.on),
      "app-pick": (m) => { if (!BROWSER_MODE && m.pick) deliverAppPickLocal(m.pick); },
      "app-pick-note": (m) => { if (!BROWSER_MODE && m.message) showToast(m.message, { level: "info" }); },
      "rec-relay": (m) => { if (!BROWSER_MODE && m.text) recDeliverLocal(m.text); },
      "rec-toggle-relay": () => { if (BROWSER_MODE && activeWv()) setRecording(!recording); },
      "pickrec.deliver": (m) => {
        if (BROWSER_MODE || !m.payload) return;
        if (m.kind === "element") deliverPickLocal(m.payload);
        else if (m.kind === "tab") deliverTabPickLocal(m.payload);
        else if (m.kind === "group") deliverGroupPickLocal(m.payload);
        else if (m.kind === "site") deliverSitePickLocal(m.payload);
      },
      "target-pending": (m) => {
        if (m.kind === "element") {
          if (!completePendingPick(m) && !m.ok) showToast(m.error || "요소 지목을 준비하지 못했습니다", { level: "err" });
          return;
        }
        if (!m.ok) { showToast(m.error || "지목을 준비하지 못했습니다", { level: "err" }); return; }
        if (m.kind === "tab") {
          paste(noticeBlock("브라우저 탭 지목", [
            `등록 구분자: ${m.delimiter}`,
            `탭: @${m.handle}${m.name ? "  " + m.name : ""}`,
            ...(m.title || m.url ? [`${m.title || ""}${m.title && m.url ? " · " : ""}${m.url || ""}`] : []),
            "이 메시지를 보내면 이 세션의 지정 탭으로 등록됩니다.",
          ]));
          bNote.textContent = "채팅 입력에 탭 지목을 추가했습니다. 보내면 이 세션 대상으로 등록됩니다.";
          return;
        }
        if (m.kind !== "group") return;
        const short = (u) => { try { const x = new URL(u); return x.host + (x.pathname !== "/" ? x.pathname.slice(0, 24) : ""); } catch { return String(u || "").slice(0, 40); } };
        const rows = (m.tabs || []).map((t) => `  @${t.handle}${t.name ? "  " + t.name : ""}`
          + (t.url ? `  — ${short(t.url)}` : "") + (t.showing ? "  (보임)" : ""));
        paste(noticeBlock("브라우저 그룹 지목", [
          `등록 구분자: ${m.delimiter}`,
          `그룹: ${m.label} (${m.handle}) · 스페이스 ${m.space}`,
          rows.length ? "탭:\n" + rows.join("\n") : "탭: (없음)",
          "이 메시지를 보내면 이 세션의 지정 그룹으로 등록됩니다.",
        ]));
        bNote.textContent = "채팅 입력에 그룹 지목을 추가했습니다. 보내면 이 세션 대상으로 등록됩니다.";
      },
    },
  };
}
