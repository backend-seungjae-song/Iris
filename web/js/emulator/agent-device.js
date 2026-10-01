// 에이전트 세션이 자기 에뮬레이터를 켤 때 고를 기기와 켜도 되는지 판정.
//
// 소유 범위
//   기기 목록(emulator.availability 의 devices)에서 다른 화면이 쓰지 않는 기기 고르기, 동시 실행 한도 판정.
//
// 제공 API
//   chooseAgentDevice({ devices, inUse, preferred }), bootAllowed({ devices, device, limit, diskOk, booting }).
//
// 의존 대상
//   없음. DOM 을 모르는 순수 계산(node 검사 test/emulator-agent-device.mjs 가 직접 호출)
//
// 영향 범위
//   web/js/emulator/boot.js 의 openForAgent.

const isAndroid = (d) => d.runtime === "Android";
const isBooted = (d) => d.state === "Booted";
// adb 에 USB 로 붙은 실제 폰도 켜진 Android 행으로 온다. 에뮬레이터 시리얼은 emulator-<포트>
const isPhysical = (d) => isAndroid(d) && isBooted(d) && !/^emulator-\d+$/.test(String(d.udid || ""));

// 같은 기종이라도 OS 이미지가 다르면 기존 앱의 테스트 조건이 달라진다.
function sameAgentModel(a, b) {
  if (!a || !b || a.runtime !== b.runtime) return false;
  if (isAndroid(a)) return !!a.modelId && a.modelId === b.modelId && !!a.imageId && a.imageId === b.imageId;
  if (a.modelId || b.modelId) return !!a.modelId && a.modelId === b.modelId;
  const name = d => String(d.name || "").replace(/\s*·\s*\d+$/, "");
  return !!name(a) && name(a) === name(b);
}

export function chooseAgentDevice({ devices, inUse, preferred = null }) {
  const busy = inUse instanceof Set ? inUse : new Set(inUse || []);
  const usable = (devices || []).filter(d => d?.udid && d.isAvailable !== false && d.runnable !== false && !isPhysical(d));
  const source = preferred
    ? usable.find(d => d.udid === preferred || isAndroid(d) && (d.persistentId === preferred || d.name === preferred))
    : usable.find(d => d.modelId === "com.apple.CoreSimulator.SimDeviceType.iPhone-13" || /^iPhone 13(?:$|\s*[·(])/.test(d.name || ""));
  if (!source) return null;
  const free = d => !busy.has(d.udid) && !(isAndroid(d) && (busy.has(d.name) || busy.has(d.persistentId)));
  return free(source) ? source : usable.find(d => free(d) && sameAgentModel(source, d)) || null;
}

// booting: 켜는 중이라 아직 Booted 로 안 잡힌 기기 수
export function bootAllowed({ devices, device, limit, diskOk = true, booting = 0 }) {
  if (!device || isBooted(device)) return { ok: true };
  const running = (devices || []).filter((d) => isBooted(d) && !isPhysical(d)).length + booting;
  if (!diskOk) return { ok: false, running, reason: "disk" };
  if (Number.isInteger(limit) && limit > 0 && running >= limit) return { ok: false, running, reason: "limit" };
  return { ok: true, running };
}
