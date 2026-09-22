// 페이지 안에서 우클릭했을 때 뜨는 메뉴. Chrome의 컨텍스트 메뉴에 해당한다.
//
// 소유 범위
//   webview guest 의 context-menu 이벤트를 받아 대상(링크·이미지·선택 글자·입력칸)에 맞는
//   항목만 구성해 띄운다.
//
// 제공 API
//   createWebviewContextMenu(deps) 하나. 그것이 돌려주는 attach(wc) 를 guest 마다 한 번 호출한다.
//   메뉴 구성 판정은 menuPlan(params, nav) 으로 따로 제공한다. 순수 함수라 검사가 그대로 호출한다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. Menu·clipboard·shell·nativeImage 와 새 탭을 여는 통로를
//   main.cjs 에서 받는다. 새 탭은 앱의 탭이어야 하므로 호스트의 ac-open-tab 을 그대로 쓰며,
//   webview-lifecycle 의 창 열기 처리와 같은 경로다.
//
// 유지 조건
//   메뉴를 띄우는 동작이 페이지를 변경하면 안 된다. 여기서 하는 일은 읽기(주소 복사·이미지
//   복사)와 브라우저 이동뿐이다.
//   "새 탭에서 열기"는 Electron 팝업 창이 아니라 앱의 탭이어야 한다. 창으로 열면 별도 창이 떠서
//   탭 목록에 잡히지 않고 프로필(로그인)도 갈린다. webview-lifecycle 도 같은 이유로 같은 경로를 쓴다.
//   http(s) 링크만 브라우저 탭으로 연다. 로컬 링크(file:)는 브라우저가 렌더링하지 못하는 경우가 많아
//   앱으로 넘기며(ac-open-local), 그것도 여는 쪽 페이지가 로컬일 때만이다. 원격 페이지가
//   지정한 file: 을 받으면 외부 페이지가 이 기계의 파일을 열게 된다.
//
// 영향 범위
//   native/electron/{main,webview-lifecycle}.cjs 의 guest 배선, 렌더러의 ac-open-tab 처리
//   (web/js/browser/ai-tabs.js), 그리고 검사 bin/smoke/sections/webview-context-menu.mjs.
//   현재 목록 확인: node bin/importers.mjs native/electron/webview-context-menu.cjs

// 우클릭 대상에 따라 어떤 항목을 구성할지 정한다. 순수 판정이라 Electron 없이 호출할 수 있다.
// 돌려주는 것은 항목 id 의 목록이며 "-" 는 구분선이다.
function menuPlan(params, nav, contextActions = []) {
  const p = params || {};
  const n = nav || {};
  const out = [];
  const link = typeof p.linkURL === "string" && p.linkURL ? p.linkURL : "";
  const isImage = !!p.hasImageContents || p.mediaType === "image";
  const selection = (p.selectionText || "").trim();

  if (link) out.push("link-open-tab", "link-copy", "-");
  if (isImage) out.push("image-open-tab", "image-copy", "image-copy-url", "image-save", "-");
  if (p.isEditable) out.push("undo", "redo", "-", "cut", "copy", "paste", "select-all", "-");
  else if (selection) out.push("copy", "search-selection", "-");
  // 아무 대상 없이 빈 페이지를 우클릭한 경우. Chrome이 이동 항목을 보여주는 자리다.
  if (!link && !isImage && !p.isEditable && !selection) {
    out.push(n.canGoBack ? "back" : "back-off", n.canGoForward ? "forward" : "forward-off", "reload", "-");
    out.push("page-copy-url", "-");
  }
  for (const action of contextActions) {
    if (!action || typeof action.name !== "string") continue;
    out.push("context-action:" + action.name);
  }
  if (contextActions.length) out.push("-");
  out.push("inspect");
  // 구분선이 맨 앞·맨 뒤에 오거나 둘이 붙는 일이 없게 다듬는다.
  const tidy = [];
  for (const id of out) {
    if (id === "-" && (!tidy.length || tidy[tidy.length - 1] === "-")) continue;
    tidy.push(id);
  }
  while (tidy.length && tidy[tidy.length - 1] === "-") tidy.pop();
  return tidy;
}

const LABELS = {
  "link-open-tab": "링크를 새 탭에서 열기",
  "link-copy": "링크 주소 복사",
  "image-open-tab": "이미지를 새 탭에서 열기",
  "image-copy": "이미지 복사",
  "image-copy-url": "이미지 주소 복사",
  "image-save": "이미지를 다른 이름으로 저장…",
  undo: "실행 취소",
  redo: "다시 실행",
  cut: "잘라내기",
  copy: "복사",
  paste: "붙여넣기",
  "select-all": "전체 선택",
  "search-selection": "선택 항목 검색",
  back: "뒤로",
  "back-off": "뒤로",
  forward: "앞으로",
  "forward-off": "앞으로",
  reload: "새로고침",
  "page-copy-url": "페이지 주소 복사",
  inspect: "검사",
};

const { isFileUrl, isLocalPage } = require("./local-link.cjs");

function createWebviewContextMenu({
  Menu, clipboard, searchUrlFor, noteExplicitSave = () => {}, getContextActions = () => [],
}) {
  const httpOnly = (u) => (typeof u === "string" && /^https?:/i.test(u) ? u : "");

  function attach(wc) {
    wc.on("context-menu", (_ev, params) => {
      try {
        const nav = { canGoBack: !!wc.canGoBack?.(), canGoForward: !!wc.canGoForward?.() };
        const host = wc.hostWebContents;
        const contextActions = host && !host.isDestroyed() ? getContextActions(host) : [];
        const plan = menuPlan(params, nav, contextActions);
        const actionByName = new Map(contextActions.map((action) => [action.name, action]));
        // 새 탭은 앱의 탭이어야 한다. 호스트가 없으면 그 항목은 동작하지 않으므로 구성하지 않는다.
        const openTab = (url, background) => {
          const u = httpOnly(url);
          if (!u || !host || host.isDestroyed()) return;
          host.send("ac-open-tab", { url: u, background: !!background, openerWc: wc.id });
        };
        // 로컬 링크의 「새 탭에서 열기」. 브라우저 탭으로 열지 않는다. 표·문서는 브라우저가
        // 렌더링하지 못해 빈 탭만 남으므로, 앱이 받아 뷰어·편집기·Finder 중 알맞은 곳에서 연다.
        // 원격 페이지가 지정한 file: 은 받지 않는다(외부 페이지가 이 기계의 파일을 열게 하지 않는다).
        const openLink = (url, background) => {
          const u = String(url || "");
          if (isFileUrl(u)) {
            let pageUrl = ""; try { pageUrl = wc.getURL() || ""; } catch {}
            if (!isLocalPage(pageUrl) || !host || host.isDestroyed()) return;
            host.send("ac-open-local", { target: u });
            return;
          }
          openTab(u, background);
        };
        const run = {
          "link-open-tab": () => openLink(params.linkURL, true),
          "link-copy": () => clipboard.writeText(params.linkURL || ""),
          "image-open-tab": () => openTab(params.srcURL, true),
          "image-copy": () => wc.copyImageAt(params.x, params.y),
          "image-copy-url": () => clipboard.writeText(params.srcURL || ""),
          // 요청은 저장이므로 file: 이미지도 앱으로 넘기지 않고 그대로 저장한다.
          "image-save": () => { noteExplicitSave(params.srcURL); wc.downloadURL(params.srcURL); },
          undo: () => wc.undo(),
          redo: () => wc.redo(),
          cut: () => wc.cut(),
          copy: () => wc.copy(),
          paste: () => wc.paste(),
          "select-all": () => wc.selectAll(),
          "search-selection": () => openTab(searchUrlFor((params.selectionText || "").trim()), false),
          back: () => { try { wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack(); } catch {} },
          forward: () => { try { wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward(); } catch {} },
          reload: () => wc.reload(),
          "page-copy-url": () => clipboard.writeText(wc.getURL() || ""),
          inspect: () => { try { wc.inspectElement(params.x, params.y); } catch {} },
        };
        const template = plan.map((id) => {
          if (id === "-") return { type: "separator" };
          if (id.startsWith("context-action:")) {
            const name = id.slice("context-action:".length);
            const action = actionByName.get(name);
            return {
              label: action ? action.label : name,
              click: () => {
                if (!action || !host || host.isDestroyed()) return;
                host.send("ac-context-action", { name: action.name, guestWebContentsId: wc.id });
              },
            };
          }
          const off = id.endsWith("-off");
          const label = LABELS[id] || id;
          if (off) return { label, enabled: false };
          const flags = params.editFlags || {};
          const editable = {
            undo: flags.canUndo, redo: flags.canRedo, cut: flags.canCut,
            copy: flags.canCopy, paste: flags.canPaste, "select-all": flags.canSelectAll,
          };
          const enabled = id in editable ? editable[id] !== false : true;
          const label2 = id === "search-selection"
            ? `"${(params.selectionText || "").trim().slice(0, 20)}" 검색`
            : label;
          return { label: label2, enabled, click: () => { try { run[id](); } catch {} } };
        });
        Menu.buildFromTemplate(template).popup();
      } catch {}
    });
  }

  return { attach };
}

module.exports = { createWebviewContextMenu, menuPlan };
