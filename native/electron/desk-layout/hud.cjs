"use strict";
// 창 레이아웃 저장·복원 결과를 모니터 가운데에 띄우는 정사각 알림(사용자 시안 H2).
// 단축키는 다른 앱을 쓰는 중에 누르므로 Iris 창 안이 아니라 모든 앱 위의 투명 창. 마우스·포커스를 가져가지 않음.
// 떠 있는 동안만 창이 있음: 숨긴 창이 남으면 창 목록을 훑는 코드(요소 선택의 창 찾기 등)가 그 창을 앱 창으로 봄

const SIZE = 200;
const HIDE_AFTER_MS = { ok: 1800, warn: 4000, err: 5000 };
const ICON = {
  ok: "M5 12.5l4.5 4.5L19 7.5",
  warn: "M12 7.5v6M12 16.8v.2",
  err: "M8.5 8.5l7 7M15.5 8.5l-7 7",
  progress: "M4 12a8 8 0 1 1 3 6.2M4 19v-5h5",
};

// 색은 web/css/00-tokens.css 어두운 테마 값(앱은 data-theme="light" 일 때만 밝음)
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:'Geist',-apple-system,'Apple SD Gothic Neo',sans-serif;}
body{display:grid;place-items:center;}
.hud{--c:#8BFBC2;width:164px;height:164px;box-sizing:border-box;padding:0 12px;border-radius:18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;text-align:center;
  color:#EAF3FA;background:rgb(15 30 43 / .88);border:1px solid rgb(166 218 244 / .18);-webkit-backdrop-filter:blur(18px);
  opacity:0;transform:scale(.94);transition:opacity .18s cubic-bezier(.25,.46,.45,.94),transform .18s cubic-bezier(.25,.46,.45,.94);}
.hud.in{opacity:1;transform:none;}
.hud.warn{--c:#F9F871;} .hud.err{--c:#FF7A72;} .hud.progress{--c:#A6DAF4;}
svg{width:40px;height:40px;fill:none;stroke:var(--c);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;}
b{font-size:13px;font-weight:600;line-height:1.35;word-break:keep-all;}
small{color:#8FB0C4;font-size:11px;line-height:1.4;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere;}
.bar{width:92px;height:3px;border-radius:2px;background:rgb(166 218 244 / .18);overflow:hidden;}
.bar i{display:block;width:34%;height:100%;background:var(--c);animation:run 1.2s cubic-bezier(.25,.46,.45,.94) infinite;}
@keyframes run{from{transform:translateX(-100%);}to{transform:translateX(300%);}}
</style></head><body><div class="hud" id="hud"></div><script>
function render(s){const h=document.getElementById("hud");h.className="hud "+s.kind;
h.innerHTML='<svg viewBox="0 0 24 24"><path d="'+s.icon+'"/></svg><b></b><small></small>'+(s.kind==="progress"?'<div class="bar"><i></i></div>':"");
h.querySelector("b").textContent=s.title;h.querySelector("small").textContent=s.sub||"";
if(!s.sub)h.querySelector("small").remove();requestAnimationFrame(()=>h.classList.add("in"));}
function out(){document.getElementById("hud").classList.remove("in");}
</script></body></html>`;

function createHud({ BrowserWindow, screen, error }) {
  let win = null;
  let ready = null;
  let hideTimer = null;
  let closeTimer = null;

  function place() {
    // 사람이 보고 있는 모니터: 커서가 있는 모니터의 가운데
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = display.bounds;
    win.setBounds({ x: Math.round(b.x + (b.width - SIZE) / 2), y: Math.round(b.y + (b.height - SIZE) / 2), width: SIZE, height: SIZE });
  }

  function open() {
    if (win && !win.isDestroyed()) return ready;
    win = new BrowserWindow({
      width: SIZE, height: SIZE, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
      hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, title: "창 레이아웃 알림",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true);
    win.on("closed", () => { win = null; ready = null; });
    ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    return ready;
  }

  // state: { kind: ok·warn·err·progress, title, sub }. progress 는 다음 show 까지 유지
  async function show(state) {
    clearTimeout(hideTimer); clearTimeout(closeTimer);
    try {
      await open();
      if (!win || win.isDestroyed()) return;
      place();
      const payload = { kind: state.kind, title: String(state.title || ""), sub: String(state.sub || ""), icon: ICON[state.kind] || ICON.ok };
      await win.webContents.executeJavaScript(`render(${JSON.stringify(payload)})`);
      win.showInactive();
      const after = HIDE_AFTER_MS[state.kind];
      if (after) hideTimer = setTimeout(hide, after);
    } catch (e) { error && error("[desklayout] 화면 가운데 알림 실패", e); }
  }

  function hide() {
    clearTimeout(hideTimer);
    if (!win || win.isDestroyed()) return;
    win.webContents.executeJavaScript("out()").catch(() => {});
    closeTimer = setTimeout(() => { try { if (win && !win.isDestroyed()) win.destroy(); } catch {} }, 220);
  }

  // 창 레이아웃 저장 때 이 창을 저장 대상에서 빼기 위한 판정
  function owns(bw) { return !!win && bw === win; }

  return { show, hide, owns };
}

module.exports = { createHud, HIDE_AFTER_MS };
