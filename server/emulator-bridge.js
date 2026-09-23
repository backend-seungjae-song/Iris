// MCP 앱 도구와 창의 에뮬레이터 기능 사이의 요청·응답. 에뮬레이터 탭은 창(web/js/emulator/boot.js)에만
// 있으므로 서버는 물어보고 답을 받아 넘긴다.
//
// 소유 범위
//   요청 번호, 응답 대기, 시간 초과. 탭 상태는 저장하지 않는다(물을 때마다 창이 지금 값을 준다).
//
// 제공 API
//   askEmulator(kind, payload, timeoutMs) → Promise<응답>, noteEmulatorReply(msg).
//
// 유지 조건
//   창이 여럿이면 에뮬레이터 기능이 켜진 창만 답한다. 먼저 온 답을 쓰고 나머지는 버린다.
//   답이 없으면 앱이 꺼져 있거나 기능이 꺼진 것이다. 기기를 따로 켜라고 안내하지 않는다.
import { broadcastLocal } from "./ws-transport.js";

const pending = new Map();   // id → { resolve, timer }
let seq = 0;

export function askEmulator(kind, payload, timeoutMs) {
  const id = "emu" + Date.now().toString(36) + (++seq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "Iris 에뮬레이터가 답하지 않습니다 — Iris 앱이 켜져 있고 모바일 에뮬레이터 기능이 켜져 있는지 확인하세요.", appGone: true });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    broadcastLocal({ type: "emulator-ask", id, kind, ...(payload || {}) });
  });
}

export function noteEmulatorReply(msg) {
  const p = pending.get(msg && msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  const { type, id, ...rest } = msg;
  p.resolve(rest);
}
