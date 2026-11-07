// Paseo 대화 화면 빌드 관리의 계산 부분. 파일·프로세스를 건드리지 않음
//
// 제공 API
//   parseVersion · compareVersions · latestStableTag(lsRemoteText) · buildName · parseBuildName ·
//   parseState(raw) · nextBuild · recordFailure · promote · rollback · checkDue · staticTarget(urlPath) · IMAGE_TYPES
//
// 유지 조건
//   태그는 vX.Y.Z 만 안정판으로 봄(-beta·-rc 등 제외)
//   실패한 빌드는 기다렸다 다시 시도하고 3번 실패하면 멈춤. 새 버전·새 Iris 재료가 나오면 그것을 시도

export const IMAGE_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp",
};

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// git ls-remote --tags 출력 → 가장 높은 안정판 버전(앞의 v 없이) 또는 null
export function latestStableTag(text) {
  let best = null;
  for (const line of String(text || "").split("\n")) {
    const m = /\srefs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line.trim());
    if (!m) continue;
    if (!best || compareVersions(m[1], best) > 0) best = m[1];
  }
  return best;
}

// 빌드 하나의 이름: Paseo 버전 + Iris 빌드 재료(진입 파일·Metro 설정·빌드 절차) 해시
// - Iris 쪽 재료가 바뀌면 같은 Paseo 버전도 다시 빌드
export const LEGACY_RECIPE = "00000000";
export function buildName(version, recipe) {
  return recipe === LEGACY_RECIPE ? version : `${version}-${recipe}`;
}
export function parseBuildName(name) {
  const m = /^(\d+\.\d+\.\d+)(?:-([0-9a-f]{8,64}))?$/.exec(String(name || ""));
  return m ? { version: m[1], recipe: m[2] || LEGACY_RECIPE } : null;
}

const RECIPE_RE = /^[0-9a-f]{8,64}$/;
const isBuild = (b) => !!b && parseVersion(b.version) && RECIPE_RE.test(String(b.recipe || ""));
const sameBuild = (a, b) => !!a && !!b && a.version === b.version && a.recipe === b.recipe;

// 실패 뒤 다시 시도하기까지 기다리는 시간(실패 횟수 1·2회 뒤). 3회 실패하면 새 버전·새 재료가 나올 때까지 멈춤
export const RETRY_AFTER_MS = [30 * 60 * 1000, 3 * 60 * 60 * 1000];
export const MAX_TRIES = 3;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// current.json → { current, previous, failed: [{ version, recipe, count, at }], checkedAt }
// - current·previous: { version, recipe } | null. previous 는 실행이 깨진 새 빌드에서 되돌아갈 곳
export function parseState(raw) {
  let j = null;
  try { j = JSON.parse(raw || "null"); } catch {}
  // 재료 해시가 없던 이전 형식({ version })은 LEGACY_RECIPE 로 읽음. 새 빌드가 끝날 때까지 그 화면을 계속 씀
  const legacy = !j?.current && parseVersion(j?.version) ? { version: j.version, recipe: LEGACY_RECIPE } : null;
  const current = isBuild(j?.current) ? { version: j.current.version, recipe: j.current.recipe } : legacy;
  const previous = isBuild(j?.previous) && !sameBuild(j.previous, current) ? { version: j.previous.version, recipe: j.previous.recipe } : null;
  const failed = Array.isArray(j?.failed)
    ? j.failed.filter((f) => isBuild(f) && Number.isSafeInteger(f.count) && f.count > 0 && Number.isFinite(f.at))
      .map((f) => ({ version: f.version, recipe: f.recipe, count: f.count, at: f.at }))
    : [];
  const checkedAt = Number.isFinite(j?.checkedAt) ? j.checkedAt : 0;
  return { current, previous, failed, checkedAt };
}

// 빌드할 { version, recipe } 또는 null
// - force: 사람이 화면을 다시 열었을 때. 기다리는 시간은 무시하고 횟수 제한만 지킴
export function nextBuild(state, latest, recipe, now, { force = false } = {}) {
  const want = { version: latest, recipe };
  if (!isBuild(want)) return null;
  if (state.current && compareVersions(latest, state.current.version) < 0) return null;
  if (sameBuild(state.current, want)) return null;
  const f = state.failed.find((x) => sameBuild(x, want));
  if (f) {
    if (f.count >= MAX_TRIES) return null;
    if (!force && now - f.at < RETRY_AFTER_MS[Math.min(f.count, RETRY_AFTER_MS.length) - 1]) return null;
  }
  return want;
}

// 실패 기록. hard: 실행이 깨진 빌드처럼 다시 해도 같은 결과인 실패 → 바로 횟수를 채움
export function recordFailure(state, build, now, hard = false) {
  const prev = state.failed.find((x) => sameBuild(x, build));
  const count = hard ? MAX_TRIES : (prev?.count || 0) + 1;
  const failed = state.failed.filter((x) => !sameBuild(x, build)).concat({ ...build, count, at: now });
  return { ...state, failed: failed.slice(-10) };
}

// 성공한 빌드를 현재로. 바로 앞 현재를 previous 로
export function promote(state, build) {
  return { ...state, current: build, previous: state.current && !sameBuild(state.current, build) ? state.current : state.previous,
    failed: state.failed.filter((x) => !sameBuild(x, build)) };
}

// 지금 빌드가 실행에서 깨졌을 때 되돌릴 상태 또는 null(되돌아갈 곳 없음)
export function rollback(state, now) {
  if (!state.current || !state.previous) return null;
  return { ...recordFailure(state, state.current, now, true), current: state.previous, previous: null };
}

export function checkDue(state, now) {
  return now - state.checkedAt >= CHECK_EVERY_MS;
}

// /paseo-ui/ 아래 주소 → 빌드 폴더 안의 상대 경로 또는 null
// - 상위 경로(..)·절대 경로·NUL 은 거절. 폴더 주소는 index.html
export function staticTarget(urlPath) {
  let rel;
  try { rel = decodeURIComponent(String(urlPath || "").replace(/^\/paseo-ui\/?/, "")); } catch { return null; }
  if (rel.includes("\0") || rel.startsWith("/") || rel.startsWith("\\")) return null;
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === ".")) return null;
  return parts.join("/");
}
