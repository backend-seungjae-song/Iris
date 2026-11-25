// WebSocket 전송 계층. 연결 수명, 생존 확인, 전체 전송과 로컬 전용 전송을 담당한다.
//
// 소유 범위
//   WSS 인스턴스 참조, 하트비트 timer, 연결마다 붙는 _alive·_local 표식,
//   들어온 프레임의 JSON 파싱과 handler 예외 격리.
//
// 제공 API
//   initWsTransport(deps): WSS·하트비트 주기·로컬 판정을 받는다.
//   attachWs({ initialState, dispatch, onClose }): 연결마다 호출할 세 콜백을 받는다.
//   broadcast(message) · broadcastLocal(message) · startHeartbeat().
//
// 의존 대상
//   기능 모듈을 import 하지 않는다. 처음에 보낼 내용, type 별 처리 담당, 연결이 끊길 때의
//   정리는 전부 조립부(server/index.js)가 콜백으로 전달한다.
//   로컬 판정도 주입받는다. 원격 허용 범위는 http-handler 가 소유한다.
//
// 유지 조건
//   어떤 프레임이든(pong·message) _alive 를 다시 true 로 만든다. 직전 ping 에 답이 없던 소켓은 terminate 한다.
//   handler 예외는 그 연결의 control-error 로만 전달되고 프로세스를 종료시키지 않는다.
//   _local 은 연결 시점에 한 번 정해지고 이후 바뀌지 않는다. 권한 판정의 정본이다.
//
// 영향 범위
//   server/index.js 의 조립(초기 스냅샷 구성·type 라우팅·close 정리)과 모든 handler 의 broadcast,
//   그리고 창 쪽 web/js/core/ws.js 의 하트비트 기대(25초 무응답이면 닫는다)와 짝을 이룬다.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs server/ws-transport.js

let wss = null;
let heartbeatMs = 10000;
let isLocalRequest = () => false;
let heartbeatTimer = null;

export function initWsTransport(deps) {
  wss = deps.wss;
  if (deps.heartbeatMs) heartbeatMs = deps.heartbeatMs;
  if (deps.isLocalRequest) isLocalRequest = deps.isLocalRequest;
}

const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

function terminate(ws) {
  try { ws.terminate?.(); } catch {}
}

const originalSend = new WeakMap();

function guardedSend(ws, args) {
  let failure;
  try {
    if (ws.readyState !== 1) failure = new Error("WebSocket 연결이 닫혔습니다.");
    else if (ws.bufferedAmount > MAX_QUEUED_BYTES) {
      failure = new Error("WebSocket 전송 대기 한도를 초과했습니다.");
      terminate(ws);
    } else {
      return (originalSend.get(ws) || ws.send).apply(ws, args);
    }
  } catch (error) {
    failure = error;
    terminate(ws);
  }
  const callback = args.at(-1);
  if (typeof callback === "function") queueMicrotask(() => callback(failure));
}

export function sendFrame(ws, data) {
  return guardedSend(ws, [data]);
}

function installSafeSend(ws) {
  if (originalSend.has(ws) || typeof ws.send !== "function") return;
  originalSend.set(ws, ws.send);
  ws.send = (...args) => guardedSend(ws, args);
}

export function broadcast(msg) {
  let data;
  try { data = JSON.stringify(msg); } catch { return; }
  for (const c of wss.clients) {
    sendFrame(c, data);
  }
}

// 로컬(루프백) 클라이언트에만 전송한다. 실행 출력 등 민감할 수 있는 데이터의 원격 노출을 막는다.
export function broadcastLocal(msg) {
  let data;
  try { data = JSON.stringify(msg); } catch { return; }
  for (const c of wss.clients) {
    if (c._local) sendFrame(c, data);
  }
}

// 절전·깨우기, Wi-Fi 전환, tailnet 불안정으로 소켓이 한쪽만 끊긴 상태가 된다. close가 오지
// 않아 양쪽 모두 연결됨으로 판단하고 재연결이 동작하지 않는다. 끊긴 소켓에 send는 오류 없이
// 성공하므로 명령이 그대로 사라진다. OS의 TCP keepalive는 기본 2시간이라 늦어서, 프로토콜
// ping으로 끊긴 연결을 정리하고 앱 층 hb로 클라이언트가 무응답을 감지하게 한다.
export function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      if (ws._alive === false) { try { ws.terminate(); } catch {} continue; } // 직전 ping에 답이 없었다
      ws._alive = false;
      try { ws.ping(); } catch {}
      sendFrame(ws, JSON.stringify({ type: "hb", t: Date.now() }));
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();
  return heartbeatTimer;
}

// 연결마다 할 일은 조립부가 전달한다. 이 함수는 그 셋을 같은 순서로 호출한다.
export function attachWs({ initialState, dispatch, onClose }) {
  wss.on("connection", (ws, req) => {
    installSafeSend(ws);
    ws.on("error", () => terminate(ws));
    ws._alive = true;
    ws.on("pong", () => { ws._alive = true; });
    ws.on("message", () => { ws._alive = true; });   // 프레임이 오면 살아 있는 연결이다
    // AC5: 로컬(루프백) 연결만 터미널 탭 생성 등 셸 관련 동작 허용. 원격(tailnet 폰)은 제외.
    ws._local = isLocalRequest(req);
    try {
      const pending = initialState(ws);
      if (pending && typeof pending.then === "function") {
        Promise.resolve(pending).catch((error) => {
          sendFrame(ws, JSON.stringify({ type: "control-error", message: "초기 상태를 보낼 수 없습니다: " + String(error?.message || error) }));
          terminate(ws);
        });
      }
    } catch (error) {
      sendFrame(ws, JSON.stringify({ type: "control-error", message: "초기 상태를 보낼 수 없습니다: " + String(error?.message || error) }));
      terminate(ws);
      return;
    }
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg.type !== "string") return;
      // 핸들러 예외를 격리한다. 잘못된 payload(예: 비문자열 path) 하나가 프로세스를 종료시키지 않게 한다(M1).
      try {
        const pending = dispatch(ws, msg);
        Promise.resolve(pending).catch((e) => {
          sendFrame(ws, JSON.stringify({ type: "control-error", message: "요청 처리 오류: " + String(e && e.message || e) }));
        });
      } catch (e) {
        sendFrame(ws, JSON.stringify({ type: "control-error", message: "요청 처리 오류: " + String(e && e.message || e) }));
      }
    });
    ws.on("close", () => { try { onClose(ws); } catch {} });
  });
}
