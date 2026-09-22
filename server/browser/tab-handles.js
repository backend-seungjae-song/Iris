// 탭·그룹의 짧은 핸들(@herdr-tab-3). 사용자와 에이전트가 부르는 이름의 유일한 발급처.
//
// 소유 범위
//   탭 정체성 ↔ 핸들의 대응, 그 디스크 기록(tab-handles.json), 스페이스 슬러그,
//   그리고 이전 형식(t83) 의 역인덱스.
//
// 제공 API
//   createTabHandles(deps) 하나. 발급·조회·표시·적재·저장을 반환한다.
//
// 의존 대상
//   조립부가 넘겨주는 tabReg(탭 레지스트리)와 공용 스페이스 키, 그리고 space-key·runtime-state
//   의 안정 키. 공용 키를 여기서 다시 정의하지 않는다. 값이 갈라지면 공용 탭의 핸들만
//   조용히 다른 이름을 받는다.
//   상태 폴더 경로는 여기서 조합하지 않고 state-home 정본에서 받는다.
//
// 유지 조건
//   한 번 발급한 핸들은 서버 재시작 후에도 다른 탭에 재배정하지 않는다.
//   메모리에만 두면 재시작할 때 순번이 0부터 시작해 @t2 가 다른 탭을 가리킨다.
//   저장하는 값은 렌더된 문자열이 아니라 (스페이스, 종류, 번호)다. 스페이스 이름이 바뀌면
//   표시는 새 이름을 따르고, 옛 이름으로 부른 참조도 종류+번호로 그대로 풀린다.
//   정체성은 그 탭에만 부여한 난수이고 순번이 아니다. 폴더 이름은 서로 겹칠 수 있다.
//
// 영향 범위
//   공급자는 server/browser-runtime.js 의 조립부이고, 양방향 소비자는 그 파일의 대상 해석
//   (tabIdOfRef)과 화면에 핸들을 전달하는 broadcastTabHandles 다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs server/browser/tab-handles.js

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as appPick from "../app-pick.js";
import {
  registerSpaceStateParticipant,
  keyOf as spKey,
  tabs as spTabs,
  groups as spGroups,
  storageSpaceOfTab,
  hasStoredTab,
  mutate as bsMutate,
  wire as bsWire,
} from "../browser-state-owner.js";
import { snapshot } from "../runtime-state.js";
import * as spaceKey from "../space-key.js";
import { stateHome } from "../state-home.cjs";

// 브라우저 실행기·탭 registry/handle·grant/target·profile/dialog·control 상태의 단일 소유자.
//
// 소유 범위
//   교체되는 CDP 실행기·profile·wire cache와 tab/wc registry, handle/grant 저장 상태,
//   pane target·pick mode·control lease·dialog ask/plan 및 그 timer.
//
// 제공 API
//   init과 registry/handle/grant/target/executor/profile/dialog의 accessor·mutation API,
//   handle/grant 지연 쓰기를 함께 끝내는 flushNow port. 원시 Map·array·object는 export하지 않는다.
//
// 의존 대상
//   runtime-state snapshot과 browser-state-owner의 read/mutate/register port, space-key/state-home,
//   app-pick primitive에 의존하며 broadcast·Herdr·console relay는 init에서 주입받는다.
//
// 유지 조건
//   wc는 즉시 실행용 핸들일 뿐 지속 정체성이 아니고, grant는 인증된 사용자 지정만 확장한다.
//   다른 프로세스의 CDP 실행기는 거절하되 같은 프로세스 재연결은 받아들이고 순서·조건·타이밍을 보존한다.
//
// 영향 범위
//   server/index.js의 browser command/HTTP dialog/WS inbound·초기 snapshot·recompute·shutdown 연결,
//   browser-state-owner의 participant migration, runtime-state workspace projection, app-pick lifecycle,
//   popup-tab-access/tab-profile-pinning/login-session-ownership/run-state-isolation/shutdown-flush와 smoke 소유 검사.

import { createDialogs } from "../browser/dialogs.js";


const IRIS_HOME = stateHome();

export function createTabHandles({ tabReg, SHARED_SPACE }) {
// 탭 정체성(tabId) ↔ 사용자·에이전트가 쓰는 짧은 핸들(t7). 한 번 발급한 핸들은 다른 탭에 재배정하지
// 않으며 서버 재시작에도 유지한다. 메모리에만 두면 재시작할 때 순번이 0부터 시작해 @t2가 다른 탭을
// 가리킨다. 그래서 디스크에 저장한다.
// 핸들은 `<스페이스>-tab-<난수>` 형식이다. `t83` 같은 순번은 로그·MCP 호출만으로는 어느
// 스페이스의 무엇인지 알 수 없다. 번호는 스페이스별 카운터라 작게 유지된다.
// 저장하는 값은 렌더된 문자열이 아니라 (스페이스, 종류, 번호)다. 스페이스 이름이 바뀌면 표시는
// 새 이름을 따르고, 옛 이름으로 부른 참조도 종류+번호로 그대로 풀린다.
const HANDLE_PATH = path.join(IRIS_HOME, "tab-handles.json");
const handleRec = new Map();      // tabId → { space, kind, h, n?, slugs, dirs }
const legacyHandle = new Map();   // "t83" → tabId (이전 형식도 계속 받는다)
let handleSaveTimer = null;
// 정체성은 그 탭에만 부여한 난수(h)이고 순번이 아니다.
//
// 스페이스별 순번을 쓰면 스페이스를 구분하는 이름이 겹칠 때 번호도 함께 겹친다. 폴더 이름은
// 서로 겹칠 수 있어(`/Acme`과
// `/Acme/acme`은 둘 다 acme이 된다) `acme-tab-1`이 두 탭에 발급되고,
// 해석기는 둘 중 하나를 임의로 고르지 않으므로(다른 탭을 조작하는 것보다 낫다)
// 그 이름으로는 아무것도 지정할 수 없다.
//
// 순번을 전역으로 바꾸는 것도 해결이 아니다. 여전히 순서 값이라 기록을 옮기거나 합칠 때마다
// 다시 매겨야 하고, 그때마다 기존 이름이 무효가 된다. 난수는 처음부터 겹치지 않으므로 다시
// 매길 일이 없다. 앞에 붙는 스페이스 이름은 로그에서 읽기 위한 표시이고, 지정은
// h 로만 해석한다.
const handleHashes = new Set();
function newHandleHash() {
  for (;;) {
    const b = crypto.randomBytes(4).toString("hex");
    // 첫 글자는 항상 알파벳이라 이전 번호(`-tab-12`) 형식과 겹치지 않는다.
    const h = "abcdefghjkmnpqrstuvwxyz"[crypto.randomBytes(1)[0] % 23] + b.slice(0, 5);
    if (!handleHashes.has(h)) { handleHashes.add(h); return h; }
  }
}
function loadTabHandles() {
  try {
    const saved = JSON.parse(fs.readFileSync(HANDLE_PATH, "utf8"));
    for (const [tabId, h] of saved.pairs || []) legacyHandle.set(String(h).toLowerCase(), tabId);
    for (const [tabId, r] of saved.recs || []) { handleRec.set(tabId, r); if (r.h) handleHashes.add(r.h); }
  } catch {}
}
function writeHandlesNow() {
  handleSaveTimer = null;
  try {
    fs.mkdirSync(path.dirname(HANDLE_PATH), { recursive: true });
    // 오래된 항목은 버린다. 그 탭들은 이미 종료돼 핸들이 null로 해석된다. 스페이스별 번호는
    // 계속 올라가므로 버린 번호가 다시 나오지는 않는다.
    fs.writeFileSync(HANDLE_PATH, JSON.stringify({
      recs: [...handleRec.entries()].slice(-1000),
      groupRecs: [...groupRec.entries()].slice(-300),
      pairs: [...legacyHandle.entries()].map(([h, t]) => [t, h]).slice(-1000),
    }));
  } catch {}
}
function persistHandles() {
  clearTimeout(handleSaveTimer);
  handleSaveTimer = setTimeout(writeHandlesNow, 300);
}
// 탭 핸들이 사라지면 기존 이름(`프로젝트-tab-3`)이 다음 실행에서 다른 탭을 가리키거나
// 아무것도 가리키지 않는다. 이름이 유일한 지정 수단이라 잃으면 지정 자체가 불안정해진다.
function flushHandlesNow() {
  if (!handleSaveTimer) return false;
  clearTimeout(handleSaveTimer);
  writeHandlesNow();
  return true;
}
// herdr에 표시되는 이름을 그대로 쓴다. 핸들에 들어가므로 공백·기호를 정규화하고 짧게 자른다.
function spaceSlug(space) {
  if (!space) return "none";
  if (space === SHARED_SPACE) return "shared";
  // 핸들에 남는 스페이스는 폴더 객체 키다. herdr에 표시되는 이름을 먼저 쓰고(실행 중이면),
  // 없으면 마지막으로 관측한 폴더 이름을 쓴다. 종료된 뒤에도 `acme-tab-3`처럼 읽힌다.
  const w = (snapshot().workspaces || []).find((x) => x.id === space || spaceKey.keyOf(x.id) === space);
  const raw = (w && w.label) || (spaceKey.isFolderKey(space) ? path.basename(spaceKey.dirOfKey(space) || space) : space);
  const s = spaceKey.slug(raw);
  return s || String(space);
}
function tabSpaceOf(tabId) {
  const stored = storageSpaceOfTab(tabId);
  if (stored) return stored;
  const live = tabReg.get(tabId);
  if (live && live.space) return spKey(live.space);
  return null;
}
// 렌더할 때마다 그때의 슬러그를 기록한다. 로그에서 어느 스페이스인지 읽기 위한 값이고
// 지정에는 쓰지 않는다. 폴더 실경로도 함께 남긴다. 스페이스가 종료된 뒤 남은 상태를
// 어디에 연결할지 정할 때, 폴더 이름은 겹치면 판정할 수 없지만 실경로는 그 자체로 유일하다.
function renderHandle(r) {
  if (!r) return null;
  const slug = spaceSlug(r.space);
  let touched = false;
  if (!r.h) { r.h = newHandleHash(); touched = true; }   // 이전 기록에도 이때 난수를 부여한다
  if (!Array.isArray(r.slugs)) r.slugs = [];
  if (!r.slugs.includes(slug)) { r.slugs.push(slug); if (r.slugs.length > 5) r.slugs.shift(); touched = true; }
  const w = (snapshot().workspaces || []).find((x) => x.id === r.space || spaceKey.keyOf(x.id) === r.space);
  const dir = spaceKey.isFolderKey(r.space) ? spaceKey.dirOfKey(r.space) : (w && w.folder) || spaceKey.folderOf(r.space) || "";
  if (dir) {
    if (!Array.isArray(r.dirs)) r.dirs = [];
    if (!r.dirs.includes(dir)) { r.dirs.push(dir); if (r.dirs.length > 5) r.dirs.shift(); touched = true; }
  }
  if (touched) persistHandles();
  return `${slug}-${r.kind}-${r.h}`;
}
function handleFor(tabId) {
  if (!tabId) return null;
  let r = handleRec.get(tabId);
  if (!r) {
    r = { space: tabSpaceOf(tabId) || "none", kind: "tab", h: newHandleHash() };
    handleRec.set(tabId, r); persistHandles();
  }
  return renderHandle(r);
}
// 그룹도 같은 형식의 이름을 쓴다. 세션이 그룹 단위로 동작하므로 그룹에도 지정할 이름이 필요하다.
// 탭 핸들과 같이 디스크에 저장한다. 메모리에만 두면 서버가 재시작할 때마다 이름이 새로 생성돼,
// 이전 이름이 다른 그룹을 가리킨다(확인 결과: claude-group-3이 재시작 뒤 7이 됐다).
const groupRec = new Map(); // "space\ngid" → { space, kind:"group", h }
function loadGroupHandles() {
  try {
    const saved = JSON.parse(fs.readFileSync(HANDLE_PATH, "utf8"));
    for (const [k, r] of (saved.groupRecs || [])) { groupRec.set(k, r); if (r.h) handleHashes.add(r.h); }
  } catch {}
}
function groupHandleFor(space, gid) {
  space = spKey(space);            // 핸들은 안정 키에 연결한다. 스페이스를 복원해도 같은 이름으로 해석된다
  if (!space || !gid) return null;
  const key = space + "\n" + gid;
  let r = groupRec.get(key);
  if (!r) { r = { space, kind: "group", h: newHandleHash() }; groupRec.set(key, r); persistHandles(); }
  return renderHandle(r);
}

  return { HANDLE_PATH, handleRec, legacyHandle, groupRec, newHandleHash, loadTabHandles,
    writeHandlesNow, persistHandles, flushHandlesNow, spaceSlug, tabSpaceOf, renderHandle,
    handleFor, loadGroupHandles, groupHandleFor };
}
