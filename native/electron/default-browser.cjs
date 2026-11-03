// 다른 앱에서 누른 웹 링크의 수신. macOS 기본 브라우저 선택과 받은 링크의 공유 브라우저 창 전달
//
// 소유 범위
//   기본 브라우저 후보 조회·변경(LaunchServices), open-url 로 받은 링크의 대기열과 공유 창 전달.
//
// 제공 API
//   webLink(url) · linkTarget(value) · browserChoices(raw, selfId) · createLinkInbox(deps) · createDefaultBrowser(deps).
//
// 의존 대상
//   Electron require 없음. 창 열기와 osascript 실행 함수는 main.cjs 에서 받음
//
// 유지 조건
//   링크를 받을 앱의 기준은 macOS 기본 브라우저 하나. Iris 안에서 열 창(공유·세션 브라우저)만 앱 UI 상태에 저장
//   Chrome 선택 시 Iris 가 꺼져 있어도 링크가 Chrome 으로 바로 감
//   기본 브라우저 변경은 macOS 확인 창에서 사용자가 고른 뒤 반영. 변경 요청의 결과는 요청 여부까지이고
//   실제 값은 다시 조회해서 확인
//
// 영향 범위
//   main.cjs 의 open-url·IPC, preload 의 defaultBrowser, 설정 화면 「링크 열기」, web/js/main.js 의 공유 창 수신.

const IRIS_BUNDLE_ID = "app.iris.console";

// http·https 만 통과. 다른 스킴은 공유 창 탭으로 열 대상이 아님
function webLink(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}

// Iris 안에서 링크를 열 창. "session" 은 지금 보고 있는 스페이스의 브라우저, 그 밖의 값은 공유 브라우저 창
function linkTarget(value) { return value === "session" ? "session" : "shared"; }

// LaunchServices 의 https 처리 앱 목록을 설정 화면 후보로 변환
// 캐시 폴더 아래 앱(Playwright 의 테스트용 Chrome 등)은 사람이 설치한 브라우저가 아니라서 제외
function browserChoices(raw, selfId = IRIS_BUNDLE_ID) {
  const apps = Array.isArray(raw && raw.apps) ? raw.apps : [];
  const seen = new Set();
  const choices = [];
  for (const a of apps) {
    if (!a || typeof a.id !== "string" || !a.id || typeof a.path !== "string") continue;
    if (/\/Library\/Caches\//.test(a.path) || seen.has(a.id)) continue;
    seen.add(a.id);
    const self = a.id === selfId;
    choices.push({ id: a.id, name: self ? "Iris" : String(a.name || a.id), path: a.path, self });
  }
  choices.sort((x, y) => (y.self - x.self) || x.name.localeCompare(y.name, "ko"));
  const current = typeof (raw && raw.current) === "string" ? raw.current : null;
  return { current, choices, irisRegistered: choices.some((c) => c.self) };
}

// 받을 창 준비 전에 받은 링크의 대기열. 링크로 앱이 켜지면 창보다 링크가 먼저 도착
// openWindow(role): 그 창을 열거나 앞으로 가져옴. target(): 지금 설정된 받을 창("shared"·"session")
function createLinkInbox({ openWindow, isAppReady, target = () => "shared" }) {
  const queue = [];
  const ready = { shared: null, session: null };   // 수신 준비를 알린 창의 webContents

  function flush() {
    const wc = ready[linkTarget(target())];
    if (!wc || wc.isDestroyed() || !queue.length) return;
    const urls = queue.splice(0);
    for (const url of urls) wc.send("ac-inbound-link", { url });
  }
  function receive(url) {
    const link = webLink(url);
    if (!link) return false;
    queue.push(link);
    if (isAppReady()) { openWindow(linkTarget(target())); flush(); }
    return true;
  }
  // 앱 준비 완료 시 한 번 호출. 그 전에 받은 링크가 있으면 이때 창 열기
  function appReady() { if (queue.length) openWindow(linkTarget(target())); }
  // 창 렌더러의 수신 준비 알림. 새로고침 때마다 다시 호출
  function windowReady(wc, role = "shared") {
    ready[linkTarget(role)] = wc;
    flush();
  }
  return { receive, appReady, windowReady, pending: () => queue.length };
}

// 앱 목록과 현재 기본값을 한 번에 조회. URLsForApplicationsToOpenURL 은 시스템 설정의 기본 브라우저
// 목록과 같은 기준
const LIST_SCRIPT = `ObjC.import("AppKit"); ObjC.import("CoreServices");
const ws = $.NSWorkspace.sharedWorkspace, fm = $.NSFileManager.defaultManager;
const list = ws.URLsForApplicationsToOpenURL($.NSURL.URLWithString("https://example.com"));
const apps = [];
for (let i = 0; i < list.count; i++) {
  const p = list.objectAtIndex(i).path.js;
  const b = $.NSBundle.bundleWithPath(p);
  const id = b && b.bundleIdentifier ? b.bundleIdentifier.js : "";
  apps.push({ id, path: p, name: fm.displayNameAtPath(p).js.replace(/\\.app$/, "") });
}
const cur = ObjC.castRefToObject($.LSCopyDefaultHandlerForURLScheme($("https")));
JSON.stringify({ apps, current: cur ? cur.js : null });`;

const SET_SCRIPT = `ObjC.import("CoreServices");
function run(argv) {
  const id = argv[0];
  const a = $.LSSetDefaultHandlerForURLScheme($("http"), $(id));
  const b = $.LSSetDefaultHandlerForURLScheme($("https"), $(id));
  return JSON.stringify({ http: a, https: b });
}`;

function createDefaultBrowser({ execFile, platform = process.platform }) {
  function osa(script, args = []) {
    return new Promise((resolve) => {
      execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...args], { timeout: 8000 },
        (error, out) => resolve(error ? null : String(out || "").trim()));
    });
  }
  async function status() {
    if (platform !== "darwin") return { ok: false, error: "macOS에서만 바꿀 수 있습니다." };
    const out = await osa(LIST_SCRIPT);
    let raw = null;
    try { raw = JSON.parse(out); } catch {}
    if (!raw) return { ok: false, error: "브라우저 목록을 읽지 못했습니다." };
    return { ok: true, ...browserChoices(raw) };
  }
  // 방금 조회한 후보만 선택 가능. 렌더러가 보낸 문자열을 LaunchServices 에 그대로 넘기지 않기 위함
  async function choose(id) {
    const now = await status();
    if (!now.ok) return now;
    const pick = now.choices.find((c) => c.id === id);
    if (!pick) return { ok: false, error: "목록에 없는 앱입니다." };
    if (now.current === pick.id) return { ok: true, requested: false };
    const out = await osa(SET_SCRIPT, [pick.id]);
    let r = null;
    try { r = JSON.parse(out); } catch {}
    if (!r || r.http !== 0 || r.https !== 0) return { ok: false, error: "기본 브라우저를 바꾸지 못했습니다." };
    return { ok: true, requested: true };
  }
  return { status, choose };
}

module.exports = { IRIS_BUNDLE_ID, webLink, linkTarget, browserChoices, createLinkInbox, createDefaultBrowser };
