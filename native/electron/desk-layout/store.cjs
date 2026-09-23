// 창 레이아웃(desklayout) 저장본 읽기·쓰기와 옛 ~/.ws-snap 가져오기.
//
// 소유 범위
//   모니터 수별 저장본 파일(desk-layouts/monitors-<n>.json)과 apps.json의 원자적 읽기·쓰기·이력,
//   자동 저장을 거르는 판정(설계 4절), 옛 Hammerspoon 저장본을 한 번 변환해 오는 가져오기(설계 6절).
//
// 제공 API
//   createStore({ fs, path, stateDir }) → { layoutDir, readLayout, writeLayout, readApps, writeApps,
//   shouldSkipAutoSave, importFromWsSnap }.
//
// 의존 대상
//   fs·path를 주입받는다(검사에서 임시 폴더로 대역). geometry.cjs의 순수 함수만 쓰고 osascript는
//   모른다. 상태 경로는 ctx.stateDir 하나로만 받고 여기서 홈 디렉터리를 직접 조합하지 않는다.
//
// 유지 조건
//   쓰기는 항상 tmp 파일 + rename이다(중간에 죽어도 기존 파일이 깨지지 않는다).
//   모니터 수마다 파일이 달라 다른 수의 저장본을 밀어내지 않는다(기존 ~/.ws-snap의 20개 공용 회전
//   문제 해결). history는 최근 10개, latest와 같은 배열의 0번째다.
//   가져오기는 desk-layouts/가 완전히 비어 있을 때만, 그리고 ~/.ws-snap은 읽기만 한다.
//
// 영향 범위
//   host.cjs(타이머·단축키가 이 API를 호출), mac.cjs가 만든 창 목록의 형태를 그대로 받는다.
//   현재 목록 확인: node bin/importers.mjs native/electron/desk-layout/store.cjs

const { monitorSlots, rectToRatio, layoutSignature } = require("./geometry.cjs");

const HISTORY_LIMIT = 10;
const MONITOR_CHANGE_GUARD_MS = 60_000;
const RESTORE_GUARD_MS = 30_000;

function atomicWriteJson(fs, path_, filePath, data) {
  const dir = path_.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function createStore({ fs, path, stateDir }) {
  if (!fs || !path || !stateDir) throw new TypeError("fs·path·stateDir 주입이 필요하다");
  const layoutDir = path.join(stateDir, "desk-layouts");
  const layoutPath = (monitorCount) => path.join(layoutDir, `monitors-${monitorCount}.json`);
  const appsPath = () => path.join(layoutDir, "apps.json");

  function readLayout(monitorCount) {
    const data = readJsonSafe(fs, layoutPath(monitorCount));
    if (!data || typeof data !== "object" || !data.latest) return null;
    return { version: 1, latest: data.latest, history: Array.isArray(data.history) ? data.history : [] };
  }

  // force: true면 서명이 같아도 쓴다(단축키 저장은 창 0개만 거르고 나머지는 저장 — 설계 4절).
  function writeLayout(monitorCount, snapshot, { force = false } = {}) {
    const existing = readLayout(monitorCount);
    const signature = layoutSignature(snapshot.windows);
    if (!force && existing && existing.latest && existing.latest.signature === signature) {
      return { written: false, reason: "signature-unchanged" };
    }
    const entry = { ...snapshot, signature, savedAt: Date.now() };
    const history = [entry, ...((existing && existing.history) || [])].slice(0, HISTORY_LIMIT);
    atomicWriteJson(fs, path, layoutPath(monitorCount), { version: 1, latest: entry, history });
    return { written: true };
  }

  function readApps() {
    return readJsonSafe(fs, appsPath());
  }

  function writeApps(snapshot) {
    atomicWriteJson(fs, path, appsPath(), { version: 1, timestamp: Date.now(), apps: snapshot.apps || [] });
  }

  // 설계 4절 "저장하지 않는 경우". 순수 판정이라 실제 fs를 건드리지 않는다.
  // state: { trigger: "auto"|"shortcut", windowCount, locked, monitorChangedAt, restoreEndedAt, now }
  function shouldSkipAutoSave(state) {
    const now = state.now != null ? state.now : Date.now();
    if (state.windowCount === 0) return { skip: true, reason: "no-windows" };
    if (state.trigger !== "auto") return { skip: false };
    if (state.locked) return { skip: true, reason: "locked" };
    if (state.monitorChangedAt != null && now - state.monitorChangedAt < MONITOR_CHANGE_GUARD_MS) {
      return { skip: true, reason: "monitor-change-guard" };
    }
    if (state.restoreEndedAt != null && now - state.restoreEndedAt < RESTORE_GUARD_MS) {
      return { skip: true, reason: "restore-guard" };
    }
    return { skip: false };
  }

  // 설계 6절: desk-layouts/가 비어 있을 때 한 번, ~/.ws-snap을 읽기만 해서 모니터 수별로 변환한다.
  function importFromWsSnap({ wsSnapDir }) {
    if (fs.existsSync(layoutDir) && fs.readdirSync(layoutDir).length > 0) {
      return { imported: false, reason: "not-empty" };
    }
    const arrDir = path.join(wsSnapDir, "arrangements");
    if (!fs.existsSync(arrDir)) return { imported: false, reason: "no-source" };
    const files = fs.readdirSync(arrDir).filter((f) => f.endsWith(".json"))
      .map((f) => path.join(arrDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    const byMonitorCount = new Map(); // count -> old snapshot(최신)
    for (const file of files) {
      const snap = readJsonSafe(fs, file);
      if (!snap || !Array.isArray(snap.windows) || snap.windows.length === 0) continue;
      const count = Array.isArray(snap.screens) ? snap.screens.length : 0;
      if (count === 0 || byMonitorCount.has(count)) continue;
      byMonitorCount.set(count, snap);
    }

    const importedCounts = [];
    for (const [count, snap] of byMonitorCount) {
      const converted = convertLegacySnapshot(snap);
      writeLayout(count, converted, { force: true });
      importedCounts.push(count);
    }

    const oldApps = readJsonSafe(fs, path.join(wsSnapDir, "apps.json"));
    if (oldApps && Array.isArray(oldApps.apps)) writeApps({ apps: oldApps.apps });

    return { imported: importedCounts.length > 0, monitorCounts: importedCounts };
  }

  // 옛 형식(절대 좌표 + screen 이름 + screenW/H + screenX/Y + spaceIndex)을 새 형식(비율 + slot)으로.
  // workArea가 없으므로 모니터 전체 크기 기준으로 비율을 낸다(메뉴 막대 높이만큼 오차 가능, 문서화된 한계).
  function convertLegacySnapshot(snap) {
    const displays = (snap.screens || []).map((s, i) => ({
      id: `legacy-${i}`,
      name: s.name,
      bounds: { x: 0, y: 0, width: s.w, height: s.h },
      primary: false,
    }));
    // 옛 형식은 모니터 원점을 창의 screenX/screenY로만 안다. 메인(원점 0,0)을 기준으로 상대 위치를 잡는다.
    const originByName = new Map();
    for (const w of snap.windows || []) {
      if (!originByName.has(w.screen)) originByName.set(w.screen, { x: w.screenX || 0, y: w.screenY || 0 });
    }
    for (const d of displays) {
      const origin = originByName.get(d.name) || { x: 0, y: 0 };
      d.bounds.x = origin.x;
      d.bounds.y = origin.y;
      if (origin.x === 0 && origin.y === 0) d.primary = true;
    }
    if (!displays.some((d) => d.primary) && displays[0]) displays[0].primary = true;
    const slots = monitorSlots(displays);
    const slotByName = new Map(displays.map((d) => [d.name, slots.find((s) => s.id === d.id).slot]));

    const windows = (snap.windows || []).map((w) => {
      const display = displays.find((d) => d.name === w.screen);
      const area = display ? display.bounds : { x: w.screenX || 0, y: w.screenY || 0, width: w.screenW, height: w.screenH };
      const rect = rectToRatio({ x: w.x, y: w.y, width: w.w, height: w.h }, area);
      return {
        bundle: w.app,
        appName: w.appName,
        title: w.title,
        pid: null,
        cgId: null,
        slot: slotByName.get(w.screen) || "main",
        rect,
        edges: { l: false, t: false, r: false, b: false },
        desktop: w.spaceIndex || 1,
        onCurrent: true,
      };
    });
    return { windows, monitors: displays.map((d) => ({ id: d.id, slot: slotByName.get(d.name), name: d.name, bounds: d.bounds })) };
  }

  return {
    layoutDir, layoutPath, appsPath,
    readLayout, writeLayout, readApps, writeApps,
    shouldSkipAutoSave, importFromWsSnap,
  };
}

module.exports = { createStore, HISTORY_LIMIT, MONITOR_CHANGE_GUARD_MS, RESTORE_GUARD_MS };
