// 소유 범위: 파일·메모 표시 설정의 값별 저장·검증·창 안팎 통지.
// 제공 API: editorPref, setEditorPref, toggleEditorPref, subscribeEditorPrefs, monacoPrefOpts.
// 의존 대상: localStorage와 storage 이벤트. 저장소가 없으면 메모리 값을 쓴다.
// 유지 조건: 값마다 별도 키, 메모 미니맵은 끔, Monaco·DOM·문서 상태를 모른다.
// 영향 범위: 파일 편집기와 메모 도크·페이지·창의 옵션과 버튼.

const PREFS = {
  "file.minimap": { storage: "ac.editor.file.minimap", fallback: true },
  "file.wrap": { storage: "ac.editor.file.wrap", fallback: false },
  "memo.wrap": { storage: "ac.editor.memo.wrap", fallback: true },
};
const memory = new Map();
const subscribers = new Set();

export function editorPref(scope, key) {
  const pref = PREFS[`${scope}.${key}`];
  if (!pref) return false;
  let stored;
  try { stored = globalThis.localStorage.getItem(pref.storage); }
  catch { stored = memory.get(pref.storage); }
  return stored === "true" ? true : stored === "false" ? false : pref.fallback;
}

function notify(scope, key) {
  for (const subscriber of subscribers) subscriber(scope, key, editorPref(scope, key));
}

export function setEditorPref(scope, key, value) {
  const pref = PREFS[`${scope}.${key}`];
  if (!pref) return;
  const next = typeof value === "boolean" ? value : pref.fallback;
  memory.set(pref.storage, String(next));
  try { globalThis.localStorage.setItem(pref.storage, String(next)); } catch {}
  notify(scope, key);
}

export function toggleEditorPref(scope, key) {
  setEditorPref(scope, key, !editorPref(scope, key));
}

export function subscribeEditorPrefs(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function monacoPrefOpts(scope) {
  return { minimap: { enabled: editorPref(scope, "minimap") }, wordWrap: editorPref(scope, "wrap") ? "on" : "off" };
}

globalThis.addEventListener?.("storage", (event) => {
  if (event.storageArea && event.storageArea !== globalThis.localStorage) return;
  for (const [name, pref] of Object.entries(PREFS)) {
    if (event.key !== null && event.key !== pref.storage) continue;
    memory.delete(pref.storage);
    const [scope, key] = name.split(".");
    notify(scope, key);
  }
});
