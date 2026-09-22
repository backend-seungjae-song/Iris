// WebSocket 연결 수명주기와 재시도, heartbeat 감시, 바이너리/문자 프레임 전송 경계를 맡는다.
//
// 소유 범위
//   현재 소켓, 연결 generation, 선형 backoff 횟수, heartbeat 감시 timer와 JSON 직렬화 전송.
//
// 제공 API
//   initWs, 현재 소켓·generation 접근자와 wsSend.
//
// 의존 대상
//   URL과 연결/닫힘/바이너리 callback, 정확한 type 문자열 dispatch 표를 init에서 받는다.
//   브라우저·터미널·파일·메모 등 기능 모듈은 import하지 않는다.
//
// 유지 조건
//   generation은 open 성공 때만 증가하고, close callback에는 그 소켓 generation을 넘긴다.
//   어떤 프레임이든 heartbeat를 갱신하며 25초 무응답이면 닫고, 재시도는 1초씩 늘어 최대 5초다.
//
// 영향 범위
//   main.js의 WebSocket onOpen/onClose/onBinary·dispatch 조립과 center/tabs의 소켓·generation 접근자,
//   모든 도메인 init에 전달되는 wsSend 및 서버가 보내는 정확한 메시지 type 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/core/ws.js

let socket = null;
let generation = 0;
let retry = 0;
let watch = null;
let config = null;

export function initWs(deps) {
  config = deps;
  connect();
}

function connect() {
  socket = new WebSocket(config.url);
  const openedSocket = socket;
  let socketGeneration = generation;
  openedSocket.binaryType = "arraybuffer";
  openedSocket.onopen = () => {
    socketGeneration = ++generation;
    retry = 0;
    config.onOpen(socketGeneration);
  };
  openedSocket.onclose = () => {
    config.onClose(socketGeneration);
    setTimeout(connect, Math.min(1000 * ++retry, 5000));
  };
  // 소켓이 정상 종료 없이 끊기면 onclose가 오지 않는다. 서버 heartbeat가 끊기면 먼저 닫고 재연결한다.
  socket._lastMsg = Date.now();
  clearInterval(watch);
  watch = setInterval(() => {
    if (!socket || socket.readyState !== 1) return;
    if (Date.now() - socket._lastMsg > 25000) { try { socket.close(); } catch {} }
  }, 5000);
  openedSocket.onmessage = (event) => {
    socket._lastMsg = Date.now();
    if (event.data instanceof ArrayBuffer) { config.onBinary(event.data); return; }
    const message = JSON.parse(event.data);
    const handler = config.dispatch[message.type];
    if (handler) handler(message);
  };
}

export function getWs() { return socket; }
export function getWsGeneration() { return generation; }

export function wsSend(message) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
}
