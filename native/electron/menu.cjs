// 앱 메뉴 막대와 거기서 시작하는 쿠키 가져오기 흐름.
//
// 소유 범위
//   메뉴 템플릿(항목·라벨·가속기·역할)과 두 가져오기 흐름의 대화상자 문구·분기.
//   상태를 보관하지 않는다. 호출할 때마다 현재 창을 조회한다.
//
// 제공 API
//   createMenu(deps) 가 build() · runImportFile() · runImportChrome() 를 제공한다.
//   Menu 객체나 template 배열은 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. Menu·BrowserWindow·dialog·platform 과, 지금 메인 창을
//   조회하는 getMainWindow, 창 종류를 구분하는 두 관리자의 판정, cookieImport, appUrl 을 주입받는다.
//
// 유지 조건
//   "앱 새로고침" 에 가속기를 두지 않는다. 두면 앱 전역에서 먼저 처리되어 브라우저 창의
//   페이지 강제 리로드(⌘⇧R)를 가로챈다. 키 분기는 렌더러가 창별로 한다.
//   "보기" 의 새로고침 두 항목은 유지한다. 서버만 수정하고 앱을 그대로 두면 창이 이전 페이지를
//   유지하는데, 이 항목이 없으면 앱 재시작 외에는 되돌릴 방법이 없다.
//   가져오기 항목은 라벨만 두지 않는다. 각각 실제 흐름을 호출한다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron Menu·dialog 와 main-window·browser-window-manager·
//   memo-window-manager 의 창 판정, cookie-import 의 가져오기다.
//   양방향 소비자는 사용자가 누르는 메뉴 하나뿐이다. 창 판정이 어긋나면 "앱 새로고침" 이
//   엉뚱한 창을 다시 그린다. 브라우저 창에서 눌렀는데 콘솔 창이 새로 뜨는 식이다.
//   현재 목록 확인: node bin/importers.mjs native/electron/menu.cjs

function createMenu({
  Menu, BrowserWindow, dialog, platform, getMainWindow, appUrl,
  isBrowserModeWindow, isMemoWindow, allBrowserWindows, allMemoWindows, cookieImport,
}) {
  // 쿠키 임포트 실행 + 결과 다이얼로그.
  async function runImportFile() {
    const win = getMainWindow();
    try {
      const r = await cookieImport.importCookiesFromFile(win);
      if (r.canceled) return;
      if (r.error) return dialog.showMessageBox(win, { type: "error", message: "쿠키 가져오기 실패", detail: r.error });
      dialog.showMessageBox(win, { type: "info", message: "쿠키 가져오기 완료", detail: `${r.imported}개 주입 · ${r.skipped}개 건너뜀\n도메인: ${r.domains.slice(0, 20).join(", ")}` });
    } catch (e) { dialog.showMessageBox(win, { type: "error", message: "오류", detail: String(e && e.message || e) }); }
  }
  async function runImportChrome() {
    const win = getMainWindow();
    try {
      const profs = cookieImport.listChromeProfiles();
      if (!profs.length) return dialog.showMessageBox(win, { type: "info", message: "가져올 브라우저 프로필 없음", detail: "설치된 Chrome/Brave/Edge의 Cookies를 찾지 못했습니다." });
      let chosen = profs[0];
      if (profs.length > 1) {
        const pick = await dialog.showMessageBox(win, {
          type: "question", message: "어느 프로필에서 쿠키를 가져올까요?",
          detail: "Keychain 접근 프롬프트가 뜰 수 있습니다.",
          buttons: [...profs.map((p) => p.label), "취소"], cancelId: profs.length,
        });
        if (pick.response >= profs.length) return;
        chosen = profs[pick.response];
      }
      const r = await cookieImport.importCookiesFromChrome(chosen);
      if (r.error) return dialog.showMessageBox(win, { type: "error", message: "쿠키 가져오기 실패", detail: r.error });
      dialog.showMessageBox(win, { type: "info", message: "쿠키 가져오기 완료", detail: `${chosen.label}\n${r.imported}/${r.total} 주입 · ${r.skipped} 건너뜀\n도메인 ${r.domains.length}개` });
    } catch (e) { dialog.showMessageBox(win, { type: "error", message: "오류", detail: String(e && e.message || e) }); }
  }
  function build() {
    const isMac = platform === "darwin";
    const template = [
      ...(isMac ? [{
        label: "Iris",
        submenu: [
          { role: "about", label: "Iris 정보" },
          { type: "separator" },
          // 앱 새로고침. 키는 렌더러가 창별로 분기해 처리한다(메인 ⌘⇧R = 앱 강제 재로딩,
          // 브라우저 창 ⌘⇧R = 페이지 강제 리로드). 여기에 가속기를 두면 앱 전역으로 먼저 발화해
          // 브라우저 창의 페이지 강제 리로드를 가로채므로 가속기를 두지 않는다.
          { label: "앱 새로고침", click: () => {
            const win = getMainWindow();
            const fw = BrowserWindow.getFocusedWindow();
            if (fw && isBrowserModeWindow(fw)) { try { fw.loadURL(appUrl + "/?mode=browser"); } catch {} }
            else if (fw && isMemoWindow(fw)) { try { fw.webContents.reloadIgnoringCache(); } catch {} }
            else {
              try { win?.loadURL(appUrl); } catch {}
              for (const b of allBrowserWindows()) { try { b.webContents.reloadIgnoringCache(); } catch {} }
              for (const b of allMemoWindows()) { try { b.webContents.reloadIgnoringCache(); } catch {} }
            }
          } },
          { type: "separator" },
          { role: "hide", label: "숨기기" },
          { role: "quit", label: "종료" },
        ],
      }] : []),
      {
        label: "편집",
        submenu: [
          { role: "undo", label: "실행 취소" },
          { role: "redo", label: "다시 실행" },
          { type: "separator" },
          { role: "cut", label: "잘라내기" },
          { role: "copy", label: "복사" },
          { role: "paste", label: "붙여넣기" },
          { role: "selectAll", label: "전체 선택" },
        ],
      },
      {
        label: "보기",
        submenu: [
          // 화면 코드는 서버가 내려준다. 서버만 수정하고 앱을 그대로 두면 창이 이전 페이지를 계속
          // 유지하는데, 새로고침 항목이 없으면 앱 재시작 외에는 되돌릴 방법이 없다.
          // 서버 코드를 수정한 뒤 반영하는 정상 경로다.
          { role: "reload", label: "새로고침", accelerator: "Cmd+R" },
          { role: "forceReload", label: "강제 새로고침", accelerator: "Cmd+Shift+R" },
          { type: "separator" },
          { role: "toggleDevTools", label: "개발자 도구", accelerator: "Cmd+Alt+I" },
          { type: "separator" },
          { role: "togglefullscreen", label: "전체 화면" },
        ],
      },
      {
        label: "브라우저",
        submenu: [
          { label: "쿠키 가져오기: Chrome에서…", click: () => runImportChrome() },
          { label: "쿠키 가져오기: JSON 파일…", click: () => runImportFile() },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return template;
  }
  return { build, runImportFile, runImportChrome };
}

module.exports = { createMenu };
