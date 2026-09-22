// 호스트 쪽 요소 지목. 페이지에 심는 오버레이 스크립트와, 콘솔 자기 화면(탭·북마크·그룹·
// docx·시트 칸)을 지목하는 라우터들.
//
// 소유 범위
//   webview 페이지에 주입하는 ORCA 오버레이 스크립트 문자열, 그리고 콘솔 화면의 어떤 요소를
//   집었는지 판정해 세션에 건네는 경로.
//
// 제공 API
//   ORCA_INJECT, 화면 종류별 지목 판정(pick*At), 그리고 전달(deliver*Pick).
//   deliver{Tab,Group,Site}PickLocal 도 내준다. 분리 브라우저 창에서 지목한 것은 서버를 거쳐
//   콘솔 창으로 중계되고, 그 중계를 받는 곳은 WS 표가 있는 main 이다. 셋을 내주지 않으면 그
// 지점은 정의 없는 이름을 부르게 되고, 지목은 아무 표시 없이 사라진다.
//
// 의존 대상
//   지목 모드와 공용 문구 조립은 browser/pick, 상태는 browser/state,
//   webview 는 browser/webview-store, 시트는 sheet/{model,render},
//   센터 탭은 center/tab-store 에서 import 한다.
//   wsSend·BROWSER_MODE·bNote·fileview 와 지금 고른 세션·터미널은 main 이 소유해서
//   init 에서 받는다.
//
// 유지 조건
//   주입 스크립트는 멱등이어야 한다. 최초 1회만 핸들러를 정의하고 이후엔 __orcaSet(on) 이
//   켜기/끄기를 정한다. 재주입해도 상태가 꼬이면 안 된다.
//   지목은 "지금 가라"가 아니라 "이것을 기억하고 쓰라"다. 여러 개를 찍어 건네는 것이 보통이고
//   언제 어떻게 쓸지는 받은 쪽이 정한다.
//   창이 이름을 지어내지 않는다. 부를 수 있는 이름은 서버가 매긴 핸들에서만 온다.
//   AGENTS 세션 값은 herdr 상태를 import 해서 얻지 않는다. 앱 셸이 initPickHost 로 넣어 준다.
//   그러지 않으면 기능을 꺼도 앱 셸의 파일이 로드되어 "끈 기능은 로드되지 않는다"가 깨진다.
//
// 영향 범위
//   콘솔 화면 전반의 지목 대상 DOM(.ctab · .tgroup · .bmk · .srow · 문서 · 표) 과 터미널로 붙여넣는 문구.
//   browser/pick 은 이 모듈을 import 하지 않는다. pickSheetElementAt 를 main 이 주입한다.
//   그러지 않으면 pick ↔ pick-host 순환이 생긴다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/pick-host.js
import { callHook } from "../core/hooks.js";
import { boundSpace } from "./state.js";
import { noticeBlock } from "../panel/xterm-wiring.js";
import { clearPickHover, deliverPick, docxCssPath, docxPickElementAt, pickMode } from "./pick.js";
import { getWebview } from "./webview-store.js";
import { getTabs } from "../center/tab-store.js";
import { fileKindById, isFileKindId } from "../core/file-kinds.js";

let wsSend, BROWSER_MODE, bNote, fileview, getCurTarget, getXterm;
let getLastAgents, orderedSpaces;

export function initPickHost(deps) {
  ({ wsSend, BROWSER_MODE, bNote, fileview, getCurTarget, getXterm } = deps);
  // AGENTS 목록의 값은 앱 셸이 가진다. 이 모듈 집합은 herdr 상태를 import 하지 않고 받아 쓴다.
  // 기능이 앱 셸의 파일을 직접 import 하면 끄고 켜는 경계가 깨진다.
  getLastAgents = deps.getLastAgents || (() => []);
  orderedSpaces = deps.orderedSpaces || (() => []);
  wirePickPointer();
}

// AGENTS 목록의 세션 한 줄. 사용자가 "저 세션"이라고 지목하는 유일한 대상이다.
export function pickAgentAt(target) {
  if (!pickMode) return null;
  if (!target || !target.closest) return null;
  const row = target.closest(".srow");
  if (!row || !row.dataset || !row.dataset.target) return null;
  const a = getLastAgents().find((x) => x && x.paneId === row.dataset.target);
  return a ? { el: row, a } : null;
}
// 고른 세션의 신원을 지금 보고 있는 터미널에 붙인다. 이 값이 없으면 "저 세션에 물어봐"를
// 받은 쪽이 같은 스페이스의 세션 전부에게 확인을 돌려야 한다.
// 그래서 실어야 하는 것은 설명이 아니라 부를 수 있는 주소, 즉 herdr 가 매긴 pane id 다.
export function deliverAgentPick(a) {
  if (!getCurTarget()) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  const sp = orderedSpaces().find((x) => x && x.id === a.workspaceId);
  const name = a.tabLabel || (a.cwd ? String(a.cwd).split("/").pop() : a.agent);
  const block = noticeBlock(`세션 지목 · ${name}`, [
    `주소: herdr pane ${a.paneId}`,
    `종류: ${a.agent || "?"}`,
    `상태: ${a.status || "?"}`,
    sp ? `스페이스: ${sp.label}` : null,
    a.cwd ? `폴더: ${a.cwd}` : null,
    a.sessionUuid ? `세션: ${a.sessionUuid}` : null,
    a.paneId === getCurTarget() ? "지금 이 세션 자신" : null,
    `읽기: herdr pane read ${a.paneId} --source recent --lines 50`,
    `보내기: herdr pane run ${a.paneId} "<명령>"`,
  ]);
  wsSend({ type: "pty.input", data: "\x1b[200~" + block + "\x1b[201~" });
  bNote.textContent = "세션 전달됨 → 터미널. 이어서 지시를 입력하고 Enter.";
  if (getXterm()) setTimeout(() => getXterm().focus(), 0);
}

// 요소 선택 모드: webview 페이지에 오버레이 스크립트를 주입해 hover 하이라이트 + 클릭 캡처.
// 캡처 결과는 main world → postMessage → webview preload → sendToHost('orca-pick')로 host에 전달.
// 멱등 구조: 최초 1회만 핸들러·함수를 정의하고, 이후엔 window.__orcaSet(on)이 켜기/끄기를
// 결정론적으로 처리한다(__orcaActive 가드로 중복/누락 없음). 재주입해도 상태가 꼬이지 않는다.
export const ORCA_INJECT = `(() => {
  if (!window.__orcaInit) {
    window.__orcaInit = true; window.__orcaActive = false;
    var HL = null, LB = null, last = null;
    // 다음 클릭을 요소 선택으로 받을 준비가 됐는가. 남의 앱에 가려져 있다가 올라온 직후에만
    // 잠시 false가 되고, 그 첫 클릭(창을 앞으로 부르는 클릭)을 삼킨 뒤 다시 true로 돌아온다.
    var armed = true;
    // 화면 고정 = dismiss 이벤트 억제만(타이머는 건드리지 않는다. SPA 영구정지·복구불가 방지).
    // 드롭다운·툴팁·포커스 팝업은 대부분 이 이벤트로 닫히므로 이것만 막아도 붙잡힌다.
    var FZ = ['blur','focusout','mouseout','mouseleave','pointerout','pointerleave'];
    var suppress = function (e) { e.stopImmediatePropagation(); };
    var cssSel = function (el) {
      if (el.id) return '#' + CSS.escape(el.id);
      var parts = [], e = el;
      for (var d = 0; e && e.nodeType === 1 && d < 5; e = e.parentElement, d++) {
        var s = e.tagName.toLowerCase();
        if (e.classList.length) s += '.' + [].slice.call(e.classList).slice(0,2).map(function (c) { return CSS.escape(c); }).join('.');
        var sibs = e.parentElement ? [].slice.call(e.parentElement.children).filter(function (x) { return x.tagName === e.tagName; }) : [];
        if (sibs.length > 1) s += ':nth-child(' + ([].indexOf.call(e.parentElement.children, e)+1) + ')';
        parts.unshift(s); if (e.id) break;
      }
      return parts.join(' > ');
    };
    // iframe 은 그 안의 문서가 스스로 고른다. 바깥 문서까지 <iframe> 상자를 칠하면 같은 위치에
    // 상자가 두 겹으로 뜨고, 누르면 내용이 아니라 바깥 프레임이 잡힌다.
    var isFrameBox = function (el) { return !!el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME'); };
    // 라벨에 적는 것: 태그·id·첫 class·크기. 이 넷이면 겹친 요소를 눈으로 가릴 수 있다.
    var labelOf = function (el) {
      var t = el.tagName.toLowerCase();
      if (el.id) t += '#' + el.id;
      else if (el.classList && el.classList.length) t += '.' + el.classList[0];
      var r = el.getBoundingClientRect();
      return t + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    };
    var paint = function (el) {
      if (isFrameBox(el)) return hideHL();
      if (!el || el === HL || el === LB || !HL) return; last = el;
      var r = el.getBoundingClientRect();
      HL.style.left = r.left+'px'; HL.style.top = r.top+'px'; HL.style.width = r.width+'px'; HL.style.height = r.height+'px';
      if (!LB) return;
      LB.textContent = labelOf(el);
      LB.style.display = 'block';
      // 위쪽에 공간이 없으면 상자 안으로 넣는다. 화면 밖으로 나가면 읽을 수 없다.
      var lh = 18;
      var top = r.top - lh - 2;
      if (top < 0) top = Math.min(r.top + 2, window.innerHeight - lh);
      LB.style.top = top + 'px';
      LB.style.left = Math.max(0, Math.min(r.left, window.innerWidth - 40)) + 'px';
    };
    var onMove = function (ev) { paint(ev.target); };
    // 좌표 기반 호버. 포커스가 다른 창에 있으면 이 창에는 mousemove가 오지 않는다(확인 결과: 5초 호버에 1건).
    // 그래서 호스트가 OS 커서 좌표를 넣어주면 elementFromPoint로 직접 해석한다.
    // 값이 비어 오면 이 창이 맨 위가 아니라는 뜻이므로 상자를 감춘다. 그대로 두면 움직이지 않을 뿐
    // 여전히 이 창이 반응하는 것으로 보인다.
    var hideHL = function () { if (HL) { HL.style.width = '0px'; HL.style.height = '0px'; } if (LB) LB.style.display = 'none'; last = null; };
    window.addEventListener('message', function (ev) {
      var d = ev.data; if (!d || !('__orcaHover' in d) || !window.__orcaActive) return;
      if (!d.__orcaHover) return hideHL();
      // 남의 앱에 가려져 있다가 방금 올라왔다면, 다음 클릭 한 번은 이 창을 앞으로 부르는 클릭이다.
      if (d.__orcaHover.entered) armed = false;
      try { paint(document.elementFromPoint(d.__orcaHover.x, d.__orcaHover.y)); } catch (e) {}
    });
    // 프레임워크 dev 소스 위치 추출. 정확한 위치 지정의 핵심이다. dev 빌드는 DOM 요소에 소스 파일:라인을
    // 심어둔다: React(@vitejs/plugin-react)는 fiber._debugSource, Vue는 컴포넌트 __file. 클래스가
    // generic하고 텍스트가 동적이어도 여기서 정확한 JSX/템플릿 위치가 나온다.
    var frameworkSource = function (el) {
      try {
        // React: __reactFiber$*(또는 구버전 __reactInternalInstance$*) 키에서 fiber를 얻는다.
        var rk = null, ks = Object.keys(el);
        for (var i = 0; i < ks.length; i++) { if (ks[i].indexOf('__reactFiber$') === 0 || ks[i].indexOf('__reactInternalInstance$') === 0) { rk = ks[i]; break; } }
        if (rk) {
          var comp = null;
          for (var n = el[rk]; n; n = n.return) {
            if (!comp && typeof n.type === 'function') comp = n.type.displayName || n.type.name || null;
            if (n._debugSource && n._debugSource.fileName) return { file: n._debugSource.fileName, line: n._debugSource.lineNumber || null, component: comp, framework: 'react' };
          }
          if (comp) return { component: comp, framework: 'react' };
        }
        // Vue 3: __vueParentComponent.type.__file / Vue 2: __vue__.$options.__file
        var vc = el.__vueParentComponent;
        if (vc && vc.type && vc.type.__file) return { file: vc.type.__file, component: vc.type.__name || vc.type.name || null, framework: 'vue' };
        if (el.__vue__ && el.__vue__.$options && el.__vue__.$options.__file) return { file: el.__vue__.$options.__file, framework: 'vue' };
      } catch (e) {}
      return null;
    };
    // 재현 스크립트가 쓰는 것과 같은 규칙의 선택자: 문서에서 유일해질 때까지 조상을 붙여 올린다.
    // 기존 cssSel(사람이 읽는 경로)은 그대로 두고 이 값을 별도 필드로 얹는다.
    var uniqOne = function (s) { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };
    var uniqStep = function (e) {
      var s = e.tagName.toLowerCase();
      var tid = e.getAttribute && (e.getAttribute('data-testid') || e.getAttribute('data-test') || e.getAttribute('name'));
      if (tid) return s + '[' + (e.getAttribute('data-testid') ? 'data-testid' : e.getAttribute('data-test') ? 'data-test' : 'name') + '=' + JSON.stringify(tid) + ']';
      if (e.classList.length) s += '.' + [].slice.call(e.classList).slice(0, 2).map(function (c) { return CSS.escape(c); }).join('.');
      var sibs = e.parentElement ? [].slice.call(e.parentElement.children).filter(function (x) { return x.tagName === e.tagName; }) : [];
      if (sibs.length > 1) s += ':nth-of-type(' + ([].filter.call(e.parentElement.children, function (x) { return x.tagName === e.tagName; }).indexOf(e) + 1) + ')';
      return s;
    };
    var uniqSel = function (el) {
      if (!el || el.nodeType !== 1) return null;
      if (el.id && uniqOne('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
      var parts = [], e = el, cand = null;
      for (var d = 0; e && e.nodeType === 1 && e !== document.documentElement && d < 12; e = e.parentElement, d++) {
        parts.unshift(uniqStep(e));
        cand = parts.join(' > ');
        if (uniqOne(cand)) return cand;
      }
      return cand;
    };
    // 고른 요소는 그대로 터미널과 기록 파일로 나간다. 그 안에 인증 토큰·비밀번호가 포함되어 있으면
    // 사용자가 의도하지 않은 값이 대화와 파일에 영구히 남는다. 주소의 토큰 파라미터와 입력칸의
    // 실제 값은 여기서, 나가기 전에 지운다(사용자가 고른 것은 "어느 요소인가"이지 그 값이 아니다).
    var SECRET_Q = /^(access_?token|id_?token|refresh_?token|token|code|auth|authorization|session|sid|password|passwd|pwd|secret|api_?key|key|signature|sig)$/i;
    var redactUrl = function (u) {
      try {
        var x = new URL(u, location.href), touched = false;
        x.searchParams.forEach(function (v, k) { if (SECRET_Q.test(k) && v) touched = true; });
        if (touched) x.searchParams.forEach(function (v, k) { if (SECRET_Q.test(k) && v) x.searchParams.set(k, 'REDACTED'); });
        if (x.hash && /(^|[#&])(access_token|id_token|token|code)=/i.test(x.hash)) x.hash = '#REDACTED';
        return x.href;
      } catch (e) { return u; }
    };
    // 비밀번호 칸과 사람이 친 값은 길이만 남긴다. 값 자체는 요소를 다시 찾는 데 필요 없다.
    var redactVal = function (el, an, av) {
      var t = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
      if (an === 'value' && (t === 'password' || t === 'hidden')) return 'REDACTED(' + String(av).length + ')';
      if (SECRET_Q.test(an)) return 'REDACTED';
      return av;
    };
    var capture = function (el) {
      // 소스 grep에 쓸모있는 속성만 추린다(class·style 제외. class는 별도, style은 노이즈).
      var KEEP = ['id','href','src','alt','title','role','type','name','placeholder','value','for'];
      var attrs = [];
      if (el.attributes) for (var ai = 0; ai < el.attributes.length; ai++) {
        var an = el.attributes[ai].name, av = el.attributes[ai].value || '';
        if (an === 'class' || an === 'style') continue;
        if (KEEP.indexOf(an) >= 0 || an.indexOf('data-') === 0 || an.indexOf('aria-') === 0) {
          av = redactVal(el, an, av);
          if (an === 'href' || an === 'src') av = redactUrl(av);
          attrs.push(an + '="' + (av.length > 60 ? av.slice(0, 60) + '…' : av) + '"');
        }
        if (attrs.length >= 8) break;
      }
      // outerHTML 에도 같은 값이 들어 있어, 속성만 가리고 HTML 을 그대로 보내면 효과가 없다.
      var html = el.outerHTML.replace(/\\s+/g, ' ');
      html = html.replace(/(\\b(?:value|href|src|content)\\s*=\\s*")([^"]*)"/gi, function (all, head, v) {
        return SECRET_Q.test(v) || /[?&#](access_?token|id_?token|token|code|auth|session|sid|api_?key)=/i.test(v)
          ? head + redactUrl(v) + '"' : all;
      });
      if ((el.getAttribute && (el.getAttribute('type') || '').toLowerCase()) === 'password')
        html = html.replace(/(value\\s*=\\s*")([^"]*)"/i, '$1REDACTED"');
      var pick = {
        tag: el.tagName.toLowerCase(), id: el.id || null, cls: [].slice.call(el.classList),
        selector: cssSel(el), usel: uniqSel(el), text: (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,120),
        href: redactUrl(el.getAttribute && el.getAttribute('href') || '') || null,
        attrs: attrs, title: (document.title || '').trim().slice(0, 80),
        html: html.slice(0, 400),
        url: redactUrl(location.href), top: (window.top === window), src: frameworkSource(el),
      };
      // 안정 전달: main world → (webview preload) postMessage → sendToHost 'orca-pick'.
      try { window.postMessage({ __orca: 'pick', pick: pick }, '*'); } catch (e) {}
      };
    // 상호작용 완전 억제. pointerdown에서 즉시 캡처하고, 이후 클릭·이동·포커스 변화를 모두 삼킨다.
    var swallow = function (ev) { ev.preventDefault(); ev.stopImmediatePropagation(); };
    var onDown = function (ev) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      // 다른 앱에 가려져 있다가 올라온 직후의 첫 클릭은 삼킨다. 픽 모드에서는 이 창이 포커스를
      // 받지 않고 첫 클릭이 그대로 콘텐츠로 가므로(acceptFirstMouse), 시뮬레이터에서 위젯을
      // 고르고 콘솔로 돌아오는 클릭이 엉뚱한 요소로 전송됐다. 페이지 상호작용은 위에서 이미
      // 막았으니 여기서 빠져도 화면은 눌리지 않는다. 같은 위치를 한 번 더 누르면 그때 잡힌다.
      if (!armed) { armed = true; return; }
      var el = ev.target && ev.target !== HL ? ev.target : last;
      if (isFrameBox(el)) return;   // 그 안의 문서가 자기 요소를 보내므로 바깥 프레임을 대신 보내지 않는다
      if (el && el.nodeType === 1) capture(el);
    };
    var SUPPRESS = ['mousedown','mouseup','click','dblclick','auxclick','contextmenu','submit','keydown','keyup','keypress','focusin','wheel','touchstart','touchend'];
    window.__orcaSet = function (on) {
      try {
        if (on && !window.__orcaActive) {
          window.__orcaActive = true;
          // 켤 때는 바로 받을 준비가 된 상태다. 켜는 행위 자체가 이 창을 보고 있다는 뜻이다.
          armed = true;
          HL = document.createElement('div');
          HL.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:rgba(244,161,167,.18);border:2px solid #F4A1A7;border-radius:3px;transition:all .03s;';
          document.documentElement.appendChild(HL);
          // 무엇이 잡혔는지 상자 옆에 적는다. 상자만 그리면 겹쳐 있는 요소 중 지금 잡힌 것이
          // 버튼인지 그것을 감싼 상자인지 누르기 전에 알 수 없다(중첩 iframe 에서 특히 그렇다).
          LB = document.createElement('div');
          LB.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#F4A1A7;color:#1a1a1a;'
            + 'font:600 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 6px;border-radius:3px;white-space:nowrap;'
            + 'max-width:60vw;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 4px rgba(0,0,0,.3);';
          document.documentElement.appendChild(LB);
          document.addEventListener('mousemove', onMove, true);
          document.addEventListener('pointerdown', onDown, true);
          SUPPRESS.forEach(function (t) { document.addEventListener(t, swallow, true); });
          FZ.forEach(function (t) { document.addEventListener(t, suppress, true); });
        } else if (!on && window.__orcaActive) {
          window.__orcaActive = false;
          if (HL) { HL.remove(); HL = null; }
          if (LB) { LB.remove(); LB = null; }
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('pointerdown', onDown, true);
          SUPPRESS.forEach(function (t) { document.removeEventListener(t, swallow, true); });
          FZ.forEach(function (t) { document.removeEventListener(t, suppress, true); });
        }
      } catch (e) {}
    };
  }
  window.__orcaSet(!!window.__orcaDesired);
})();`;
// 픽 모드 중 탭 클릭 = 탭 전환이 아니라 "이 탭을 이 세션의 제어 대상으로" 지목. 캡처 단계에서
// 기존 탭 전환 핸들러보다 먼저 가로챈다.
// 탭 전환은 click(버블)에 걸려 있어 pointerdown만 막으면 뒤따르는 click이 그대로 전환시킨다.
// 그래서 지목은 pointerdown에서 하고, 이어지는 마우스 이벤트 전부를 캡처 단계에서 삼킨다.
export function pickTabAt(target) {
  const el = target && target.closest ? target.closest(".ctab") : null;
  const id = el && el.dataset ? el.dataset.tab : null;
  if (!id) return null;
  const rec = getWebview(id);
  if (rec && rec.wc) return { el, rec, id };
  // 문서 탭(docx/sheet)은 webview가 없어 여기서 null 이 되고 지목 자체가 되지 않는다. webview
  // 자동화 대상으로 묶을 순 없지만(CDP로 잡을 webContents 자체가 없음), 탭 자체를 지목해 설명을
  // 전달하는 것까진 가능하다.
  const sp = boundSpace();
  const local = getTabs(sp).find((x) => x.id === id);
  if (local && isFileKindId(local.kind)) return { el, rec: null, id, docTab: local };
  return null; // 그 외(파일 탭 등)는 평소대로 null
}
// 북마크도 지목 대상이다. 탭·그룹이 "어디서 일할지"라면 북마크는 "어디로 갈지"다. 주소를 받아
// 적어 주는 대신 눌러서 넘긴다.
export function pickBmkAt(target) {
  const el = target && target.closest ? target.closest(".bmk") : null;
  const url = el && el.dataset ? el.dataset.url : null;
  if (!url) return null;
  return { url, title: (el.querySelector(".bmk-t")?.textContent || "").trim() };
}
// 그룹 칩도 지목 대상이다. 세션이 그룹 단위로 작업하므로 탭을 하나씩 지목하는 것은 흐름과 맞지 않는다.
export function pickGroupAt(target) {
  const el = target && target.closest ? target.closest(".tgroup") : null;
  const id = el && el.dataset ? el.dataset.group : null;
  return id ? { el, id } : null;
}
// 문서 탭 안의 콘텐츠도 요소 선택 대상이다. docx는 webview가 아니라 이 페이지 자체의 DOM이라
// 주입 스크립트 없이 바로 집을 수 있다.
// 전달은 새로 만들지 않고 기존 deliverPick(webview 요소 선택용)을 그대로 쓴다. relay·녹화 통합·
// pid 부여가 이미 되어 있어 중복으로 만들지 않는다.
// 범위는 본문(.docx-view-root)만이 아니라 패널 전체(.docx-editor-shell)다. 헤더 메뉴(.gd-menu)·
// 툴바(.gd-tb)도 지목 대상이어야 "이 헤더가 이상하다"처럼 크롬 자체를 짚어 전달할 수 있다.
export function pickDocxAt(target) {
  const hit = docxPickElementAt(target);
  if (!hit) return null;
  const { t, el } = hit;
  // 클릭 시점에는 이 el이 호버 미리보기로 pick-hover 클래스를 달고 있을 수 있다. 그대로 읽으면
  // 표시용 클래스가 선택자·HTML·cls에 섞여 나간다(확인 결과: 실제 문서에 없는
  // "pick-hover"가 선택자·HTML에 그대로 기록됐다). cls/selector/html을 읽기 전에 제거한다.
  clearPickHover(el);
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300);
  return {
    el, tabId: t.id, tag: el.tagName.toLowerCase(), cls: Array.from(el.classList || []), text,
    selector: docxCssPath(el), html: (el.outerHTML || "").slice(0, 500),
    title: t.label || (t.path || "").split("/").pop(), url: "docx:" + (t.path || ""),
  };
}
// 호버 미리보기가 없으면 클릭해야 무엇이 잡힐지 알 수 있다. 탭·요소 픽(pick-hover 클래스, ORCA 오버레이)은
// 모두 호버 미리보기가 있는데 docx만 없으면 선택은 되지만 화면에 아무것도 표시되지 않는다.
// 별도 mousemove 리스너로 만들면, 이 창이 픽 모드 중 포커스 불가 상태라
// (setBrowserWinsFocusable) 네이티브 mousemove가 거의 오지 않는다. 탭/그룹/북마크 호버가 같은
// 문제를 해결한 방법(OS 커서 좌표를 acHost.onCursor로 받아 elementFromPoint로 직접 해석)이
// 아래에 있다. docx도 새로 만들지 않고 그 경로에 얹는다.
export function pickCellAt(target) {
  if (!pickMode) return null;
  const t = callHook("viewer.activeSheetTab");
  if (!t) return null;
  const cell = callHook("viewer.sheetCellAt", target);
  if (!cell || !fileview.contains(cell)) return null;
  const r = Number(cell.dataset.r), c = Number(cell.dataset.c);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
  return { r, c, addr: callHook("viewer.colName", c) + r, text: cell.textContent || "", tabId: t.id, path: t.path };
}
// Sheet도 문서 탭과 같은 이유로 요소 선택 대상이다. 그리드 칸(pickCellAt)만 잡으면
// 메뉴바·도구 모음·수식 입력줄 같은 나머지 화면은 호버 미리보기도 뜨지 않고 클릭해도 아무것도
// 잡히지 않는다. docx와 같은 좌표 기반 해석(docxCssPath 재사용)을 그대로 쓰되, 칸 자체는
// 이미 pickCellAt이 주소·값까지 딸린 더 구체적인 정보로 다루므로 여기선 그 밖의 영역만 잡는다.
export function pickSheetElementAt(target) {
  if (!pickMode) return null;
  const t = callHook("viewer.activeSheetTab");
  if (!t || fileview.hidden) return null;
  if (!target || !target.closest || !fileview.contains(target)) return null;
  if (callHook("viewer.sheetCellAt", target)) return null; // 칸은 pickCellAt이 처리
  const el = target.closest("[class]") || target;
  if (el === fileview) return null; // 패널 바깥 여백은 지목 대상 아님
  return { t, el };
}
export function pickSheetAt(target) {
  const hit = pickSheetElementAt(target);
  if (!hit) return null;
  const { t, el } = hit;
  clearPickHover(el);
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300);
  return {
    el, tabId: t.id, tag: el.tagName.toLowerCase(), cls: Array.from(el.classList || []), text,
    selector: docxCssPath(el), html: (el.outerHTML || "").slice(0, 500),
    title: t.label || (t.path || "").split("/").pop(), url: "sheet:" + (t.path || ""),
  };
}
// 지목 중 눌린 위치를 잡는다. 기존 최상위 부작용이라 init 에서 부른다.
function wirePickPointer() {
  // 지목 중에는 탭 전환·닫기·이름변경·북마크 이동·문서 캐럿 이동을 전부 삼킨다.
  // capture 등록 순서가 중요하므로 기존 최상위와 같은 시점에 건다.
  for (const type of ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"]) {
    document.addEventListener(type, (e) => {
      if (!pickMode || (!pickTabAt(e.target) && !pickGroupAt(e.target) && !pickBmkAt(e.target) && !pickAgentAt(e.target) && !pickCellAt(e.target) && !pickDocxAt(e.target) && !pickSheetAt(e.target))) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    }, true);
  }

  document.addEventListener("pointerdown", (e) => {
    if (!pickMode) return;
    const g = pickGroupAt(e.target);
    if (g) {
      e.preventDefault(); e.stopPropagation();
      deliverGroupPick({ group: g.id, space: boundSpace(), label: (g.el.textContent || "그룹").replace(/^[▶▼]\s*/, "").replace(/\s*\d+$/, "").trim() });
      return;
    }
    const bm = pickBmkAt(e.target);
    if (bm) {
      e.preventDefault(); e.stopPropagation();
      deliverSitePick(bm);
      return;
    }
    const ag = pickAgentAt(e.target);
    if (ag) {
      e.preventDefault(); e.stopPropagation();
      clearPickHover(ag.el);
      deliverAgentPick(ag.a);
      return;
    }
    const cell = pickCellAt(e.target);
    if (cell) {
      e.preventDefault(); e.stopPropagation();
      deliverCellPick(cell);
      return;
    }
    const doc = pickDocxAt(e.target);
    if (doc) {
      e.preventDefault(); e.stopPropagation();
      deliverPick(doc, doc.tabId);
      return;
    }
    const sheetEl = pickSheetAt(e.target);
    if (sheetEl) {
      e.preventDefault(); e.stopPropagation();
      deliverPick(sheetEl, sheetEl.tabId);
      return;
    }
    const hit = pickTabAt(e.target); if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    const label = (hit.el.querySelector(".cname")?.textContent || "브라우저").trim();
    if (hit.docTab) { deliverDocTabPick(hit.docTab); return; } // webview 없음. 자동화 대상 지정이 아니라 설명 전달
    deliverTabPick({ wc: hit.rec.wc, tabId: hit.rec.tabId || hit.id || null, label, url: hit.rec.url || "", title: hit.rec.title || "" });
  }, true);
}
// 문서 탭 지목. CDP로 잡을 webview가 없어 browser-target-set(자동화 대상 고정)은 쓸 수 없다. 대신
// 어느 파일 탭인지 설명을 터미널로 보낸다(cell-pick과 같은 패턴).
function deliverDocTabPick(t) {
  if (!getCurTarget()) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  const block = noticeBlock(`문서 탭 지목 · ${t.label || (t.path || "").split("/").pop()}`, [
    `종류: ${(fileKindById(t.kind) || {}).docLabel || "문서"}`,
    `경로: ${t.path}`,
  ]);
  wsSend({ type: "pty.input", data: "\x1b[200~" + block + "\x1b[201~" });
  bNote.textContent = `문서 탭 전달됨 → 터미널. 이어서 지시를 입력하고 Enter.`;
  if (getXterm()) setTimeout(() => getXterm().focus(), 0);
}
// 탭 지목 전달. 분리창엔 터미널이 없으므로 콘솔로 relay하고, 콘솔이 자기 세션(getCurTarget())에 묶는다.
function deliverTabPick(tab) {
  if (BROWSER_MODE) { wsSend({ type: "tab-pick-relay", tab }); bNote.textContent = "탭 지목됨 → 콘솔 세션에 고정."; return; }
  deliverTabPickLocal(tab);
}
// 북마크 지목. 탭·그룹과 달리 서버가 매길 이름이 없어(주소가 곧 이름) 문구를 여기서 만든다.
// 분리창엔 터미널이 없으므로 콘솔로 넘긴다.
function deliverSitePick(bm) {
  if (BROWSER_MODE) { wsSend({ type: "site-pick-relay", site: bm }); bNote.textContent = `사이트 지목됨 → 콘솔 세션에 전달.`; return; }
  deliverSitePickLocal(bm);
}
export function deliverSitePickLocal(bm) {
  if (!getCurTarget()) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  // 지목은 "지금 가라"가 아니라 "이 주소를 쓰라"다. 여러 개를 찍어 건네는 것이 보통이고,
  // 언제 어떻게 쓸지는 받은 쪽이 정한다.
  const block = [
    `[사이트 지목 · 이 주소를 기억하고 활용하세요]`,
    `${bm.title ? bm.title + "  " : ""}${bm.url}`,
  ].join("\n");
  wsSend({ type: "pty.input", data: "\x1b[200~" + block + "\x1b[201~" });
  if (getXterm()) setTimeout(() => getXterm().focus(), 0);
  bNote.textContent = `사이트 "${bm.title || bm.url}" 지목됨.`;
}
function deliverGroupPick(g) {
  if (BROWSER_MODE) { wsSend({ type: "group-pick-relay", group: g }); bNote.textContent = "그룹 지목됨 → 콘솔 세션에 전달."; return; }
  deliverGroupPickLocal(g);
}
// 지목만 보내고, 붙여넣을 문구는 서버가 핸들을 매겨 돌려준 뒤에 만든다(group-granted 수신부).
// 창이 이름을 지어내면 터미널에는 실제로 부를 수 없는 이름이 남는다.
export function deliverGroupPickLocal(g) {
  if (!getCurTarget()) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  if (!g.space) { bNote.textContent = "이 그룹의 스페이스를 알 수 없습니다."; return; }
  wsSend({ type: "browser-group-grant", pane: getCurTarget(), space: g.space, group: g.group });
  bNote.textContent = `그룹 "${g.label}" 지목됨. 이 세션이 씁니다.`;
}
// 지목만 보내고, 붙여넣을 문구는 서버가 핸들을 매겨 돌려준 뒤에 만든다(tab-granted 수신부).
// 창이 아는 wc 숫자(@4)는 부를 수 있는 이름이 아니고 숫자라 혼동된다.
export function deliverTabPickLocal(tab) {
  if (!getCurTarget()) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  wsSend({ type: "browser-target-set", pane: getCurTarget(), wc: tab.wc, tabId: tab.id || tab.tabId || null });
  bNote.textContent = `탭 "${tab.label}" 고정됨: 이 세션의 iris-browser 대상.`;
}
function deliverCellPick(pick) {
  deliverCellPickLocal(pick);
}
function deliverCellPickLocal(pick) {
  if (!getCurTarget()) { bNote.textContent = "먼저 왼쪽에서 에이전트(세션)를 선택하세요."; return; }
  const block = noticeBlock.call(null, `표 셀 선택 · ${pick.addr}`, [
    `셀: ${pick.addr} · 행 ${pick.r} · 열 ${pick.c}`,
    `값: ${JSON.stringify(pick.text)}`,
    `경로: ${pick.path}`,
  ]);
  wsSend({ type: "pty.input", data: "\x1b[200~" + block + "\x1b[201~" });
  bNote.textContent = `표 셀 ${pick.addr} 전달됨 → 터미널. 이어서 지시를 입력하고 Enter.`;
  if (getXterm()) setTimeout(() => getXterm().focus(), 0);
}
