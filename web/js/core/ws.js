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
//   연결 완료 처리(onOpen)·수신 전달·전송은 첫 메시지 caps 의 netPolicy 확인 후에만
//   정책 불일치 서버(이전 버전, 외부 수신 가능)는 연결 종료, 재연결 중단
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
let verified = false;      // 현재 소켓의 서버 정책 확인 여부
let policyBlocked = false; // 정책 불일치 서버 확인 후 재연결 중단

// 서버 네트워크 정책. server/env.cjs NET_POLICY 와 같은 값(검사로 대조)
export const EXPECTED_NET_POLICY = "loopback-only/1";

export function initWs(deps) {
  config = deps;
  connect();
}

function connect() {
  if (policyBlocked) return;
  socket = new WebSocket(config.url);
  verified = false;
  const openedSocket = socket;
  let socketGeneration = generation;
  openedSocket.binaryType = "arraybuffer";
  // 소켓 열림만으로 연결 완료 처리 안 함. 첫 caps 의 정책 확인 후 처리
  openedSocket.onopen = () => {};
  openedSocket.onclose = () => {
    config.onClose(socketGeneration);
    if (policyBlocked) return;
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
    if (!verified) {
      // 확인 전 수신은 전달 없음. 첫 문자 메시지 = 정책 실린 caps 만 통과
      let first = null;
      if (!(event.data instanceof ArrayBuffer)) { try { first = JSON.parse(event.data); } catch {} }
      if (!first || first.type !== "caps" || first.netPolicy !== EXPECTED_NET_POLICY) {
        policyBlocked = true;
        console.error("[ws] 서버 네트워크 정책 불일치 — 연결 종료, 재연결 중단", first && first.netPolicy);
        try { openedSocket.close(); } catch {}
        config.onPolicyMismatch?.(first);
        return;
      }
      verified = true;
      socketGeneration = ++generation;
      retry = 0;
      config.onOpen(socketGeneration);
      const capsHandler = config.dispatch.caps;
      if (capsHandler) capsHandler(first);
      return;
    }
    if (event.data instanceof ArrayBuffer) { config.onBinary(event.data); return; }
    const message = JSON.parse(event.data);
    const handler = config.dispatch[message.type];
    if (handler) handler(message);
  };
}

// 정책 확인 전 소켓 비공개(직접 전송 경로 차단)
export function getWs() { return verified ? socket : null; }
export function getWsGeneration() { return generation; }

export function wsSend(message) {
  if (!socket || socket.readyState !== 1 || !verified) return false;
  try { socket.send(JSON.stringify(message)); return true; }
  catch { return false; }
}
