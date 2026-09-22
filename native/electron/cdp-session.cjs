// CDP debugger 세션·자식 프레임·대화상자 응답 계획을 한 수명주기로 관리한다.
//
// 소유 범위
//   debugger attach 장부, root/child primer, OOPIF session·frame origin, 탭별 dialog plan.
//
// 제공 API
//   createCdpSession(ctx)가 attach/reset/prime·자식 장부·dialog plan 함수만 준다. 원시 컨테이너는 내주지 않는다.
//
// 의존 대상
//   조립부가 주입하는 observation·hidden viewport·overlay·ref registry·upload/device/transport 포트와
//   Electron webContents.debugger. Electron이나 cdp-control.cjs를 직접 require하지 않는다.
//
// 유지 조건
//   같은 세션은 한 번만 prime하고 재부착 뒤에는 root·child 주입을 다시 건다. dialog queue가 비면
//   사람이 처리하는 null mode로 돌아가며, attach/detach event만 자식 session 장부를 바꾼다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 observation/viewport/overlay/ref/upload/device/transport 조립과 main.cjs primer다.
//   양방향 소비자는 cdp-control.cjs 실행기·frame sender·overlay/진단 API와 webview-lifecycle의 root/child 주입이다.
//
// 현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs native/electron/cdp-session.cjs

function createCdpSession({
  observation,
  hiddenViewport,
  overlay,
  refRegistry,
  upload,
  deviceEmulation,
  ctlSend,
  tagError,
  sessionDetachedCode,
  aiDriving = () => false,
  // 부착 관문. 거짓이면 어떤 경로도 debugger 를 붙이지 못한다(Google 로그인 호스트 등).
  allowAttach = () => true,
  attachBlockedCode = "cdp_blocked",
}) {
  const wired = new Set();   // debugger/webContents 이벤트 수신기를 한 번 건 webContents id

  // 프레임을 타고 내려가는 조회. 페이지의 주요 내용이 iframe 안에 있으면 최상위 document만 조회해서는
  // 사용자가 보고 있는 요소를 찾지 못한다(확인 결과: 본문이 통째로 iframe 인 어드민 화면).
  // 같은 출처 프레임까지만 접근할 수 있고, 교차 출처 프레임은 별도 세션이 필요하다.
  // 순서는 문서를 만난 순서, 즉 화면에 나오는 순서와 같게 둔다.
  const FRAME_UTIL = `(function(){ try {
    if (window.__acFrameUtil) return; window.__acFrameUtil = 1;
    window.__acDocs = function(){
      var out = [], seen = [];
      var walk = function(d){
        if (!d || seen.indexOf(d) >= 0) return; seen.push(d); out.push(d);
        var fs = []; try { fs = d.querySelectorAll("iframe,frame"); } catch (e) { return; }
        for (var i = 0; i < fs.length; i++) {
          var cd = null; try { cd = fs[i].contentDocument; } catch (e) { cd = null; } // 교차 출처면 여기서 막힌다
          if (cd) walk(cd);
        }
      };
      walk(document); return out;
    };
    window.__acQA = function(sel){
      var docs = window.__acDocs(), out = [];
      for (var i = 0; i < docs.length; i++) {
        var n = []; try { n = docs[i].querySelectorAll(sel); } catch (e) { n = []; }
        for (var j = 0; j < n.length; j++) out.push(n[j]);
      }
      return out;
    };
    window.__acQ = function(sel){ var r = window.__acQA(sel); return r.length ? r[0] : null; };
  } catch (e) {} })();`;

  // 대화상자 자동 응답 계획. 기본은 비어 있고, 이때는 사람이 보고 누른다.
  // 재생 스크립트가 `iris-browser dialogs ok,cancel`처럼 무장했을 때만 CDP가 대신 닫는다.
  // 확인 결과(격리 프로브): Page 도메인이 켜져 있어도 네이티브 창은 그대로 뜨고,
  // javascriptDialogOpening 이벤트가 함께 오며 handleJavaScriptDialog로 프로그램에서 닫을 수 있다.
  const dialogPlans = new Map(); // wcId → { queue: string[], mode: "ok"|"cancel"|null, text: string|null }
  // 교차 출처 iframe(OOPIF)은 별도 타깃이라 최상위 세션에서 Runtime.evaluate 해도 그 안이 안 보인다.
  // contentDocument 도 막힌다. 그래서 붙은 자식 세션을 들고 있다가 같은 질문을 각각에 던져 합친다.
  // main.cjs 가 Target.setAutoAttach 를 걸어 두므로 attachedToTarget 이 여기로 온다.
  const childSessions = new Map(); // wcId → Set(sessionId)
  const childObserved = new Map(); // wcId → 명시적 관찰 준비를 마친 child sessionId
  const documentPrimed = new Set(); // wcId → 현재 debugger session의 Page/document 계약 준비 완료
  const observationPrimed = new Set(); // wcId → 현재 debugger session의 Runtime/진단 계약 준비 완료
  // 그 탭이 지금 띄우고 있는 문서들의 origin. 확인창 요청이 사칭인지 판정할 때 서버가 쓴다.
  // 최상위 origin 만 보면 iframe 안에서 뜬 확인창이 통째로 막힌다(확인 결과: 다른 출처의 iframe 안 주문서).
  const frameOrigins = new Map(); // wcId → Set(origin)
  function childrenOf(id) { let s2 = childSessions.get(id); if (!s2) { s2 = new Set(); childSessions.set(id, s2); } return s2; }
  function observedChildrenOf(id) {
    let set = childObserved.get(id);
    if (!set) { set = new Set(); childObserved.set(id, set); }
    return set;
  }
  function primeChildObservation(wcId, sid, dbg) {
    const observed = observedChildrenOf(wcId);
    if (observed.has(sid)) return;
    observed.add(sid);
    // Runtime.evaluate는 Runtime domain event 구독 없이 쓸 수 있다. child Runtime.enable은 콘솔·stack
    // 직렬화 같은 관찰 흔적만 늘리고, Iris는 child Runtime event를 소비하지 않는다.
    for (const domain of ["DOM", "Accessibility"]) {
      dbg.sendCommand(domain + ".enable", {}, sid).catch(() => {});
    }
    dbg.sendCommand("Runtime.evaluate", { expression: FRAME_UTIL }, sid).catch(() => {});
    dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: FRAME_UTIL, runImmediately: true }, sid).catch(() => {});
    const overlaySend = (method, params, targetSid) => targetSid
      ? dbg.sendCommand(method, params, targetSid) : dbg.sendCommand(method, params);
    overlay.injectActive(wcId, sid, overlaySend, false);
  }
  // child document primer는 OOPIF가 붙는 즉시 실행한다. 조회 helper와 DOM/Accessibility domain은
  // 첫 명시적 관찰 때까지 미뤄 일반 탐색에 Runtime 관찰을 섞지 않는다.
  function noteChildSession(wcId, sid, dbg) {
    if (wcId == null || !sid) return;
    const set = childrenOf(wcId);
    const fresh = !set.has(sid);
    set.add(sid);
    if (!dbg || !fresh) return;
    // 프레임 주입은 "처음 붙은 자식"에만 한다. 자동 부착을 다시 걸면 이미 붙어 있던 자식에도
    // attachedToTarget 이 다시 오는데, 그때 또 심으면 그 프레임만 스크립트가 두 벌이 된다.
    const cp = childPrimers.get(wcId);
    if (cp) { try { cp(dbg, sid); } catch {} }
    dbg.sendCommand("Page.enable", {}, sid).catch(() => {});
    if (observationPrimed.has(wcId)) primeChildObservation(wcId, sid, dbg);
  }
  function dropChildSession(wcId, sid) {
    if (wcId == null || !sid) return;
    childrenOf(wcId).delete(sid);
    observedChildrenOf(wcId).delete(sid);
  }
  // 그 탭이 지금 띄우고 있는 문서의 origin. 확인창 요청이 사칭인지 가릴 때 서버가 쓴다.
  function noteFrameOrigin(wcId, url) {
    let o = null; try { o = url ? new URL(url).origin : null; } catch { o = null; }
    if (!o || o === "null" || wcId == null) return;
    let set = frameOrigins.get(wcId); if (!set) { set = new Set(); frameOrigins.set(wcId, set); }
    if (set.has(o)) return;
    set.add(o);
    ctlSend({ type: "browser-frame-origins", wc: wcId, origins: Array.from(set) });
  }
  function planFor(id) { let p = dialogPlans.get(id); if (!p) { p = { queue: [], mode: null, text: null }; dialogPlans.set(id, p); } return p; }
  function nextAnswer(id) {
    const p = dialogPlans.get(id);
    if (!p) return null;
    if (p.queue.length) return p.queue.shift();
    return p.mode;
  }

  // ── 세션 준비를 한 군데로 ────────────────────────────────────────────────
  //
  // CDP 세션에 건 것들(도메인 켜기·문서보다 먼저 도는 주입·자식 타깃 자동 부착)은 세션을 떼는 순간
  // 전부 사라진다. 그런데 명령이 멈추면 세션을 떼었다 다시 붙인다. 다시 걸지 않으면 그 탭은
  // 그때부터 기능 일부를 잃는다. 콘솔·예외·네트워크 수집이 멈추고, 확인창이 우리 것으로 바뀌지 않고,
  // 파일 선택이 동작하지 않고, iframe이 도구에 보이지 않는다. 겉으로는 명령이 성공했는데 결과만
  // 이상한 상태로 보여 원인을 찾기 가장 어려운 부류다.
  //
  // 그래서 이 세션에 있어야 하는 것의 목록을 한 곳에 두고, 붙일 때와 다시 붙일 때 같은 목록을
  // 실행한다. main.cjs 도 자기 몫(WebAuthn 알림·확인창 대체·자식 타깃)을 여기 등록한다.
  const sessionPrimers = new Map();   // wcId → fn(wc, dbg). 탭이 죽으면 함께 지운다.
  const childPrimers = new Map();     // wcId → fn(dbg, sid). 처음 붙은 자식 프레임에만 돈다.
  function registerSessionPrimer(wcId, fn, childFn) {
    if (typeof fn === "function") sessionPrimers.set(wcId, fn);
    else sessionPrimers.delete(wcId);
    if (typeof childFn === "function") childPrimers.set(wcId, childFn);
    else if (typeof fn !== "function") childPrimers.delete(wcId);
  }
  function makeSend(wc) {
    const dbg = wc.debugger;
    const send = (method, params) => dbg.sendCommand(method, params || {});
    send.on = (sid) => (method, params) => sid
      ? dbg.sendCommand(method, params || {}, sid) : dbg.sendCommand(method, params || {});
    send.frames = () => [null, ...childrenOf(wc.id)];
    const FRAME_ASK_MS = 6000;
    send.ask = (sid, method, params) => new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, FRAME_ASK_MS);
      send.on(sid)(method, params).then(
        (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
        () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } },
      );
    });
    send.all = async (method, params) => {
      const results = await Promise.all(send.frames().map((sid) => send.ask(sid, method, params)));
      return results.filter((result) => result != null);
    };
    return send;
  }

  function clearSessionGuards(wcId) {
    documentPrimed.delete(wcId);
    observationPrimed.delete(wcId);
    childSessions.delete(wcId);
    childObserved.delete(wcId);
  }

  // 일반 탐색에 필요한 Page 계약만 준비한다. 이벤트 수신기를 먼저 걸어 Target.setAutoAttach가
  // 즉시 내보내는 child와 첫 AI 명령 전 file chooser도 놓치지 않는다.
  function primeSession(wc) {
    const send = ensureWired(wc);
    if (documentPrimed.has(wc.id)) return send;
    documentPrimed.add(wc.id);
    const dbg = wc.debugger;
    dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => {});
    dbg.sendCommand("Page.enable").catch(() => {});
    const own = sessionPrimers.get(wc.id);
    if (own) { try { own(wc, dbg); } catch {} }
    return send;
  }

  function primeObservation(wc, send) {
    if (observationPrimed.has(wc.id)) return;
    observationPrimed.add(wc.id);
    const dbg = wc.debugger;
    dbg.sendCommand("Runtime.enable").catch(() => {});
    dbg.sendCommand("Log.enable").catch(() => {});
    dbg.sendCommand("Network.enable").catch(() => {});
    dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: FRAME_UTIL, runImmediately: true }).catch(() => {});
    dbg.sendCommand("Runtime.evaluate", { expression: FRAME_UTIL }).catch(() => {});
    observation.prime(send);
    overlay.injectActive(wc.id, null, send, true);
    // Target 이벤트 수신은 document 단계부터 시작한다. 첫 AI 명령보다 먼저 붙은 OOPIF도 여기서
    // 한 번씩 승격해야 cross-frame 조회가 빠지지 않는다.
    for (const sid of childrenOf(wc.id)) primeChildObservation(wc.id, sid, dbg);
  }

  // debugger와 수신기는 document/observation 어느 쪽보다 먼저 준비한다. debugger의 외부 detach도
  // 세션 계약을 모두 지우므로 다음 호출이 해당 단계를 정확히 한 번 다시 건다.
  function ensureWired(wc) {
    const dbg = wc.debugger;
    let attached = false;
    try { attached = dbg.isAttached(); } catch {}
    if (!attached && !allowAttach(wc)) {
      throw tagError(new Error("이 페이지에서는 CDP 를 붙이지 않습니다(로그인 호스트). CDP 없이 되는 명령만 쓰거나 사람에게 넘기세요(browser_ask_user)."), attachBlockedCode);
    }
    try { if (!attached) dbg.attach("1.3"); }
    catch (e) { throw tagError(e, sessionDetachedCode); }
    if (!wired.has(wc.id)) {
      wired.add(wc.id);
      // 페이지가 이동하면 이전 snapshot의 ref(backendDOMNodeId)는 stale 이므로 세대를 올려 click이 거부하게 한다.
      // did-navigate는 최상위 내비게이션만 발생. did-navigate-in-page는 iframe에서도 발생하므로
      // isMainFrame일 때만 무효화(광고/위젯 iframe hash 변경이 메인 snapshot을 과잉 무효화하는 것 방지).
      const bump = () => refRegistry.bumpNavigation(wc.id);
      wc.on("did-navigate", bump);
      wc.on("did-navigate-in-page", (_ev, _url, isMainFrame) => { if (isMainFrame) bump(); });
      wc.once("destroyed", () => {
        wired.delete(wc.id);
        refRegistry.clear(wc.id);
        observation.forget(wc.id);
        dialogPlans.delete(wc.id);
        upload.forget(wc.id);
        deviceEmulation.forget(wc.id);
        hiddenViewport.forget(wc.id);
        sessionPrimers.delete(wc.id);
        childPrimers.delete(wc.id);
        frameOrigins.delete(wc.id);
        clearSessionGuards(wc.id);
      });
      dbg.on("detach", () => clearSessionGuards(wc.id));
      // 닫힌 루프 QA용 상시 수집: 콘솔 API·미처리 예외·브라우저 로그(에러/경고)·네트워크 실패(4xx/5xx·loadingFailed).
      dbg.on("message", (_ev, method, params) => {
        try {
          if (method === "Target.attachedToTarget") {
            const ti = params && params.targetInfo;
            if (params && params.sessionId && ti && (ti.type === "iframe" || ti.type === "page")) {
              noteChildSession(wc.id, params.sessionId, dbg);   // 헬퍼 주입까지 여기서 한다
            }
          } else if (method === "Page.frameNavigated") {
            noteFrameOrigin(wc.id, params && params.frame && params.frame.url);
          } else if (method === "Target.detachedFromTarget") {
            dropChildSession(wc.id, params && params.sessionId);
          }
          const moment = observation.momentPayload(method, params);
          if (moment) {
            const momentSend = (cmd, args) => dbg.sendCommand(cmd, args || {});
            observation.noteMoment(wc.id, momentSend, moment); // 기다리지 않는다. 찍는 동안 페이지가 멈추면 안 된다
            return;
          }
          if (method === "Runtime.consoleAPICalled") {
            const text = (params.args || []).map((a) => (a && a.value !== undefined) ? String(a.value) : (a && (a.description || a.type)) || "").join(" ");
            if (/Electron Security Warning/i.test(text)) return; // Electron 주입 dev 경고: 페이지 이슈가 아니므로 제거한다
            observation.recordConsole(wc.id, { level: params.type, text: text.slice(0, 2000) });
          } else if (method === "Runtime.exceptionThrown") {
            const ex = params.exceptionDetails || {};
            observation.recordException(wc.id, { text: String(ex.exception?.description || ex.text || "exception").slice(0, 2000), url: ex.url || "", line: ex.lineNumber });
          } else if (method === "Log.entryAdded") {
            const e = params.entry || {};
            if ((e.level === "error" || e.level === "warning") && !/Electron Security Warning/i.test(e.text || "")) observation.recordConsole(wc.id, { level: e.level, text: String(e.text || "").slice(0, 2000), url: e.url || "", source: e.source });
          } else if (method === "Page.javascriptDialogOpening") {
            // 사람이 보고 누르도록 두는 것이 기본. 무장돼 있을 때만 대신 닫는다.
            const ans = nextAnswer(wc.id);
            const rec = observation.openDialog(wc.id, { type: params.type, message: String(params.message || "").slice(0, 300),
              answer: ans || "사람이 처리(자동 응답 없음)" });
            // 자동 응답이 없으면 사람이 눌러야 한다. 그런데 이 창은 탭이 아니라 창에 붙어서, 다른 탭을
            // 보고 있으면 관계없는 페이지 위에 뜨고 그 창이 통째로 막힌다. 어느 탭이
            // 물어보는지 알려 그 탭으로 이동시킨다.
            // AI 가 조작해서 뜬 것인지 함께 보낸다. 사람이 눌러 뜬 창은 커서를 가져가는 것이 맞지만,
            // AI 가 조작하다 뜬 창이 커서를 가져가면 사용자가 입력하던 자리에서 벗어난다.
            // 호스트에서는 그 webview 안 입력칸에 커서가 있는지 볼 수 없어 인과로 구분한다.
            if (!ans) ctlSend({ type: "browser-dialog-open", wc: wc.id, kind: params.type,
              message: rec.message, byAi: !!(aiDriving && aiDriving(wc.id)) });
            if (ans) {
              const plan = dialogPlans.get(wc.id);
              dbg.sendCommand("Page.handleJavaScriptDialog", {
                accept: ans !== "cancel",
                ...(params.type === "prompt" && plan && plan.text != null ? { promptText: String(plan.text) } : {}),
              }).catch(() => {});
            }
          } else if (method === "Page.fileChooserOpened") {
            // Electron은 webview 게스트의 파일 선택창을 띄우지 못하므로 가로채서 직접 연다.
            observation.setFileChooser(wc.id, { backendNodeId: params.backendNodeId, mode: params.mode });
            const chooserSend = (cmd, args) => dbg.sendCommand(cmd, args || {});
            upload.serveFileChooser(chooserSend, wc, params).catch(() => {});
          } else if (method === "Page.javascriptDialogClosed") {
            observation.closeDialog(wc.id);
            ctlSend({ type: "browser-dialog-closed", wc: wc.id });
          } else if (method === "Network.requestWillBeSent") {
            observation.noteRequest(wc.id, params.requestId, (params.request && params.request.url) || "");
          } else if (method === "Network.responseReceived") {
            const r = params.response || {};
            if (r.status >= 400) observation.recordNetwork(wc.id, { url: String(r.url || observation.requestUrl(wc.id, params.requestId) || "").slice(0, 300), status: r.status });
          } else if (method === "Network.loadingFailed") {
            if (params.errorText && params.errorText !== "net::ERR_ABORTED") observation.recordNetwork(wc.id, { url: String(observation.requestUrl(wc.id, params.requestId) || "").slice(0, 300), failed: params.errorText });
          }
        } catch {}
      });
    }
    return makeSend(wc);
  }

  // 명시적 도구 관찰은 기본값이다. 화면 크기 준비처럼 Runtime 관찰이 필요 없는 호출자는
  // ensureAttached(wc, { observe: false })로 document 계약만 보장할 수 있다.
  function ensureAttached(wc, { observe = true } = {}) {
    const send = primeSession(wc);
    if (observe) primeObservation(wc, send);
    return send;
  }

  // 도구 실행 중 깨진 세션을 새 세션으로 바꾸고 두 계약을 모두 복원한다. 이 함수의 소비자는 이미
  // 명시적 관찰을 시작한 command timeout/reattach/capture recovery 경로다.
  function resetCdpSession(wc) {
    try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
    clearSessionGuards(wc.id);
    hiddenViewport.resetSession(wc.id);
    overlay.resetSession(wc.id);
    refRegistry.clearSnapshot(wc.id);
    return ensureAttached(wc);
  }

  // 의도적으로 debugger를 떼는 호출. detach event가 동기/비동기 어느 쪽이어도 guard 정리는 같다.
  function detachIdle(wc) {
    let isAttached = false;
    try { isAttached = wc.debugger.isAttached(); } catch {}
    if (isAttached) { try { wc.debugger.detach(); } catch {} }
    clearSessionGuards(wc.id);
    try { refRegistry.clearSnapshot(wc.id); } catch {}
    try { hiddenViewport.resetSession(wc.id); } catch {}
    try { overlay.resetSession(wc.id); } catch {}
  }

  // AI 세션(document 계약)이 지금 attach 위에 준비돼 있는가. 정체성 전달만을 위한 attach 와 구분한다.
  function primed(wcId) { return documentPrimed.has(Number(wcId)); }

  return { ensureAttached, resetCdpSession, detachIdle, registerSessionPrimer, primeSession, primed,
    noteChildSession, dropChildSession, childrenOf, noteFrameOrigin, planFor, nextAnswer };
}

module.exports = { createCdpSession };
