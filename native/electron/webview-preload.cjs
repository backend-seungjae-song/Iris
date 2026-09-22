// 브라우저 패널 <webview>의 preload. 요소 선택과 페이지가 처리하지 않은 파일 드롭을 호스트로 전달한다.
// 요소 선택 오버레이(하이라이트·pointerdown 캡처·화면 고정)는 페이지의 main world에서
// 실행되어야 타이머·이벤트를 실제로 억제할 수 있으므로 호스트가 executeJavaScript로 주입한다.
// 그 main world 스크립트는 결과를 window.postMessage({__orca:'pick', ...})로 던지고, isolated
// world인 이 preload가 그 message를 받아 ipcRenderer.sendToHost로 호스트에 넘긴다.
// console-message 채널이 Electron webview에서 불안정한 문제를 우회하는 신뢰 경로.
const { ipcRenderer, webUtils } = require("electron");

(() => {
  let internalDrag = false, pageOwnsDrag = false;
  const hasFiles = (event) => event.isTrusted && Array.from(event.dataTransfer?.types || []).includes("Files");
  const nativeDropTarget = (event) => event.composedPath().some((node) =>
    node?.matches?.('input[type="file"], textarea, input:not([type="file"])') || node?.isContentEditable ||
    node?.matches?.("label") && node.control?.type === "file");
  const reset = () => { internalDrag = false; pageOwnsDrag = false; };
  window.addEventListener("dragstart", (event) => { if (event.isTrusted) internalDrag = true; }, true);
  window.addEventListener("dragend", reset, true);
  window.addEventListener("blur", reset);
  for (const kind of ["dragover", "drop"]) {
    window.addEventListener(kind, (event) => {
      if (!hasFiles(event)) return;
      const skip = internalDrag || nativeDropTarget(event);
      const owned = pageOwnsDrag;
      if (kind === "dragover") pageOwnsDrag = true;
      const finish = (bubbled) => {
        if (bubbled !== event) return;
        if (kind === "drop") reset();
        if (skip || event.defaultPrevented || event.cancelBubble || kind === "drop" && owned) return;
        if (kind === "dragover") {
          pageOwnsDrag = false;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          return;
        }
        const entries = Array.from(event.dataTransfer.items || []).filter((item) => item.kind === "file").map((item) => {
          try {
            const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
            if (entry?.isDirectory) return { error: "directory" };
            if (!entry?.isFile) return { error: "entry" };
            const file = item.getAsFile();
            return { path: file && webUtils.getPathForFile(file) };
          } catch { return { error: "path" }; }
        });
        event.preventDefault();
        ipcRenderer.sendToHost("ac-file-drop", entries);
      };
      const afterDocument = (bubbled) => {
        if (bubbled === event) window.addEventListener(kind, finish, { once: true });
      };
      document.addEventListener(kind, afterDocument, { once: true });
      setTimeout(() => {
        document.removeEventListener(kind, afterDocument);
        window.removeEventListener(kind, finish);
      }, 0);
    }, true);
  }
})();
// 호스트가 보낸 OS 커서 좌표를 게스트 main world로 넘긴다. 격리 월드는 main world 변수에 직접
// 접근할 수 없지만 postMessage는 월드를 넘는다. 포커스 없는 창에서 mousemove가 오지 않는 것을 우회한다.
// null이 오면 이 창이 맨 위가 아니라는 뜻이므로 하이라이트를 지운다. 키는 그대로 두고 값만
// 비워 보낸다(받는 쪽이 키 유무로 이 채널을 구분한다).
// entered 가 포함되어 오면 다른 앱에 가려져 있다가 방금 앞으로 나왔다는 뜻이다. 오버레이가 그 뒤
// 첫 클릭을 소비한다(창을 활성화하는 클릭이지 요소를 고르는 클릭이 아니다).
ipcRenderer.on("ac-cursor-guest", (_e, pt) => {
  try {
    window.postMessage({
      __orcaHover: pt ? { x: pt.x, y: pt.y, entered: !!pt.entered } : null,
    }, "*");
  } catch (_) {}
});
window.addEventListener("message", (e) => {
  const d = e && e.data;
  if (d && d.__acRec) { try { ipcRenderer.sendToHost("ac-rec", d.__acRec); } catch (_) {} return; } // 녹화 이벤트
  if (d && d.__orca === "pick" && d.pick) {
    try { ipcRenderer.sendToHost("orca-pick", d.pick); } catch (_) {}
  }
  if (d && d.__acWebAuthn) { try { ipcRenderer.sendToHost("ac-webauthn", d.__acWebAuthn); } catch (_) {} }
  if (d && d.__acBotCheck) { try { ipcRenderer.sendToHost("ac-botcheck", d.__acBotCheck); } catch (_) {} } // 사람 확인 실패 → Chrome 넘겨주기
});

// 페이지 안 사용자 활동은 호스트 DOM에서 보이지 않는다. 클릭은 오버레이를 닫는 기존 신호로 보내고,
// 입력/스크롤도 LRU 최근성 시계를 갱신해 미제출 폼·방금 읽던 위치를 보수적으로 보존한다.
let lastActivityReport = 0;
function reportUserActivity(kind) {
  const now = Date.now();
  if (now - lastActivityReport < 1000) return;
  lastActivityReport = now;
  try { ipcRenderer.sendToHost("ac-user-activity", { kind }); } catch (_) {}
}
window.addEventListener("pointerdown", (e) => {
  try { ipcRenderer.sendToHost("ac-guest-pointerdown"); } catch (_) {}
  if (e && e.isTrusted) reportUserActivity("pointer");
}, true);
window.addEventListener("keydown", (e) => { if (e && e.isTrusted) reportUserActivity("key"); }, true);
window.addEventListener("input", (e) => { if (e && e.isTrusted) reportUserActivity("input"); }, true);
window.addEventListener("scroll", (e) => { if (!e || e.isTrusted) reportUserActivity("scroll"); }, true);
window.addEventListener("wheel", (e) => { if (e && e.isTrusted) reportUserActivity("scroll"); }, true);
window.addEventListener("touchstart", (e) => { if (e && e.isTrusted) reportUserActivity("touch"); }, true);

// ③ 자체 자동완성(아이디/비번). Electron webview엔 Chrome식 네이티브 드롭다운이 없다.
// 보안 설계:
//  - 게스트(비신뢰 페이지)엔 비밀번호를 미리 넘기지 않는다. 드롭다운은 "아이디 목록"만 받는다.
//  - 실제 신뢰 클릭(ev.isTrusted)으로 항목을 고른 순간에만 그 계정 1개의 비밀번호를 호스트에서 받아 채운다.
//  - 호스트는 AI가 브라우저를 조작 중(control-active)이면 아이디·비밀번호 전달을 거부한다(CDP 자동수확 차단).
(function () {
  var accounts = null, requested = false, dd = null, curField = null, fillTarget = null;
  // preload가 하위 프레임에서도 돌기 때문에 호스트 응답은 모든 프레임에 도착한다. 이 id로 내 것만 받는다.
  var FRAME_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var origin = "";
  try { origin = location.origin; } catch (e) {}
  if (!/^https?:$/.test((location.protocol || ""))) return; // http(s) 페이지에서만

  ipcRenderer.on("ac-autofill-response", function (_e, payload) {
    if (!payload || payload.origin !== origin || payload.frameId !== FRAME_ID) return;
    var list = Array.isArray(payload.accounts) ? payload.accounts : []; // [{i, username}], 비번 없음
    if (list.length) { accounts = list; if (curField) showDropdown(curField); }
    // 빈 응답: 임포트가 아직 안 끝났을 수 있다(탭 열림 시 auto-import 비동기). accounts=null로 두어
    // 다음 focus 때 재요청을 허용한다. (조작 중 차단으로 빈 경우도 동일하며, 재시도 비용이 낮다.)
    else { accounts = null; requested = false; }
  });
  ipcRenderer.on("ac-autofill-fill-response", function (_e, payload) {
    if (!payload || payload.origin !== origin || payload.frameId !== FRAME_ID || payload.password == null) return;
    if (!fillTarget) return;
    doFill(fillTarget.field, payload.username, payload.password);
    fillTarget = null;
  });
  // AI가 요청한 로그인. 호스트(main)가 허용 목록을 확인한 뒤에만 이 채널로 보낸다. 페이지 JS는
  // ipcRenderer를 볼 수 없으므로 이 값은 여기서 처음 드러나고, 곧바로 입력칸으로만 들어간다.
  ipcRenderer.on("ac-ai-login", function (_e, payload) {
    if (!payload || payload.origin !== origin || payload.password == null) return;
    var pw = document.querySelector('input[type="password"]');
    var anchor = pw || document.querySelector("input");
    if (!anchor) return;
    doFill(anchor, payload.username, payload.password);
  });
  function requestAccounts() {
    if (requested) return; requested = true;
    try { ipcRenderer.sendToHost("ac-autofill-request", { origin: origin, frameId: FRAME_ID }); } catch (e) {}
  }

  function isPassword(el) { return el && el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password"; }
  // 아이디 필드 힌트(멀티스텝 로그인은 같은 폼에 비번 필드가 없어, 힌트로 로그인 필드를 판별해 검색창 오탐을 막는다).
  function userHint(el) {
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (ac.indexOf("username") >= 0 || ac.indexOf("email") >= 0) return true;
    var s = ((el.name || "") + " " + (el.id || "")).toLowerCase();
    return /user(name)?|userid|loginid|email|login|account/.test(s);
  }
  function isUserField(el) {
    if (!el || el.tagName !== "INPUT") return false;
    var t = (el.type || "text").toLowerCase();
    if (["text", "email", "tel", ""].indexOf(t) < 0) return false;
    var scope = el.form || document;
    if (scope.querySelector('input[type="password"]')) return true; // 같은 폼에 비번 → 로그인 폼 확실
    if (t === "email") return true;                                  // 이메일 필드는 거의 로그인/가입
    return userHint(el);                                             // 멀티스텝(비번 필드 부재): 힌트 있을 때만
  }

  function nativeSet(el, val) {
    try {
      var proto = window.HTMLInputElement && HTMLInputElement.prototype;
      var d = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, val); else el.value = val;
    } catch (e) { try { el.value = val; } catch (e2) {} }
    try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
  }
  function doFill(anchor, username, password) {
    var scope = (anchor && anchor.form) || document;
    var pw = scope.querySelector('input[type="password"]');
    var user = null, inputs = scope.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i]; if (el === pw) break;
      var t = (el.type || "text").toLowerCase();
      if (["text", "email", "tel", ""].indexOf(t) >= 0 && el.offsetParent !== null) user = el;
    }
    if (user && username != null) { user.focus(); nativeSet(user, username); }
    if (pw && password != null) { pw.focus(); nativeSet(pw, password); }
    hideDropdown();
  }
  // 항목 선택 → 그 계정 비밀번호 요청(호스트가 AI 조작 중이면 거부). 신뢰 클릭만.
  function requestFill(acc, field) {
    fillTarget = { field: field };
    try { ipcRenderer.sendToHost("ac-autofill-fill", { origin: origin, frameId: FRAME_ID, i: acc.i }); } catch (e) {}
  }

  function hideDropdown() { if (dd) { try { dd.remove(); } catch (e) {} dd = null; } }
  function showDropdown(field) {
    hideDropdown();
    if (!accounts || !accounts.length) return;
    var r = field.getBoundingClientRect();
    dd = document.createElement("div");
    dd.setAttribute("data-ac-autofill", "1");
    // 게스트 문서라 호스트 CSS 토큰 접근 불가 → 팔레트 유래 soft 상수 인라인(raw #000/#fff·검정 그림자 금지).
    dd.style.cssText = "position:fixed;z-index:2147483647;background:#EAF3FA;color:#0A1620;border:1px solid #C7D9E6;border-radius:8px;box-shadow:0 6px 24px rgba(10,22,32,.26);font:13px/1.4 -apple-system,system-ui,sans-serif;padding:4px;min-width:" + Math.max(200, r.width) + "px;max-height:240px;overflow:auto;";
    dd.style.left = Math.round(r.left) + "px";
    dd.style.top = Math.round(r.bottom + 4) + "px";
    var hdr = document.createElement("div");
    hdr.textContent = "저장된 로그인";
    hdr.style.cssText = "font-size:10.5px;color:#5A7488;padding:4px 8px 2px;text-transform:uppercase;letter-spacing:.04em;";
    dd.appendChild(hdr);
    accounts.forEach(function (acc) {
      var it = document.createElement("div");
      it.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;cursor:pointer;";
      it.onmouseenter = function () { it.style.background = "#DCEAF4"; };
      it.onmouseleave = function () { it.style.background = "transparent"; };
      var key = document.createElement("span"); key.textContent = "🔑";
      var nm = document.createElement("span"); nm.textContent = acc.username || "(아이디 없음)"; nm.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      var dots = document.createElement("span"); dots.textContent = "••••••"; dots.style.cssText = "color:#9DB4C4;font-size:11px;";
      // 로그인하는 화면에서 바로 AI 허용을 켜고 끈다. 관리 페이지로 이동하지 않아도 된다.
      var ai = document.createElement("button");
      ai.type = "button"; ai.setAttribute("data-ac-ai", "1");
      var paintAi = function () {
        ai.textContent = "AI";
        ai.title = acc.ai ? "AI가 이 계정으로 로그인할 수 있습니다 — 눌러서 잠금" : "AI에게는 잠겨 있습니다 — 눌러서 허용";
        ai.style.cssText = "flex:none;font:inherit;font-size:10px;font-weight:700;letter-spacing:.03em;padding:2px 7px;border-radius:999px;cursor:pointer;"
          + (acc.ai ? "background:#2B7FD4;color:#F2F8FC;border:1px solid #2B7FD4;" : "background:transparent;color:#9DB4C4;border:1px solid #C7D9E6;");
      };
      paintAi();
      ai.addEventListener("mousedown", function (ev) {
        if (!ev.isTrusted) return;            // 페이지가 합성 이벤트로 권한을 켜지 못하게
        ev.preventDefault(); ev.stopPropagation();
        acc.ai = !acc.ai; paintAi();          // 호스트 응답으로 확정되지만 화면에는 즉시 반영한다
        try { ipcRenderer.sendToHost("ac-ai-allow", { origin: origin, frameId: FRAME_ID, i: acc.i, allow: acc.ai }); } catch (e) {}
      });
      it.appendChild(key); it.appendChild(nm); it.appendChild(dots); it.appendChild(ai);
      // 신뢰 클릭(ev.isTrusted)만 받는다. 페이지가 합성 이벤트로 비번을 가져가지 못하게 한다. (CDP는 호스트의 control-active 게이트가 별도 차단.)
      it.addEventListener("mousedown", function (ev) { if (!ev.isTrusted) return; if (ev.target === ai) return; ev.preventDefault(); requestFill(acc, field); });
      dd.appendChild(it);
    });
    // 헤더든 항목(사이트/계정)이든 드롭다운 안 어디를 클릭해도 즉시 닫는다(항목 클릭은 위에서 채움 요청 후 닫힘).
    // 단 AI 스위치는 예외다. 켜자마자 닫히면 결과를 확인할 수 없다.
    dd.addEventListener("mousedown", function (ev) {
      if (!ev.isTrusted) return;
      if (ev.target && ev.target.getAttribute && ev.target.getAttribute("data-ac-ai")) return;
      setTimeout(hideDropdown, 0);
    });
    document.body.appendChild(dd);
  }

  // ④ 이 브라우저에서 새로 로그인한 자격증명을 수집한다. 가져오기만 되고 저장이 안 되면 여기서
  // 만든 계정을 다음에 다시 입력해야 한다. 수집만 하고 저장 여부는 호스트가 사용자에게 묻는다.
  // Chrome 쪽 저장소는 수정하지 않는다. 이 경로의 저장 대상은 앱의 자격증명 저장소뿐이다.
  var lastSent = "";
  // 멀티스텝 로그인은 아이디를 앞 화면에서 받아 비번 화면엔 그 칸이 없다. 사람이 친 마지막 아이디를
  // 이 프레임에 들고 있다가 비번만 있는 폼에서 쓴다. 페이지가 통째로 넘어가면 이것도 사라진다.
  var typedUser = "";
  document.addEventListener("input", function (e) {
    if (!e || !e.isTrusted) return;
    var el = e.target;
    if (isUserField(el) && el.value) typedUser = el.value;
  }, true);

  function fieldValue(el) { return el && typeof el.value === "string" ? el.value : ""; }
  function captureFrom(scope) {
    var root = scope && scope.querySelector ? scope : document;
    var pw = root.querySelector('input[type="password"]');
    if (!pw || !fieldValue(pw)) return null;
    var user = "", inputs = root.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i]; if (el === pw) break;
      var t = (el.type || "text").toLowerCase();
      if (["text", "email", "tel", ""].indexOf(t) >= 0 && fieldValue(el)) user = el.value;
    }
    if (!user) user = typedUser;
    if (!user) return null;
    return { origin: origin, url: location.href, username: user, password: pw.value };
  }
  function sendCapture(scope) {
    var cap = captureFrom(scope);
    if (!cap) return;
    var key = cap.origin + "\n" + cap.username + "\n" + cap.password;
    if (key === lastSent) return;   // 같은 제출이 submit·pagehide 로 두 번 오는 것이 정상이다
    lastSent = key;
    try { ipcRenderer.sendToHost("ac-login-captured", cap); } catch (e) {}
  }
  document.addEventListener("submit", function (e) {
    if (e && e.isTrusted) sendCapture(e.target);
  }, true);
  // submit 을 발생시키지 않는 로그인이 많다(폼 없이 버튼으로 보내는 화면). 사용자가 버튼을 누른 시점이
  // 비밀번호가 완성된 시점이므로, 그 자리에서 한 번 수집한다.
  document.addEventListener("click", function (e) {
    if (!e || !e.isTrusted) return;
    var el = e.target;
    for (var n = 0; el && n < 4; n++, el = el.parentElement) {
      var tag = (el.tagName || "").toLowerCase();
      var type = (el.type || "").toLowerCase();
      if (tag === "button" || (tag === "input" && (type === "submit" || type === "button"))) {
        sendCapture(el.form || document); return;
      }
    }
  }, true);
  // 폼 제출이 곧 이동인 화면은 위 두 경로를 모두 지나지 않을 수 있다(Enter 로 보내고 바로 이동한다).
  window.addEventListener("pagehide", function () { sendCapture(document); }, true);

  document.addEventListener("focusin", function (e) {
    var el = e.target;
    if (isPassword(el) || isUserField(el)) {
      curField = el;
      if (accounts == null) requestAccounts();
      else if (accounts.length) showDropdown(el);
    }
  }, true);
  document.addEventListener("focusout", function () {
    setTimeout(function () { if (!dd || !dd.contains(document.activeElement)) hideDropdown(); }, 150);
  }, true);
  document.addEventListener("scroll", hideDropdown, true);
  window.addEventListener("resize", hideDropdown);
})();
