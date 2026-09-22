// 탭 끌기. 크롬의 TabDragController 에 해당한다.
//
// 소유 범위
//   창마다 보고받은 탭 띠의 화면 사각형, 지금 끌고 있는 탭 하나의 상태(어느 띠에 붙어 있는가),
//   그리고 끌리는 중인 분리 창을 커서에 맞춰 옮기는 일.
//
// 제공 API
//   createTabDrag({ ... }) → { registerTabDragIpc, endAll }
//
// 의존 대상
//   BrowserWindow·screen 은 주입받는다. 창 생성은 detached-tab-window 가 담당하고,
//   여기서는 언제 만들지만 정한다.
//
// 유지 조건
//   판정은 크롬과 같은 식이다. 가로는 띠 사각형 안, 세로는 그 사각형을 15px 넓힌 범위
//   (kVerticalDetachMagnetism). 이 값을 바꾸면 크롬과 조작감이 달라진다.
//   분리는 놓을 때가 아니라 경계를 넘는 순간에 일어난다. 놓기는 상태를 끝낼 뿐이며 크롬도 같다
//   (ContinueDragging 이 매 이동마다 target 을 다시 구하고, 달라지면 그 자리에서 옮긴다).
//   붙는 것도 같다. 다른 창의 띠에 들어가는 순간 붙는다.
//   띠 사각형은 렌더러가 보고한 것만 믿는다. 여기서 창 크기로 짐작하면 띠가 없는 창(메모 창
//   같은)에도 붙게 된다.
//   끌던 창이 사라지면 상태를 반드시 지운다. 지우지 않으면 다음 끌기가 이미 없는 창을 옮기려 한다.
//   창을 끄는 동안에는 그 창을 판정에서 뺀다. 그 창은 커서를 따라다니므로 늘 커서 아래에 있고,
//   빼지 않으면 자기 띠에 자기가 붙어 창이 닫히고, 끌자마자 탭이 원래 위치로 돌아간다.
//   붙는 것은 그 탭이 원래 속한 스페이스로 돌아가는 것이다. 다른 스페이스의 창 띠에 놓아도
//   탭이 그 스페이스로 옮겨 가지는 않는다. 탭 기록을 옮기는 일은 이 모듈이 하지 않는다.
//   그 이동까지 하려면 브라우저 상태의 tab.move 를 스페이스 넘어 쓰는 별개의 일이 필요하다.
//
// 영향 범위
//   detached-tab-window.cjs 가 이 모듈을 소유한다(그 기능의 경계 안이다). 렌더러 쪽 짝은
//   web/js/browser/tab-drag.js 다.
//   현재 목록 확인: node bin/importers.mjs native/electron/tab-drag.cjs

// 크롬: const int TabDragController::kVerticalDetachMagnetism = 15;
const VERTICAL_DETACH_MAGNETISM = 15;

const RECT_CHANNEL = "ac-tabstrip-rect";

function createTabDrag({ BrowserWindow, ipcMain, screen, isTrustedSender, openDetachedTab, closeDetachedTab, detachedWindowFor, log }) {
  // wcId → { left, top, w, h, space, tab }. 창 안의 상대 좌표이며 화면 좌표는 쓸 때 계산한다.
  // 렌더러가 화면 좌표로 보내면 창을 옮기는 순간 값이 낡는데, 옮긴 창은 다시 그리지 않아 갱신되지
  // 않는다. 창의 위치는 이 모듈이 항상 알고 있다.
  const strips = new Map();
  // 지금 끌고 있는 것. 없으면 null.
  let drag = null;

  function forgetWindow(wcId) {
    strips.delete(wcId);
    if (drag && drag.sourceWc === wcId) drag = null;
  }

  // 상대 좌표 + 창의 현재 위치 = 화면 좌표. 창을 옮겨도 이 값은 유효하다.
  function screenRect(wcId) {
    const rel = strips.get(wcId);
    const win = windowOf(wcId);
    if (!rel || !win) return null;
    let b;
    try { b = win.getContentBounds(); } catch { return null; }
    return { x: b.x + rel.left, y: b.y + rel.top, w: rel.w, h: rel.h };
  }

  // 크롬 DoesTabStripContain 과 같다. 가로는 띠 안, 세로는 15px 넓힌 범위.
  function stripContains(rect, x, y) {
    if (!rect) return false;
    return x >= rect.x && x < rect.x + rect.w
      && y >= rect.y - VERTICAL_DETACH_MAGNETISM
      && y < rect.y + rect.h + VERTICAL_DETACH_MAGNETISM;
  }

  // 크롬 GetTargetTabStripForPoint 와 같다. 커서 아래 창의 띠가 이 점을 포함하면 그 띠, 아니면 null.
  // 창이 겹쳐 있으면 위에 있는 창을 선택한다. Electron 이 z 순서를 제공하지 않으므로 마지막으로
  // 포커스된 창을 위로 본다. 실제로 겹치는 경우가 드물고, 틀려도 놓기 전에 되돌릴 수 있다.
  //
  // excludeWc 는 지금 끌고 있는 창이다. 크롬도 창을 끄는 동안에는 그 창을 판정에서 뺀다
  // (GetLocalProcessWindow 의 exclude_dragged_view, 호출부는 current_state_ == kDraggingWindow).
  // 그 창은 커서를 따라다니므로 늘 커서 아래에 있다. 빼지 않으면 자기 띠에 자기가 붙어
  // attachTo 가 그 창을 닫고, 끌자마자 탭이 원래 위치로 돌아가는 결함이 된다.
  function stripAt(x, y, excludeWc) {
    let best = null;
    for (const wcId of strips.keys()) {
      if (excludeWc != null && wcId === excludeWc) continue;
      const rect = screenRect(wcId);
      if (!stripContains(rect, x, y)) continue;
      const win = windowOf(wcId);
      if (!win) continue;
      if (!best || win.isFocused()) best = { wcId, rect, win };
    }
    return best;
  }

  // 끌고 있는 창의 webContents id. 창을 끄는 중이 아니면 null.
  function draggedWc() {
    if (!drag || drag.state !== "window") return null;
    const win = drag.win;
    if (!win) return null;
    try { return win.isDestroyed() ? null : win.webContents.id; } catch { return null; }
  }

  function windowOf(wcId) {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed() && w.webContents.id === wcId) return w; } catch {}
    }
    return null;
  }

  // 크롬 DetachIntoNewBrowserAndRunMoveLoop 와 같다. 그 자리에서 창을 만들고 커서를 따라가게 한다.
  function detachIntoNewWindow(pt) {
    // 포커스를 가져가지 않는다. 가져가면 끌던 창이 마우스를 놓쳐 끌기가 그 자리에서 멈춘다.
    const win = openDetachedTab({ space: drag.space, tabId: drag.tabId, title: drag.title, activate: false });
    if (!win) return false;
    drag.state = "window";
    drag.win = win;
    // 커서가 잡은 지점을 창 안에서도 유지한다. 그러지 않으면 창이 커서 왼쪽 위로 이동한다.
    moveWindowTo(pt);
    // 띠에서 감추는 일은 창을 만들 때 이미 방송된다(detached-tab-window 의 broadcast).
    // 여기서 다시 알리면 같은 사실을 두 곳에서 통지하게 된다.
    return true;
  }

  function moveWindowTo(pt) {
    const win = drag && drag.win;
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      win.setBounds({ x: Math.round(pt.x - drag.grabDx), y: Math.round(pt.y - drag.grabDy), width: b.width, height: b.height });
    } catch {}
  }

  // 크롬 Attach(target) 와 같다. 그 창의 띠에 붙이고 끌던 분리 창은 닫는다(닫기 = 되돌리기).
  function attachTo(target) {
    if (drag.state === "window" && drag.win && !drag.win.isDestroyed()) {
      try { closeDetachedTab(drag.tabId); } catch {}
    }
    drag.state = "tabs";
    drag.win = null;
    drag.attachedWc = target.wcId;
    // 붙는 것은 분리 목록에서 빠지는 것이다. 창을 닫으면 그 통지가 나가고 모든 띠가 다시
    // 그려지므로, 여기서 따로 알리지 않는다.
    try { target.win.show(); target.win.focus(); } catch {}
  }

  // 크롬 ContinueDragging 과 같다. 매 이동마다 target 을 다시 구하고, 달라지면 그 자리에서 옮긴다.
  function continueDragging(pt) {
    if (!drag) return { ok: false, skipped: "no-drag" };
    // 크롬: GetLocalProcessWindow(point, current_state_ == kDraggingWindow, ...)
    const target = stripAt(pt.x, pt.y, draggedWc());
    const targetWc = target ? target.wcId : null;
    if (targetWc !== drag.attachedWc) {
      if (!targetWc) {
        if (drag.state !== "window") detachIntoNewWindow(pt);
        drag.attachedWc = null;
      } else {
        attachTo(target);
      }
    }
    if (drag.state === "window") moveWindowTo(pt);
    return { ok: true, state: drag.state, attached: drag.attachedWc };
  }

  function registerTabDragIpc() {
    // 띠 사각형 보고. 렌더러가 화면 좌표로 전달하며, 창 크기로 추정하지 않는다.
    ipcMain.on(RECT_CHANNEL, (e, arg) => {
      if (!isTrustedSender(e)) return;
      const wcId = e.sender.id;
      if (!arg || typeof arg !== "object") { strips.delete(wcId); return; }
      const left = Number(arg.left), top = Number(arg.top), w = Number(arg.w), h = Number(arg.h);
      if (![left, top, w, h].every(Number.isFinite) || w <= 0 || h <= 0) { strips.delete(wcId); return; }
      strips.set(wcId, { left, top, w, h, space: String(arg.space || ""), tab: String(arg.tab || "") || null });
      e.sender.once("destroyed", () => forgetWindow(wcId));
    });

    ipcMain.handle("ac-tabdrag-start", (e, arg) => {
      if (!isTrustedSender(e)) return { ok: false, error: "untrusted" };
      const tabId = String((arg && arg.tabId) || "").trim();
      const space = String((arg && arg.space) || "").trim();
      if (!tabId || !space) return { ok: false, error: "탭을 알 수 없습니다" };
      drag = {
        tabId, space, title: String((arg && arg.title) || ""),
        sourceWc: e.sender.id, attachedWc: e.sender.id,
        grabDx: Number((arg && arg.grabDx) || 0) || 0,
        grabDy: Number((arg && arg.grabDy) || 0) || 0,
        state: "tabs", win: detachedWindowFor(tabId) || null,
      };
      // 이미 떨어져 있는 탭을 그 창에서 끌면 처음부터 창 끌기다.
      if (drag.win && !drag.win.isDestroyed()) {
        drag.state = "window";
        drag.attachedWc = null;
        // 렌더러가 준 잡은 지점은 칩 안의 offset 이다. 새로 만드는 창에는 맞지만,
        // 이미 있는 창에는 맞지 않는다. 그대로 쓰면 첫 이동에서 창이 커서 쪽으로 이동한다.
        // 창 기준으로 다시 계산한다.
        try {
          const cur = screen.getCursorScreenPoint();
          const b = drag.win.getBounds();
          drag.grabDx = cur.x - b.x;
          drag.grabDy = cur.y - b.y;
        } catch {}
      }
      return { ok: true, state: drag.state };
    });

    ipcMain.handle("ac-tabdrag-move", (e, arg) => {
      if (!isTrustedSender(e)) return { ok: false, error: "untrusted" };
      if (!drag) return { ok: false, skipped: "no-drag" };
      const x = Number(arg && arg.x), y = Number(arg && arg.y);
      const pt = ([x, y].every(Number.isFinite)) ? { x, y } : screen.getCursorScreenPoint();
      return continueDragging(pt);
    });

    ipcMain.handle("ac-tabdrag-end", (e) => {
      if (!isTrustedSender(e)) return { ok: false, error: "untrusted" };
      // 크롬의 EndDrag 와 같다. 상태를 종료할 뿐이고 분리와 결합은 이미 끝나 있다.
      const was = drag;
      drag = null;
      return { ok: true, state: was ? was.state : "none" };
    });
  }

  return { registerTabDragIpc, forgetWindow, stripContains, stripAt, VERTICAL_DETACH_MAGNETISM };
}

module.exports = { createTabDrag, VERTICAL_DETACH_MAGNETISM };
