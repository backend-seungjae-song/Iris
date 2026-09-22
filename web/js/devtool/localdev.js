// 로컬 데브: 기존 localdev 대시보드를 rail 안에 붙인다.
//
// 소유 범위
//  <div class="ld-head"> LD_URL, ldWv, ldChecked: 대시보드 주소와 이 창에 붙인 webview 하나, reachability 확인 상태.
//
// 제공 API
//   initLocaldev({ $, browserMode, openBrowserTab }): 버튼을 연결한다. main 이 한 번 부른다.
//   ldEnsure(): 화면에 들어올 때 대시보드를 확인하고 붙인다. 이미 붙었으면 새로고침한다.
//
// 의존 대상
//   $, browserMode, openBrowserTab 을 init 에서 주입받는다. core 나 browser 를 import 하지 않는다.
//   실제 상태 조회·시작·정지는 http://localdev.test/ 대시보드가 소유한다.
//
// 유지 조건
//   원본 주소를 그대로 써야 한다. 컨트롤 서버의 Origin 허용값 때문에 127.0.0.1로 바꾸면 조작이 막힌다.
//   webview는 브라우저 탭과 같은 persist:acbrowser 세션을 쓰고 target=_blank를 허용한다.
//
// 영향 범위
//   main 의 rail 전환 콜백과 브라우저 탭 열기 주입부. 대시보드 자체 구현에는 영향이 없다.

// 이 기능의 영역. index.html 이 이 마크업을 항상 그리면 기능을 꺼도
// 셸이 파싱되므로 여기서 만든다. 셸(aside 의 id·class)은 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="ld-head">
    <span class="ld-title">로컬 데브</span>
    <button class="scr-ico" id="ld-reload" title="새로고침">↻</button>
    <button class="scr-ico" id="ld-open" title="브라우저 탭으로 크게 열기">⇱</button>
  </div>
  <div class="ld-err" id="ld-err" hidden></div>
`;

const LD_URL = "http://localdev.test/";
let ldWv = null, ldChecked = false;
let dom = null;
let browserMode = false;
let openBrowserTab = null;

export function initLocaldev(deps) {
  dom = deps.$;
  browserMode = !!deps.browserMode;
  openBrowserTab = deps.openBrowserTab;
  const reload = dom("#ld-reload");
  if (reload) reload.onclick = () => { if (ldWv) { try { ldWv.reload(); } catch (e) {} } else { ldChecked = false; ldEnsure(); } };
  const open = dom("#ld-open");
  if (open) open.onclick = () => openBrowserTab(LD_URL);
}

export async function ldEnsure() {
  const panel = dom("#ld-panel"), err = dom("#ld-err");
  if (!panel || browserMode) return;
  if (ldWv) { try { ldWv.reload(); } catch (e) {} return; }
  if (!ldChecked) {
    ldChecked = true;
    // 라우터가 떠 있지 않으면 webview는 크롬 오류 화면만 보여주므로, 필요한 조치를 대신 안내한다.
    try {
      const r = await fetch(LD_URL, { method: "GET", mode: "no-cors", cache: "no-store" });
      void r;
    } catch (e) {
      err.hidden = false;
      err.innerHTML = "localdev 라우터에 연결하지 못했습니다.<br>터미널에서 <code>localdev status</code>로 상태를 보고, 필요하면 <code>sudo localdev setup</code>을 실행하세요.";
      return;
    }
  }
  err.hidden = true;
  const el = document.createElement("webview");
  el.className = "ld-frame";
  el.setAttribute("src", LD_URL);
  // 대시보드 링크는 target=_blank다. 이 옵션을 켜야 main의 disposition 라우팅이 브라우저 탭으로 보낸다.
  el.setAttribute("allowpopups", "");
  el.setAttribute("partition", "persist:acbrowser"); // 브라우저 탭과 같은 세션. 별도 프로필을 만들지 않는다
  panel.appendChild(el);
  ldWv = el;
}

// 이 기능의 연결. 표에는 선언만 남고, 연결 방법은 각 기능이 소유한다.
export function initCapability(ctx) {
  initLocaldev({ $: ctx.$, browserMode: ctx.browserMode, openBrowserTab: ctx.openBrowserTab });
  return { screen: { enter: ldEnsure } };
}
