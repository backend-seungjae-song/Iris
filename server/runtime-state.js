import path from "node:path";

// 서버가 최근 publish한 workspace snapshot과 recompute 재진입 guard의 단일 소유자.
//
// 소유 범위
//   교체되는 state·workspaces·tabs·allowedRoots snapshot, recompute의 computing·dirty 상태,
//   실제로 열어 본 파일의 저장 capability, fs.list와 git mutation이 공유하는 짧은 Git 상태 cache,
//   entry가 한 번 주입하는 scheduleRecompute 포트.
//
// 제공 API
//   initRuntimeState, 현재 참조를 읽는 snapshot, 경로 경계 isPathAllowed,
//   publish용 replace, 재진입 guard를 통과시키는 requestRecompute, 열린 파일의 note/save 판정,
//   Git 상태 cache의 get/set/clear 함수. 원시 Map은 내보내지 않는다.
//
// 의존 대상
//   경로 정규화는 node:path에, 실제 recompute 본문은 initRuntimeState에서 주입받은
//   scheduleRecompute에 기대며 기능 모듈은 import하지 않는다.
//
// 유지 조건
//   교체되는 값을 원시 export하지 않고 방어 복사도 만들지 않는다. publish는 replace로만 하며,
//   계산 중 요청은 dirty 한 번으로 합쳐 현재 계산이 끝난 직후 같은 순서로 다시 요청한다.
//
// 영향 범위
//   server/index.js의 HTTP·WS 초기 snapshot, browser·memo·archive·fs·git·run 경계와
//   recompute publish/fallback/event 호출부, fs·sheet·docx·git handler 및 이후 이 API를 import하는 모든 서버 기능 모듈.

let current = {
  state: [],
  workspaces: [],
  tabs: {},
  allowedRoots: [],
};
let scheduleRecompute;
let computing = false;
let dirty = false;
const gitStatusCache = new Map();
const openedForEdit = new Map();
const OPENED_MAX = 500;

export function initRuntimeState(deps) {
  ({ scheduleRecompute } = deps);
}

export function snapshot() {
  return current;
}

export function isPathAllowed(p) {
  if (typeof p !== "string" || !p) return false;
  const abs = path.resolve(p);
  return current.allowedRoots.some((root) => abs === root || abs.startsWith(root + path.sep));
}

export function replace(next) {
  current = { ...current, ...next };
}

export function getGitStatusCache(root) {
  return gitStatusCache.get(root);
}

export function setGitStatusCache(root, value) {
  gitStatusCache.set(root, value);
}

export function clearGitStatusCache(root) {
  gitStatusCache.delete(root);
}

// 저장 경계를 워크스페이스 안으로만 잡아 두면, 사람이 뷰어로 열어 고친 파일을 저장하지 못한다.
// 그렇다고 로컬의 임의 경로를 허용하지는 않고, 이 앱이 실제로 열어 준 파일만 예외로 추가한다.
export function noteOpened(p) {
  try {
    const abs = path.resolve(p);
    openedForEdit.delete(abs);
    openedForEdit.set(abs, Date.now());
    while (openedForEdit.size > OPENED_MAX) openedForEdit.delete(openedForEdit.keys().next().value);
  } catch {}
}

function wasOpenedHere(p) {
  try { return openedForEdit.has(path.resolve(p)); } catch { return false; }
}

export function saveAllowed(p) { return isPathAllowed(p) || wasOpenedHere(p); }

export function saveDeniedMsg(p) {
  return "이 파일에는 저장하지 않습니다: " + String(p || "")
    + " — 저장은 스페이스 폴더 안이거나, 이 앱에서 열어 본 파일이어야 합니다."
    + " 앱에서 그 파일을 한 번 연 뒤 다시 저장해 주세요.";
}

export async function requestRecompute() {
  if (computing) {
    dirty = true;
    return;
  }
  computing = true;
  try {
    await scheduleRecompute();
  } finally {
    computing = false;
    if (dirty) {
      dirty = false;
      requestRecompute();
    }
  }
}
