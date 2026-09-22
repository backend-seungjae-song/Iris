// 이 브라우저에서 새로 로그인한 것을 금고에 담는다. 가져오기의 반대 방향이다.
//
// 소유 범위
//   수집한 로그인의 저장 여부 판정과, 사용자에게 묻는 막대. 저장은 사람이 누른 뒤에만 일어난다.
//
// 제공 API
//   initCapability(ctx). 이 기능의 진입점으로 앱 셸이 부르는 이름 하나를 채운다(savelogin.offer).
//   initSaveLogin(deps) · saveDecision(순수 판정) · offerSaveLogin(게스트가 수집한 것을 받는 지점).
//
// 의존 대상
//   Electron acHost 연결(getCreds·credsPassword·saveCred)과 main 소유의 toast·조작 잠금.
//   수집하는 쪽은 native/electron/webview-preload.cjs 의 ac-login-captured 채널이다.
//
// 유지 조건
//   AI가 그 탭을 조작 중이면 저장하지 않는다. 조작으로 채워 넣은 값이 금고에 남기 때문이다.
//   묻지 않고 저장하지 않는다. Chrome 쪽 저장소는 이 경로가 절대 건드리지 않는다(읽기 전용).
//   이 파일을 앱 셸이 정적으로 import 하면 "끈 기능은 로드되지 않는다"가 깨진다. 앱 셸은 이름만 부른다.
//   본 창과 분리 브라우저 창 둘 다에서 동작한다(표의 windows). 로그인은 어느 창에서든 한다.
//
// 영향 범위
//   web/js/browser/webview-factory.js 의 ipc-message 처리(savelogin.offer 로 부른다),
//   native/electron/credential-{service,ipc}.cjs, native/electron/preload.cjs 의 saveCred 연결.
//   화면은 web/css/23-save-login.css 가 가진다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/save-login.js

import { provide } from "../core/hooks.js";

let host = null;
let showToast = null;
let autofillBlocked = null;

export function initSaveLogin(deps) {
  host = deps.acHost;
  showToast = deps.showToast;
  autofillBlocked = deps.autofillBlocked;
}

// 이번 세션에 "안 함"을 누른 대상이다. 다시 묻지 않는다. 사이트마다 로그인 버튼을 여러 번 누르는
// 화면이 있어, 기억하지 않으면 같은 위치에서 막대가 계속 뜬다.
const dismissed = new Set();
export function saveKey(origin, username) { return String(origin) + "\n" + String(username); }

// 판정만 분리해 둔다. 막대와 얽혀 있으면 "조작 중에도 저장되는가"를 검사가 확인할 수 없다.
// known: 금고에 이미 있는 그 계정의 비밀번호(없으면 null).
export function saveDecision(o) {
  if (!o || !o.origin || !o.username || !o.password) return "ignore";
  if (!/^https?:\/\//.test(o.origin)) return "ignore";
  if (o.blocked) return "blocked";
  if (o.dismissed) return "ignore";
  if (o.known && o.known === o.password) return "ignore";  // 이미 같은 것이 들어 있다
  return o.known ? "update" : "new";
}

let barEl = null;
function closeBar() { if (barEl) { try { barEl.remove(); } catch {} barEl = null; } }

function askBar(text, okLabel, onOk, onNo) {
  closeBar();
  const bar = document.createElement("div");
  barEl = bar;
  bar.setAttribute("data-save-login", "1");
  bar.className = "slog-bar";
  const t = document.createElement("div");
  t.className = "slog-text";
  t.textContent = text;
  bar.appendChild(t);
  const ok = document.createElement("button");
  ok.textContent = okLabel;
  ok.className = "slog-ok";
  ok.onclick = () => { closeBar(); onOk(); };
  bar.appendChild(ok);
  const no = document.createElement("button");
  no.textContent = "안 함";
  no.className = "slog-no";
  no.onclick = () => { closeBar(); onNo(); };
  bar.appendChild(no);
  document.body.appendChild(bar);
}

// 게스트가 로그인 폼을 제출한 순간 이 지점으로 온다. 비밀번호가 렌더러에 머무는 시간은 사용자가
// 누를 때까지다. 누르면 main으로 넘기고 여기서는 해제한다.
export async function offerSaveLogin(cap, tabId, partition) {
  if (!cap || !host || !host.saveCred) return "ignore";
  const blocked = !!(autofillBlocked && autofillBlocked(tabId));
  let known = null;
  if (!blocked) {
    try {
      const creds = host.getCreds ? await host.getCreds(partition, cap.origin) : [];
      const hit = (creds || []).some((c) => c && c.username === cap.username);
      if (hit && host.credsPassword) {
        known = (await host.credsPassword(partition, cap.origin, cap.username)) || null;
      }
    } catch {}
  }
  const verdict = saveDecision({
    origin: cap.origin, username: cap.username, password: cap.password,
    blocked, known, dismissed: dismissed.has(saveKey(cap.origin, cap.username)),
  });
  if (verdict !== "new" && verdict !== "update") return verdict;
  const site = String(cap.origin).replace(/^https?:\/\//, "");
  askBar(
    verdict === "update"
      ? `${site} 의 ${cap.username} 비밀번호가 바뀌었습니다. 금고를 새 것으로 바꿀까요?`
      : `${site} 의 ${cap.username} 로그인을 금고에 저장할까요?`,
    verdict === "update" ? "바꾸기" : "저장",
    async () => {
      try {
        const r = await host.saveCred(partition, {
          origin: cap.origin, url: cap.url || cap.origin,
          username: cap.username, password: cap.password,
        });
        if (r && r.ok) showToast(verdict === "update" ? "비밀번호를 바꿨습니다." : "금고에 저장했습니다.");
        else showToast("저장하지 못했습니다.");
      } catch { showToast("저장하지 못했습니다."); }
    },
    () => { dismissed.add(saveKey(cap.origin, cap.username)); },
  );
  return verdict;
}

// 이 기능의 연결. 표에는 선언만 두고 연결 방법은 각 기능이 가진다.
export function initCapability(ctx) {
  initSaveLogin({ acHost: ctx.acHost, showToast: ctx.showToast, autofillBlocked: ctx.autofillBlocked });
  provide("savelogin.offer", (cap, tabId, partition) => offerSaveLogin(cap, tabId, partition));
  return {};
}
