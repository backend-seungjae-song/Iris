// 페이지 이동·대기·크기 조회 명령 handler.
//
// 소유 범위
//   goto·wait·back·forward·reload·viewport·url 명령의 조건·타이밍·응답 문구.
//
// 제공 API
//   createPageCommands(ctx)가 명령 이름별 async handler 표를 준다. 모듈 상태나 원시 컨테이너는 내주지 않는다.
//
// 의존 대상
//   호출자가 주입하는 applyViewport 행동과 명령마다 넘기는 CDP send·Electron webContents.
//   Electron이나 cdp-control.cjs를 직접 require하지 않는다.
//
// 유지 조건
//   URL scheme 판정, readyState 150ms polling·10초 상한, 고정 wait와 history의 한국어 사유를 보존한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 handler 조립과 cdp-device-emulation의 apply 행동이다. 양방향 소비자는
//   cdp-control.cjs dispatcher·default 안내, CLI/MCP의 page 명령과 viewport UI 상태다.

function createPageCommands({ applyViewport }) {
  // 히스토리 이동. Electron 43 navigationHistory 우선, 구 API fallback.
  async function moveHistory(wc, cmd) {
    const nh = wc.navigationHistory;
    const can = cmd === "back" ? (nh?.canGoBack?.() ?? wc.canGoBack?.()) : (nh?.canGoForward?.() ?? wc.canGoForward?.());
    if (!can) return { ok: false, error: (cmd === "back" ? "뒤로" : "앞으로") + " 갈 기록이 없습니다." };
    if (cmd === "back") { nh?.goBack ? nh.goBack() : wc.goBack(); } else { nh?.goForward ? nh.goForward() : wc.goForward(); }
    return { ok: true, url: wc.getURL() };
  }

  return {
    async goto(_send, wc, args) {
      const url = args.url; if (!url) throw new Error("url 필요");
      // 스킴 판별: http(s)/data/about/blob/file 등 알려진 스킴(// 없어도)이나 임의 scheme://는 그대로,
      // 그 외("google.com"·"localhost:4271")는 https:// 를 붙인다.
      // 스킴 판별: http(s)/data/about/blob/file 등 알려진 스킴(// 없어도)이나 임의 scheme://는 그대로,
      // 그 외("google.com"·"localhost:4271")는 https:// 를 붙인다. (data:/about: 를 https로 오인하던 버그 수정)
      const hasScheme = /^(https?|data|about|blob|file):/i.test(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
      await wc.loadURL(hasScheme ? url : "https://" + url);
      return { ok: true, url: wc.getURL() };
    },
    async wait(send, _wc, args) {
      // 로드 완료 대기: readyState==='complete' 폴링(기본 최대 10s). wait <ms>=고정 대기.
      if (args.ms != null) { await new Promise((res) => setTimeout(res, Math.max(0, Number(args.ms)))); return { ok: true, waited_ms: Number(args.ms) }; }
      const timeout = 10000, start = Date.now(); // Date.now: 런타임 코드(워크플로우 스크립트 아님)라 허용
      for (;;) {
        const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
        if (r.result && r.result.value === "complete") return { ok: true, readyState: "complete", waited_ms: Date.now() - start };
        if (Date.now() - start >= timeout) return { ok: true, readyState: String(r.result && r.result.value), waited_ms: timeout, note: "timeout" };
        await new Promise((res) => setTimeout(res, 150));
      }
    },
    async back(_send, wc) {
      return await moveHistory(wc, "back");
    },
    async forward(_send, wc) {
      return await moveHistory(wc, "forward");
    },
    async reload(_send, wc) {
      wc.reload(); return { ok: true, url: wc.getURL() };
    },
    // 탭 화면 크기 지정. 주소줄의 크기 버튼과 같은 동작이다(반응형 확인).
    async viewport(_send, wc, args) {
      return await applyViewport(wc, args);
    },
    async url(_send, wc) {
      return { url: wc.getURL(), title: wc.getTitle() };
    },
  };
}

module.exports = { createPageCommands };
