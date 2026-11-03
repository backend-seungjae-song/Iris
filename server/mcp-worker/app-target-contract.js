export const MAX_APP_TARGETS = 4;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function appDeviceTargetId({ udid, persistentId } = {}) {
  if (!ID_RE.test(String(udid || ""))) throw new Error("기기 식별자가 올바르지 않습니다");
  if (!/^emulator-\d+$/.test(udid)) return udid;
  const target = persistentId && !/^emulator-\d+$/.test(persistentId) ? `avd:${persistentId}` : null;
  if (!target || !ID_RE.test(target)) throw new Error("Android 기기의 AVD 이름을 확인하지 못했습니다. 기기 목록을 새로 고침한 뒤 다시 지목하세요.");
  return target;
}
