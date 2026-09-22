// 스페이스별 상태의 키는 경로가 아니라 폴더 객체의 파일시스템 정체성이다.
//
// herdr workspace_id는 스페이스를 닫았다 되살리면 달라지고, 절대경로는 폴더를 rename/move하면
// 달라진다. 둘 중 어느 것도 북마크·브라우저 탭·그룹·메모 같은 영속 상태의 정체성이 될 수 없다.
// 파일시스템의 inode + birthtime은 같은 폴더 객체가 같은 볼륨 안에서 이동해도 유지되고, 같은
// 경로에 폴더를 새로 만들면 달라진다. macOS에서 재부팅마다 바뀔 수 있는 device는 영속 키에 넣지
// 않는다. 런타임 권한과 조작은 계속 workspace_id로 판정하고, 디스크에 남기는 상태만 이 폴더 객체
// 키로 변환한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateHome } from "./state-home.cjs";

const KEY_PATH = path.join(stateHome(), "space-keys.json");
const FOLDER_KEY_PREFIX = "folder:";
const FOLDER_KEY_VERSION = "v2";

// 폴더가 없는 공유 브라우저 영역.
export const SHARED = "__shared__";

export const CONFIRMED = "identity";
export const WEAK = "pane";
export const REQUESTED = "requested";

export function isFolderKey(key) {
  return typeof key === "string" && key.startsWith(FOLDER_KEY_PREFIX);
}

export function isLegacyPathKey(key) {
  return typeof key === "string" && path.isAbsolute(key);
}

export function realDir(value) {
  if (!value) return "";
  try { return fs.realpathSync(path.resolve(value)); } catch { return path.resolve(value); }
}

const observedDirByKey = new Map();

function identityTail(key) {
  const match = /^folder:[^:]+:([^:]+):([^:]+)$/.exec(String(key || ""));
  return match ? `${match[1]}:${match[2]}` : null;
}

function canonicalFolderKey(key) {
  const identity = identityTail(key);
  return identity ? `${FOLDER_KEY_PREFIX}${FOLDER_KEY_VERSION}:${identity}` : null;
}

// bigint stat을 써야 큰 inode가 Number 정밀도에서 잘려 다른 객체와 충돌하지 않는다.
export function keyForDir(value) {
  if (!value) return null;
  const dir = realDir(value);
  try {
    const st = fs.statSync(dir, { bigint: true });
    if (!st.isDirectory()) return null;
    const born = st.birthtimeNs > 0n ? st.birthtimeNs : 0n;
    const identity = `${st.ino.toString(36)}:${born.toString(36)}`;
    const key = `${FOLDER_KEY_PREFIX}${FOLDER_KEY_VERSION}:${identity}`;
    observedDirByKey.set(key, dir);
    return key;
  } catch {
    return null;
  }
}

// history까지 포함해 v1 키 아래 남은 상태를 같은 정체성의 결정론적 v2 키로 고른다. 관측 순서가
// canonical을 정하지 않으므로 서버 재시작이나 레코드 순서 변경으로 이관 방향이 뒤집힐 수 없다.
export function driftedKeyRemaps() {
  const out = {};
  for (const record of Object.values(folderById)) {
    for (const candidate of [record.key, ...(record.history || []).map((item) => item.key)]) {
      const canonical = canonicalFolderKey(candidate);
      if (candidate && canonical && candidate !== canonical) out[candidate] = canonical;
    }
  }
  return out;
}

export function slug(raw) {
  return String(raw || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20);
}

function normalizeSrc(src) {
  if (src === REQUESTED || src === CONFIRMED) return src;
  return WEAK;
}

// 생성 요청은 즉시 바인딩할 근거지만 최종 정체성은 아니다. herdr의 검증된 identity가 나중에
// 다른 폴더 객체를 가리키면 따라가야 한다. pane cwd는 identity를 한 번 얻은 뒤에는 바꾸지 못한다.
function srcRank(src) {
  return src === CONFIRMED ? 2 : (src === REQUESTED ? 1 : 0);
}

function normalizeAliases(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((x) => typeof x === "string" && x)
    .map(realDir))];
}

function normalizeHistory(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value.dir !== "string" || !isFolderKey(value.key)) continue;
    const dir = realDir(value.dir);
    const token = `${value.key}\n${dir}`;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ dir, key: value.key, aliases: normalizeAliases(value.aliases) });
    observedDirByKey.set(value.key, dir);
    const canonical = canonicalFolderKey(value.key);
    if (canonical) observedDirByKey.set(canonical, dir);
  }
  return out.slice(-50);
}

let folderById = {}; // { [workspaceId]: { dir, key, src, aliases, history } }
let loadedLegacy = false;
let loaded = false;

// 읽기는 import 시점이 아니라 load()를 부를 때 한다.
//
// 정적 import는 호출하는 쪽 본문보다 먼저 평가된다. 그래서 여기서 파일을 읽으면 상태 폴더의
// 잠금을 얻기 전에 읽게 되고, 잠금을 기다리던 서버가 T0 스냅샷을 가진 채 소유권을 넘겨받아
// 그 사이의 변경을 덮어쓴다. 레거시 형식이면 그 시점에 200ms 저장 타이머까지 예약되어,
// 아직 다른 프로세스가 소유한 파일을 기다리는 동안 덮어쓴다.
export function load() {
  if (loaded) return;
  loaded = true;
  readKeyFile();
  // 레거시 경로표를 안정 키로 승격하는 첫 쓰기. 잠금을 얻은 뒤에만 실행해야 한다.
  if (loadedLegacy) persist();
}

function readKeyFile() {
  folderById = {};
  loadedLegacy = false;
  observedDirByKey.clear();
  const raw = readKeyRaw();
  if (!raw) return;
  for (const [id, value] of Object.entries(raw)) {
    const old = typeof value === "string" ? { dir: value } : value;
    if (!old || typeof old.dir !== "string") continue;
    const dir = realDir(old.dir);
    const aliases = normalizeAliases(old.aliases);
    const previousKey = isFolderKey(old.key) ? old.key : null;
    const key = (previousKey && canonicalFolderKey(previousKey)) || keyForDir(dir);
    const history = normalizeHistory([
      ...(old.history || []),
      ...(previousKey && key && previousKey !== key ? [{ dir, key: previousKey, aliases }] : []),
    ]);
    folderById[id] = { dir, key: key || null, src: normalizeSrc(old.src), aliases, history };
    if (!previousKey || previousKey !== key) loadedLegacy = true;
    if (key) {
      observedDirByKey.set(key, dir);
    }
    if (previousKey) observedDirByKey.set(previousKey, dir);
  }
}

function readKeyRaw() {
  try { return JSON.parse(fs.readFileSync(KEY_PATH, "utf8")) || {}; } catch { return null; }
}

let saveTimer = null;
let keyBackupDone = false;
function backupBeforeFirstWrite() {
  if (keyBackupDone) return;
  keyBackupDone = true;
  try {
    if (!fs.existsSync(KEY_PATH)) return;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const backup = `${KEY_PATH}.bak-${stamp}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(KEY_PATH, backup);
  } catch {}
}
function persist() {
  // 레거시 경로표를 안정 키로 승격하는 첫 쓰기 전에 원본을 보존한다. 상태 파일 이관이 중간에
  // 실패해도 이 표와 browser-state의 각자 백업으로 되돌릴 수 있어야 한다.
  backupBeforeFirstWrite();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 200);
}
function writeNow() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH + ".tmp", JSON.stringify(folderById), { mode: 0o600 });
    fs.renameSync(KEY_PATH + ".tmp", KEY_PATH);
  } catch {}
}
// 종료 신호가 지연 구간에 들어오면 방금 만든 스페이스↔폴더 연결이 사라진다. 키가 그 상태의
// 주소이므로, 다음 실행에서 그 스페이스는 자기 탭·북마크를 찾지 못한다.
export function flushNow() {
  if (!saveTimer) return false;
  clearTimeout(saveTimer);
  writeNow();
  return true;
}

// 반환:
// - previousKey=null: 같은 폴더 객체의 위치만 달라졌거나 최초 바인딩
// - previousKey=<key>: workspace가 다른 폴더 객체로 이동
//
// previousKey가 생겨도 그 상태를 새 키로 옮기면 안 된다. 상태의 소유자는 workspace가 아니라 폴더
// 객체이므로, 호출자는 새 바인딩을 방송하기만 해야 한다.
export function learnFolder(wsId, cwd, src = WEAK) {
  if (!wsId || !cwd) {
    return { dir: folderOf(wsId), key: keyOf(wsId), previousKey: null, previousDir: null };
  }
  const dir = realDir(cwd);
  const key = keyForDir(dir);
  if (!key) return { dir: folderOf(wsId), key: keyOf(wsId), previousKey: null, previousDir: null };
  src = normalizeSrc(src);
  const current = folderById[wsId];

  if (!current) {
    folderById[wsId] = { dir, key, src, aliases: [], history: [] };
    persist();
    return { dir, key, previousKey: null, previousDir: null };
  }

  if (current.key === key) {
    let changed = false;
    const previousDir = current.dir;
    if (current.dir !== dir) {
      current.aliases = [...new Set([...(current.aliases || []), current.dir])].filter((x) => x && x !== dir);
      current.dir = dir;
      changed = true;
    }
    if (srcRank(src) > srcRank(current.src)) {
      current.src = src;
      changed = true;
    }
    if (changed) persist();
    observedDirByKey.set(key, dir);
    return { dir, key, previousKey: null, previousDir: previousDir === dir ? null : previousDir };
  }

  const sameConfirmedRank = src === CONFIRMED && current.src === CONFIRMED;
  const unresolvedCurrent = !current.key;
  if (srcRank(src) < srcRank(current.src)
    || (srcRank(src) === srcRank(current.src) && !sameConfirmedRank && !unresolvedCurrent)) {
    return { dir: current.dir, key: current.key || wsId, previousKey: null, previousDir: null };
  }

  const previousKey = current.key || wsId;
  const previousDir = current.dir;
  // 다른 객체로 이동한 경우 옛 경로를 alias로 새 객체에 붙이지 않는다. 이전 객체의 기록으로 따로
  // 남겨, 연결이 끊겼던 창의 옛 경로 저장분은 이전 키로 돌아가고 새 폴더 설정과 섞이지 않게 한다.
  const history = normalizeHistory([
    ...(current.history || []),
    ...(current.key ? [{ dir: current.dir, key: current.key, aliases: current.aliases || [] }] : []),
  ]);
  folderById[wsId] = { dir, key, src, aliases: [], history };
  observedDirByKey.set(key, dir);
  persist();
  return { dir, key, previousKey, previousDir };
}

export function folderOf(wsId) {
  return (wsId && folderById[wsId] && folderById[wsId].dir) || null;
}

export function srcOf(wsId) {
  return (wsId && folderById[wsId] && folderById[wsId].src) || null;
}

export function dirOfKey(key) {
  if (!key) return null;
  if (isLegacyPathKey(key)) return realDir(key);
  const observed = observedDirByKey.get(key);
  if (observed) return observed;
  for (const record of Object.values(folderById)) {
    if (record.key === key && record.dir) return record.dir;
    const past = (record.history || []).find((item) => item.key === key && item.dir);
    if (past) return past.dir;
  }
  return null;
}

// 렌더러가 workspace_id로 보낸 로컬 저장분을 폴더 객체 키로 옮기는 표.
export function allKeys() {
  const out = {};
  for (const id of Object.keys(folderById)) {
    const key = keyOf(id);
    if (key) out[id] = key;
  }
  return out;
}

// 레거시 workspace_id/절대경로 저장분을 안정 키로 옮긴다. 하나의 옛 키가 여러 객체를 가리키게 된
// 기록은 추측하지 않고 생략한다.
export function remapsFor(_liveIds) {
  const candidates = new Map();
  const add = (from, to) => {
    if (!from || !to || from === to) return;
    if (!candidates.has(from)) candidates.set(from, new Set());
    candidates.get(from).add(to);
  };
  for (const [id, record] of Object.entries(folderById)) {
    if (!record.key) continue;
    const currentKey = keyOf(id);
    add(id, currentKey);
    add(record.dir, currentKey);
    for (const alias of record.aliases || []) add(alias, currentKey);
    for (const past of record.history || []) {
      const pastKey = keyOf(past.key);
      add(past.key, pastKey);
      add(past.dir, pastKey);
      for (const alias of past.aliases || []) add(alias, pastKey);
    }
  }
  const out = {};
  for (const [from, targets] of candidates) if (targets.size === 1) out[from] = [...targets][0];
  return out;
}

export function keyOf(space) {
  if (!space || space === SHARED) return space;
  if (isFolderKey(space)) return canonicalFolderKey(space) || space;
  const known = folderById[space]?.key;
  if (known) return canonicalFolderKey(known) || known;
  if (isLegacyPathKey(space)) return keyForDir(space) || space;
  return String(space);
}

export function sameStorageSpace(left, right) {
  if (!left || !right) return false;
  return keyOf(left) === keyOf(right);
}

export function idOfKey(key, liveIds, preferredId = null) {
  if (!key || key === SHARED || !isFolderKey(key)) return key;
  key = keyOf(key);
  if (preferredId && (liveIds || []).includes(preferredId) && keyOf(preferredId) === key) return preferredId;
  for (const id of liveIds || []) if (keyOf(id) === key) return id;
  return null;
}

// 한 폴더 객체를 가리키는 workspace가 둘이어도 둘 다 같은 프로젝트 상태를 받는다. wire는 각자의
// workspace_id를 유지하고, MCP 권한은 같은 프로젝트 안에서 세션 그룹과 사람 지목으로 구분한다.
export function projectByWorkspace(map, liveIds) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    const ids = (liveIds || []).filter((id) => keyOf(id) === keyOf(key));
    if (ids.length) for (const id of ids) out[id] = value;
    else out[key] = value;
  }
  return out;
}

// 옛 workspace_id/경로 아래 남은 상태를 폴더 객체 키로 복원한다. 직접 경로, 핸들에 기록된 경로,
// 유일한 폴더 이름 순으로만 판단하며 모호하면 그대로 둔다.
export function planRecovery({ legacySpaces, slugsBySpace, dirsBySpace, candidateDirs, direct }) {
  const bySlug = new Map();
  for (const candidate of candidateDirs || []) {
    const dir = realDir(candidate);
    const key = keyForDir(dir);
    if (!key) continue;
    const name = slug(path.basename(dir));
    if (!name) continue;
    if (!bySlug.has(name)) bySlug.set(name, new Set());
    bySlug.get(name).add(key);
  }

  const map = {};
  const unresolved = [];
  for (const space of legacySpaces || []) {
    if (!space || space === SHARED || isFolderKey(space)) continue;

    const known = folderById[space]?.key;
    if (known) {
      map[space] = known;
      continue;
    }

    if (isLegacyPathKey(space)) {
      const key = keyForDir(space);
      if (key) { map[space] = key; continue; }
    }

    const exact = direct && direct[space];
    const exactKey = exact && keyForDir(exact);
    if (exactKey) { map[space] = exactKey; continue; }

    const recorded = new Set(((dirsBySpace && dirsBySpace[space]) || []).map(keyForDir).filter(Boolean));
    if (recorded.size === 1) { map[space] = [...recorded][0]; continue; }
    if (recorded.size > 1) {
      unresolved.push({ space, reason: `기록된 폴더 객체가 ${recorded.size}개 — 확정 불가` });
      continue;
    }

    const names = ((slugsBySpace && slugsBySpace[space]) || [])
      .filter((name) => name && name !== slug(space));
    if (!names.length) {
      unresolved.push({ space, reason: "이름 기록 없음" });
      continue;
    }
    const hits = new Set();
    for (const name of names) for (const key of bySlug.get(name) || []) hits.add(key);
    if (hits.size === 1) map[space] = [...hits][0];
    else unresolved.push({ space, reason: hits.size ? `후보 ${hits.size}곳 — 어느 쪽인지 확정 불가` : "맞는 폴더 없음" });
  }
  return { map, unresolved };
}

export function adoptRecovered(map) {
  let changed = false;
  for (const [space, rawKey] of Object.entries(map || {})) {
    if (isFolderKey(space) || isLegacyPathKey(space) || !isFolderKey(rawKey)) continue;
    const key = keyOf(rawKey);
    const dir = dirOfKey(rawKey);
    if (!dir) continue;
    const current = folderById[space];
    if (!current || current.key !== key || current.dir !== dir) {
      folderById[space] = {
        dir,
        key,
        src: CONFIRMED,
        aliases: current?.aliases || [],
        history: current?.history || [],
      };
      changed = true;
    }
  }
  if (changed) persist();
}
