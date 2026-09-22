// Iris 서버와 Electron CDP 실행기 사이의 WebSocket 전송·재연결을 관리한다.
//
// 소유 범위
//   현재 실행기 socket, 연결 전 outbound 보류 큐, heartbeat 감시와 재연결 backoff.
//
// 제공 API
//   createCdpTransport(ctx)가 ctlSend·setupCdpControl 함수만 준다. socket·queue 원시 상태는 내주지 않는다.
//
// 의존 대상
//   조립부가 주입하는 WebSocket 생성자·port·cdpExec·오류 생성기·process/timer/log 포트.
//   cdp-control.cjs를 require하지 않고 서버가 보낸 명령은 주입된 cdpExec으로만 실행한다.
//
// 유지 조건
//   연결 전 메시지는 open 뒤 등록 다음에 보내고, close/error/heartbeat 침묵 뒤에는 다시 붙는다.
//   실행기 거절은 한국어 진단을 남기고 socket을 닫아 빈 자리를 다시 얻을 수 있게 한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 WebSocket/port/cdpExec/error/process 조립과 server의 executor register 계약이다.
//   양방향 소비자는 cdp-control.cjs facade ctlSend/setup, popup/frame/dialog 등록과 CLI/MCP 명령 결과 전송이다.
//
// 현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/cdp-transport.cjs

function createCdpTransport({
  WebSocket,
  port,
  cdpExec,
  codedError,
  tabGoneCode,
  execPath,
  pid,
  now = Date.now,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  log = console.log,
  error = console.error,
}) {
  // main이 서버(기본 4271, IRIS_PORT로 갈림)에 WS 실행기로 붙어 cdp-exec를 처리한다. 서버 재시작에도 자동 재연결.
  // 팝업 창처럼 렌더러가 모르는 조종 대상은 여기서 서버에 알린다. 연결이 끊겨 있으면 붙은 뒤에 보낸다.
  // 앱이 먼저 뜨고 서버가 늦게 올라오는 순서에서도 등록이 누락되지 않게 하기 위해서다.
  let ctlWs = null;
  const ctlPending = [];
  function ctlSend(msg) {
    if (ctlWs && ctlWs.readyState === 1) { try { ctlWs.send(JSON.stringify(msg)); return; } catch {} }
    ctlPending.push(msg);
    if (ctlPending.length > 50) ctlPending.shift();
  }
  function setupCdpControl(webContentsMod) {
    let retry = 0;
    const connect = () => {
      // 소켓은 지역 변수로 잡는다. 바깥 `ws` 하나를 돌려쓰면 close 핸들러가 그 변수를 null로
      // 지운 뒤 error 핸들러가 죽은 참조를 만지고, 재연결로 새 소켓이 들어온 뒤에는 옛 소켓의
      // 핸들러가 새 소켓을 건드린다. 그 상태에서 서버만 다시 띄우면 제어가 돌아오지 않았다(확인 결과).
      let sock;
      // UI가 붙는 포트와 실행기가 붙는 포트는 같아야 한다. 여기만 4271로 박혀 있으면 개발
      // 인스턴스가 자기 UI는 자기 포트로 띄우면서 실행기는 설치된 앱의 포트에 가서 붙는다.
      try { sock = new WebSocket("ws://127.0.0.1:" + port); } catch { setTimeoutFn(connect, 1500); return; }
      let done = false;
      // 이 소켓이 응답 없이 끊기면 close가 오지 않는다. 그러면 서버는 죽은 실행기를 붙들고 있고
      // 모든 브라우저 명령이 30초씩 대기한다. 서버가 10초마다 보내는 hb가 끊기면 우리가 먼저 끊는다.
      let lastMsg = now(), watch = null;
      const again = (why) => {
        if (done) return; done = true;
        log("[cdp] 실행기 소켓 끊김 — 재연결 예약", why || "");
        clearIntervalFn(watch);
        if (ctlWs === sock) ctlWs = null;
        setTimeoutFn(connect, Math.min(1000 * ++retry, 5000));
      };
      watch = setIntervalFn(() => {
        if (sock.readyState !== 1) return;
        if (now() - lastMsg > 25000) { log("[cdp] 실행기 소켓 무응답 25s — 끊고 재연결"); try { sock.terminate(); } catch {} }
      }, 5000);
      if (watch.unref) watch.unref();
      sock.on("open", () => {
        log("[cdp] 실행기 소켓 연결됨");
        retry = 0; ctlWs = sock; lastMsg = now();
        // 누가 붙었는지 남긴다. 중복이 생겼을 때 어느 쪽인지 알아야 고칠 수 있다.
        try { sock.send(JSON.stringify({ type: "cdp-executor-register",
          app: execPath, pid })); } catch {}
        while (ctlPending.length) { const m = ctlPending.shift(); try { sock.send(JSON.stringify(m)); } catch { break; } }
      });
      sock.on("message", async (data) => {
        lastMsg = now();
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.type === "cdp-executor-refused") {
          // 이 포트는 이미 다른 앱 것이다. 조용히 물러나면 "떠 있는데 아무것도 안 되는" 상태가 되므로
          // 무엇이 붙어 있고 무엇을 해야 하는지 남긴다.
          error("[cdp] 실행기 자리를 얻지 못했습니다 — 이 포트에는 이미 다른 앱이 붙어 있습니다.\n"
            + `      먼저 붙은 것: ${(m.holder && m.holder.app) || "?"} (pid ${(m.holder && m.holder.pid) || "?"})\n`
            + `      나: ${execPath} (pid ${pid})\n`
            + "      개발 인스턴스라면 자기 포트로 도세요 — pnpm dev (IRIS_PORT로 서버·앱을 함께 가릅니다).");
          // 거절당한 채로 소켓을 붙들고 있으면, 먼저 붙은 쪽이 나중에 죽어 자리가 비어도 이쪽은
          // 재연결하지 않아 영영 아무것도 못 한다. 끊어서 재연결 사다리에 다시 태운다.
          try { sock.close(); } catch {}
          return;
        }
        if (m.type !== "cdp-exec") return;
        try {
          if (!m.wc) throw codedError(tabGoneCode, "활성 브라우저 탭이 없습니다 — 브라우저를 먼저 여세요.");
          const result = await cdpExec(webContentsMod, m.wc, m.cmd, m.args);
          sock.send(JSON.stringify({ type: "cdp-result", id: m.id, ok: true, data: result }));
        } catch (e) {
          try { sock.send(JSON.stringify({ type: "cdp-result", id: m.id, ok: false,
            error: String((e && e.message) || e), code: e && e.code })); } catch {}
        }
      });
      sock.on("close", again);
      sock.on("error", () => { try { sock.close(); } catch {} again(); });
    };
    connect();
  }

  return { ctlSend, setupCdpControl };
}

module.exports = { createCdpTransport };
