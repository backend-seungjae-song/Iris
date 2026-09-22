// CDP 로그·순간 UI·조작 뒤 애니메이션 관찰의 단일 상태 소유 모듈.
//
// 소유 범위
//   탭별 capped 로그·요청 URL·대화상자·순간 UI 장부, 알림 지문과 watcher source,
//   유한 애니메이션만 기다리는 안정화 규칙.
//
// 제공 API
//   createObservation(...)이 로그 기록·조회·비우기, session prime, noteMoment·drainMoments,
//   settleAnimations·animates 명령을 준다. 원시 Map·Set·배열은 내주지 않는다.
//
// 의존 대상
//   호출자가 주입하는 CDP send, captureHold·isTabShown·now와 shotsDir, Node fs/path.
//   Electron debugger나 webContents를 직접 잡지 않는다.
//
// 유지 조건
//   모든 버퍼는 앞에서 버려 상한을 지키고, 같은 알림 지문은 탭마다 한 번만 찍는다. 배경 탭 촬영
//   hold는 finally에서 풀며 실패 문구도 남긴다. 무한 애니메이션은 세지 않고 정지 화면은 바로 놓는다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 session event·명령 send와 main.cjs의 capture hold·visibility adapter이고,
//   양방향 소비자는 session prime, 모든 명령 결과의 moment drain, observe·diagSince·명령 timeout이다.
//   기록·촬영 시점은 CLI·MCP 결과와 QA 보고서의 콘솔·네트워크·순간 UI 증거에도 영향을 준다.

const fs = require("node:fs");
const path = require("node:path");

const LOG_CAP = 150;
const SETTLE_CAP_MS = 900;
const SETTLE_STEP_MS = 60;
const MOMENT_BINDING = "__irisMoment";
const MOMENT_GONE_MS = 8000;
const MOMENT_SETTLE_MS = 4000;

// 화면을 바꿀 수 있는 조작들. 이 뒤에 뜨는 것이 트랜지션을 타고 나타난다.
const ANIMATES = new Set(["click", "dblclick", "type", "key", "fill", "select", "check", "clear",
  "hover", "focus", "goto", "back", "forward", "reload", "upload", "scroll", "scrollto",
  "nativeclick", "nativekey", "dialog"]);

// 순간 UI: 눌러야 뜨고 스스로 사라지는 것들(토스트·스낵바·플래시)은 조작과 촬영이 따로면
// 잡을 수 없다. 관찰자를 탭에 상시 심어 두고, 뜨는 순간 페이지가 Node를 불러 바로 찍는다.
const MOMENT_WATCH = `(function(){ try {
  if (window.__irisMomentOn) return; window.__irisMomentOn = 1;
  var seq = 0, live = new Map();
  var txt = function(el){ try { return String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300); } catch(e){ return ""; } };
  var shown = function(el){ try {
    if (!el.isConnected) return false;
    var s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    var b = el.getBoundingClientRect();
    return b.width >= 40 && b.height >= 14 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
  } catch(e){ return false; } };
  var floating = function(el){ try {
    var s = getComputedStyle(el);
    return s.position === "fixed" || s.position === "absolute";
  } catch(e){ return false; } };
  // 알림 여부 판정: 접근성 표시가 가장 정확하고, 없으면 이름에 남은 관례를 본다.
  var noticeish = function(el){ try {
    var role = String(el.getAttribute("role") || "").toLowerCase();
    var lv = String(el.getAttribute("aria-live") || "").toLowerCase();
    if (role === "alert" || role === "status" || lv === "polite" || lv === "assertive") return "role";
    var name = (String(el.className || "") + " " + String(el.id || "")).toLowerCase();
    if (/toast|snack|notif|flash|banner|alert|message/.test(name)) return "name";
    return "";
  } catch(e){ return ""; } };
  var say = function(o){ try { window.__irisMoment(JSON.stringify(o)); } catch(e){} };
  // opacity 0에서 시작하는 후보는 잠깐 다시 확인해야 실제로 보인 순간을 놓치지 않는다.
  var pending = new Map();
  // Iris가 그린 판정 표시·마스크는 페이지의 UI가 아니다.
  var mine = function(el){ try { return !!(el.closest && el.closest('[id^="__ac"]')); } catch(e){ return false; } };
  var born = function(el){
    if (!floating(el) || mine(el)) return;
    var was = live.get(el);
    if (was) {
      // 알림 하나를 상자 하나에 돌려 쓰는 앱이 많다. 문구가 바뀌면 새 알림이다.
      var nowText = txt(el);
      if (!nowText || nowText === was.text) return;
      live.delete(el);
      say({ kind: "gone", id: was.id, text: was.text, why: was.why, lived: Date.now() - was.at });
    }
    if (!shown(el)) {
      if (!pending.has(el) && txt(el)) pending.set(el, Date.now());
      return;
    }
    var t = txt(el); if (!t) return;
    pending.delete(el);
    var id = ++seq, b = el.getBoundingClientRect(), why = noticeish(el);
    live.set(el, { id: id, text: t, at: Date.now(), why: why });
    say({ kind: "born", id: id, text: t, why: why,
          rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] });
  };
  var scan = function(root){
    try {
      if (root.nodeType !== 1) return;
      born(root);
      var q = root.querySelectorAll("*");
      for (var i = 0; i < q.length && i < 400; i++) born(q[i]);
    } catch(e){}
  };
  var mo = new MutationObserver(function(recs){
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
      if (r.type === "attributes" && r.target) born(r.target);
    }
  });
  // 새 문서 주입 때 documentElement가 아직 없어도 관찰자 부착을 다시 시도한다.
  var tries = 0;
  var attach = function(){
    var root = document.documentElement || document.body || document;
    try { mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden"] }); }
    catch(e){ if (++tries < 100) setTimeout(attach, 30); return; }
    try { scan(document.body || root); } catch(e){}
  };
  attach();
  setInterval(function(){
    var now = Date.now();
    pending.forEach(function(t0, el){
      if (now - t0 > 1500 || !el.isConnected) { pending.delete(el); return; }
      if (shown(el)) born(el);
    });
    live.forEach(function(v, el){
      if (shown(el)) return;
      live.delete(el);
      say({ kind: "gone", id: v.id, text: v.text, why: v.why, lived: now - v.at });
    });
  }, 120);
} catch(e){} })();`;

function createObservation({
  captureHold,
  isTabShown,
  now,
  shotsDir,
  setTimeoutFn = setTimeout,
}) {
  const logBuffers = new Map();

  function bufFor(id) {
    let b = logBuffers.get(Number(id));
    if (!b) {
      b = { console: [], exceptions: [], network: [], dialogs: [], reqUrls: new Map(),
        moments: [], momentSeen: new Set() };
      logBuffers.set(Number(id), b);
    }
    return b;
  }

  function pushCapped(arr, item) {
    arr.push(item);
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
  }

  function record(id, kind, item) {
    item.ts = now();
    pushCapped(bufFor(id)[kind], item);
  }

  function recordConsole(id, item) { record(id, "console", item); }
  function recordException(id, item) { record(id, "exceptions", item); }
  function recordNetwork(id, item) { record(id, "network", item); }

  function openDialog(id, item) {
    item.ts = now();
    const buf = bufFor(id);
    pushCapped(buf.dialogs, item);
    buf.dialogOpen = item;
    return item;
  }

  function closeDialog(id) { bufFor(id).dialogOpen = null; }
  function dialogOpen(id) { const b = logBuffers.get(Number(id)); return b && b.dialogOpen; }

  function noteRequest(id, requestId, url) {
    if (!requestId) return;
    const urls = bufFor(id).reqUrls;
    urls.set(requestId, url || "");
    if (urls.size > 500) urls.delete(urls.keys().next().value);
  }

  function requestUrl(id, requestId) {
    const b = logBuffers.get(Number(id));
    return (b && b.reqUrls.get(requestId)) || "";
  }

  function setFileChooser(id, value) {
    const b = bufFor(id);
    b.fileChooser = value;
    if (value) value.at = now();
  }

  function setLastUpload(id, value) { bufFor(id).lastUpload = value; }

  function momentPrint(text) {
    return String(text || "")
      .replace(/\d[\d,.]*/g, "#")
      .replace(/[a-f0-9]{8,}/gi, "#")
      .replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
  }

  // 뜨는 그 순간에 찍는다. 못 찍었어도 문구와 실패 이유는 남긴다.
  async function noteMoment(wcId, send, m) {
    if (!m || !m.kind) return;
    const buf = bufFor(wcId);
    if (m.kind === "gone") {
      for (let i = buf.moments.length - 1; i >= 0; i--) {
        const entry = buf.moments[i];
        if (entry.id === m.id) { entry.gone = true; entry.lived = m.lived; break; }
      }
      if (!m.why && m.lived <= MOMENT_GONE_MS && !buf.moments.some((entry) => entry.id === m.id)) {
        pushCapped(buf.moments, { id: m.id, text: m.text, print: momentPrint(m.text),
          ts: now(), gone: true, lived: m.lived, shot: null, why: "사라짐" });
      }
      return;
    }
    if (m.kind !== "born" || !m.why) return;
    const print = momentPrint(m.text);
    if (buf.momentSeen.has(print)) return;
    buf.momentSeen.add(print);
    const rec = { id: m.id, text: m.text, print, ts: now(), why: m.why,
      rect: m.rect || null, gone: false, shot: null };
    pushCapped(buf.moments, rec);
    let held = false;
    try { if (!isTabShown(wcId)) held = await captureHold(wcId, true); } catch { held = false; }
    try {
      const result = await Promise.race([
        send("Page.captureScreenshot", { format: "png" }),
        new Promise((resolve) => setTimeoutFn(() => resolve(null), 3000)),
      ]);
      if (!result || !result.data) { rec.shotError = "찍는 데 3초가 넘었다"; return; }
      const png = Buffer.from(result.data, "base64");
      if (!png.length) { rec.shotError = "빈 그림이 왔다"; return; }
      fs.mkdirSync(shotsDir, { recursive: true });
      const file = path.join(shotsDir, "moment-" + now() + ".png");
      fs.writeFileSync(file, png);
      rec.shot = file;
    } catch { rec.shotError = "그려지지 않는 탭이라 못 찍음"; }
    finally { if (held) { try { await captureHold(wcId, false); } catch {} } }
  }

  // 실행 중인 유한 애니메이션이 끝날 때까지만 붙잡는다. 정지 화면이면 한 번 확인하고 바로 해제한다.
  async function settleAnimations(send, cap) {
    const until = now() + Math.max(0, Math.min(3000, Number(cap) || SETTLE_CAP_MS));
    for (;;) {
      let running = 0;
      try {
        const result = await send("Runtime.evaluate", {
          expression: `(() => { try { return document.getAnimations().filter((a) => {
            if (a.playState !== "running") return false;
            try { const t = a.effect && a.effect.getTiming();
                  if (t && (t.iterations === Infinity || !isFinite(t.iterations))) return false; } catch (e) {}
            return true; }).length; } catch (e) { return 0; } })()`,
          returnByValue: true,
        });
        running = Number(result && result.result && result.result.value) || 0;
      } catch { return; }
      if (!running || now() >= until) return;
      await new Promise((resolve) => setTimeoutFn(resolve, SETTLE_STEP_MS));
    }
  }

  function prime(send) {
    send("Runtime.addBinding", { name: MOMENT_BINDING }).catch(() => {});
    send("Page.addScriptToEvaluateOnNewDocument", { source: MOMENT_WATCH, runImmediately: true }).catch(() => {});
    send("Runtime.evaluate", { expression: MOMENT_WATCH }).catch(() => {});
  }

  function momentPayload(method, params) {
    if (method !== "Runtime.bindingCalled" || !params || params.name !== MOMENT_BINDING) return null;
    try { return JSON.parse(params.payload); } catch { return null; }
  }

  function drainMoments(wcId) {
    const b = logBuffers.get(Number(wcId));
    if (!b || !b.moments || !b.moments.length) return null;
    const at = now();
    const fresh = b.moments.filter((m) => !m.sent && (m.shot || m.shotError || at - m.ts > MOMENT_SETTLE_MS));
    if (!fresh.length) return null;
    return {
      list: fresh.map((m) => ({ text: m.text, shot: m.shot || null, gone: !!m.gone,
        lived: m.lived || null, print: m.print, why: m.why,
        note: m.shot ? null : (m.shotError || "뜬 것은 봤지만 찍지 못했다") })),
      commit: () => { for (const m of fresh) m.sent = true; },
    };
  }

  function observe(wcId, level, limit) {
    const buf = bufFor(wcId);
    const con = buf.console.filter((entry) => level === "all" ? true
      : (level === "warn" ? (entry.level === "error" || entry.level === "warning" || entry.level === "assert")
        : (entry.level === "error" || entry.level === "assert")));
    return {
      console: con.slice(-limit), exceptions: buf.exceptions.slice(-limit), network: buf.network.slice(-limit),
      dialogs: buf.dialogs.slice(-limit), moments: buf.moments.slice(-limit), fileChooser: buf.fileChooser,
      counts: { consoleErrors: con.length, exceptions: buf.exceptions.length, networkFailures: buf.network.length,
        dialogs: buf.dialogs.length, moments: buf.moments.length },
    };
  }

  function clearDiagnostics(wcId) {
    const buf = bufFor(wcId);
    buf.console.length = 0; buf.exceptions.length = 0; buf.network.length = 0;
  }

  function diagSince(wcId, since) {
    const b = logBuffers.get(Number(wcId));
    if (!b) return { console: [], exceptions: [], network: [], dialogs: [], moments: [] };
    const from = Number(since) || 0;
    const pick = (arr) => (arr || []).filter((entry) => (entry && entry.ts ? entry.ts >= from : true)).slice(-200);
    return { console: pick(b.console), exceptions: pick(b.exceptions), network: pick(b.network),
      dialogs: pick(b.dialogs), moments: pick(b.moments) };
  }

  function forget(wcId) { logBuffers.delete(Number(wcId)); }
  function animates(cmd) { return ANIMATES.has(cmd); }

  return { recordConsole, recordException, recordNetwork, openDialog, closeDialog, dialogOpen,
    noteRequest, requestUrl, setFileChooser, setLastUpload, noteMoment, settleAnimations, prime,
    momentPayload, drainMoments, observe, clearDiagnostics, diagSince, forget, animates };
}

module.exports = { createObservation };
