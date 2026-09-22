// 설치본의 기능 상태를 부팅 전에 읽고, 저장 성공 뒤에만 화면에 반영한다.
import { RAIL_ITEMS, railItemById, lockedIds } from "./rail-items.js";
import { CAPABILITIES } from "./capabilities.js";

const KEY = "ac.railHidden";
const LOCKED = new Set(lockedIds());

// rail 에 등록되지 않는 기능. 표에서 rail 이 비어 있는 항목이다.
function railless() { return CAPABILITIES.filter((c) => !c.rail); }

let state;
let loadError = null;
// 이 회차에 켰지만 서버·네이티브 구성 요소 때문에 재시작 전에는 로드되지 않는 기능. 화면에서는 꺼진 것으로 다룬다.
const pendingRestart = new Set();
let writes = Promise.resolve();
const MARKER = KEY + ".migrated";

async function responseValue(response) {
  const value = await response.json();
  if (!Array.isArray(value.hidden) || !Number.isSafeInteger(value.revision)
    || typeof value.local !== "boolean") throw new Error("기능 상태를 읽지 못했습니다");
  return value;
}
export async function refreshFeatures() {
  const response = await fetch("/features", { cache: "no-store" });
  if (!response.ok) throw new Error("기능 상태를 읽지 못했습니다");
  state = await responseValue(response);
}
// 상태를 못 읽어도 앱 셸은 떠야 한다. 무엇을 꺼 두었는지 모르는 회차에는 선택 기능을 하나도
// 로드하지 않고 설정 변경만 잠근다. 꺼 둔 기능이 그 회차에 실행되면 끈 설정이 무시된다.
try { await refreshFeatures(); }
catch (error) { loadError = error; state = { exists: false, revision: 0, hidden: CAPABILITIES.map((c) => c.id), local: false }; }

let legacy = null, migrated = null;
try { legacy = localStorage.getItem(KEY); migrated = localStorage.getItem(MARKER); } catch {}
if (!state.exists && state.local && legacy !== null && migrated === null) {
  let hidden;
  try { hidden = JSON.parse(legacy); } catch { hidden = null; }
  if (Array.isArray(hidden) && hidden.every((id) => typeof id === "string")) {
    const response = await fetch("/features", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden, baseRevision: state.revision }) });
    if (!response.ok && response.status !== 409) throw new Error("기능 설정을 옮기지 못했습니다");
    state = await responseValue(response);
    try { localStorage.setItem(MARKER, String(state.revision)); } catch {}
  }
}

export function featureHidden() { return new Set([...state.hidden, ...pendingRestart]); }
export function featurePendingRestart() { return new Set(pendingRestart); }
// 설정을 바꿀 수 없는 이유. 비어 있으면 바꿀 수 있다.
export function featureLockNote() {
  if (loadError) return "기능 상태를 읽지 못해 선택 기능을 싣지 않았습니다. ⌘⇧R 로 다시 읽어 주세요";
  return state.local ? "" : "원격 창에서는 기능 설정을 바꿀 수 없습니다";
}
function write(change) {
  const task = writes.then(async () => {
    const reason = featureLockNote();
    if (reason) throw new Error(reason);
    let base = state;
    for (let attempt = 0; attempt < 8; attempt++) {
      const hidden = new Set(base.hidden);
      change(hidden);
      const response = await fetch("/features", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: [...hidden], baseRevision: base.revision }) });
      if (response.status === 409) { base = await responseValue(response); continue; }
      if (!response.ok) throw new Error("기능 설정을 저장하지 못했습니다");
      state = await responseValue(response);
      return;
    }
    throw new Error("다른 창에서 설정을 바꾸고 있습니다. 다시 시도해 주세요");
  });
  writes = task.catch(() => {});
  return task;
}

// 서버·네이티브 짝이 있는 기능은 부팅 때 조립되므로 켜고 끄는 반영이 앱 재시작이다.
export function featureNeedsRestart(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (cap?.alwaysIn?.includes("memo")) return false;   // 서버 쪽이 항상 켜져 있어 렌더러만 다시 로드하면 된다
  return !!(cap?.server?.length || cap?.native);
}

export function featureRestartNote(id) {
  const cap = CAPABILITIES.find((c) => c.id === id);
  if (cap?.alwaysIn?.includes("memo")) return "본 창에서만 빠집니다. 메모 창과 메모 서버는 유지됩니다";
  return featureNeedsRestart(id)
    ? "앱을 다시 시작하면 서버·네이티브에서도 빠집니다"
    : "⌘⇧R 로 다시 읽으면 빠집니다";
}

export function featureEnableNote(id) {
  return featureNeedsRestart(id) ? "저장했습니다. 앱을 다시 시작하면 켜집니다" : "켰습니다";
}

export function featureIsKnown(id) { return !!railItemById(id) || railless().some((c) => c.id === id); }

// 설정이 그릴 목록. rail 화면이 먼저 오고, 패널만 갖는 기능이 그 뒤에 온다.
export function featureList() {
  const saved = new Set(state.hidden);   // 저장된 상태. 재시작 대기 중인 것은 켜짐으로 보이되 그 사실을 적는다
  const note = (id) => pendingRestart.has(id) ? "저장했습니다. 앱을 다시 시작하면 켜집니다" : featureRestartNote(id);
  const rows = RAIL_ITEMS.map((f) => ({
    id: f.id, label: f.label, on: !saved.has(f.id), lock: f.canDisable ? featureLockNote() : f.disabledReason,
    readonly: !state.local, note: note(f.id),
  }));
  for (const c of railless()) rows.push({ id: c.id, label: c.label || c.id, on: !saved.has(c.id), lock: featureLockNote(), readonly: !state.local, note: note(c.id) });
  return rows;
}

// 프리셋. 사용자마다 주로 쓰는 상위 개념이 다르고, 이 도구는 편의를 위해 조립하는 커스텀
// 도구다. 프리셋은 켤 id 목록 하나이며, 표시 문자열은 여기 코드에 정의한 것만 쓴다.
// 사용자가 입력한 문자열을 저장해 두고 화면에 그리면 그 지점이 주입 경계가 된다.
export const PRESETS = [
  { id: "full", label: "전부", desc: "쓸 수 있는 기능을 모두 켠다" },
  { id: "minimal", label: "최소", desc: "작업과 설정만 남긴다" },
  { id: "dev", label: "개발자", desc: "깃·실행·로컬 서버" },
];

// 어느 기능이 어느 그룹에 드는지는 기능 자신이 선언한다(capabilities.js 의 presets).
// 여기에 id 목록을 두면 두 사람이 각자 기능을 추가할 때 같은 줄에서 충돌한다.
const inPreset = (id) => CAPABILITIES.filter((c) => (c.presets || []).includes(id)).map((c) => c.id);
const PRESET_ON = {
  full: null,                                              // null 은 "전부"
  minimal: [],
  get dev() { return inPreset("dev"); },
};

// 프리셋을 적용하면 무엇이 켜지고 무엇이 꺼지는지. 실제로 바꾸기 전에 물어볼 수 있게 따로 낸다.
export function presetPlan(presetId) {
  if (!(presetId in PRESET_ON)) return null;
  const want = PRESET_ON[presetId];
  const rows = featureList().filter((r) => !r.lock);       // 잠긴 것은 프리셋이 못 건드린다
  const on = rows.filter((r) => want === null || want.includes(r.id)).map((r) => r.id);
  const off = rows.filter((r) => !on.includes(r.id)).map((r) => r.id);
  const hidden = featureHidden();
  return {
    on, off,
    turningOn: on.filter((id) => hidden.has(id)),
    turningOff: off.filter((id) => !hidden.has(id)),
  };
}

// 적용은 상태만 바꾼다. 화면 반영과 "지금 실을지 다음에 실을지"는 부르는 쪽이 정한다.
export async function applyPreset(presetId) {
  const plan = presetPlan(presetId);
  if (!plan) return null;
  await write((hidden) => {
    for (const id of plan.on) hidden.delete(id);
    for (const id of plan.off) hidden.add(id);
  });
  for (const id of plan.turningOn) if (featureNeedsRestart(id)) pendingRestart.add(id);
  for (const id of plan.off) pendingRestart.delete(id);
  return plan;
}

export async function toggleFeature(id) {
  if (!id || LOCKED.has(id) || !featureIsKnown(id)) return false;
  const turnOff = !state.hidden.includes(id);
  await write((hidden) => { turnOff ? hidden.add(id) : hidden.delete(id); });
  if (turnOff) pendingRestart.delete(id);
  else if (featureNeedsRestart(id)) pendingRestart.add(id);
  return true;
}

// 패널을 갖는 기능. 끄면 그 패널도 함께 내려가야 한다. 그러지 않으면 아무도 채우지 않는
// 안내문만 남은 빈 영역이 그대로 보인다.
export function panelFeatures() {
  return CAPABILITIES.filter((c) => c.panel).map((c) => ({ id: c.id, panel: c.panel }));
}
