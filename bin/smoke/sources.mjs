// 소유 범위: 여러 smoke 섹션이 함께 읽는 저장소 소스 문자열의 단일 초기화 지점.
// 제공 API: web·server·native의 이름 붙은 소스 문자열과 CSS/readAll 합성 결과.
// 의존 대상: core의 read/readAll/sourceFiles와 저장소 안 소스 경로가 실행 중 안정적이라는 계약.
// 유지 조건: 읽는 경로·연결 순서·경계 문자열·초기화 타이밍을 분할 전과 같게 유지한다.
// 영향 범위: 러너와 DOCX 섹션 양쪽이 같은 문자열 인스턴스를 소비하므로 함께 본다.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs bin/smoke/sources.mjs
import {
  cannotMeasure, read, readAll, sourceFiles,
} from "./core.mjs";

export const mcp = read("bin/iris-mcp.mjs");
export const mcpReport = read("bin/mcp/report.mjs");
export const mcpApp = read("bin/mcp/app.mjs");
export const textEditor = read("web/js/center/text-editor.js");
export const docxEditor = read("web/js/docx/editor.js");
export const docxPanel = read("web/js/docx/panel.js");
export const web = read("web/index.html") + "\n" + read("web/js/main.js");
// 옛 모놀리스가 모듈로 쪼개진 뒤, index.html + main.js 만 보던 검사는 옮겨간 함수를 못 찾는다.
// "이 함수가 이렇게 한다"를 보는 검사는 그 함수가 지금 어느 파일에 있든 찾아야 하므로 렌더러
// 전체를 본다. 대신 이름이 겹칠 수 있다. 앱 셸과 기능이 같은 이름을 각자 쓴다(fileviewClickHandler:
// 앱 셸은 글자 탭용, 뷰어는 문서·표용). 겹치면 이름으로 찾는 쪽이 첫 번째를 집어 엉뚱한
// 것을 측정한다. 그래서 docxSourceFunction 이 둘 이상이면 멈추고, 그 검사는 capabilitySource 로
// 그 집합만 보게 한다. "겹치는 이름이 없다"고 여기 적어 두지 않는다. 그 문장은 오래된다.
// 이 둘은 최상위라 import 때 던진다. 그러면 check 가 아예 안 불려서 cannotMeasure 로 옮겨도
// "못 잰 것"으로 세어지지 않는다. 러너가 최상위 await import 로 섹션을 부르므로 프로세스가
// 통째로 끝나고 결과 줄 자체가 나오지 않는다. 잘못된 통과는 아니다(종료코드 0 아님, "결과:" 줄 없음).
// 그래서 이 둘은 그대로 두었다. 왜 이 둘만 빠졌는지 다시 판단하지 않도록 여기 적어 둔다.
export const renderer = (() => {
  const files = sourceFiles("web").filter((rel) => rel.startsWith("web/js/") && rel.endsWith(".js"));
  if (files.length < 60) throw new Error(`renderer 말뭉치가 먹혔다: ${files.length} 파일`);
  return read("web/index.html") + "\n" + files.map((rel) => read(rel)).join("\n");
})();
// 기능 모듈 집합의 소스. 어느 파일이 그 기능 것인지는 등록표가 안다. 검사에 파일 목록을 직접
// 적으면 파일이 갈라질 때 검사되지 않는 영역이 생긴다. 렌더러 전체를 보면 안 되는 검사가 있다:
// 앱 셸과 기능이 같은 이름의 함수를 각자 가질 수 있어서(fileviewClickHandler) 전체에서 이름으로
// 찾으면 엉뚱한 쪽을 측정한다. 그런 검사는 이 함수로 그 집합만 본다.
const { CAPABILITIES } = await import(new URL("../../web/js/core/capabilities.js", import.meta.url).href);
export const capabilityFiles = (id) => {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (!cap) cannotMeasure(`등록표에 ${id} 기능이 없다 — 이름이 바뀌었거나 지워졌다`);
  const files = (cap.files || []).map((f) => "web/js/" + f);
  if (!files.length) cannotMeasure(`${id} 기능이 자기 파일을 하나도 안 적었다`);
  return files;
};
export const capabilitySource = (id) => {
  const src = capabilityFiles(id).map((rel) => read(rel)).join("\n");
  if (src.length < 500) cannotMeasure(`${id} 기능 소스가 ${src.length} 글자다 — 말뭉치가 먹혔다`);
  return src;
};
// 화면 마크업이 있는 두 곳. 앱 셸의 index.html 과, 자기 마크업을 들고 오는 기능들이다
// (확인 결과: 기능 소유 영역 일곱을 index.html 에서 그 기능으로 옮겼다).
// "이 칸이 화면에 있다"를 보는 검사는 여기를 본다. index.html 만 보면 옮기는 순간 실패한다.
// 이 둘은 최상위라 import 때 던진다. 그러면 check 가 아예 안 불려서 cannotMeasure 로 옮겨도
// "못 잰 것"으로 세어지지 않는다. 러너가 최상위 await import 로 섹션을 부르므로 프로세스가
// 통째로 끝나고 결과 줄 자체가 나오지 않는다. 잘못된 통과는 아니다(종료코드 0 아님, "결과:" 줄 없음).
// 그래서 이 둘은 그대로 두었다. 왜 이 둘만 빠졌는지 다시 판단하지 않도록 여기 적어 둔다.
export const screenMarkup = (() => {
  const caps = CAPABILITIES.flatMap((c) => (c.files || []).map((f) => read("web/js/" + f))).join("\n");
  if (caps.length < 5000) throw new Error(`기능 소스를 못 읽었다: ${caps.length} 글자`);
  return web + "\n" + caps;
})();
export const css = (name) => read(`web/css/${name}.css`);
export const allCss = sourceFiles("web").filter((rel) => rel.startsWith("web/css/") && rel.endsWith(".css"))
  .map((rel) => read(rel)).join("\n");
export const pick = read("web/js/browser/pick.js");
export const profiles = read("web/js/browser/profiles.js");
// 계정 화면은 profiles.js 에서 갈라져 나갔다. 화면 쪽을 코어에서 찾으면 나오지 않는다.
export const accountsScreen = read("web/js/browser/accounts-screen.js");
// 계정 화면의 렌더링은 profiles.js 에서 accounts-view.js 로 나갔다. 연결과 렌더링이 갈라졌으므로
// "그 칸이 화면에 있는가"를 보는 검사는 둘을 함께 봐야 한다. 한쪽만 보면 옮기는 순간 실패한다.
export const accountsView = read("web/js/browser/accounts-view.js");
export const record = read("web/js/browser/record.js");
export const webview = read("web/js/browser/webview.js");
export const reorder = read("web/js/core/reorder.js");
export const bookmarks = read("web/js/browser/bookmarks.js");
export const browserTabs = read("web/js/browser/tabs.js");
export const pickHost = read("web/js/browser/pick-host.js");
export const pickSource = read("server/pick-source.js");
export const pickBoot = read("web/js/browser/pick-boot.js");
export const findInPage = read("web/js/browser/find-in-page.js");
export const appPick = read("web/js/browser/app-pick.js");
export const localdev = read("web/js/devtool/localdev.js");
export const rail = read("web/js/devtool/rail.js");
export const archive = read("web/js/devtool/archive.js");
export const browserHandoff = read("web/js/browser/handoff.js");
export const aiState = read("web/js/browser/ai-state.js");
export const aiTabs = read("web/js/browser/ai-tabs.js");
export const autofillAllowlist = read("web/js/browser/autofill-allowlist.js");
export const mainJs = read("web/js/main.js");
// 표·문서 뷰어가 main 에서 분리된 모듈. 표 응답·저장 ACK 처리기가 여기에 있다.
export const viewerBoot = read("web/js/viewer/boot.js");
// 어떤 확장자가 표·문서인지는 이 파일이 갖는다. 앱 셸은 core/file-kinds.js 에 묻는다.
export const viewerKinds = read("web/js/viewer/kinds.js");
export const centerTabs = read("web/js/center/tabs.js");
export const dock = read("web/js/browser/dock.js");
export const browserState = read("web/js/browser/state.js");
export const webviewFactory = read("web/js/browser/webview-factory.js");
export const webviewStore = read("web/js/browser/webview-store.js");
export const fileRouting = read("web/js/center/file-routing.js");
export const tabClose = read("web/js/center/tab-close.js");
export const memoAdmin = read("web/js/panel/memo-admin.js");
export const memoPanel = read("web/js/panel/memo.js");
export const memoStorePanel = read("web/js/panel/memo-store.js");
export const contextMenu = read("web/js/explorer/context-menu.js");
export const tree = read("web/js/explorer/tree.js");
export const herdrAgents = read("web/js/herdr/agents.js");
export const herdrState = read("web/js/herdr/state.js");
export const herdrSync = read("web/js/herdr/sync.js");
export const memoWindow = read("web/js/panel/memo-window.js");
export const xtermWiring = read("web/js/panel/xterm-wiring.js");
export const chatCopyBoot = read("web/js/chatcopy/boot.js");
export const chatCopyText = read("web/js/chatcopy/copy-text.js");
export const chatCopyEdge = read("web/js/chatcopy/edge-drag.js");
export const chatCopyDrop = read("web/js/chatcopy/drop-path.js");
export const touchDragPanel = read("web/js/panel/touch-drag.js");
export const viewportPanel = read("web/js/panel/viewport.js");
export const keynav = read("web/js/core/keynav.js");
export const screenSwitch = read("web/js/core/screen-switch.js");
export const wsCore = read("web/js/core/ws.js");
export const browserRuntime = read("server/browser-runtime.js");
export const browserDialogs = read("server/browser/dialogs.js");
export const browserHandles = read("server/browser/tab-handles.js");
export const serverIndexSource = read("server/index.js");
export const archiveHandlers = read("server/archive-handlers.js");
export const browserStateOwner = read("server/browser-state-owner.js");
export const workspaceRuntime = read("server/workspace-runtime.js");
export const workspaceHandlers = read("server/workspace-handlers.js");
export const herdrHandlers = read("server/herdr-handlers.js");
export const browserCommands = read("server/browser-commands.js");
export const browserMessages = read("server/browser-message-handlers.js");
export const httpHandler = read("server/http-handler.js");
export const allServer = readAll("server");
// 존재 검사("어디에도 없어야 한다")가 보는 소스. 파일을 직접 합치면 새 파일이 검사에서 빠지므로
// web/js 전부를 붙인다. 소유를 묻는 검사에는 쓰지 않는다.
export const allWebJs = sourceFiles("web").filter((rel) => rel.endsWith(".js") && rel.startsWith("web/js/"))
  .map((rel) => read(rel)).join("\n");
export const terminalPanel = read("web/js/panel/terminal.js");
export const sheetModel = read("web/js/sheet/model.js");
export const sheetFormula = read("web/js/sheet/formula.js");
export const sheetConditional = read("web/js/sheet/conditional.js");
export const sheetRender = read("web/js/sheet/render.js");
export const sheetEdit = read("web/js/sheet/edit.js");
// 표 탭이 들고 있는 상태(스냅숏·되돌리기·정리)는 앱 셸에서 여기로 나갔다.
export const sheetTabState = read("web/js/sheet/tab-state.js");
export const sheetActions = read("web/js/sheet/actions.js");
export const sheetEvents = read("web/js/sheet/events.js");
export const sheetMode = read("web/js/sheet/mode.js");
export const main = read("native/electron/main.cjs");
export const audioDiagnosticsSource = read("native/electron/audio-diagnostics.cjs");
export const certificateTrustSource = read("native/electron/certificate-trust.cjs");
export const chromeImportRegistrySource = read("native/electron/chrome-import-registry.cjs");
export const credentialServiceSource = read("native/electron/credential-service.cjs");
export const webviewThrottleSource = read("native/electron/webview-throttle.cjs");
export const profileSessionPolicySource = read("native/electron/profile-session-policy.cjs");
export const webviewLifecycleSource = read("native/electron/webview-lifecycle.cjs");
export const contextMenuSource = read("native/electron/webview-context-menu.cjs");
export const mainWindowSource = read("native/electron/main-window.cjs");
export const browserWindowManagerSource = read("native/electron/browser-window-manager.cjs");
export const memoWindowManagerSource = read("native/electron/memo-window-manager.cjs");
export const pickModeSource = read("native/electron/pick-mode.cjs");
export const chromeHandoffIpcSource = read("native/electron/chrome-handoff-ipc.cjs");
export const aiLoginPolicySource = read("native/electron/ai-login-policy.cjs");
export const downloadHookSource = read("native/electron/download-hook.cjs");
export const fsIpcSource = read("native/electron/fs-ipc.cjs");
export const credentialIpcSource = read("native/electron/credential-ipc.cjs");
export const cdpLayoutSource = read("native/electron/cdp-layout.cjs");
export const cdpUploadSource = read("native/electron/cdp-upload.cjs");
export const cdpResultSafetySource = read("native/electron/cdp-result-safety.cjs");
export const cdpHintsSource = read("native/electron/cdp-hints.cjs");
export const cdpObservationSource = read("native/electron/cdp-observation.cjs");
export const cdpHiddenViewportSource = read("native/electron/cdp-hidden-viewport.cjs");
export const cdpSessionSource = read("native/electron/cdp-session.cjs");
export const cdpCaptureToolsSource = read("native/electron/cdp-capture-tools.cjs");
export const cdpTransportSource = read("native/electron/cdp-transport.cjs");
export const cdpCmdPageSource = read("native/electron/cdp-cmd-page.cjs");
export const cdpCmdInputSource = read("native/electron/cdp-cmd-input.cjs");
export const cdpCmdInspectSource = read("native/electron/cdp-cmd-inspect.cjs");
export const cdpCmdCaptureSource = read("native/electron/cdp-cmd-capture.cjs");
export const cdpCmdNativeSource = read("native/electron/cdp-cmd-native.cjs");
export const nativeAx = read("native/electron/cdp-native-ax.cjs");
