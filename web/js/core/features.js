// 설치본의 기능 상태를 부팅 전에 읽고, 저장 성공 뒤에만 화면에 반영한다.
import { RAIL_ITEMS, railItemById, lockedIds } from "./rail-items.js";
import { CAPABILITIES } from "./capabilities.js";
import { callHook } from "./hooks.js";

const KEY = "ac.railHidden";
const LOCKED = new Set(lockedIds());

// rail 에 등록되지 않는 기능. 표에서 rail 이 비어 있는 항목이다.
function railless() { return CAPABILITIES.filter((c) => !c.rail); }
// 설정 목록·상태 파일은 rail 이 있으면 rail id 로, 없으면 기능 id 로 부른다.
const capOf = (id) => CAPABILITIES.find((c) => (c.rail || c.id) === id || c.id === id);
export function featureOptIn(id) { return capOf(id)?.optIn || null; }
// server/feature-state-read.cjs 의 featureOn 과 같은 식이다. 검사가 둘을 대조한다.
export function featureOn(s, id, optIn) {
  if ((s.hidden || []).includes(id)) return false;
  return !optIn || (s.shown || []).includes(id);
}
const isOn = (id) => featureOn(state, id, !!featureOptIn(id));

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
  return { ...value, shown: Array.isArray(value.shown) ? value.shown : [] };
}
export async function refreshFeatures() {
  const response = await fetch("/features", { cache: "no-store" });
  if (!response.ok) throw new Error("기능 상태를 읽지 못했습니다");
  state = await responseValue(response);
}
// 상태를 못 읽어도 앱 셸은 떠야 한다. 무엇을 꺼 두었는지 모르는 회차에는 선택 기능을 하나도
// 로드하지 않고 설정 변경만 잠근다. 꺼 둔 기능이 그 회차에 실행되면 끈 설정이 무시된다.
try { await refreshFeatures(); }
catch (error) { loadError = error; state = { exists: false, revision: 0, hidden: CAPABILITIES.map((c) => c.id), shown: [], local: false }; }

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

// 사용자가 켜지 않은 기본 꺼짐 기능도 로드하지 않는다. 기능 id 와 rail id 를 모두 넣는다.
export function featureHidden() {
  const off = CAPABILITIES.filter((c) => !isOn(c.rail || c.id)).flatMap((c) => [c.id, c.rail].filter(Boolean));
  return new Set([...state.hidden, ...off, ...pendingRestart]);
}
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
      const hidden = new Set(base.hidden), shown = new Set(base.shown);
      change(hidden, shown);
      const response = await fetch("/features", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: [...hidden], shown: [...shown], baseRevision: base.revision }) });
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
// on 은 저장된 상태다. 재시작 대기 중인 것은 켜짐으로 보이되 그 사실을 적는다.
export function featureList() {
  const note = (id) => pendingRestart.has(id) ? "저장했습니다. 앱을 다시 시작하면 켜집니다"
    : !isOn(id) && featureOptIn(id) ? "기본 꺼짐. 켜면 필요한 권한과 동작을 먼저 안내합니다" : featureRestartNote(id);
  const rows = RAIL_ITEMS.map((f) => ({
    id: f.id, label: f.label, on: isOn(f.id), optIn: !!featureOptIn(f.id), lock: f.canDisable ? featureLockNote() : f.disabledReason,
    readonly: !state.local, note: note(f.id),
  }));
  for (const c of railless()) rows.push({ id: c.id, label: c.label || c.id, on: isOn(c.id), optIn: !!c.optIn, lock: featureLockNote(), readonly: !state.local, note: note(c.id) });
  return rows;
}

// 끄기 전에 그 기능이 자기 네이티브 동작(단축키·타이머·로그인 항목 등)을 거두게 한다. 채운 기능이 없거나
// 3초 안에 끝나지 않으면 그대로 끈다. 끄는 것을 막으면 사용자가 기능을 끌 수 없게 된다.
async function beforeDisable(id) {
  const capId = capOf(id)?.id || id;
  let timer;
  try {
    await Promise.race([
      Promise.resolve(callHook(`${capId}.disabling`)),
      new Promise((resolve) => { timer = setTimeout(resolve, 3000); }),
    ]);
  } catch {} finally { clearTimeout(timer); }
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
// 꺼져 있는 기본 꺼짐 기능은 확인 창 없이 켜지면 안 되므로 프리셋 대상에서 뺀다. 켜진 것은 끌 수 있다.
export function presetPlan(presetId) {
  if (!(presetId in PRESET_ON)) return null;
  const want = PRESET_ON[presetId];
  const rows = featureList().filter((r) => !r.lock && !(r.optIn && !r.on));   // 잠긴 것은 프리셋이 못 건드린다
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
  for (const id of plan.turningOff) if (featureOptIn(id)) await beforeDisable(id);
  await write((hidden, shown) => {
    for (const id of plan.on) hidden.delete(id);
    for (const id of plan.off) { hidden.add(id); shown.delete(id); }
  });
  for (const id of plan.turningOn) if (featureNeedsRestart(id)) pendingRestart.add(id);
  for (const id of plan.off) pendingRestart.delete(id);
  return plan;
}

// 기본 꺼짐 기능을 켜려면 부르는 쪽이 확인 창(featureOptIn 문구)을 보여 주고 confirmed 를 넘긴다.
export async function toggleFeature(id, { confirmed = false } = {}) {
  if (!id || LOCKED.has(id) || !featureIsKnown(id)) return false;
  const optIn = !!featureOptIn(id);
  const turnOff = isOn(id);
  if (!turnOff && optIn && !confirmed) return false;
  if (turnOff && optIn) await beforeDisable(id);
  await write((hidden, shown) => {
    if (turnOff) { hidden.add(id); shown.delete(id); }
    else { hidden.delete(id); if (optIn) shown.add(id); }
  });
  if (turnOff) pendingRestart.delete(id);
  else if (featureNeedsRestart(id)) pendingRestart.add(id);
  return true;
}

// 패널을 갖는 기능. 끄면 그 패널도 함께 내려가야 한다. 그러지 않으면 아무도 채우지 않는
// 안내문만 남은 빈 영역이 그대로 보인다.
export function panelFeatures() {
  return CAPABILITIES.filter((c) => c.panel).map((c) => ({ id: c.id, panel: c.panel }));
}
