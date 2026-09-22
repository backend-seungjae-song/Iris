import fs from "node:fs";
import path from "node:path";

import * as browserState from "./browser-state.js";
import { snapshot } from "./runtime-state.js";
import * as spaceKey from "./space-key.js";
import { stateHome } from "./state-home.cjs";

// 저장용 browser state와 runtime workspace 투영·space-key 이관의 단일 소유자.
//
// 소유 범위
//   마지막 활성 runtime workspace id, space별 browser-state 필드의 저장 key 변환,
//   workspace projection 지문과 space-key 이관 참가자 registry.
//
// 제공 API
//   init/register command, key·tabs·groups·tab query, project/wire snapshot, mutate,
//   has/bind/move/migrate/publish command와 browser-state flush port.
//
// 의존 대상
//   browser-state.js·space-key.js의 저장 primitive와 runtime-state snapshot에 의존하고,
//   memo/handle/grant의 반대 방향 이관은 init 뒤 등록된 callback port로만 호출한다.
//
// 유지 조건
//   저장은 folder key, wire는 live workspace id라는 양방향 경계와 active-space 복원 우선순위를
//   보존한다. 교체되거나 변하는 원시 객체를 export하지 않고 방어 복사도 새로 만들지 않는다.
//
// 영향 범위
//   server/index.js의 lock 뒤 초기화·workspace recompute·space 생성/복원·WS 초기 snapshot,
//   memo-service/browser-runtime의 key·projection 소비와 browser-state.js·space-key.js 저장 계약.

const BS_SPACE_FIELDS = ["tabsBySpace", "bookmarksBySpace", "groupsBySpace", "activeBySpace", "defaultProfileBySpace", "urlHistoryBySpace"];
const DATA_DIR = stateHome();

let broadcast;
let getRecoveryEvidence;
let lastActiveWorkspaceId = null;
let lastSpaceSig = "";
const participants = new Map();

export function initBrowserStateOwner(deps) {
  broadcast = deps.broadcast;
  getRecoveryEvidence = deps.getRecoveryEvidence;
  browserState.load();
}

export function registerSpaceStateParticipant(name, participant) {
  participants.set(String(name), participant);
}

export function keyOf(space) {
  return spaceKey.keyOf(space);
}

export function tabs(space) {
  return (browserState.get().tabsBySpace || {})[keyOf(space)] || [];
}

export function groups(space) {
  return (browserState.get().groupsBySpace || {})[keyOf(space)] || [];
}

export function storageSpaceOfTab(tabId) {
  const stored = browserState.get().tabsBySpace || {};
  for (const space of Object.keys(stored)) if ((stored[space] || []).some((tab) => tab.id === tabId)) return space;
  return null;
}

export function hasStoredTab(tabId) {
  return storageSpaceOfTab(tabId) !== null;
}

export function mutate(mutation) {
  const runtimeChanged = mutation?.op === "space.active" && lastActiveWorkspaceId !== (mutation.space || null);
  if (mutation?.op === "space.active") lastActiveWorkspaceId = mutation.space || null;
  const persistedChanged = browserState.mutate(mutation && mutation.space
    ? { ...mutation, space: keyOf(mutation.space) }
    : mutation);
  return runtimeChanged || persistedChanged;
}

export function project(map) {
  return spaceKey.projectByWorkspace(map, (snapshot().workspaces || []).map((workspace) => workspace.id));
}

export function wire() {
  const state = browserState.get();
  const out = { ...state };
  for (const field of BS_SPACE_FIELDS) out[field] = project(state[field]);
  if (out.activeSpace) {
    const liveIds = (snapshot().workspaces || []).map((workspace) => workspace.id);
    out.activeSpace = spaceKey.idOfKey(out.activeSpace, liveIds, lastActiveWorkspaceId) || out.activeSpace;
  }
  return out;
}

export function spaceKeysWire() {
  return {
    type: "space-keys",
    map: spaceKey.allKeys(),
    remaps: spaceKey.remapsFor((snapshot().workspaces || []).map((workspace) => workspace.id)),
  };
}

function backupOnce(file) {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const destination = `${file}.bak-${stamp}`;
    if (!fs.existsSync(destination) && fs.existsSync(file)) fs.copyFileSync(file, destination);
  } catch {}
}

function broadcastProjection() {
  broadcast(spaceKeysWire());
  broadcast({ type: "browser-state", state: wire() });
  for (const participant of participants.values()) participant.broadcast?.();
}

function applySpaceRemap(map, options, publish = true) {
  const pairs = Object.entries(map || {}).filter(([from, to]) => from && to && from !== to);
  if (!pairs.length) return false;
  backupOnce(path.join(DATA_DIR, "browser-state.json"));
  for (const participant of participants.values()) {
    for (const file of participant.backupPaths?.() || []) backupOnce(file);
  }
  for (const participant of participants.values()) participant.prepareRemap?.(map, pairs);
  browserState.remapSpaces(map, options);
  for (const participant of participants.values()) participant.remap?.(map, pairs);
  if (publish) broadcastProjection();
  return true;
}

// 빈 레코드도 old/new가 같은 runtime id로 투영될 때 뒤쪽의 빈 값이 v2 정본을 가릴 수 있다.
export function hasSpaceState(key) {
  if (!key) return false;
  const state = browserState.get();
  for (const field of BS_SPACE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(state[field] || {}, key)) return true;
  }
  for (const participant of participants.values()) if (participant.hasSpace?.(key)) return true;
  return false;
}

export function moveSpaceState(from, to, why) {
  try {
    if (applySpaceRemap({ [from]: to }, { preferSource: true })) {
      console.log(`[space-key] ${why} — 쌓여 있던 상태를 옮겼습니다.`);
      broadcast({ type: "space-key-moved", from, to });
    }
  } catch (error) {
    console.log(`[space-key] ${why} — 옮기지 못했습니다:`, error.message || error);
  }
}

export function bindSpaceFolder(workspaceId, cwd) {
  if (!workspaceId || !cwd) return;
  const dir = spaceKey.realDir(cwd);
  const learned = spaceKey.learnFolder(workspaceId, dir, spaceKey.REQUESTED);
  // 생성 응답과 바인딩 사이에 workspace_id 아래 쌓인 것이 있으면 요청 폴더의 안정 키로 옮긴다.
  // 다른 폴더로 이동할 때는 이 경로를 쓰지 않으므로 이전 폴더 상태가 따라가지 않는다.
  if (learned.key && learned.key !== workspaceId && hasSpaceState(workspaceId)) {
    moveSpaceState(workspaceId, learned.key, `${workspaceId}: 생성 폴더 객체 배정(→ ${learned.key})`);
  }
}

function migrateSpaceState(from, to, why, moved) {
  try {
    if (applySpaceRemap({ [from]: to }, { preferSource: true }, false)) {
      console.log(`[space-key] ${why} — 쌓여 있던 상태를 옮겼습니다.`);
      moved.push({ from, to });
      return true;
    }
  } catch (error) {
    console.log(`[space-key] ${why} — 옮기지 못했습니다:`, error.message || error);
  }
  return false;
}

function recoverDriftedFolderKeys(moved) {
  let changed = false;
  for (const [from, to] of Object.entries(spaceKey.driftedKeyRemaps())) {
    if (from === to || !hasSpaceState(from)) continue;
    try {
      if (applySpaceRemap({ [from]: to }, undefined, false)) {
        console.log(`[space-key] 재부팅으로 갈라진 열쇠를 다시 합쳤습니다 (${from} → ${to}).`);
        moved.push({ from, to });
        changed = true;
      }
    } catch (error) {
      console.log(`[space-key] 갈라진 열쇠를 못 합쳤습니다 (${from} → ${to}):`, error.message || error);
    }
  }
  return changed;
}

export function migrateSpaceKeys(workspaces = snapshot().workspaces, migrations = []) {
  let changed = false;
  const moved = [];
  for (const migration of migrations) {
    if (!hasSpaceState(migration.from)) continue;
    if (migrateSpaceState(migration.from, migration.to, migration.why, moved)) changed = true;
  }
  if (!(workspaces || []).length) return { changed, moved };
  try {
    if (recoverDriftedFolderKeys(moved)) changed = true;
    const state = browserState.get();
    const legacy = new Set();
    const addLegacy = (key) => {
      if (key && !/^__.*__$/.test(key) && !spaceKey.isFolderKey(key)) legacy.add(key);
    };
    for (const field of BS_SPACE_FIELDS) Object.keys(state[field] || {}).forEach(addLegacy);

    const slugsBySpace = {};
    const dirsBySpace = {};
    const addRecord = (record) => {
      if (!record?.space) return;
      addLegacy(record.space);
      (slugsBySpace[record.space] ||= []).push(...(record.slugs || []));
      (dirsBySpace[record.space] ||= []).push(...(record.dirs || []));
    };
    for (const participant of participants.values()) {
      participant.contributeRecovery?.({ addLegacy, addRecord });
    }
    if (!legacy.size) return { changed, moved };

    const evidence = getRecoveryEvidence(workspaces);
    const { map, unresolved } = spaceKey.planRecovery({
      legacySpaces: [...legacy],
      slugsBySpace,
      dirsBySpace,
      candidateDirs: evidence.candidateDirs,
      direct: evidence.direct,
    });
    if (!Object.keys(map).length) return { changed, moved };

    spaceKey.adoptRecovered(map);
    if (applySpaceRemap(map, undefined, false)) changed = true;

    // 이름을 분리한다. 위의 moved 는 무엇이 어디로 이동했는지 담아 호출자가 방송에 쓰는 배열이고,
    // 이것은 그 회차에 옮긴 개수다. 같은 이름을 쓰면 이 블록 전체가 TDZ 가 되어, 옮길 것이
    // 없어 일찍 반환하는 정상 경로(`!legacy.size`)가 예외를 던진다. 그 예외를 아래 catch 가
    // 무시해 실행할 때마다 이관 실패 로그가 남는다.
    const movedCount = Object.entries(map).filter(([from, to]) => from !== to).length;
    console.log(`[space-key] 옛 열쇠 ${movedCount}개를 폴더로 옮겼습니다.`
      + (unresolved.length ? ` 근거가 없어 그대로 둔 것 ${unresolved.length}개: ${unresolved.map((item) => `${item.space}(${item.reason})`).join(", ")}` : ""));
  } catch (error) {
    console.log("[space-key] 이관 실패 — 예전 열쇠 그대로 둡니다:", error.message || error);
  }
  return { changed, moved };
}

export function publishProjectionIfChanged(migration = null) {
  const sig = (snapshot().workspaces || [])
    .map((workspace) => `${workspace.id}:${spaceKey.keyOf(workspace.id) || ""}:${spaceKey.folderOf(workspace.id) || ""}`)
    .join("|");
  if (sig === lastSpaceSig && !migration?.changed) return false;
  lastSpaceSig = sig;
  broadcastProjection();
  for (const item of migration?.moved || []) broadcast({ type: "space-key-moved", from: item.from, to: item.to });
  return true;
}

export function flushNow() {
  return browserState.flushNow();
}
