// 메인이 executor 등록 때 알리는 기능 이름 · 기본 명령을 탭 대기열의 한 단위로 실행
export const COMMAND_UNIT_FEATURE = "worker-command-unit";
// 입력 처리기가 쓰는 기본 명령(ref.resolve · cdp.detachIdle · focus.state 의 paint)을 가진 메인
export const INPUT_COMMANDS_FEATURE = "worker-input-commands";
// 페이지·읽기·캡처 처리기가 쓰는 기본 명령(cdp.gate · cdp.sync · wc.navHistory · cdp.screencastShot · img.stitch · img.diff · img.same)을 가진 메인
export const PAGE_COMMANDS_FEATURE = "worker-page-commands";
// 네이티브 처리기가 쓰는 메인 동작(단위 표시 outside · download.configure 의 폴더 오류 code · login.fill 의 needUser 붙임 해제)을 가진 메인
export const NATIVE_COMMANDS_FEATURE = "worker-native-commands";
// QA 입력·로그인·화면 크기·QA 모드 처리기가 쓰는 메인 동작(login.accounts·login.input 의 qa 방식 · 구독 scoped · 단위가 닫힐 때 포커스 반환 · QA 탭의 viewport.ensureReady)을 가진 메인
export const QA_INPUT_COMMANDS_FEATURE = "worker-qa-input-commands";
// QA 확인·캡처·관찰·반응 처리기가 쓰는 메인 동작(obs.pending · obs.since · scoped 가 아닌 구독이 CDP 부착을 유지)을 가진 메인
export const QA_OBSERVE_COMMANDS_FEATURE = "worker-qa-observe-commands";
// snapshot 이 쓰는 접근성 트리 축소 기본 명령(ax.tree)을 가진 메인 · 없으면 snapshot 이 cdp.send 로 전체 트리를 받음
export const AX_TREE_FEATURE = "worker-ax-tree";

export const INTERNAL_RELAY_COMMANDS = new Set([
  "cdp.send", "cdp.batch", "cdp.frames", "cdp.reset", "cdp.subscribe", "cdp.unsubscribe",
  "wc.info", "wc.nav", "wc.exec", "wc.input", "wc.capture", "wc.captureToFile", "wc.pdf", "wc.pdfToFile",
  "tab.state", "hold.capture", "focus.state", "focus.prepare", "focus.return", "ai.enter", "ai.leave",
  "viewport.get", "viewport.apply", "viewport.setTemporary", "viewport.restore", "obs.read", "obs.drain", "obs.clear",
  "dialog.state", "dialog.answer", "dialog.plan", "upload.arm", "download.state", "download.configure",
  "login.accounts", "login.fill", "login.input", "native.click", "native.key", "native.drag", "native.window",
  "native.windowClick", "native.windowKey", "qa.mode", "qa.anchor", "viewport.ensureReady", "viewport.qa",
  "img.render", "contextaction", "cdp.attach", "ref.record", "ref.resolve", "cdp.detachIdle", "result.redact",
  "cdp.gate", "cdp.sync", "wc.navHistory", "cdp.screencastShot", "img.stitch", "img.diff", "img.same",
  "obs.pending", "obs.since", "ax.tree",
]);

export const INTERNAL_HOST_API_COMMANDS = new Set([
  "browser.sessionView", "browser.targetGet", "browser.targetSet", "browser.targetClear", "browser.commandGuard",
  "browser.commandTargetState", "browser.resolveForCommand",
  "browser.tabCreate", "browser.tabWake", "browser.tabClose", "browser.status", "browser.promptTargetsActivate",
  "browser.pickRecord", "browser.pickList", "browser.executeWithDialog", "browser.dialogState", "browser.dialogAnswer",
  "browser.legacyHostTask",
  "qa.anchorUpdate", "qa.claimIfFree", "qa.releaseIfOwner", "qa.owner", "qa.tabCreate", "qa.tabsRestore",
  "qa.tabClose", "qa.tabsPublish", "qa.deviceAuthorize", "qa.askUser", "qa.reportOpen",
  "app.targetsGet", "app.targetsAll", "app.targetsSet", "app.command", "journal.sessionCommand", "journal.accept",
  "journal.complete", "journal.release", "journal.trace", "journal.recordFrame", "journal.surfaces", "lease.grant", "lease.check",
  "lease.revoke", "user.ask", "user.notify", "user.progress",
]);
