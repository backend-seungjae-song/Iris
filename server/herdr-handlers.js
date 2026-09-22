import { requestRecompute as recompute } from "./runtime-state.js";

// Herdr relay·control/focus와 실제 PTY WebSocket handler의 단일 소유 모듈.
//
// 소유 범위
//   한 콘솔 relay 선택, pane/tab control·focus, PTY start/input/resize/copy와 pane scroll cache.
//
// 제공 API
//   Herdr/PTY/로컬 broadcast port를 받는 initHerdrHandlers, namespace별 handler,
//   relay 함수와 workspace runtime용 scroll 기억/해제 함수, 연결 종료용 closeHerdrClient.
//
// 의존 대상
//   runtime-state의 recompute port에 의존하고, Herdr·PtyManager·broadcastLocal은 composition root에서
//   주입받으며 다른 handler를 import하지 않는다.
//
// 유지 조건
//   로컬 gate, 실제 PTY 바이트 전달, 마지막 입력 콘솔 우선 relay, pane scroll 검증과 응답 순서,
//   read 응답 지연 [400, 1200, 2600, 5000] 및 focus/close 뒤 recompute 시점을 보존한다.
//
// 영향 범위
//   server/index.js의 WebSocket dispatch·close와 browser-runtime.js의 app-pick relay,
//   workspace-runtime.js의 scroll event 연결, web의 terminal/control 소비자,
//   bin/smoke.mjs relay 소유 검사 및 test/terminal-env-isolation.mjs의 PTY 경계.

let herdr;
let ptyMgr;
let broadcastLocal;
let focusQueue = Promise.resolve();
// 사용자가 마지막으로 입력한 콘솔 창. 분리 창에서 온 내용을 어느 채팅에 붙일지 정할 때 쓴다.
// 콘솔이 여럿이면 직전까지 입력하던 창이 사용자가 가리키는 채팅이다.
let lastTypedConsole = null;

export function initHerdrHandlers(deps) {
  herdr = deps.herdr;
  ptyMgr = deps.ptyManager;
  broadcastLocal = deps.broadcastLocal;
}


// 콘솔 창 하나에만 보낸다. 받는 쪽이 터미널에 내용을 입력하는 종류의 알림은 전체에
// 보내면 안 된다. 콘솔 창이 둘이면 같은 내용이 두 번 입력된다. 콘솔 창은 각각 herdr에 연결되지만
// 연결되는 세션은 하나라, 두 창이 입력한 내용이 같은 채팅에 함께 쌓인다.
//
// 대상 창은 사용자가 직전에 입력하던 창이다. 분리 창에서 요소를 고르는 동작은 직전까지
// 입력하던 채팅에 붙이려는 동작이다. 그 창이 없으면 터미널이 연결된 콘솔 중 하나를 쓴다.
// 터미널이 연결된 콘솔이 없으면 전체에 전달한다.
export function relayToOneConsole(msg) {
  const consoles = ptyMgr.clients().filter((c) => c.readyState === 1 && c._local);
  if (!consoles.length) { broadcastLocal(msg); return; }
  const target = consoles.includes(lastTypedConsole) ? lastTypedConsole : consoles[0];
  try { target.send(JSON.stringify(msg)); } catch {}
}

// 조종(AC2): 클라이언트가 대상 세션에 채팅을 보내고 응답을 같은 화면에서 받는다.
// capability 경계: 이 서버가 herdr로 내보내는 조종 동작을 화이트리스트로 고정한다.
// 지금 허용: 기존 세션에 메시지 전송(agent.send)·pane 읽기. 금지(구조적): 신규 작업 시작·임의
// 셸 실행(AC5). 원격 블록에서 인증 등급별로 이 경계를 더 좁힌다(미인증=읽기만, AC6).
const CONTROL_CAPS = { read: true, send: true, startTask: false, shell: false };

export async function handleControl(ws, msg) {
  try {
    if (msg.type === "read") {
      if (!CONTROL_CAPS.read) return;
      const read = await herdr.paneRead(msg.target, msg.source || "recent");
      ws.send(JSON.stringify({ type: "pane", target: msg.target, text: read.text || "", revision: read.revision ?? 0, truncated: !!read.truncated }));
    } else if (msg.type === "send") {
      if (!CONTROL_CAPS.send) { ws.send(JSON.stringify({ type: "control-error", message: "전송 권한 없음" })); return; }
      // 원격 send 잠금(M2): 원격 피어가 로컬 AI에게 지시해 AC5(원격 셸·비밀번호
      // 덤프 금지)를 우회하는 confused-deputy 경로 차단. 원격은 읽기(read)만. 재활성은 provenance 기반 결정 필요.
      if (!ws._local) { ws.send(JSON.stringify({ type: "control-error", message: "원격에서는 전송 불가(AC5·M2) — 읽기만 허용" })); return; }
      if (!msg.target || typeof msg.text !== "string" || !msg.text.length) return;
      await herdr.agentSend(msg.target, msg.text);
      ws.send(JSON.stringify({ type: "sent", target: msg.target }));
      // 응답이 pane에 표시될 시간을 두고 여러 번 읽어 반환한다(응답 왕복).
      for (const delay of [400, 1200, 2600, 5000]) {
        setTimeout(async () => {
          try {
            const read = await herdr.paneRead(msg.target, "recent");
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pane", target: msg.target, text: read.text || "", revision: read.revision ?? 0 }));
          } catch {}
        }, delay);
      }
    }
  } catch (e) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "control-error", message: String(e.message || e) }));
  }
}

// herdr 화면은 공유 상태다. 빠른 선택 요청이 역순 완료되어 옛 pane이 남지 않도록 순서를 지킨다.
function enqueueFocus(ws, operation) {
  const pending = focusQueue.then(operation).then(() => recompute());
  focusQueue = pending.catch((e) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "control-error", message: String(e.message || e) }));
  });
  return focusQueue;
}

// 사이드바 선택은 해당 pane만 표시한다. 같은 pane 재선택으로 zoom을 풀지 않는다.
export function handleFocus(ws, msg) {
  if (!ws._local || !msg.target) return;
  const client = herdr;
  return enqueueFocus(ws, () => client.paneZoom(msg.target, "on"));
}

// 세션 없는 탭 전환도 pane 선택과 같은 순서를 따른다.
export function handleTabFocus(ws, msg) {
  if (!ws._local || !msg.tabId) return;
  const client = herdr;
  return enqueueFocus(ws, () => client.tabFocus(msg.tabId));
}

// 세션 닫기는 화면이 가리킨 terminal identity까지 대조하고 해당 pane 하나에만 적용한다.
export async function handlePaneClose(ws, msg) {
  if (!ws._local || !msg.paneId || !msg.terminalId) return;
  try {
    const pane = await herdr.paneGet(msg.paneId);
    if (pane.terminal_id !== msg.terminalId) throw new Error("세션이 바뀌어 닫기를 취소했습니다");
    await herdr.paneClose(msg.paneId);
    await recompute();
  } catch (e) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "control-error", message: String(e.message || e) }));
  }
}

// 이전 클라이언트나 빈 탭의 닫기 요청도 분할 탭 전체를 지우지 않는다.
export async function handleTabClose(ws, msg) {
  if (!ws._local || !msg.tabId) return;
  try {
    const info = await herdr.call("tab.get", { tab_id: msg.tabId });
    const tab = info.tab;
    if (!tab?.workspace_id) throw new Error("탭을 확인할 수 없어 닫기를 취소했습니다");
    const panes = (await herdr.paneList(tab.workspace_id)).filter((pane) => pane.tab_id === msg.tabId);
    if (panes.length !== 1) throw new Error("분할 탭은 세션을 선택해서 하나씩 닫아주세요");
    await herdr.paneClose(panes[0].pane_id);
    await recompute();
  } catch (e) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "control-error", message: String(e.message || e) }));
  }
}

// 실제 터미널: 스냅샷 폴링 대신 PTY에 연결된 herdr를 그대로 스트리밍한다.
// PTY output → WebSocket 바이너리 프레임(xterm이 바이트를 받아 렌더). 입력·리사이즈는 JSON.
// AC5: PTY는 실질 셸 접근이므로 로컬(루프백) 연결만 허용, 원격(폰)은 금지.
export async function handlePty(ws, msg) {
  try {
    if (msg.type === "pty.start") {
      if (!ws._local) { ws.send(JSON.stringify({ type: "control-error", message: "원격에서는 터미널 사용 불가(AC5) — 로컬 앱에서만" })); return; }
      ptyMgr.start(ws, msg.cols, msg.rows, (data) => {
        if (ws.readyState !== 1) return;
        // node-pty(encoding:null)는 Buffer를 준다. 바이너리 프레임으로 그대로 전송.
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
        ws.send(buf, { binary: true });
      });
      ws.send(JSON.stringify({ type: "pty.started" }));
    } else if (msg.type === "pty.input") {
      if (!ws._local) return;
      lastTypedConsole = ws;   // 사용자가 직전에 입력한 콘솔. 분리 창이 보낸 내용을 붙일 대상
      if (typeof msg.data === "string") ptyMgr.input(ws, msg.data);
    } else if (msg.type === "pty.resize") {
      if (!ws._local) return;
      ptyMgr.resize(ws, msg.cols, msg.rows);
    }
  } catch (e) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "control-error", message: String(e.message || e) }));
  }
}

export function closeHerdrClient(ws) {
  ptyMgr.stop(ws);
}
