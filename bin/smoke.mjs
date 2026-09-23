#!/usr/bin/env node
// 동작 캡처 스모크. 리팩터링 전후 동일성을 결정론적으로 확인한다.
// 테스트 스위트가 없는 프로젝트라 이 스크립트가 안전망 역할을 한다.
// 실행: node bin/smoke.mjs [--live]   (--live는 앱이 떠 있을 때 서버·브라우저 경로까지 검사)
import { check, DOCX_ONLY, read, sourceFiles, summary } from "./smoke/core.mjs";

const { default: runDocxBlock1 } = await import("./smoke/sections/90-docx-block1.mjs");
const { default: runDocxVendorGate } = await import("./smoke/sections/docx-vendor-gate.mjs");
const { default: runDocxEditorHost } = await import("./smoke/sections/docx-editor-host.mjs");
const { default: runDocxRevisionProtocol } = await import("./smoke/sections/docx-revision-protocol.mjs");
const { default: runDocxSaveLifecycle } = await import("./smoke/sections/docx-save-lifecycle.mjs");
const { default: runDocxAtomicWrite } = await import("./smoke/sections/docx-atomic-write.mjs");
const { default: runDocxLegacyMigration } = await import("./smoke/sections/docx-legacy-migration.mjs");
const { default: runDocxIntegration } = await import("./smoke/sections/docx-integration.mjs");
const { default: runDocxBrowserTab } = await import("./smoke/sections/docx-browser-tab.mjs");
// DOCX 블록은 --docx-only 에서만 실행한다. 그 호출이 곧 섹션의 default run 이다.
// 러너가 블록 이름을 다시 나열하면 섹션의 run 은 아무 일도 하지 않는 껍데기가 되고,
// 도달성 검사는 그 껍데기로 통과한다.
if (DOCX_ONLY) {
  await runDocxBlock1();
  await runDocxVendorGate();
  await runDocxEditorHost();
  await runDocxRevisionProtocol();
  await runDocxSaveLifecycle();
  await runDocxAtomicWrite();
  await runDocxLegacyMigration();
  await runDocxIntegration();
  await runDocxBrowserTab();
  process.exit(summary());
}
const { default: runStructureGuards } = await import("./smoke/sections/10-structure-guards.mjs");
await runStructureGuards();

check("smoke sections 의 모든 .mjs 가 러너에서 default run 으로 닿는다", () => {
  // 주석을 먼저 제거한다. 제거하지 않으면 호출을 지우지 않고 `// await runX();` 로 막아도 이 검사가
  // 통과한다. 확인 결과: 그렇게 막으면 검사 100개가 사라져도 실패하지 않는다.
  const runner = read("bin/smoke.mjs")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  const sections = sourceFiles("smoke").filter((rel) => rel.startsWith("bin/smoke/sections/"));
  if (!sections.length) throw new Error("smoke section을 하나도 찾지 못함");
  const imports = new Map([...runner.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*await import\("([^"]+)"\);/g)]
    .map((match) => [match[2], match[1]]));
  const missing = [];
  for (const rel of sections) {
    const spec = `./${rel.slice("bin/".length)}`;
    const fields = imports.get(spec) || "";
    const defaultBinding = /\bdefault\s*:\s*([A-Za-z_$][\w$]*)/.exec(fields)?.[1];
    if (!defaultBinding || !new RegExp(`\\bawait\\s+${defaultBinding}\\(\\);`).test(runner)) missing.push(rel);
  }
  if (missing.length) throw new Error(`러너에서 default run 으로 닿지 않는 섹션: ${missing.join(", ")}`);
  return true;
});

const { default: runStructureGuardsAfterReachability } = await import("./smoke/sections/11-structure-guards-after-reachability.mjs");
await runStructureGuardsAfterReachability();

// 아래 열넷은 20-browser-contracts 한 파일에서 나눈 것이다. 이름은 브라우저 계약이지만
// 메모 창·webview 수명·탭 프로필·대화상자·녹화·MCP·herdr·편집기가 함께 있었다.
const { default: runFeatureWiring } = await import("./smoke/sections/feature-wiring.mjs");
await runFeatureWiring();

const { default: runBrowserStateModel } = await import("./smoke/sections/browser-state-model.mjs");
await runBrowserStateModel();

const { default: runRecordReplay } = await import("./smoke/sections/record-replay.mjs");
await runRecordReplay();

const { default: runMcpServer } = await import("./smoke/sections/mcp-server.mjs");
await runMcpServer();

const { default: runSpaceIsolation } = await import("./smoke/sections/space-isolation.mjs");
await runSpaceIsolation();

const { default: runBrowserUi } = await import("./smoke/sections/browser-ui.mjs");
await runBrowserUi();

const { default: runTabDeathAndLinks } = await import("./smoke/sections/tab-death-and-links.mjs");
await runTabDeathAndLinks();

const { default: runSessionTabs } = await import("./smoke/sections/session-tabs.mjs");
await runSessionTabs();

const { default: runWebviewLru } = await import("./smoke/sections/webview-lru.mjs");
await runWebviewLru();
const { default: runTabWake } = await import("./smoke/sections/tab-wake.mjs");
await runTabWake();
const { default: runClosedTabs } = await import("./smoke/sections/closed-tabs.mjs");
await runClosedTabs();
const { default: runKeymap } = await import("./smoke/sections/keymap.mjs");
await runKeymap();
const { default: runCookieHarvest } = await import("./smoke/sections/cookie-harvest.mjs");
await runCookieHarvest();
const { default: runSaveLogin } = await import("./smoke/sections/save-login.mjs");
await runSaveLogin();
const { default: runToolScreens } = await import("./smoke/sections/tool-screens.mjs");
await runToolScreens();

const { default: runPageTranslate } = await import("./smoke/sections/page-translate.mjs");
await runPageTranslate();

const { default: runLinkAndOmnibox } = await import("./smoke/sections/link-and-omnibox.mjs");
await runLinkAndOmnibox();

const { default: runHerdrPassthrough } = await import("./smoke/sections/herdr-passthrough.mjs");
await runHerdrPassthrough();

const { default: runEditorMonaco } = await import("./smoke/sections/editor-monaco.mjs");
await runEditorMonaco();
const { default: runEditorControls } = await import("./smoke/sections/editor-controls.mjs");
await runEditorControls();
const { default: runCenterFileDrop } = await import("./smoke/sections/center-file-drop.mjs");
await runCenterFileDrop();
const { default: runBrowserFileDrop } = await import("./smoke/sections/browser-file-drop.mjs");
await runBrowserFileDrop();

const { default: runExecutorQueue } = await import("./smoke/sections/executor-queue.mjs");
await runExecutorQueue();

const { default: runPasskeyAndFrames } = await import("./smoke/sections/passkey-and-frames.mjs");
await runPasskeyAndFrames();

const { default: runChromeAuth } = await import("./smoke/sections/30-chrome-auth.mjs");
await runChromeAuth();

const { default: runNativeModal } = await import("./smoke/sections/32-native-modal.mjs");
await runNativeModal();

const { default: runAppPick } = await import("./smoke/sections/34-app-pick.mjs");
await runAppPick();
const { default: runPickSource } = await import("./smoke/sections/pick-source.mjs");
await runPickSource();

const { default: runAppShell } = await import("./smoke/sections/60-app-shell.mjs");
await runAppShell();

// 아래는 40-qa-evidence 한 파일에서 나눈 것이다. 이름은 QA 증거였지만 안에는 보관함·스크롤백
// 복사·메모·탭바·하트비트·보고서 페이지·키 입력이 섞여 있었다.
const { default: runArchive } = await import("./smoke/sections/archive.mjs");
await runArchive();

const { default: runScrollbackCopy } = await import("./smoke/sections/scrollback-copy.mjs");
await runScrollbackCopy();

const { default: runMemo } = await import("./smoke/sections/memo.mjs");
await runMemo();

const { default: runBrowserChrome } = await import("./smoke/sections/browser-chrome.mjs");
await runBrowserChrome();

const { default: runWsLiveness } = await import("./smoke/sections/ws-liveness.mjs");
await runWsLiveness();

const { default: runQaEvidenceTools } = await import("./smoke/sections/qa-evidence-tools.mjs");
await runQaEvidenceTools();

const { default: runQaReportPage } = await import("./smoke/sections/qa-report-page.mjs");
await runQaReportPage();

const { default: runCaptureTools } = await import("./smoke/sections/capture-tools.mjs");
await runCaptureTools();

const { default: runHiddenTabOps } = await import("./smoke/sections/hidden-tab-ops.mjs");
await runHiddenTabOps();

const { default: runBackgroundTab } = await import("./smoke/sections/background-tab.mjs");
await runBackgroundTab();

const { default: runKeys } = await import("./smoke/sections/keys.mjs");
await runKeys();
const { default: runScreenSwitch } = await import("./smoke/sections/screen-switch.mjs");
await runScreenSwitch();
const { default: runWindowSwitcher } = await import("./smoke/sections/window-switcher.mjs");
await runWindowSwitcher();
const { default: runModuleLeak } = await import("./smoke/sections/module-leak.mjs");
await runModuleLeak();
const { default: runFindInPage } = await import("./smoke/sections/find-in-page.mjs");
await runFindInPage();
const { default: runWebviewContextMenu } = await import("./smoke/sections/webview-context-menu.mjs");
await runWebviewContextMenu();
const { default: runExtensionLoader } = await import("./smoke/sections/extension-loader.mjs");
await runExtensionLoader();

const { default: runDeskLayout } = await import("./smoke/sections/desk-layout.mjs");
await runDeskLayout();

const { default: runLocalLink } = await import("./smoke/sections/local-link.mjs");
await runLocalLink();
const { default: runBrowserShortcuts } = await import("./smoke/sections/browser-shortcuts.mjs");
await runBrowserShortcuts();

const { default: runQaRunJournal } = await import("./smoke/sections/qa-run-journal.mjs");
await runQaRunJournal();

const { default: runPlanRunner } = await import("./smoke/sections/plan-runner.mjs");
await runPlanRunner();

const { default: runPlanMacro } = await import("./smoke/sections/plan-macro.mjs");
await runPlanMacro();

const { default: runSnapshotCursor } = await import("./smoke/sections/snapshot-cursor.mjs");
await runSnapshotCursor();

const { default: runQaContracts } = await import("./smoke/sections/qa-contracts.mjs");
await runQaContracts();

// 아래 아홉은 50-two-flows 한 파일을 기능마다 나눈 것이다. 고장 하나를 고칠 때
// 열어야 할 파일이 하나여야 하고, 새 기능은 기존 파일 수정이 아니라 새 파일로 들어와야 한다.
const { default: runCdpSession } = await import("./smoke/sections/cdp-session.mjs");
await runCdpSession();

const { default: runCdpCommands } = await import("./smoke/sections/cdp-commands.mjs");
await runCdpCommands();

const { default: runCdpCapture } = await import("./smoke/sections/cdp-capture.mjs");
await runCdpCapture();

const { default: runNativeServices } = await import("./smoke/sections/native-services.mjs");
await runNativeServices();

const { default: runStateHome } = await import("./smoke/sections/state-home.mjs");
await runStateHome();

const { default: runArtifactsHome } = await import("./smoke/sections/artifacts-home.mjs");
await runArtifactsHome();

const { default: runSketchOverlay } = await import("./smoke/sections/sketch-overlay.mjs");
await runSketchOverlay();

const { default: runFullPageStitch } = await import("./smoke/sections/full-page-stitch.mjs");
await runFullPageStitch();

const { default: runWindowPlacement } = await import("./smoke/sections/window-placement.mjs");
await runWindowPlacement();

const { default: runTwoFlows } = await import("./smoke/sections/two-flows.mjs");
await runTwoFlows();

const { default: runServerHost } = await import("./smoke/sections/server-host.mjs");
await runServerHost();

const { default: runPackaging } = await import("./smoke/sections/packaging.mjs");
await runPackaging();

const { default: runDevSourceWatch } = await import("./smoke/sections/dev-source-watch.mjs");
await runDevSourceWatch();

const { default: runDevEnv } = await import("./smoke/sections/dev-env.mjs");
await runDevEnv();

const { default: runViewerAndMenu } = await import("./smoke/sections/70-viewer-and-menu.mjs");
await runViewerAndMenu();

const { default: runMemolab } = await import("./smoke/sections/memolab.mjs");
await runMemolab();

const { default: runEmulator } = await import("./smoke/sections/emulator.mjs");
await runEmulator();

const { default: runRedBlocks } = await import("./smoke/sections/80-red-blocks.mjs");
await runRedBlocks();

process.exit(summary());
