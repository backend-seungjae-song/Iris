// 브라우저 handoff. Iris webview에서 연결된 실제 Chrome 프로필로 인증 흐름을 넘긴다.
//
// 소유 범위
//   handoff 진행 막대와 단계 표시, 중복 자동 실행 억제, 입력 필드 캡처,
//   패스키·사람 확인 감지 알림.
//
// 제공 API
//   initCapability(ctx). 이 기능의 진입점으로 앱 셸이 부르는 네 이름을 채운다.
//   initHandoff(deps) · handoffCheck · handoffToChrome · webauthnNotice · botCheckNotice.
//
// 의존 대상
//   Electron acHost 다리와 main 소유의 toast·profile source·autofill 차단·browser log 함수를 init에서 주입받는다.
//   document와 URL 같은 브라우저 표준 객체는 런타임 전역을 쓴다.
//
// 유지 조건
//   http(s)·알려진 profile partition만 넘기고, AI 조작 중에는 넘기지 않는다.
//   자동 감지는 입력값을 싣거나 Chrome 창을 스스로 열지 않는다.
//   사람이 시작한 값도 같은 origin일 때만 옮기며 로그에 남기지 않는다.
//
// 유지 조건 (이어서)
//   이 파일을 앱 셸이 정적으로 import 하면 "끈 기능은 로드되지 않는다"가 깨진다. 앱 셸은 훅 이름만
//   부른다: handoff.tabItem · handoff.webauthnNotice · handoff.botCheckNotice.
//   이 기능은 본 창과 분리 브라우저 창 둘 다에서 동작한다(표의 windows). 한쪽만 적으면 그 창에서
//   동작하지 않는다. 분리 창에서 로그인 벽을 만나는 경우가 오히려 흔하다.
//
// 영향 범위
//   browser webview 이벤트 중 ac-webauthn·ac-botcheck 처리, 탭 우클릭의 Chrome 이어가기,
//   연결된 Chrome profile source 기록, autofill 조작 잠금, 공용 toast.
//   화면은 web/css/22-handoff.css 가 가진다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/handoff.js
//
// main을 import하지 않는다. 아직 모듈이 아닌 의존성은 init 표로만 받는다.
import { provide } from "../core/hooks.js";
let host = null;
let showToast = null;
let getProfileChromeSource = null;
let autofillBlocked = null;
let blog = null;

export function initHandoff(deps) {
  host = deps.acHost;
  showToast = deps.showToast;
  getProfileChromeSource = deps.getProfileChromeSource;
  autofillBlocked = deps.autofillBlocked;
  blog = deps.blog;
}

// 넘겨주기 막대. 토스트로는 부족하다. 사라지지 않아야 하고 누를 대상이 있어야 한다.
let handoffBarEl = null, handoffStageHooked = false;
const HANDOFF_STAGE = {
  launching: "연결된 Chrome 계정 프로필 여는 중…", seeding: "현재 탭 쿠키 옮기는 중…",
  filling: "쳐 넣은 값 옮기는 중…",
  waiting: "Chrome 창에서 로그인한 뒤 그 창을 닫으세요. 닫으면 가져옵니다",
  collecting: "창이 닫혔습니다. 쿠키 가져오는 중…", harvesting: "쿠키 가져오는 중…",
};
// 기다리는 동안에는 도는 표시가 있어야 한다. 글자만 바뀌면 멈춘 것처럼 보인다.
// 창을 닫고 나서 디스크에 쓰이길 기다리는 몇 초가 특히 그렇다.
const HANDOFF_SPIN_OFF = new Set(["waiting"]);

// 이 탭을 연결된 실제 Chrome 계정 프로필로 넘길 수 있는가.
export function handoffCheck(rec) {
  if (!rec || !rec.el) return { ok: false, why: "넘길 탭이 없습니다." };
  if (!host || !host.chromeAuth) return { ok: false, why: "이 빌드는 넘겨주기를 지원하지 않습니다." };
  let url = rec.url || "";
  try { if (!url && rec.el.getURL) url = rec.el.getURL(); } catch (e) {}
  if (!/^https?:/i.test(url)) return { ok: false, why: "http(s) 페이지만 넘길 수 있습니다." };
  const partition = rec.el.getAttribute("partition") || "";
  if (!partition) return { ok: false, why: "이 탭의 프로필을 알 수 없습니다." };
  let src = "";
  try {
    const profileId = /^persist:acprof:(.+)$/.exec(partition);
    if (profileId) src = getProfileChromeSource()[profileId[1]] || "";
  } catch (e) {}
  return { ok: true, url, partition, src };
}

// 지금 이 페이지에 입력한 값을 수집한다. 임시 창에서 같은 칸에 다시 넣기 위한 것으로,
// 방금 입력한 것을 다시 입력하게 하지 않는다. 값은 여기서 로그로 남기지 않는다(비번이 섞인다).
// 칸을 다시 찾는 키는 셋이다: id → name → 같은 type 안에서의 순번. 순번은 값이 빈 칸까지
// 세어야 양쪽이 같은 기준이 된다.
// 체크박스·라디오는 제외한다. 값이 아니라 켜짐 상태라서 같은 방식으로 옮기면 잘못 켜진다.
const CAPTURE_JS = `(function(){try{
  var SKIP=["hidden","submit","button","file","image","reset","checkbox","radio"];
  var out=[],cnt={};
  [].slice.call(document.querySelectorAll("input,textarea,select")).forEach(function(el){
    var t=String(el.type||"").toLowerCase();
    var i=(cnt[t]=(cnt[t]||0)); cnt[t]=i+1;
    if(SKIP.indexOf(t)>=0) return;
    var v=el.value||"";
    if(!v) return;
    out.push({id:el.id||"",name:el.name||"",type:t,tidx:i,value:String(v).slice(0,4096)});
  });
  return {url:String(location.href||""),fields:out.slice(0,40)};
}catch(e){return {url:"",fields:[]}}})()`;
async function captureFields(rec) {
  if (!rec || !rec.el || !rec.el.executeJavaScript) return { url: "", fields: [] };
  try {
    const r = await rec.el.executeJavaScript(CAPTURE_JS);
    return (r && Array.isArray(r.fields)) ? { url: String(r.url || ""), fields: r.fields } : { url: "", fields: [] };
  } catch (e) { return { url: "", fields: [] }; }
}

// 어느 탭이든 연결된 실제 Chrome 프로필로 넘긴다. 별도 user-data-dir Chrome을 만들지 않으므로
// 계정 프로필이 그대로 보이고 Dock에도 두 번째 Chrome 인스턴스가 생기지 않는다.
// 같은 탭이 연달아 넘기려 드는 것을 막는다. 페이지가 인증을 재시도하면 start가 여러 번 온다.
const handoffRecent = new WeakMap();
// auto: 감지로 저절로 열린 것(누르라고 하지 않고 바로 연다, 값은 안 싣는다)
// now: 사람이 버튼을 눌러 연 것(확인 한 번 더 묻지 않고 바로 연다, 값도 싣는다)
export function handoffToChrome(rec, reason, auto, now) {
  const chk = handoffCheck(rec);
  if (!chk.ok) { showToast(chk.why); return; }
  if (autofillBlocked(rec && rec.tabId)) { showToast("이 탭을 AI가 조작하는 중에는 넘길 수 없습니다."); return; }
  if (auto) {
    const last = handoffRecent.get(rec) || 0;
    if (Date.now() - last < 30000) return;   // 재시도 폭주로 창이 쏟아지지 않게
    handoffRecent.set(rec, Date.now());
  }
  if (handoffBarEl) handoffBarEl.remove();

  const bar = document.createElement("div");
  handoffBarEl = bar;
  bar.className = "hoff-bar";
  const spin = document.createElement("div");
  spin.className = "hoff-spin";
  bar.appendChild(spin);
  const txt = document.createElement("div");
  txt.className = "hoff-text";
  txt.textContent = reason || "이 탭을 Chrome에서 이어서 진행합니다.";
  bar.appendChild(txt);
  bar.__txt = txt;
  bar.__spin = spin;
  // 누를 대상이 남아 있는 동안에는 진행 표시를 돌리지 않는다. 사람을 기다리는 상태이기 때문이다.
  spin.style.display = (auto || now) ? "" : "none";

  const go = document.createElement("button");
  go.textContent = "Chrome에서 열기";
  go.className = "hoff-go";
  // 실패했을 때 다시 누를 자리를 만든다. 바로 여는 모드는 go를 처음엔 안 붙이므로 여기서 붙인다.
  const offerRetry = (label) => {
    if (bar.__spin) bar.__spin.style.display = "none";
    go.disabled = false; go.style.opacity = ""; go.textContent = label;
    if (!go.isConnected) bar.insertBefore(go, x);
  };
  const run = async () => {
    if (autofillBlocked(rec && rec.tabId)) { txt.textContent = "이 탭을 AI가 조작하는 중에는 넘길 수 없습니다."; return; }
    go.disabled = true; go.style.opacity = "0.6"; go.textContent = "여는 중…";
    if (bar.__spin) bar.__spin.style.display = "";
    if (!handoffStageHooked && host.onChromeAuthStage) {
      handoffStageHooked = true;
      host.onChromeAuthStage((s) => {
        if (!handoffBarEl || !handoffBarEl.__txt || !HANDOFF_STAGE[s.stage]) return;
        handoffBarEl.__txt.textContent = HANDOFF_STAGE[s.stage];
        if (handoffBarEl.__spin) handoffBarEl.__spin.style.display = HANDOFF_SPIN_OFF.has(s.stage) ? "none" : "";
      });
    }
    // 값 옮기기는 사람이 직접 눌렀을 때만 한다. 패스키·사람확인 감지로 저절로 열린 창에까지
    // 방금 입력한 비밀번호를 보내지 않는다. 사용자가 요청한 적 없는 전송이기 때문이다.
    // 값과 주소를 한 번에 수집한다. 따로 읽으면 그 사이 페이지가 이동했을 때 새 페이지에 입력한
    // 비밀번호를 이전 주소로 보내게 된다.
    const snap = auto ? { url: "", fields: [] } : await captureFields(rec);
    // 수집한 주소가 지금 열려는 주소와 다르면 값은 버린다. 다른 사이트에 값을 넣지 않기 위해서다.
    let sameOrigin = false;
    try { sameOrigin = !!snap.url && new URL(snap.url).origin === new URL(chk.url).origin; } catch (e) {}
    const fields = sameOrigin ? snap.fields : [];
    const dropped = snap.fields.length && !sameOrigin;
    try {
      const r = await host.chromeAuth(chk.url, chk.partition, chk.src, fields);
      if (r && r.ok) {
        const got = r.harvested || 0;
        // 값을 옮기지 못했으면 감추지 않는다. 왜 빈 칸인지 사용자가 알아야 한다.
        // 일부만 들어간 것도 알린다. 전부 옮겨졌다고 보면 빈 칸을 확인하지 못한다.
        const short = fields.length && (r.filled || 0) < fields.length;
        const missed = dropped ? " (페이지가 바뀌어 입력값은 안 옮겼습니다)"
          : !short ? ""
          : r.fillWhy === "wrong-page" ? " (그 창이 다른 페이지라 입력값은 안 넣었습니다)"
            : ` (입력값 ${fields.length}칸 중 ${r.filled || 0}칸만 옮겼습니다)`;
        if (bar.__spin) bar.__spin.style.display = "none";
        // 지금 적용되는 것과 앱을 다시 켜야 적용되는 것을 구분해 알린다. 합쳐서 "가져왔습니다"라고만
        // 하면, 새로고침해도 여전히 로그아웃인 이유를 알 수 없다.
        const later = r.staged || 0;
        const head = later
          ? `쿠키 ${got}개 중 ${r.live || 0}개를 가져왔습니다. 나머지 ${later}개는 앱을 다시 켜면 들어옵니다`
          : `가져왔습니다(쿠키 ${got}개)`;
        txt.textContent = `${head}${missed}. 탭을 새로고침합니다.`;
        go.remove();
        setTimeout(() => {
          try { rec.el.reload(); } catch (e) {}
          // 다시 켜야 하는 것이 남았으면 막대를 그대로 둔다. 막대가 사라지면 그 안내도 함께 사라진다.
          if (!later && handoffBarEl === bar) { bar.remove(); handoffBarEl = null; }
        }, 1200);
      } else {
        txt.textContent = "넘겨주기 실패: " + ((r && r.error) || "알 수 없는 오류");
        offerRetry("다시 시도");
      }
    } catch (e) {
      txt.textContent = "넘겨주기 실패: " + (e && e.message ? e.message : String(e));
      offerRetry("다시 시도");
    }
  };
  go.onclick = run;
  // 바로 여는 경우엔 누르라고 하지 않는다. 막대는 진행 상황을 보여주는 자리로만 남는다.
  if (!auto && !now) bar.appendChild(go);

  const x = document.createElement("button");
  x.textContent = "닫기";
  x.className = "hoff-close";
  x.onclick = () => { bar.remove(); handoffBarEl = null; };
  bar.appendChild(x);
  document.body.appendChild(bar);
  if (auto || now) run();
}

// 왜 이 창에서 안 되는지 알리고, 넘길 수 있는 탭이면 같은 막대에 "Chrome에서 열기"를 붙인다. 감지가
// 스스로 창을 열고 닫으면서 쿠키까지 가져가지 않도록 여는 것은 사람이 누를 때만 한다.
function handoffHint(rec, text) {
  if (!rec || !rec.el || !rec.el.classList.contains("active")) return;  // 보이지 않는 탭에서는 알리지 않는다
  if (handoffCheck(rec).ok) { handoffToChrome(rec, text + " Chrome에서 이어서 진행하세요."); return; }
  if (handoffBarEl) handoffBarEl.remove();
  const bar = document.createElement("div");
  handoffBarEl = bar;
  bar.className = "hoff-bar";
  const t = document.createElement("div");
  t.className = "hoff-text";
  t.textContent = text;
  bar.appendChild(t);
  const x = document.createElement("button");
  x.textContent = "닫기";
  x.className = "hoff-close";
  x.onclick = () => { bar.remove(); handoffBarEl = null; };
  bar.appendChild(x);
  document.body.appendChild(bar);
}

// 패스키 감지. 알림을 띄우는 지점이며 여기서 창을 열지 않는다.
export function webauthnNotice(m, tabUrl, partition, wv, rec) {
  if (!m) return;
  // ready는 문서마다 발생해 소음이라 남기지 않고, 실제 인증 시도만 로그로 남긴다. 알림이 뜨지 않는다는
  // 신고가 오면 이 로그가 "페이지가 호출하지 않았다"와 "감지하지 못했다"를 구분해 준다.
  if (m.phase !== "ready") { try { blog("[browser] WA " + JSON.stringify(m).slice(0, 180)); } catch (e0) {} }
  if (m.phase === "ready" || m.phase === "probe") return;
  if (m.phase === "end") { if (handoffBarEl) { handoffBarEl.remove(); handoffBarEl = null; } return; }
  if (m.phase !== "start") return;
  if (m.platform) {
    // 보안키는 이 창에서도 동작할 수 있으므로, 넘기라고 하기 전에 연결해 보라고 알린다.
    if (handoffBarEl) handoffBarEl.remove();
    const bar = document.createElement("div");
    handoffBarEl = bar;
    bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:9999;"
      + "padding:12px 14px;background:#16181d;color:#e8e8ea;border:1px solid #343841;border-radius:10px;"
      + "box-shadow:0 8px 28px rgba(0,0,0,.45);font-size:13px;max-width:min(620px,92vw);";
    bar.textContent = (m.host || "이 페이지") + " 에 보안키로 로그인하는 중입니다. 보안키를 꽂고 터치하세요.";
    document.body.appendChild(bar);
    return;
  }
  // 자동으로 창을 열지 않는다. 창이 저절로 열리고 닫히면 사용자가 무슨 일이 일어났는지 모른 채
  // 세션만 바뀐다. 왜 막혔는지 알리고, 여는 것은 사용자가 막대의 "Chrome에서 열기"로 정한다.
  handoffHint(rec, (m.host || "이 페이지") + " 이(가) 패스키를 요구합니다. 이 창은 지문을 띄울 수 없습니다.");
}

// 사람 확인(Cloudflare Turnstile) 실패. 패스키와 같은 알림 지점이지만 이유가 다르다.
// 패스키는 이 창에 지문 대화상자가 없기 때문이고, 이것은 이 창이 사람 확인을 통과하지 못하기 때문이다
// (browser-hardening.cjs의 BOTCHECK_SCRIPT 위 확인 결과표). 둘 다 해결책은 진짜 Chrome 으로 넘기는 것이다.
export function botCheckNotice(m, rec) {
  if (!m || !rec) return;
  // 광고·분석 프레임이 자기 위젯을 실패시키는 경우까지 사람을 부르지 않는다. 사람이 지금
  // 하려던 일은 최상위 문서에 있다.
  if (!m.top) return;
  try { blog("[browser] botcheck " + JSON.stringify(m).slice(0, 180)); } catch (e) {}
  // 여기서도 자동으로 열지 않는다(위와 같은 이유).
  handoffHint(rec, (m.host || "이 페이지") + " 의 사람 확인이 이 창에서는 통과되지 않습니다.");
}

// 이 기능의 연결. 표에는 선언만 두고 연결 방법은 각 기능이 가진다.
export function initCapability(ctx) {
  initHandoff({
    acHost: ctx.acHost, showToast: ctx.showToast,
    getProfileChromeSource: ctx.getProfileChromeSource,
    autofillBlocked: ctx.autofillBlocked, blog: ctx.blog,
  });
  // 탭 우클릭 메뉴의 한 줄. 넘길 수 없는 탭이면 아무것도 내주지 않고, 앱 셸이 빈 항목을 거른다.
  provide("handoff.tabItem", (rec) => (handoffCheck(rec).ok ? {
    label: "Chrome에서 이어서 진행",
    act: () => handoffToChrome(rec, "이 탭을 Chrome에서 이어서 진행합니다. 끝나면 로그인을 가져옵니다."),
  } : null));
  provide("handoff.webauthnNotice", (m, tabUrl, partition, wv, rec) => webauthnNotice(m, tabUrl, partition, wv, rec));
  provide("handoff.botCheckNotice", (m, rec) => botCheckNotice(m, rec));
  return {};
}
