// 켜 둔 capability 만 로드한다.
//
// 소유 범위
//   켜진 항목의 동적 로드와 setup 순서, 그리고 하나가 실패했을 때의 정리.
//
// 제공 API
//   bootCapabilities({ items, isOn, ctx, onPanel, onScreen, onWs, onError }): 로드한 id 목록을 반환한다.
//
// 의존 대상
//   표도 on/off 판정도 인자로 받는다. DOM 도 localStorage 도 보지 않으므로 Node 에서 그대로
//   호출되고, 검사가 가짜 표로 이 함수를 직접 실행한다.
//
// 유지 조건
//   하나가 실패해도 나머지는 로드한다. 한 기능의 오타가 앱 전체를 못 뜨게 만들면, 끄고 켜는
//   장치가 오히려 앱의 가용성을 떨어뜨린다.
//   끈 항목은 load 를 호출하지 않는다. 로드한 뒤 감추면 이 파일이 하는 일이 없다.
//   서버 메시지 처리기도 각 기능이 자기 것을 등록한다. main 이 표로 들고 있으면 그 기능을 꺼도
//   그 줄이 남아, 처리기가 참조하는 모듈이 함께 로드된다.
//   실패는 삼키지 않고 onError 로 전달해 사용자가 볼 수 있게 한다. 조용히 없는 기능이 되면
//   뜨지 않는 원인을 추적할 수 없다. 등록 callback과 initCapability가 반환한 dispose는 실패 시
//   역순으로 실행한다.
//   영역(panelHtml)은 연결보다 먼저 붙인다. init 에서 자기 영역을 찾는 기능이 있어, 순서가
//   뒤집히면 그 기능만 대상 없이 연결된다.
//
// 영향 범위
//   core/capabilities.js 의 표, devtool/rail.js 의 화면 등록, main.js 의 부팅 순서.
//   현재 목록 확인: node bin/importers.mjs web/js/core/capability-boot.js

async function dispose(value) {
  if (typeof value === "function") await value();
  else if (value && typeof value.dispose === "function") await value.dispose();
}

function report(onError, id, error) {
  if (typeof onError === "function") onError(id, error);
}

export async function bootCapabilities({ items, isOn, ctx, onPanel, onScreen, onWs, onError } = {}) {
  const list = Array.isArray(items) ? items : [];
  const on = typeof isOn === "function" ? isOn : () => true;
  const loaded = [];
  const candidates = [];
  for (const cap of list) {
    if (!cap || !cap.id) continue;
    try {
      if (on(cap.id)) candidates.push(cap);        // 끈 항목은 load 를 호출하지 않는다
    } catch (error) {
      report(onError, cap.id, error);
    }
  }

  // import가 느린 기능 하나가 뒤의 기능 전체를 기다리게 하지 않는다. 초기화 자체는 표 순서를
  // 유지해 기능 사이의 기존 연결 순서를 바꾸지 않는다.
  const imports = await Promise.all(candidates.map(async (cap) => {
    try {
      return { cap, mod: await cap.load() };
    } catch (error) {
      return { cap, error };
    }
  }));

  for (const { cap, mod, error: importError } of imports) {
    if (importError) {
      report(onError, cap.id, importError);
      continue;
    }
    const cleanups = [];
    let out = null;
    try {
      if (!mod || typeof mod !== "object") throw new Error(`${cap.id}: capability 모듈이 객체를 반환하지 않았다`);
      // 영역을 먼저 붙인다. rail 이 없는데 영역을 반환하면 열 수 있는 진입점이 없으므로 막는다.
      if (mod.panelHtml && !cap.rail) throw new Error(`${cap.id}: rail 이 없는데 panelHtml 을 반환했다`);
      if (mod.panelHtml && onPanel) {
        const cleanup = onPanel(cap.rail, mod.panelHtml);
        if (cleanup === false) throw new Error(`${cap.id}: panel 등록에 실패했다`);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      // 연결은 각 기능이 담당한다. 표에 적지 않는 것이 원칙이고, setup 은 남겨 둔 예외 경로다.
      const wire = typeof mod.initCapability === "function" ? () => mod.initCapability(ctx || {})
        : (cap.setup ? () => cap.setup(mod, ctx || {}) : null);
      out = (wire ? await wire() : null) || {};
      // rail 이 없는 항목이 화면을 반환하면 그 화면에는 진입점이 없다. 등록해도 열 수 없으므로
      // 표가 잘못 적힌 것으로 보고 그 기능만 실패로 처리한다.
      if (out.screen && !cap.rail) throw new Error(`${cap.id}: rail 이 없는데 화면을 돌려준다`);
      if (out.screen && onScreen) {
        const cleanup = onScreen(cap.rail, out.screen);
        if (cleanup === false) throw new Error(`${cap.id}: 화면 등록에 실패했다`);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      if (out.ws && onWs) for (const [type, fn] of Object.entries(out.ws)) {
        const cleanup = onWs(type, fn, cap.id);
        if (cleanup === false) throw new Error(`${cap.id}: WS 중복 등록 ${type}`);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      loaded.push(cap.id);
    } catch (error) {
      try { await dispose(out?.dispose); } catch {}
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup(); } catch {}
      }
      report(onError, cap.id, error);
    }
  }
  return loaded;
}
