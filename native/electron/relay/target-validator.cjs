const TARGETLESS_COMMANDS = new Set(["download.state", "download.configure", "native.window", "native.windowClick",
  "native.windowKey", "qa.anchor", "img.render", "img.stitch", "img.diff", "img.same"]);
// 탭의 세대 비교를 하지 않는 명령 · 페이지를 건드리지 않거나(result.redact) 현재 세대를 읽는 것(cdp.sync)이라
// 명령 도중 탐색으로 세대가 바뀌어도 응답을 내거나 다시 맞출 수 있어야 함
const GENERATION_EXEMPT_COMMANDS = new Set(["result.redact", "cdp.sync"]);
const CDP_REQUIRED_COMMANDS = new Set([
  "cdp.send", "cdp.batch", "cdp.frames", "cdp.reset", "cdp.subscribe", "cdp.unsubscribe", "ax.tree",
  "viewport.apply", "viewport.setTemporary", "viewport.restore", "viewport.ensureReady", "viewport.qa",
  "dialog.answer", "qa.mode",
]);

function createTargetValidator({ webContents, targetState, currentUrl, pendingUrl, blockedUrl, codedError }) {
  const fail = (message) => { throw codedError("STALE_TARGET", message); };

  function liveGuest(target) {
    const wcId = Number(target && target.wcId);
    if (!Number.isSafeInteger(wcId) || wcId <= 0) fail("대상 webContents 식별자가 올바르지 않습니다.");
    let wc = null;
    try { wc = webContents.fromId(wcId); } catch {}
    if (!wc || wc.isDestroyed?.()) fail("대상 webContents가 없습니다.");
    let type = "";
    try { type = String(wc.getType?.() || ""); } catch {}
    const guest = !!wc.hostWebContents && (!type || type === "webview");
    const sitePopup = type === "window" && targetState.isRegistered?.(wcId) === true;
    if (!guest && !sitePopup) fail("앱 셸 webContents는 중계 대상으로 쓸 수 없습니다.");
    return wc;
  }

  function validate(command, target) {
    if (TARGETLESS_COMMANDS.has(command)) return null;
    const wc = liveGuest(target);
    const wcId = wc.id;
    let current = "", pending = "";
    try { current = String(currentUrl(wcId) || ""); } catch {}
    try { pending = String(pendingUrl(wcId) || ""); } catch {}
    if (CDP_REQUIRED_COMMANDS.has(command)
      && ((current && blockedUrl(current)) || (pending && blockedUrl(pending)))) {
      fail("현재 URL 또는 진행 중인 탐색 URL에서는 Electron 중계를 실행할 수 없습니다.");
    }
    if (GENERATION_EXEMPT_COMMANDS.has(command)) return wc;
    const actual = targetState.generations(wcId) || {};
    if (target.documentGeneration !== actual.documentGeneration
      || target.debuggerGeneration !== actual.debuggerGeneration) {
      fail("대상의 문서 또는 debugger 세대가 바뀌었습니다.");
    }
    const child = target.childSessionId;
    if (child != null && !targetState.ownsChildSession(wcId, child)) {
      fail("자식 CDP 세션이 이 탭과 현재 debugger 세대에 속하지 않습니다.");
    }
    return wc;
  }

  return { validate, liveGuest, targetless: (command) => TARGETLESS_COMMANDS.has(command) };
}

module.exports = { createTargetValidator };
