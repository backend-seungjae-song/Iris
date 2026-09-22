// 소유 범위: 브라우저 안에서 누른 로컬 링크의 처리 경로. 새 탭 요청·같은 탭 이동·
//   내려받기·우클릭 네 경우의 경계와, 그 판정을 렌더러가 갖고 main 은 복사본만 본다는 계약.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: native/electron/{local-link,webview-lifecycle,download-hook,webview-context-menu}.cjs
//   와 렌더러의 web/js/center/file-routing.js. 넷 다 Electron 없이 호출할 수 있다.
// 유지 조건: 소스 모양이 아니라 실제로 호출해서 확인한다. 원격 페이지가 여는 file: 은
//   받지 않는다는 경계가 여기서 실패로 걸려야 한다. 깨지면 외부 페이지가 이 기기의 파일을 연다.
//   사용자가 요청한 「다른 이름으로 저장」이 앱 열기로 바뀌면 안 된다.
// 영향 범위: native/electron/{local-link,webview-lifecycle,download-hook,webview-context-menu,
//   main,preload}.cjs, web/js/{main.js,center/file-routing.js}.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/local-link.mjs
import { check, checkAsync, read } from "../core.mjs";
import { main, web } from "../sources.mjs";

const preload = read("native/electron/preload.cjs");

const at = (rel) => new URL(rel, import.meta.url).href;
const req = async (rel) => import(at(rel));

// webview 게스트 대역. 보낸 것을 그대로 모아 둔다. 무엇이 어느 통로로 갔는지가 판정 기준이다.
function fakeGuest(pageUrl) {
  const sent = [];
  const navHandlers = [];
  const wc = {
    id: 7, getType: () => "webview", isDestroyed: () => false,
    getURL: () => pageUrl,
    on: (ev, fn) => { if (ev === "will-navigate") navHandlers.push(fn); },
    once: () => {}, session: { on: () => {}, setPermissionRequestHandler: () => {} },
    setBackgroundThrottling: () => {},
    setWindowOpenHandler: (fn) => { wc.openHandler = fn; },
    hostWebContents: { isDestroyed: () => false, send: (ch, m) => sent.push([ch, m]) },
    debugger: { isAttached: () => false, attach: () => { throw new Error("no cdp"); }, on: () => {} },
  };
  return { wc, sent, navHandlers };
}

async function bootLifecycle(pageUrl, appDrawsLink) {
  const { createWebviewLifecycle } = await req("../../../native/electron/webview-lifecycle.cjs");
  let onCreated = null;
  createWebviewLifecycle({
    app: { on: (ev, fn) => { if (ev === "web-contents-created") onCreated = fn; } },
    noThrottleOpt: false, getAppUrl: () => "http://127.0.0.1:4291",
    clearThrottleState: () => {}, forgetSecrets: () => {}, dialogScript: () => "",
    webAuthnScript: "", botcheckScript: "",
    registerSessionPrimer: () => {}, primeSession: () => {}, noteFrameOrigin: () => {},
    dropChildSession: () => {}, noteChildSession: () => {}, randomUuid: () => "u1",
    registerPopup: () => {}, unregisterPopup: () => {}, setThrottleReason: () => {},
    reconcilePopupThrottling: () => {}, ctlSend: () => {},
    aiDriving: () => false, appDrawsLink,
  });
  const guest = fakeGuest(pageUrl);
  onCreated({}, guest.wc);
  return guest;
}

function makeDownloadHook(createDownloadHook, sent) {
  const hook = createDownloadHook({
    fs: { existsSync: () => false },
    path: { extname: () => "", basename: (x) => x, join: (a, b) => a + "/" + b },
    downloadState: { snapshot: () => ({ dir: "" }), claim: () => {}, complete: () => {}, blocked: () => {} },
    allWindows: () => [], now: () => 1000, aiDriving: () => false,
  });
  let onDownload = null;
  hook.installDownloadHook({ on: (ev, fn) => { if (ev === "will-download") onDownload = fn; } });
  const wc = { id: 7, isDestroyed: () => false,
    hostWebContents: { isDestroyed: () => false, send: (ch, m) => sent.push([ch, m]) } };
  return { hook, fire: (item) => onDownload({}, item, wc) };
}

function fakeItem(source) {
  const dones = [];
  const item = {
    cancelled: false, dones,
    getURL: () => source, getFilename: () => "x", getTotalBytes: () => 0,
    cancel: () => { item.cancelled = true; },
    setSavePath: () => {}, getSavePath: () => "/saved/x.xlsx",
    once: (ev, fn) => { if (ev === "done") dones.push(fn); },
  };
  return item;
}

export default async function run() {
console.log("[local-link] 브라우저 안에서 누른 로컬 링크");

await checkAsync("무엇이 로컬인가 — file: 과 loopback 만이다", async () => {
  const { isFileUrl, isLoopbackUrl, isLocalPage } = await req("../../../native/electron/local-link.cjs");
  const cases = [
    ["file:///a/b.xlsx", { file: true, loop: false, local: true }],
    ["http://localhost:4291/x.xlsx", { file: false, loop: true, local: true }],
    ["http://127.0.0.1:9/x", { file: false, loop: true, local: true }],
    ["https://a.example/x", { file: false, loop: false, local: false }],
    ["https://evil.example/?next=localhost", { file: false, loop: false, local: false }],
    ["https://localhost.evil.example/x", { file: false, loop: false, local: false }],
    ["", { file: false, loop: false, local: false }],
  ];
  const wrong = cases.filter(([u, want]) => isFileUrl(u) !== want.file
    || isLoopbackUrl(u) !== want.loop || isLocalPage(u) !== want.local).map(([u]) => u || "(빈 주소)");
  if (wrong.length) throw new Error("판정이 다르다: " + wrong.join(", "));
  return true;
});

await checkAsync("로컬 페이지의 file: 새 탭 요청은 앱이 받는다(브라우저 탭으로 열지 않는다)", async () => {
  const { wc, sent } = await bootLifecycle("file:///r/report.html", () => false);
  const r = wc.openHandler({ url: "file:///r/sheet.xlsx", disposition: "foreground-tab" });
  if (r.action !== "deny") throw new Error("file: 을 브라우저 탭·창으로 연다");
  if (sent.length !== 1 || sent[0][0] !== "ac-open-local") throw new Error("앱으로 안 넘긴다: " + JSON.stringify(sent));
  if (sent[0][1].target !== "file:///r/sheet.xlsx") throw new Error("주소가 안 실렸다");
  return true;
});

await checkAsync("원격 페이지가 여는 file: 은 받지 않는다", async () => {
  const { wc, sent } = await bootLifecycle("https://evil.example/p", () => false);
  const r = wc.openHandler({ url: "file:///Users/you/.ssh/id_rsa", disposition: "foreground-tab" });
  if (r.action !== "deny") throw new Error("원격 페이지의 file: 을 연다");
  if (sent.length !== 0) throw new Error("원격 페이지가 지목한 파일을 앱으로 넘긴다: " + JSON.stringify(sent));
  return true;
});

await checkAsync("http 새 탭·팝업 정책은 그대로다", async () => {
  const { wc, sent } = await bootLifecycle("file:///r/report.html", () => false);
  const tab = wc.openHandler({ url: "https://a.example/x", disposition: "foreground-tab" });
  if (tab.action !== "deny" || sent.length !== 1 || sent[0][0] !== "ac-open-tab") throw new Error("http 새 탭이 옛 길을 안 탄다");
  const popup = wc.openHandler({ url: "https://auth.example/o", disposition: "new-window" });
  if (popup.action !== "allow") throw new Error("http 팝업을 막는다");
  const mailto = wc.openHandler({ url: "mailto:a@b.c", disposition: "new-window" });
  if (mailto.action !== "deny" || sent.length !== 1) throw new Error("http 아닌 다른 scheme 이 샌다");
  return true;
});

await checkAsync("앱이 그리기로 한 확장자만 이동을 가로챈다", async () => {
  const { navHandlers, sent } = await bootLifecycle("file:///r/report.html", (u) => /\.md$/i.test(String(u)));
  if (!navHandlers.length) throw new Error("will-navigate 를 안 듣는다");
  const fire = (target) => {
    let prevented = false;
    const ev = { isMainFrame: true, preventDefault: () => { prevented = true; } };
    for (const fn of navHandlers) fn(ev, target);
    return prevented;
  };
  if (!fire("file:///r/notes.md")) throw new Error("마크다운 이동을 안 막는다");
  if (sent.length !== 1 || sent[0][0] !== "ac-open-local") throw new Error("마크다운을 앱으로 안 넘긴다");
  if (fire("file:///r/other.html")) throw new Error("html 이동까지 막는다");
  if (fire("https://a.example/x.md")) throw new Error("원격 주소의 이동을 막는다");
  if (sent.length !== 1) throw new Error("가로채지 않기로 한 이동까지 앱으로 넘긴다");
  return true;
});

await checkAsync("표를 아직 못 받았으면 아무 이동도 안 막는다", async () => {
  const { navHandlers, sent } = await bootLifecycle("file:///r/report.html", () => false);
  let prevented = false;
  for (const fn of navHandlers) fn({ isMainFrame: true, preventDefault: () => { prevented = true; } }, "file:///r/notes.md");
  if (prevented || sent.length) throw new Error("빈 표로도 가로챈다");
  return true;
});

await checkAsync("file: 내려받기는 앱이 받고, 사람이 시킨 저장은 그대로 저장한다", async () => {
  const { createDownloadHook } = await req("../../../native/electron/download-hook.cjs");
  const sent = [];
  const { hook, fire } = makeDownloadHook(createDownloadHook, sent);
  const local = fakeItem("file:///r/sheet.xlsx");
  fire(local);
  if (!local.cancelled) throw new Error("로컬 파일을 굳이 내려받는다");
  if (sent.length !== 1 || sent[0][0] !== "ac-open-local") throw new Error("앱으로 안 넘긴다");

  hook.noteExplicitSave("file:///r/pic.png");
  const saved = fakeItem("file:///r/pic.png");
  fire(saved);
  if (saved.cancelled) throw new Error("사람이 시킨 저장을 취소한다");
  // 녹화용 통지(ac-rec-native)는 어느 내려받기에서도 나가므로, 앱 열기 통로만 계산한다.
  if (sent.filter(([ch]) => ch === "ac-open-local").length !== 1) throw new Error("시킨 저장을 앱 열기로 바꾼다");
  return true;
});

await checkAsync("받고 나서 여는 것은 로컬에서 받은 것뿐이다", async () => {
  const { createDownloadHook } = await req("../../../native/electron/download-hook.cjs");
  const once = (source) => {
    const sent = [];
    const { fire } = makeDownloadHook(createDownloadHook, sent);
    const item = fakeItem(source);
    fire(item);
    for (const fn of item.dones) fn({}, "completed");
    return sent.filter(([ch]) => ch === "ac-downloaded");
  };
  if (once("http://localhost:5173/x.xlsx").length !== 1) throw new Error("로컬에서 받은 것을 안 연다");
  if (once("https://a.example/x.xlsx").length !== 0) throw new Error("일반 웹에서 받은 것까지 연다");
  return true;
});

await checkAsync("우클릭 「새 탭에서 열기」도 로컬 링크는 앱으로", async () => {
  const { createWebviewContextMenu } = await req("../../../native/electron/webview-context-menu.cjs");
  const once = (pageUrl, linkURL) => {
    const sent = [], template = [];
    const menu = createWebviewContextMenu({
      Menu: { buildFromTemplate: (t) => { template.push(...t); return { popup: () => {} }; } },
      clipboard: { writeText: () => {} }, searchUrlFor: (q) => "https://s/?q=" + q,
    });
    let onMenu = null;
    const wc = { id: 7, getURL: () => pageUrl, canGoBack: () => false, canGoForward: () => false,
      on: (ev, fn) => { if (ev === "context-menu") onMenu = fn; },
      hostWebContents: { isDestroyed: () => false, send: (ch, m) => sent.push([ch, m]) } };
    menu.attach(wc);
    onMenu({}, { linkURL, editFlags: {} });
    const entry = template.find((t) => t.label === "링크를 새 탭에서 열기");
    if (!entry) throw new Error("항목이 안 뜬다");
    entry.click();
    return sent;
  };
  const localLink = once("file:///r/report.html", "file:///r/sheet.xlsx");
  if (localLink.length !== 1 || localLink[0][0] !== "ac-open-local") throw new Error("로컬 링크가 브라우저 탭으로 간다: " + JSON.stringify(localLink));
  if (once("https://evil.example/p", "file:///Users/you/.ssh/id_rsa").length !== 0) throw new Error("원격 페이지가 지목한 파일을 연다");
  const httpLink = once("file:///r/report.html", "https://a.example/x");
  if (httpLink.length !== 1 || httpLink[0][0] !== "ac-open-tab") throw new Error("http 링크가 옛 길을 안 탄다");
  return true;
});

await checkAsync("렌더러는 링크마다 제자리를 고른다", async () => {
  const fk = await req("../../../web/js/core/file-kinds.js");
  const fr = await req("../../../web/js/center/file-routing.js");
  const bs = await req("../../../web/js/browser/state.js");
  const seen = [];
  const acHost = {
    revealInFinder: (p) => seen.push(["finder", p]),
    openInConsole: (p) => seen.push(["console", p]),
    openBrowser: () => {},
  };
  const boot = (browserMode) => {
    seen.length = 0;
    bs.initBrowserState({ BOUND_SPACE: "s1", BROWSER_MODE: browserMode, wsSend: (m) => seen.push(["ws", m]) });
    bs.replaceBrowserState({ docked: false, activeSpace: "s1", tabsBySpace: {}, activeBySpace: {} });
    fr.initFileRouting({
      $: () => null, showToast: (t) => seen.push(["toast", t]), acHost,
      terminalBarePathToken: (x) => x, agentByPane: () => null, BROWSER_MODE: browserMode,
      makeFileTab: () => ({}), requestFileContent: () => {}, trackFileWatch: () => {},
      renderTabs: () => {}, showActiveTab: () => {}, persistFileTabs: () => {}, syncWatchDirs: () => {},
      newBrowserTab: (u) => seen.push(["browsertab", u]),
      getHostHome: () => "/Users/you", getCurTarget: () => null, getLastAgents: () => [],
      getSelectedSpaceId: () => "s1",
    });
  };
  const opened = () => seen.find(([k, m]) => k === "ws" && m && m.mutation && m.mutation.op === "tab.open");
  fk.clearFileKinds();
  fk.registerFileKind({ id: "sheet", test: (p) => /\.xlsx$/i.test(p) });

  boot(false);
  fr.openLocalLink("file:///r/sheet.xlsx");
  if (!opened() || opened()[1].mutation.kind !== "sheet") throw new Error("표가 뷰어 탭으로 안 간다: " + JSON.stringify(seen));

  boot(false);
  fr.openLocalLink("file:///r/report.html");
  if (!seen.some(([k, u]) => k === "browsertab" && /report\.html$/.test(String(u)))) throw new Error("html 이 브라우저로 안 간다");

  boot(false);
  fr.openLocalLink("file:///r/bundle.zip");
  if (!seen.some(([k, p]) => k === "finder" && p === "/r/bundle.zip")) throw new Error("압축파일이 Finder 로 안 간다");

  boot(true);
  fr.openLocalLink("file:///r/notes.md");
  if (!seen.some(([k, p]) => k === "console" && p === "/r/notes.md")) throw new Error("분리 창의 글자 파일이 콘솔로 안 간다");

  boot(false);
  fr.openDownloadedLocal("/saved/x.xlsx");
  if (!opened()) throw new Error("받은 표를 안 연다");
  boot(false);
  fr.openDownloadedLocal("/saved/x.zip");
  if (seen.length) throw new Error("뷰어가 안 맡는 것까지 연다: " + JSON.stringify(seen));

  fk.clearFileKinds();
  return true;
});

// 분리 브라우저 창은 자기가 보고 있는 스페이스만 그린다(dock.js 의 reconcileDocTabs). 그래서
// 그 창에서 연 문서는 그 스페이스에 등록되어야 한다. 콘솔의 센터 스페이스를 쓰면 두 값이
// 달라질 때 아무도 그리지 않는 탭이 된다.
await checkAsync("분리 브라우저 창의 문서는 그 창이 보고 있는 스페이스에 등록된다", async () => {
  const fk = await req("../../../web/js/core/file-kinds.js");
  const fr = await req("../../../web/js/center/file-routing.js");
  const bs = await req("../../../web/js/browser/state.js");
  const ts = await req("../../../web/js/center/tab-store.js");
  const seen = [];
  bs.initBrowserState({ BOUND_SPACE: "보는스페이스", BROWSER_MODE: true, wsSend: (m) => seen.push(m) });
  bs.replaceBrowserState({ docked: false, activeSpace: "보는스페이스", tabsBySpace: {}, activeBySpace: {} });
  // 콘솔의 센터 스페이스를 일부러 다른 값으로 둔다. 두 값이 다를 때 어느 쪽을 고르는지가 판정 기준이다.
  ts.setCenterSpace("다른스페이스");
  fr.initFileRouting({
    $: () => null, showToast: () => {}, acHost: {},
    terminalBarePathToken: (x) => x, agentByPane: () => null, BROWSER_MODE: true,
    makeFileTab: () => ({}), requestFileContent: () => {}, trackFileWatch: () => {},
    renderTabs: () => {}, showActiveTab: () => {}, persistFileTabs: () => {}, syncWatchDirs: () => {},
    newBrowserTab: () => {}, getHostHome: () => "/Users/you", getCurTarget: () => null,
    getLastAgents: () => [], getSelectedSpaceId: () => "다른스페이스",
  });
  fk.clearFileKinds();
  fk.registerFileKind({ id: "sheet", test: (p) => /\.xlsx$/i.test(p) });
  fr.openLocalLink("file:///r/sheet.xlsx");
  fk.clearFileKinds();
  ts.setCenterSpace(null);
  const open = seen.find((m) => m && m.mutation && m.mutation.op === "tab.open");
  if (!open) throw new Error("문서 탭을 안 연다");
  if (open.mutation.space !== "보는스페이스") throw new Error("그 창이 안 보고 있는 스페이스에 세운다: " + open.mutation.space);
  return true;
});

// 판정은 렌더러가 갖고 main 은 복사본만 본다. 그 복사본이 실제로 전달되어야 하며,
// 전달 경로 하나가 빠지면 마크다운 가로채기가 조용히 동작하지 않는다.
check("앱이 그리는 확장자 표가 렌더러에서 main 까지 건너간다", () => {
  const bridges = /setAppDrawnLinkExts/.test(preload) && /onOpenLocal/.test(preload)
    && /onDownloaded/.test(preload) && /openInConsole/.test(preload);
  const renderer = /acHost\.setAppDrawnLinkExts\(APP_DRAWN_LINK_EXTS\)/.test(web)
    && /acHost\.onOpenLocal\(/.test(web) && /acHost\.onDownloaded\(/.test(web);
  const mainSide = /ac-app-drawn-link-exts/.test(main) && /appDrawsLink,/.test(main)
    && /ac-open-in-console/.test(main);
  return bridges && renderer && mainSide;
});
}
