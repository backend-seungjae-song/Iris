// 브라우저 정체성과 Google 인증 호환. Orca browser-session-ua.ts에서 이식.
// 일반 사이트에는 실제 Electron 엔진의 UA·Client Hints를 유지한다. Google 인증 예외는
// google-auth-user-agent.cjs와 공유해 요청 헤더·페이지·기기 미리보기가 같은 값을 사용한다.
const { rewriteGoogleAuthHeaders } = require("./google-auth-user-agent.cjs");

// 모바일 판별 라이브러리가 Iris 제품명을 휴대폰으로 오인하므로 앱 토큰만 뺀다.
// 실제 런타임인 Electron 토큰이나 엔진 버전은 바꾸지 않는다.
function cleanUserAgent(ua) {
  return String(ua || "").replace(/\s+Iris\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
}

let nativeUserAgent = null;
function setNativeUserAgent(ua) { nativeUserAgent = cleanUserAgent(ua); }

// 엔진이 보내는 힌트는 그대로 둔다. Google 인증 문서가 보내는 요청만 호환 UA와 맞춘다.
function setupClientHints(sess) {
  sess.webRequest.onBeforeSendHeaders({ urls: ["https://*/*"] }, (details, cb) => {
    rewriteGoogleAuthHeaders(details.requestHeaders, details.url, details);
    cb({ requestHeaders: details.requestHeaders });
  });
}

function applyHardening(sess) {
  try {
    const ua = nativeUserAgent || cleanUserAgent(sess.getUserAgent());
    sess.setUserAgent(ua);
    setupClientHints(sess);
    return ua;
  } catch { return null; }
}

// Electron은 권한 요청 단계에서는 mediaTypes(배열), 사전 확인 단계에서는 mediaType(단수)을 준다.
// 오디오라고 확인된 요청만 막아 카메라(video-only)와 구버전의 판별 불가 요청은 기존 동작을 보존한다.
function isAudioInputPermission(permission, details) {
  if (permission !== "media") return false;
  if (Array.isArray(details && details.mediaTypes)) return details.mediaTypes.includes("audio");
  return !!details && details.mediaType === "audio";
}

// 패스키·보안키 감지. Chrome의 인증 대화상자는 브라우저 층이 그리는 것이라 Electron엔 없고,
// 확인 결과: 요청은 응답 없이 대기만 한다. main world에서 감싸야 페이지가 실제로 부르는 객체를 잡는다.
// 인라인 <script> 주입은 CSP가 엄격한 사이트에서 실행되지 않으므로(확인 결과: signin.aws.amazon.com)
// 이 스크립트는 CDP의 addScriptToEvaluateOnNewDocument로 건다. main world이고 CSP를 받지 않는다.
const WEBAUTHN_SCRIPT = `(function(){try{
  if (window.__acWA) return; window.__acWA = 1;
  var post = function(p){ try { p.host = location.host; p.top = (window.top === window); window.postMessage({ __acWebAuthn: p }, '*'); } catch(e){} };
  var P = window.PublicKeyCredential;
  // 원본을 먼저 보관한다. 아래 get 래퍼가 이 값을 쓰므로 자기 계측을 다시 타지 않는다.
  var oi = (P && P.isUserVerifyingPlatformAuthenticatorAvailable) || null;
  post({ phase: 'ready' });
  try {
    if (oi) P.isUserVerifyingPlatformAuthenticatorAvailable = function(){ post({ phase: 'probe', api: 'isUVPAA' }); return oi.apply(this, arguments); };
    var oc = P && P.isConditionalMediationAvailable;
    if (typeof oc === 'function') P.isConditionalMediationAvailable = function(){ post({ phase: 'probe', api: 'isCMA' }); return oc.apply(this, arguments); };
  } catch(e){}
  var C = navigator.credentials; if (!C || !C.get) return;
  var wrap = function(n){
    var o = C[n]; if (typeof o !== 'function') return;
    C[n] = function(opt){
      // mediation:'conditional' 은 자동완성 목록에 패스키를 올리려는 대기 요청이다(확인 결과: Google 로그인
      // 식별자 페이지가 로드 직후 부른다). 대화상자를 요구하는 것이 아니므로 시작으로 보고하지 않는다.
      var conditional = !!(opt && opt.mediation === 'conditional');
      var demand = !!(opt && opt.publicKey) && !conditional;
      if (conditional && opt.publicKey) post({ phase: 'probe', api: 'conditional', kind: n });
      if (demand) {
        var send = function(pa){ post({ phase: 'start', kind: n, platform: !!pa, url: location.href }); };
        try { oi ? oi.call(P).then(send, function(){ send(false); }) : send(false); } catch(e){ send(false); }
      }
      var r = o.apply(this, arguments);
      if (demand && r && r.then) r.then(function(v){ post({ phase: 'end' }); return v; }, function(e){ post({ phase: 'end', err: (e && e.name) || '' }); });
      return r;
    };
  };
  wrap('get'); wrap('create');
} catch(e){}})();`

// Turnstile 실패를 페이지의 error callback에서 관찰한다. 오류만으로 엔진에서 통과할 수
// 없다고 단정하지 않는다. 설정 오류(1xxxxx)는 다른 브라우저로 옮겨도 해결되지 않는다.
const BOTCHECK_SCRIPT = `(function(){try{
  if (window.__acBot) return; window.__acBot = 1;
  var sent = false;
  var report = function(code){
    if (sent) return; sent = true;   // 한 문서에 한 번 — 재시도 위젯이 창을 쏟아내지 않게
    try { window.postMessage({ __acBotCheck: {
      kind: 'turnstile', code: String(code == null ? '' : code),
      host: location.host, top: (window.top === window)
    } }, '*'); } catch(e){}
  };
  var envFail = function(c){ c = String(c == null ? '' : c); return /^[36]\\d{5}$/.test(c); };
  var wrapCb = function(fn){
    return function(code){
      try { if (envFail(code)) report(code); } catch(e){}
      return (typeof fn === 'function') ? fn.apply(this, arguments) : undefined;
    };
  };
  // 이름으로 지정된 전역 콜백(data-error-callback)을 감싼다. 접근자로 바꿔 두면 페이지가 나중에
  // 다시 대입해도 그 값까지 감싸므로, 감싼 뒤 덮어써서 감지가 누락되는 것을 막는다.
  var wrapped = {};
  var wrapGlobal = function(name){
    if (!name || wrapped[name]) return; wrapped[name] = 1;
    try {
      var cur = wrapCb(window[name]);
      Object.defineProperty(window, name, {
        configurable: true,
        get: function(){ return cur; },
        set: function(v){ cur = wrapCb(v); }
      });
    } catch(e){}
  };
  var scanDom = function(){
    try {
      var els = document.querySelectorAll('.cf-turnstile[data-error-callback],[data-sitekey][data-error-callback]');
      for (var i = 0; i < els.length; i++) wrapGlobal(els[i].getAttribute('data-error-callback'));
    } catch(e){}
  };
  // window.turnstile 은 건드리지 않는다. 확인 결과: 여기에 접근자를 걸면 api.js가 로드되고도
  // window.turnstile 을 대입하지 않아 체크박스가 표시되지 않았다. 위젯이 변조를 감지하고
  // 초기화를 중단한 것으로 보인다. 그래서 감지는 사이트 자신의 전역 콜백(data-error-callback)만
  // 감싼다. 그것은 사이트 코드라 위젯의 무결성 검사 대상이 아니다.
  // 대가: turnstile.render()로 콜백을 직접 넘기는 사이트는 감지하지 못한다. 위젯을 깨뜨리는 것보다 낫다.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanDom, { once: true });
  } else { scanDom(); }
  // 위젯이 나중에 붙는 페이지도 있어 몇 초만 더 관찰하고 중단한다. 상시 관찰은 두지 않는다.
  var tries = 0;
  var t = setInterval(function(){ scanDom(); if (++tries > 6) clearInterval(t); }, 700);
} catch(e){}})();`;

// 페이지의 alert/confirm/prompt를 우리 것으로 바꾼다.
//
// 설계 이유: 이 대화상자는 Electron에서 창에 붙는 시트로 뜬다. 그래서 다른 탭이 물어도 지금
// 보고 있는 페이지 위에 떠서 창 전체를 막았다. 네이티브 시트를 끄면(disableDialogs) 그 문제는
// 사라지지만 질문 자체가 사라진다. 확인 결과: confirm이 묻지 않고 false를 돌려준다.
// 그래서 질문을 가로채 앱 안 그 탭에서 묻고, 답을 받아 페이지에 돌려준다.
//
// confirm/prompt는 값을 동기로 돌려줘야 한다. 페이지를 실제로 멈추는 유일한 방법이 동기 XHR이라
// 그것을 쓴다. 원래 대화상자도 같은 자리에서 페이지를 멈추며, 멈추는 범위는 이 탭 하나뿐이다.
function dialogScript(wcId, port) {
  return `(function(){try{
  if (window.__acDlg) return; window.__acDlg = 1;
  // 채널이 끊기면 confirm 이 묻지 않고 false 가 되어 페이지의 확인 버튼이 동작하지 않는다.
  // 그 상태를 조용히 넘기면 원인을 찾기 어려우므로 한 번은 경고를 남긴다.
  var warned = false;
  var fail = function(why){
    if (!warned) { warned = true;
      try { console.error("[Iris] 대화상자 채널 실패 — confirm/prompt 가 취소로 처리됩니다: " + why); } catch(e){}
    }
    return null;
  };
  var ask = function(kind, msg, def){
    try {
      var x = new XMLHttpRequest();
      x.open("GET", "http://127.0.0.1:${port}/dialog-ask?wc=${wcId}&kind=" + kind
        + "&msg=" + encodeURIComponent(String(msg == null ? "" : msg)).slice(0, 2000)
        + "&def=" + encodeURIComponent(String(def == null ? "" : def)), false);
      x.send(null);
      if (x.status !== 200) return fail("HTTP " + x.status + " " + String(x.responseText || "").slice(0, 80));
      return JSON.parse(x.responseText);
    } catch (e) { return fail(String(e && e.message || e)); }
  };
  window.alert = function(m){ ask("alert", m, ""); };
  window.confirm = function(m){ var r = ask("confirm", m, ""); return !!(r && r.answer === "ok"); };
  window.prompt = function(m, d){ var r = ask("prompt", m, d); return (r && r.answer === "ok") ? String(r.text == null ? "" : r.text) : null; };
} catch(e){}})();`;
}

module.exports = { cleanUserAgent, setupClientHints, applyHardening, isAudioInputPermission, setNativeUserAgent, WEBAUTHN_SCRIPT, BOTCHECK_SCRIPT, dialogScript };
