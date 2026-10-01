// 에뮬레이터 화면 자리 기록. 앱 재시작 때 boot.js 가 이 기록대로 탭·세로 열·분리 창 복원,
// 종료 때 켜져 있던 기기만 다시 켜기
//
// 소유 범위
//   기록 한 줄의 모양, 저장 문자열 읽기(검증), 복원 때 갈 자리 계산, 저장 때 아직 복원 못 한 기록 합치기.
//
// 제공 API
//   PLACES_KEY, placeRecord(entry, info), parsePlaces(text), restoreTarget(rec, layoutOn), restoreDevice(rec),
//   mergePlaces(current, pending).
//
// 의존 대상
//   없음. DOM·탭 저장소를 모르는 순수 계산(node 검사 test/emulator-places.mjs 가 직접 호출)
//
// 유지 조건
//   스페이스는 폴더 열쇠(spk)로 저장. workspace id 는 앱 재시작 때 바뀔 수 있음
//   복원 못 한 기록(스페이스가 아직 안 보임)은 삭제 없이 다음 저장에 합침. 못 본 것 ≠ 없어진 것
//
// 영향 범위
//   web/js/emulator/boot.js 의 저장·복원.

export const PLACES_KEY = "ac.emulator.places";

const ID_RE = /^[\w.:-]{1,128}$/;
const PLACES = new Set(["strip", "column", "stage", "detached"]);
const HOMES = new Set(["column", "tab"]);
const DETACH_HOMES = new Set(["strip", "column", "stage"]);
const MAX_RECORDS = 64;

// entry(boot.js 의 mounted 값) → 기록 한 줄. info: { key, index, active, running, name }
export function placeRecord(entry, info) {
  const place = entry.detached ? "detached" : entry.inColumn ? "column" : entry.inStage ? "stage" : "strip";
  return {
    key: info.key, id: entry.tab.id, label: entry.tab.label || "", deviceId: entry.tab.deviceId || null,
    group: entry.group || "emulator", deviceKey: entry.tab.deviceKey || entry.tab.deviceId || null, owner: entry.tab.owner || null, name: info.name || "", running: !!info.running, place,
    home: entry.home || null, stageFrom: entry.stageFrom || null, detachHome: entry.detachHome || null,
    index: Number.isInteger(info.index) ? info.index : -1, active: !!info.active, narrowed: !!entry.narrowed,
    bounds: validBounds(entry.bounds),
  };
}

export function validBounds(b) {
  if (!b || typeof b !== "object") return null;
  const out = {};
  for (const k of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(b[k])) return null;
    out[k] = Math.round(b[k]);
  }
  return out.width > 0 && out.height > 0 ? out : null;
}

const str = (v, max = 200) => (typeof v === "string" && v.length <= max ? v : null);

// 저장 문자열 → 기록 목록. 모양이 틀린 줄(다른 판의 저장분·손상된 값)은 제외
export function parsePlaces(text) {
  let raw;
  try { raw = JSON.parse(text || "[]"); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw.slice(0, MAX_RECORDS)) {
    if (!r || typeof r !== "object" || !str(r.key, 4096) || !ID_RE.test(String(r.id)) || !PLACES.has(r.place)) continue;
    if (r.deviceId != null && !ID_RE.test(String(r.deviceId))) continue;
    if (r.owner != null && !ID_RE.test(String(r.owner))) continue;
    out.push({
      key: r.key, id: r.id, label: str(r.label) || "", deviceId: r.deviceId || null, owner: r.owner || null, name: str(r.name) || "",
      group: /^[\w.-]{1,40}$/.test(r.group || "") ? r.group : "emulator",
      deviceKey: ID_RE.test(String(r.deviceKey || "")) ? r.deviceKey : null,
      running: r.running === true, place: r.place,
      home: HOMES.has(r.home) ? r.home : null, stageFrom: HOMES.has(r.stageFrom) ? r.stageFrom : null,
      detachHome: DETACH_HOMES.has(r.detachHome) ? r.detachHome : null,
      index: Number.isInteger(r.index) ? r.index : -1, active: r.active === true, narrowed: r.narrowed === true,
      bounds: validBounds(r.bounds),
    });
  }
  return out;
}

// 복원 때 갈 자리. 무대는 rail 기기 화면 안에만 있으므로 그 화면을 나갈 때 가는 자리(home, 없으면 온 자리)
// 세로 열인데 배치 엔진이 꺼져 있으면(좁은 창) 탭 + narrowed(엔진이 켜지면 열로 복귀)
export function restoreTarget(rec, layoutOn) {
  let place = rec.place;
  if (place === "stage") place = (rec.home || rec.stageFrom) === "column" ? "column" : "strip";
  if (place === "column" && !layoutOn) return { place: "strip", narrowed: true };
  return { place, narrowed: place === "strip" && !!rec.narrowed };
}

// 다시 켤 기기. Android 는 붙으면 기록이 시리얼(emulator-5554)로 바뀌고 재시작 뒤 그 시리얼은 없음 → AVD 이름
export function restoreDevice(rec) {
  if (rec.deviceKey && ID_RE.test(rec.deviceKey)) return rec.deviceKey;
  if (rec.deviceId && /^emulator-\d+$/.test(rec.deviceId) && rec.name && ID_RE.test(rec.name)) return rec.name;
  return rec.deviceId;
}

// 저장할 목록. 지금 화면 기록 + 복원 못 한 기록 중 같은 스페이스·같은 소유 세션·같은 탭이 지금 없는 것
export function mergePlaces(current, pending) {
  const slot = (r) => `${r.key}\n${r.deviceKey || r.deviceId || r.id}`;
  const slots = new Set(current.map(slot));
  const ids = new Set(current.map((r) => r.id));
  return current.concat(pending.filter((r) => !slots.has(slot(r)) && !ids.has(r.id))).slice(0, MAX_RECORDS);
}
