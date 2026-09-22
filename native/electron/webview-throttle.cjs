// webview·팝업의 보호 사유를 합산하는 Chromium throttling 상태 소유자.
//
// 소유 범위
//   webContents별 보호 사유, host renderer별 webview·탭 보고, popup tabId별 webContents 관계.
//
// 제공 API
//   createWebviewThrottle(...)이 setReason·clearContents·reportRenderer·clearRendererReport와
//   registerPopup·unregisterPopup·reconcilePopups 명령을 제공한다. 원시 Map·Set은 제공하지 않는다.
//
// 의존 대상
//   호출자가 주입하는 webContents ID 조회 함수와 전달하는 host/guest/popup webContents 객체,
//   그리고 ready 전에 확정된 rollback 설정. Electron 모듈을 직접 잡지 않는다.
//
// 유지 조건
//   같은 사유는 한 번만 남고 서로 다른 마지막 보호 사유가 사라질 때만 기본 throttling을 허용한다.
//   renderer의 authoritative AI 상태가 없거나 unknown이면 popup은 fail-safe로 계속 보호한다.
//
// 영향 범위
//   공급자는 main.cjs의 trusted renderer IPC·webContents 조회·IRIS_NO_THROTTLE_OPT이고, 양방향
//   소비자는 main.cjs capture/visible adapter와 다음 webview-lifecycle의 popup 생성·파기다.
//   판정은 Chromium 창 단위 프레임 생성, 배경 AI 탭·녹화·미디어·popup 자동화까지 번진다.

function createWebviewThrottle({ noThrottleOpt = false, fromId = () => null } = {}) {
  const throttleReasonsByWc = new Map();
  const rendererThrottleReports = new Map();
  const popupThrottleTabs = new Map();

  function setReason(contents, reason, on) {
    try {
      if (!contents || contents.isDestroyed()) return;
      if (noThrottleOpt) { contents.setBackgroundThrottling(false); return; }
      let reasons = throttleReasonsByWc.get(contents.id);
      if (on) {
        if (!reasons) { reasons = new Set(); throttleReasonsByWc.set(contents.id, reasons); }
        reasons.add(reason);
      } else if (reasons) {
        reasons.delete(reason);
        if (!reasons.size) { throttleReasonsByWc.delete(contents.id); reasons = null; }
      }
      contents.setBackgroundThrottling(!(reasons && reasons.size));
    } catch {}
  }

  function clearContents(contents) {
    try { if (contents) throttleReasonsByWc.delete(contents.id); } catch {}
  }

  function protectedPopupTabIds() {
    const ids = new Set();
    let unknownAi = rendererThrottleReports.size === 0;
    for (const report of rendererThrottleReports.values()) {
      if (report.unknownAi) unknownAi = true;
      for (const id of report.tabs) ids.add(id);
    }
    return { ids, unknownAi };
  }

  function reconcilePopups() {
    const { ids, unknownAi } = protectedPopupTabIds();
    for (const [tabId, contents] of [...popupThrottleTabs]) {
      if (!contents || contents.isDestroyed()) { popupThrottleTabs.delete(tabId); continue; }
      setReason(contents, "renderer-automation", unknownAi || ids.has(tabId));
    }
  }

  function clearRendererReport(hostId) {
    const previous = rendererThrottleReports.get(hostId);
    if (!previous) return;
    for (const wcId of previous.wcs) {
      const guest = fromId(wcId);
      if (guest && !guest.isDestroyed()) setReason(guest, "renderer:" + hostId, false);
    }
    rendererThrottleReports.delete(hostId);
    reconcilePopups();
  }

  function reportRenderer(sender, payload) {
    const hostId = sender.id;
    const nextWcs = new Set();
    const nextTabs = new Set();
    const rows = Array.isArray(payload && payload.webviews) ? payload.webviews.slice(0, 500) : [];
    for (const row of rows) {
      const wcId = Number(row && row.wc);
      const guest = fromId(wcId);
      if (!guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== sender) continue;
      nextWcs.add(wcId);
      if (row.tabId && row.protected) nextTabs.add(String(row.tabId));
      setReason(guest, "renderer:" + hostId, !!row.protected);
    }
    for (const id of (Array.isArray(payload && payload.protectedTabIds) ? payload.protectedTabIds.slice(0, 1000) : [])) {
      if (id) nextTabs.add(String(id));
    }
    const previous = rendererThrottleReports.get(hostId);
    if (previous) {
      for (const wcId of previous.wcs) {
        if (nextWcs.has(wcId)) continue;
        const guest = fromId(wcId);
        if (guest && !guest.isDestroyed()) setReason(guest, "renderer:" + hostId, false);
      }
    } else {
      try { sender.once("destroyed", () => clearRendererReport(hostId)); } catch {}
    }
    rendererThrottleReports.set(hostId, {
      wcs: nextWcs,
      tabs: nextTabs,
      unknownAi: !!(payload && payload.unknownAi),
    });
    reconcilePopups();
  }

  function registerPopup(tabId, contents) {
    popupThrottleTabs.set(tabId, contents);
  }

  function unregisterPopup(tabId) {
    popupThrottleTabs.delete(tabId);
  }

  return {
    setReason,
    clearContents,
    reportRenderer,
    clearRendererReport,
    registerPopup,
    unregisterPopup,
    reconcilePopups,
  };
}

module.exports = { createWebviewThrottle };
