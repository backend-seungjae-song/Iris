// 배경 탭의 대체 viewport와 문서 focus emulation 상태 소유 모듈.
//
// 소유 범위
//   탭·페이지 세대별 focus emulation 표식, 자동으로 넣은 viewport, 최근 보이는 실제 viewport,
//   viewport 확인 시각과 화면이 필요한 명령 분류.
//
// 제공 API
//   createHiddenViewport(...)가 pin·clearAutoViewport·ensureReady·setDefaultViewport와
//   resetSession·yieldToExplicitViewport·forget 명령을 준다. 원시 Map·Set이나 viewport 참조는 내주지 않는다.
//
// 의존 대상
//   호출자가 주입하는 CDP send, visibility·명시적 device·navigation epoch 조회, now와 disable 조회.
//   Electron debugger나 webContents를 직접 잡지 않는다.
//
// 유지 조건
//   어느 탭이 보이는지 모르면 metrics를 걸지 않고, 사람이 보고 있거나 명시적 기기 크기를 정한 탭은
//   덮지 않는다. 자동 metrics 표식을 먼저 세우고, 해제 요청은 표식 유무와 관계없이 clear 명령을 보낸다.
//
// 영향 범위
//   공급자는 main.cjs visibility registry·tab-shown viewport와 cdp-control.cjs의 navigation/session send,
//   양방향 소비자는 session reset/destroy, 명령 준비, capture·input, cdp-device-emulation의 명시적
//   viewport 적용·해제다. 판정은 배경 탭 반응형 layout과 사람이 보고 있는 탭의 실제 화면에도 영향을 준다.

const VP_FALLBACK = { width: 1280, height: 800 };

// 화면과 무관한 조회 명령까지 붙잡아 둘 필요는 없다. 실제로 페이지를 만지는 것들만.
const NEEDS_VIEW = new Set(["click", "dblclick", "hover", "fill", "type", "key", "select", "focus", "clear", "check", "scroll", "scrollto",
  "screenshot", "observe", "snapshot", "expect", "diff", "a11y", "shotsizes", "login", "upload"]);

// 사람이 다른 탭을 보고 있으면 그 탭의 webview는 display:none이라 문서가 포커스를 잃고 viewport도
// 0×0이 된다. DOM.focus만으로는 document.hasFocus()가 거짓인 탭의 insertText를 살리지 못하므로
// 문서 세대별 focus emulation이 필요하다. viewport도 0×0인 채 두면 폭으로 기기를 가르는 사이트가
// 배경 탭을 폰으로 보고 모바일 결제나 전용 주소로 보낸다. 크롬의 배경 탭은 기존 크기를 유지한다.
//
// 두 보정의 수명은 다르다. focus는 debugger session과 navigation에 묶이고, 자동 viewport는 탭이
// 다시 보이거나 사람이 명시적 크기를 정할 때까지 남는다. 그래서 resetSession은 focus와 확인 시각만
// 지우고, clearAutoViewport·yieldToExplicitViewport·forget이 각자 자기 전이에 맞춰 metrics 장부를
// 걷는다. 한 함수로 합치면 재부착 때 배경 탭 크기가 풀리거나 화면 전환 때 focus 세대가 남는다.
//
// visibility가 unknown인 동안은 "안 보인다"고 추측하지 않는다. 시작 직후 보이는 탭 보고가 오기 전에
// metrics를 걸면 사용자가 실제로 보고 있는 탭이 대체 크기로 굳는다. 반대로 명령 준비에서 0×0을 직접
// 확인한 뒤의 보정은 그 명령에 필요한 화면을 만드는 경로라 visibility 보고와 독립적으로 유지한다.

function createHiddenViewport({
  isTabShown,
  shownStateKnown,
  hasExplicitDevice,
  navigationEpoch,
  now,
  isDisabled,
}) {
  const focusEmulated = new Set();
  const autoViewport = new Map();
  let lastSeenViewport = null;
  const vpChecked = new Map();

  function setDefaultViewport(width, height) {
    lastSeenViewport = { width: Math.round(width), height: Math.round(height) };
  }

  function clearFocusEmulation(wcId) {
    for (const key of focusEmulated) {
      if (key.startsWith(wcId + ":")) focusEmulated.delete(key);
    }
  }

  // 화면에 안 올라온 탭에 사람이 보고 있는 창 크기를 물려준다. 탭이 만들어지는 순간에는 그릴
  // 표면이 없어 호출자가 부르지 않고, did-attach-webview와 화면에서 내려가는 순간에만 부른다.
  // 표시를 먼저 남긴다. 응답 전에 탭이 화면에 올라와도 clear 쪽이 걸린 값을 볼 수 있어야 한다.
  function applyPin(id, send, want) {
    autoViewport.set(id, want);
    send("Emulation.setDeviceMetricsOverride",
      { width: want.width, height: want.height, deviceScaleFactor: 0, mobile: false })
      .catch(() => { if (autoViewport.get(id) === want) autoViewport.delete(id); });
  }

  function pin(wcId, send, opts) {
    const id = Number(wcId);
    try {
      if (isDisabled()) return false;
      if (!shownStateKnown()) return false;
      if (isTabShown(id) || hasExplicitDevice(id)) return false;
      const want = autoViewport.get(id) || lastSeenViewport || VP_FALLBACK;
      // 방금 붙은 게스트는 브라우저 탭이 아닐 수 있다. 장부는 탭만 알아서 그 밖의 webview 는
      // 늘 안 보이는 탭으로 읽히고, 탭이 아니어서 다시 보이는 순간이 오지 않으므로 한 번 적용된
      // 크기를 되돌릴 방법이 없다. 확인 결과: rail 「서버」 화면이 담는 대시보드 webview 가
      // 브라우저 탭 크기 843×857 로 고정돼, 표시 폭 699 와 어긋난 채 왼쪽이 크게 비고
      // 오른쪽이 잘려 보였다. IRIS_NO_HIDDEN_VP=1 로 이 보정을 끄면 699×801 로 맞았다.
      // 이 보정이 실제로 다루는 것은 그릴 표면이 없어 0 이 된 게스트다. 그것만 본다.
      if (opts && opts.onlyIfCollapsed) {
        send("Runtime.evaluate", { expression: "[innerWidth,innerHeight]", returnByValue: true })
          .then((result) => {
            const value = result && result.result && result.result.value;
            const width = Array.isArray(value) ? Number(value[0]) : 0;
            const height = Array.isArray(value) ? Number(value[1]) : 0;
            if (width > 0 && height > 0) return;   // 그릴 표면이 있다. 남의 크기를 덮어쓰지 않는다
            applyPin(id, send, want);
          })
          // 측정하지 못하면 기본값을 적용한다. 배경 탭이 자기를 폰으로 인식하는 쪽의 비용이 더 크다.
          .catch(() => applyPin(id, send, want));
        return true;
      }
      applyPin(id, send, want);
      return true;
    } catch {
      return false;
    }
  }

  // 표식이 없어도 한 번 해제한다. 적용 응답보다 화면 전환이 먼저 오면, 표식만 보고 건너뛴 해제가
  // 사용자 탭을 대체 크기로 고정시킨다.
  function clearAutoViewport(wcId, send) {
    const id = Number(wcId);
    const had = autoViewport.has(id);
    autoViewport.delete(id);
    vpChecked.delete(id);
    try { send("Emulation.clearDeviceMetricsOverride").catch(() => {}); } catch {}
    return had;
  }

  // 사람이 직접 정한 device metrics가 바로 같은 CDP 상태를 덮으므로 별도 clear를 먼저 보내지 않는다.
  function yieldToExplicitViewport(wcId) {
    const id = Number(wcId);
    autoViewport.delete(id);
    vpChecked.delete(id);
  }

  async function ensureReady(send, wcId, cmd) {
    const id = Number(wcId);
    if (!NEEDS_VIEW.has(cmd)) return;
    // 페이지 세대까지 열쇠에 넣는다. navigation 뒤에는 focus emulation도 새 문서에 다시 걸어야 한다.
    const focusKey = id + ":" + navigationEpoch(id);
    if (!focusEmulated.has(focusKey)) {
      focusEmulated.add(focusKey);
      await send("Emulation.setFocusEmulationEnabled", { enabled: true })
        .catch(() => { focusEmulated.delete(focusKey); });
    }
    if (hasExplicitDevice(id) && !autoViewport.has(id)) return;
    const at = now();
    if (at - (vpChecked.get(id) || 0) < 1000) return;
    vpChecked.set(id, at);
    let size = null;
    try {
      const result = await send("Runtime.evaluate", {
        expression: "[innerWidth,innerHeight]", returnByValue: true,
      });
      const value = result && result.result && result.result.value;
      if (Array.isArray(value)) size = { width: Number(value[0]) || 0, height: Number(value[1]) || 0 };
    } catch {}
    if (!size) return;
    if (size.width > 0 && size.height > 0) {
      // 사람이 정한 모바일 viewport를 다음 배경 탭의 기본 크기로 물려주지 않는다.
      if (!autoViewport.has(id) && !hasExplicitDevice(id)) {
        lastSeenViewport = { width: size.width, height: size.height };
      }
      return;
    }
    const want = autoViewport.get(id) || lastSeenViewport || VP_FALLBACK;
    try {
      await send("Emulation.setDeviceMetricsOverride",
        { width: want.width, height: want.height, deviceScaleFactor: 0, mobile: false });
      autoViewport.set(id, want);
    } catch {}
  }

  // debugger session을 다시 붙이면 focus emulation은 사라지고 viewport 확인도 다시 해야 한다.
  function resetSession(wcId) {
    clearFocusEmulation(Number(wcId));
    vpChecked.delete(Number(wcId));
  }

  function forget(wcId) {
    const id = Number(wcId);
    clearFocusEmulation(id);
    autoViewport.delete(id);
    vpChecked.delete(id);
  }

  return { pin, clearAutoViewport, ensureReady, setDefaultViewport,
    resetSession, yieldToExplicitViewport, forget };
}

module.exports = { createHiddenViewport };
