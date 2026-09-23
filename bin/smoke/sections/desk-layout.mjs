// 창 레이아웃(desklayout) 기능 검사: geometry.cjs 단위 검사, 저장 거르기 판정, 가져오기 변환,
// 기능 경계(네이티브·렌더러 표) 대조, host 저장→복원 계산 왕복.
//
// 소유 범위: desk-layout/{geometry,store,mac,host}.cjs · web/js/desklayout/boot.js ·
//   native/electron/capabilities.cjs·web/js/core/capabilities.js의 desklayout 줄.
// 제공 API: 러너가 한 번 부르는 기본 run.
// 의존 대상: geometry.cjs·store.cjs·host.cjs를 require_로 직접 부른다. host 에는 대역 창 목록(mac)과
//   대역 화면(screen)을 넣는다. 실제 osascript·Electron은 실행하지 않는다(mac.cjs의 JXA는 실기기에서만 확인된다).
// 유지 조건: 픽스처는 실제 ~/.ws-snap 파일 하나에서 발췌해 title만 가명으로 치환한 것이다.
// 영향 범위: native/electron/desk-layout/*.cjs, web/js/desklayout/boot.js.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { pathToFileURL } from "node:url";

import { check, checkAsync, read, require_, summary } from "../core.mjs";

const geometry = require_("../native/electron/desk-layout/geometry.cjs");
const { createStore } = require_("../native/electron/desk-layout/store.cjs");
const NATIVE_CAPS = read("native/electron/capabilities.cjs");
const RENDERER_CAPS = read("web/js/core/capabilities.js");
const RENDERER_BOOT = read("web/js/desklayout/boot.js");
const GEOMETRY_SRC = read("native/electron/desk-layout/geometry.cjs");

const roots = [];
function tempDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `iris-desklayout-${label}-`));
  roots.push(dir);
  return dir;
}

function run() {
  // ── 기능 경계 ──────────────────────────────────────────────────────
  check("네이티브 표에 desklayout이 host.cjs를 가리킨다", () => {
    if (!/id:\s*"desklayout",\s*module:\s*require\.resolve\("\.\/desk-layout\/host\.cjs"\)/.test(NATIVE_CAPS)) {
      throw new Error("native/electron/capabilities.cjs에 desklayout 줄이 없거나 경로가 다르다");
    }
    return true;
  });

  check("렌더러 표의 desklayout id가 네이티브 표와 같은 낱말이다", () => {
    const m = /id:\s*"desklayout"[\s\S]{0,2000}?load:\s*\(\)\s*=>\s*import\("\.\.\/desklayout\/boot\.js"\)/.exec(RENDERER_CAPS);
    if (!m) throw new Error("web/js/core/capabilities.js에 desklayout 항목이 없거나 files·load가 어긋난다");
    if (!/native:\s*true/.test(m[0])) throw new Error("desklayout 항목에 native: true가 없다");
    return true;
  });

  check("desklayout 렌더러 입구는 screen·panelHtml을 반환하지 않는다(rail 없는 기능)", () => {
    if (/export\s+const\s+panelHtml|screen\s*:/.test(RENDERER_BOOT)) {
      throw new Error("rail 없는 기능이 screen 또는 panelHtml을 반환하면 안 된다(설계 2-2절)");
    }
    if (!/export\s+function\s+initCapability/.test(RENDERER_BOOT)) throw new Error("initCapability export가 없다");
    return true;
  });

  check("geometry.cjs는 Electron·fs·osascript를 require하지 않는다(순수 함수)", () => {
    const bad = GEOMETRY_SRC.match(/require\(["'](electron|fs|node:fs|child_process|node:child_process)["']\)/);
    if (bad) throw new Error(`geometry.cjs가 ${bad[1]}을 require한다 — 순수 함수 계약 위반`);
    return true;
  });

  // ── geometry: 모니터 자리 이름 ────────────────────────────────────
  check("monitorSlots: 모니터 1대는 main뿐이다", () => {
    const out = geometry.monitorSlots([{ id: 1, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]);
    if (out.length !== 1 || out[0].slot !== "main") throw new Error(`실제: ${JSON.stringify(out)}`);
    return true;
  });

  check("monitorSlots: 메인 오른쪽 모니터는 right-1이다", () => {
    const out = geometry.monitorSlots([
      { id: 1, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, primary: false, bounds: { x: 1920, y: -37, width: 1728, height: 1117 } },
    ]);
    const slot = out.find((d) => d.id === 2).slot;
    if (slot !== "right-1") throw new Error(`실제: ${slot}`);
    return true;
  });

  check("monitorSlots: 메인 위쪽 모니터는 above-1이다", () => {
    const out = geometry.monitorSlots([
      { id: 1, primary: true, bounds: { x: 0, y: 1080, width: 1920, height: 1080 } },
      { id: 2, primary: false, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);
    const slot = out.find((d) => d.id === 2).slot;
    if (slot !== "above-1") throw new Error(`실제: ${slot}`);
    return true;
  });

  check("monitorSlots: 같은 방향 둘은 가까운 순으로 -1·-2다", () => {
    const out = geometry.monitorSlots([
      { id: 1, primary: true, bounds: { x: 0, y: 0, width: 1000, height: 1000 } },
      { id: 2, primary: false, bounds: { x: 1000, y: 0, width: 1000, height: 1000 } }, // 가깝다
      { id: 3, primary: false, bounds: { x: 3000, y: 0, width: 1000, height: 1000 } }, // 멀다
    ]);
    const s2 = out.find((d) => d.id === 2).slot;
    const s3 = out.find((d) => d.id === 3).slot;
    if (s2 !== "right-1" || s3 !== "right-2") throw new Error(`실제: id2=${s2} id3=${s3}`);
    return true;
  });

  check("matchMonitorSlots: 이름 짝이 없으면 main으로 보낸다", () => {
    const map = geometry.matchMonitorSlots(
      [{ id: "old-main", slot: "main" }, { id: "old-right", slot: "right-1" }],
      [{ id: "new-main", slot: "main" }], // 지금은 모니터 1대뿐
    );
    if (map.get("main") !== "new-main") throw new Error("main 짝짓기 실패");
    if (map.get("right-1") !== "new-main") throw new Error(`짝 없는 저장 모니터가 main으로 안 감: ${map.get("right-1")}`);
    return true;
  });

  // ── geometry: 비율 왕복·edges 고정 ─────────────────────────────────
  check("rectToRatio/ratioToRect 왕복이 원래 좌표를 복원한다", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 };
    const rect = { x: 480, y: 270, width: 960, height: 540 };
    const ratio = geometry.rectToRatio(rect, area);
    const back = geometry.ratioToRect(ratio, area);
    if (back.x !== rect.x || back.y !== rect.y || back.width !== rect.width || back.height !== rect.height) {
      throw new Error(`왕복 불일치: ${JSON.stringify(back)}`);
    }
    return true;
  });

  check("computeEdges/pinEdges: 모서리에 붙은 창은 반올림 오차 없이 그대로 붙는다", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 };
    const rect = { x: 1, y: 0, width: 959, height: 1080 }; // 왼쪽 1px 오차
    const edges = geometry.computeEdges(rect, area);
    if (!edges.l || !edges.t || !edges.b) throw new Error(`edges 판정 실패: ${JSON.stringify(edges)}`);
    const pinned = geometry.pinEdges(rect, area, edges);
    if (pinned.x !== 0) throw new Error(`pinEdges가 x를 0으로 고정하지 못함: ${pinned.x}`);
    return true;
  });

  // ── geometry: 창 짝짓기 3단계 ───────────────────────────────────────
  check("pairAppWindows 1단계: pid+cgId가 같은 창을 짝짓는다", () => {
    const saved = [{ pid: 100, cgId: 5, title: "A", slot: "main", y: 0, x: 0 }];
    const current = [{ pid: 100, cgId: 5, title: "B(제목 바뀜)", y: 0, x: 0 }];
    const { pairs } = geometry.pairAppWindows(saved, current);
    if (pairs.length !== 1 || pairs[0].current.title !== "B(제목 바뀜)") throw new Error("1단계 짝짓기 실패");
    return true;
  });

  check("pairAppWindows 2단계: 고유 제목으로 짝짓는다(pid·cgId 다름)", () => {
    const saved = [{ pid: 100, cgId: 5, title: "고유창", slot: "main", y: 0, x: 0 }];
    const current = [{ pid: 200, cgId: 9, title: "고유창", y: 0, x: 0 }];
    const { pairs } = geometry.pairAppWindows(saved, current);
    if (pairs.length !== 1 || pairs[0].current.cgId !== 9) throw new Error("2단계 짝짓기 실패");
    return true;
  });

  check("pairAppWindows 3단계: 남은 창은 순서로 짝짓는다", () => {
    // 실제 기록 모양: 저장본 rect는 비율, 지금 창 rect는 전역 px.
    const saved = [
      { pid: 1, cgId: 1, title: "창1", slot: "main", rect: { x: 0, y: 0, w: 0.5, h: 0.4 } },
      { pid: 1, cgId: 2, title: "창2", slot: "main", rect: { x: 0, y: 0.5, w: 0.5, h: 0.4 } },
    ];
    const current = [
      { pid: 9, cgId: 91, title: "다른이름1", rect: { x: 0, y: 500, width: 800, height: 400 } },
      { pid: 9, cgId: 92, title: "다른이름2", rect: { x: 0, y: 0, width: 800, height: 400 } },
    ];
    const { pairs } = geometry.pairAppWindows(saved, current);
    const byCg = new Map(pairs.map((p) => [p.saved.cgId, p.current.cgId]));
    if (byCg.get(1) !== 92 || byCg.get(2) !== 91) throw new Error(`3단계 순서 짝짓기 실패: ${JSON.stringify([...byCg])}`);
    return true;
  });

  // ── store: 저장 거르기(설계 4절) ────────────────────────────────────
  check("shouldSkipAutoSave: 창 0개는 자동·단축키 모두 거른다", () => {
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: tempDir("skip0") });
    const a = store.shouldSkipAutoSave({ trigger: "auto", windowCount: 0 });
    const b = store.shouldSkipAutoSave({ trigger: "shortcut", windowCount: 0 });
    if (!a.skip || !b.skip) throw new Error(`실제: auto=${JSON.stringify(a)} shortcut=${JSON.stringify(b)}`);
    return true;
  });

  check("shouldSkipAutoSave: 잠금 중 자동 저장은 거르고 단축키 저장은 거르지 않는다", () => {
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: tempDir("skiplock") });
    const a = store.shouldSkipAutoSave({ trigger: "auto", windowCount: 3, locked: true });
    const b = store.shouldSkipAutoSave({ trigger: "shortcut", windowCount: 3, locked: true });
    if (!a.skip || a.reason !== "locked") throw new Error(`자동: ${JSON.stringify(a)}`);
    if (b.skip) throw new Error(`단축키까지 걸림: ${JSON.stringify(b)}`);
    return true;
  });

  check("shouldSkipAutoSave: 모니터 변경 뒤 60초 안 자동 저장은 거른다", () => {
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: tempDir("skipchg") });
    const now = 1_000_000;
    const inside = store.shouldSkipAutoSave({ trigger: "auto", windowCount: 3, monitorChangedAt: now - 1000, now });
    const outside = store.shouldSkipAutoSave({ trigger: "auto", windowCount: 3, monitorChangedAt: now - 61_000, now });
    if (!inside.skip) throw new Error(`60초 안인데 저장 안 거름: ${JSON.stringify(inside)}`);
    if (outside.skip) throw new Error(`60초 지났는데 거름: ${JSON.stringify(outside)}`);
    return true;
  });

  check("store.writeLayout: 원자적 쓰기(tmp 파일이 안 남는다)와 history 10개 제한", () => {
    const dir = tempDir("write");
    const fs = require_("node:fs");
    const p = require_("node:path");
    const store = createStore({ fs, path: p, stateDir: dir });
    for (let i = 0; i < 12; i += 1) {
      store.writeLayout(2, { windows: [{ bundle: "x", slot: "main", rect: { x: 0, y: 0, w: i, h: 0 }, desktop: 1 }] }, { force: true });
    }
    const layout = store.readLayout(2);
    if (!layout || layout.history.length !== 10) throw new Error(`history 길이: ${layout && layout.history.length}`);
    const leftoverTmp = fs.readdirSync(store.layoutDir).some((f) => f.includes(".tmp-"));
    if (leftoverTmp) throw new Error("tmp 파일이 정리되지 않았다");
    return true;
  });

  check("store.writeLayout: 서명이 같으면(force 없이) 다시 쓰지 않는다", () => {
    const dir = tempDir("dedupe");
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: dir });
    const snap = { windows: [{ bundle: "x", slot: "main", rect: { x: 0, y: 0, w: 1, h: 1 }, desktop: 1 }] };
    const first = store.writeLayout(2, snap, {});
    const second = store.writeLayout(2, snap, {});
    if (!first.written || second.written) throw new Error(`실제: first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
    return true;
  });

  // ── 가져오기: 실제 ~/.ws-snap 표본(가명 처리) ───────────────────────
  check("importFromWsSnap: 실제 형식 표본을 모니터 수별 저장본으로 변환한다", () => {
    const dir = tempDir("import");
    const wsSnapDir = path.join(dir, "ws-snap-src");
    mkdirSync(path.join(wsSnapDir, "arrangements"), { recursive: true });
    // 2026-09-22 13:21 실측 ~/.ws-snap/arrangements 표본 발췌. title은 가명으로 치환했다.
    const fixture = {
      windows: [
        { w: 1728, screenW: 1728, h: 1032, x: 1920, winIdx: 1, screen: "Built-in Retina Display",
          y: 1, screenY: -37, title: "창 A", app: "app.iris.console", appName: "Iris", screenX: 1920, spaceIndex: 1, screenH: 1117 },
        { w: 1916, screenW: 1920, h: 1005, x: 2, winIdx: 3, screen: "U32J59x",
          y: 27, screenY: 0, title: "창 B", app: "app.iris.console", appName: "Iris", screenX: 0, spaceIndex: 1, screenH: 1080 },
        { w: 957, screenW: 1728, h: 1009, x: 1922, winIdx: 1, screen: "Built-in Retina Display",
          y: 1, screenY: -37, title: "창 C", app: "com.example.other", appName: "예시앱", screenX: 1920, spaceIndex: 1, screenH: 1117 },
      ],
      screens: [{ name: "U32J59x", h: 1080, w: 1920 }, { name: "Built-in Retina Display", h: 1117, w: 1728 }],
      timestamp: 1790050868,
      name: "Arrangement (가명)",
    };
    writeFileSync(path.join(wsSnapDir, "arrangements", "a.json"), JSON.stringify(fixture));
    writeFileSync(path.join(wsSnapDir, "apps.json"), JSON.stringify({ apps: [{ name: "예시앱", bundle: "com.example.other" }] }));

    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: dir });
    const result = store.importFromWsSnap({ wsSnapDir });
    if (!result.imported || !result.monitorCounts.includes(2)) throw new Error(`가져오기 실패: ${JSON.stringify(result)}`);

    const layout = store.readLayout(2);
    if (!layout || layout.latest.windows.length !== 3) throw new Error(`창 수: ${layout && layout.latest.windows.length}`);
    for (const w of layout.latest.windows) {
      if (w.rect.x < -0.01 || w.rect.x > 1.5 || w.rect.w <= 0) throw new Error(`비율 범위 밖: ${JSON.stringify(w.rect)}`);
    }
    const mainWindow = layout.latest.windows.find((w) => w.title === "창 B"); // screenX/Y 0,0인 U32J59x가 main
    if (!mainWindow || mainWindow.slot !== "main") throw new Error(`main 판정 실패: ${mainWindow && mainWindow.slot}`);
    const rightWindow = layout.latest.windows.find((w) => w.title === "창 A");
    if (!rightWindow || rightWindow.slot === "main") throw new Error(`오른쪽 모니터 창이 main으로 잘못 감: ${rightWindow && rightWindow.slot}`);

    const apps = store.readApps();
    if (!apps || !apps.apps.some((a) => a.bundle === "com.example.other")) throw new Error("apps.json 가져오기 실패");
    return true;
  });

  check("importFromWsSnap: desk-layouts가 비어 있지 않으면 다시 가져오지 않는다", () => {
    const dir = tempDir("import-skip");
    const wsSnapDir = path.join(dir, "ws-snap-src");
    mkdirSync(path.join(wsSnapDir, "arrangements"), { recursive: true });
    writeFileSync(path.join(wsSnapDir, "arrangements", "a.json"), JSON.stringify({
      windows: [{ w: 100, h: 100, x: 0, y: 0, screen: "S", screenW: 100, screenH: 100, screenX: 0, screenY: 0, app: "x", appName: "X", title: "t", spaceIndex: 1, winIdx: 1 }],
      screens: [{ name: "S", w: 100, h: 100 }],
    }));
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: dir });
    store.writeLayout(1, { windows: [{ bundle: "already", slot: "main", rect: { x: 0, y: 0, w: 1, h: 1 }, desktop: 1 }] }, { force: true });
    const result = store.importFromWsSnap({ wsSnapDir });
    if (result.imported) throw new Error("이미 저장본이 있는데 다시 가져왔다");
    return true;
  });

  for (const dir of roots) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// ── host 왕복: 저장 → 창 흩뜨림 → 복원 계산 ──────────────────────────
// 모듈을 하나씩 부르는 검사는 서로 넘기는 값의 모양이 어긋나도 통과한다(사각형 w/h 와 width/height 가
// 섞여 비율이 NaN 이 되고, 모니터 자리가 null 로 저장돼 전부 메인으로 복원되던 결함이 그렇게 지나갔다).
// 그래서 host 를 대역 창 목록·대역 화면으로 끝까지 돌린다. 실제 창은 움직이지 않는다.
const { createHost, initCapability } = require_("../native/electron/desk-layout/host.cjs");

function fakeScreen(external) {
  const main = { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, workArea: { x: 0, y: 38, width: 1728, height: 1079 } };
  return {
    getPrimaryDisplay: () => main,
    getAllDisplays: () => (external ? [main, external] : [main]),
  };
}

function fakeMac(state) {
  return {
    listWindows: async () => ({ ok: true, locked: false, windows: state.windows, desktops: [{ order: [3, 4, 5], current: 3 }] }),
    applyWindows: async (items) => { state.applied.push(...items); return { ok: true, results: items.map(() => ({ ok: true })) }; },
    restoreAcrossDesktops: async (plan) => { (state.plans ||= []).push(plan); return { ok: true, results: {} }; },
    runningBundleIds: async () => ({ ok: true, bundles: [], regular: [] }),
  };
}

const RIGHT_1920 = { id: 2, bounds: { x: 1728, y: 0, width: 1920, height: 1080 }, workArea: { x: 1728, y: 25, width: 1920, height: 1055 } };
const RIGHT_2560 = { id: 7, bounds: { x: 1728, y: 0, width: 2560, height: 1440 }, workArea: { x: 1728, y: 25, width: 2560, height: 1415 } };

function hostFor(state, screen, extra = {}) {
  return createHost({ stateDir: state.dir, screen, mac: fakeMac(state), selfPid: -1, notify: () => {}, ...extra });
}

async function runAsync() {
  const state = { dir: tempDir("host"), applied: [], windows: [
    // 오른쪽 모니터 왼쪽 절반(위·아래·왼쪽 변이 작업 영역에 붙음), 데스크톱 2
    { bundle: "com.google.Chrome", appName: "Chrome", pid: 10, cgId: 100, title: "문서", rect: { x: 1728, y: 25, width: 960, height: 1055 }, desktop: 2, onCurrent: false },
    // 메인 모니터 전체, 데스크톱 1
    { bundle: "com.tinyspeck.slackmacgap", appName: "Slack", pid: 20, cgId: 200, title: "채널", rect: { x: 0, y: 38, width: 1728, height: 1079 }, desktop: 1, onCurrent: true },
  ] };

  await checkAsync("host 저장: 모니터 자리와 창 비율이 값으로 저장된다(null·NaN 아님)", async () => {
    const r = await hostFor(state, fakeScreen(RIGHT_1920)).saveNow("shortcut");
    if (!r.saved) throw new Error(`저장 안 됨: ${JSON.stringify(r)}`);
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: state.dir });
    const latest = store.readLayout(2).latest;
    const slots = latest.monitors.map((m) => m.slot).sort().join(",");
    if (slots !== "main,right-1") throw new Error(`모니터 자리: ${slots}`);
    const chrome = latest.windows.find((w) => w.bundle === "com.google.Chrome");
    if (chrome.slot !== "right-1") throw new Error(`Chrome 창 자리: ${chrome.slot}`);
    if (![chrome.rect.x, chrome.rect.y, chrome.rect.w, chrome.rect.h].every(Number.isFinite)) throw new Error(`비율: ${JSON.stringify(chrome.rect)}`);
    return true;
  });

  await checkAsync("host 복원 계산: 창을 흩뜨려도(앱 재시작) 원래 모니터·원래 자리로 돌아간다", async () => {
    state.windows = [
      { bundle: "com.google.Chrome", appName: "Chrome", pid: 11, cgId: 111, title: "문서", rect: { x: 100, y: 100, width: 500, height: 400 }, desktop: 1, onCurrent: true },
      { bundle: "com.tinyspeck.slackmacgap", appName: "Slack", pid: 21, cgId: 211, title: "채널", rect: { x: 1800, y: 100, width: 600, height: 500 }, desktop: 1, onCurrent: true },
    ];
    const host = hostFor(state, fakeScreen(RIGHT_1920));
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: state.dir });
    const { entries } = host.planEntries(store.readLayout(2).latest, await host.collect());
    const to = Object.fromEntries(entries.map((e) => [e.saved.bundle, e.to]));
    const want = {
      "com.google.Chrome": { x: 1728, y: 25, width: 960, height: 1055 },
      "com.tinyspeck.slackmacgap": { x: 0, y: 38, width: 1728, height: 1079 },
    };
    for (const [b, r] of Object.entries(want)) {
      if (JSON.stringify(to[b]) !== JSON.stringify(r)) throw new Error(`${b}: ${JSON.stringify(to[b])} ≠ ${JSON.stringify(r)}`);
    }
    return true;
  });

  await checkAsync("host 복원 계산: 같은 자리의 다른 해상도 모니터에서는 비율로, 붙은 변은 모서리에 맞춘다", async () => {
    const host = hostFor(state, fakeScreen(RIGHT_2560));
    const store = createStore({ fs: require_("node:fs"), path: require_("node:path"), stateDir: state.dir });
    const { entries } = host.planEntries(store.readLayout(2).latest, await host.collect());
    const chrome = entries.find((e) => e.saved.bundle === "com.google.Chrome").to;
    const want = { x: 1728, y: 25, width: 1280, height: 1415 };
    if (JSON.stringify(chrome) !== JSON.stringify(want)) throw new Error(`${JSON.stringify(chrome)} ≠ ${JSON.stringify(want)}`);
    return true;
  });

  await checkAsync("host 자동 복원: 지금 데스크톱 창만 움직이고 다른 데스크톱 창은 보류한다", async () => {
    state.applied = [];
    state.windows = [
      { bundle: "com.google.Chrome", appName: "Chrome", pid: 11, cgId: 111, title: "문서", rect: { x: 100, y: 100, width: 500, height: 400 }, desktop: 2, onCurrent: false },
      { bundle: "com.tinyspeck.slackmacgap", appName: "Slack", pid: 21, cgId: 211, title: "채널", rect: { x: 1800, y: 100, width: 600, height: 500 }, desktop: 1, onCurrent: true },
    ];
    const host = hostFor(state, fakeScreen(RIGHT_1920));
    const r = await host.restoreAuto("check");
    host.stopPending();
    if (r.placed !== 1 || r.pending !== 1) throw new Error(`결과: ${JSON.stringify(r)}`);
    if (state.applied.length !== 1 || state.applied[0].pid !== 21) throw new Error(`움직인 창: ${JSON.stringify(state.applied)}`);
    return true;
  });

  // 지금 데스크톱에 있지만 저장한 데스크톱·위치가 둘 다 다른 창. 먼저 위치를 맞추므로, 데스크톱 이동은 맞춘 위치에서
  // 창을 찾아야 한다. 옛 위치로 찾으면 창을 못 찾아 데스크톱이 돌아오지 않았다(독립 검토에서 발견).
  await checkAsync("host 단축키 복원: 지금 데스크톱에서 위치를 먼저 맞춘 창은 맞춘 위치에서 찾아 데스크톱을 옮긴다", async () => {
    state.applied = []; state.plans = [];
    state.windows = [
      { bundle: "com.google.Chrome", appName: "Chrome", pid: 11, cgId: 111, title: "문서", rect: { x: 100, y: 100, width: 500, height: 400 }, desktop: 1, onCurrent: true },
    ];
    await hostFor(state, fakeScreen(RIGHT_1920)).restoreWithDesktops();
    const item = state.plans[0] && state.plans[0].visits[0] && state.plans[0].visits[0].items[0];
    if (!item) throw new Error(`데스크톱 이동 계획이 없다: ${JSON.stringify(state.plans)}`);
    if (item.target !== 2) throw new Error(`목표 데스크톱: ${item.target}`);
    if (JSON.stringify(item.from) !== JSON.stringify(item.to)) throw new Error(`찾는 위치 ${JSON.stringify(item.from)} ≠ 맞춘 위치 ${JSON.stringify(item.to)}`);
    return true;
  });

  await checkAsync("host 저장 단축키: 보류 중인 창 목록을 버린다(옛 저장본 자리로 옮기지 않게)", async () => {
    state.applied = [];
    state.windows = [
      { bundle: "com.google.Chrome", appName: "Chrome", pid: 11, cgId: 111, title: "문서", rect: { x: 100, y: 100, width: 500, height: 400 }, desktop: 2, onCurrent: false },
      { bundle: "com.tinyspeck.slackmacgap", appName: "Slack", pid: 21, cgId: 211, title: "채널", rect: { x: 1800, y: 100, width: 600, height: 500 }, desktop: 1, onCurrent: true },
    ];
    const host = hostFor(state, fakeScreen(RIGHT_1920));
    await host.restoreAuto("check");
    if (!host.state.pending) throw new Error("보류 목록이 만들어지지 않았다");
    await host.saveNow("shortcut");
    const left = host.state.pending;
    host.stopPending();
    if (left) throw new Error("저장 단축키 뒤에도 보류 목록이 남았다");
    return true;
  });

  // 앞 검사의 저장 단축키가 기준 배치를 바꿨으므로, 그 배치와 다른 자리에 창을 둔다.
  await checkAsync("host 모니터 변경: 잠금 중에 못 한 복원은 수를 확정하지 않고, 잠금이 풀린 뒤 다시 하면 복원한다", async () => {
    state.applied = [];
    state.windows = [
      { bundle: "com.tinyspeck.slackmacgap", appName: "Slack", pid: 21, cgId: 211, title: "채널", rect: { x: 50, y: 60, width: 600, height: 500 }, desktop: 1, onCurrent: true },
    ];
    const host = hostFor(state, fakeScreen(RIGHT_1920), { displayDebounceMs: 1 });
    const settle = () => new Promise((r) => setTimeout(r, 30));
    host.state.locked = true;
    host.onDisplaysChanged(); await settle();
    if (host.state.lastMonitorCount !== 0) throw new Error(`잠금 중인데 모니터 수를 확정했다: ${host.state.lastMonitorCount}`);
    host.state.locked = false;
    host.onDisplaysChanged(); await settle();
    host.stopPending();
    if (host.state.lastMonitorCount !== 2 || !state.applied.length) throw new Error(`잠금 해제 뒤 복원 안 됨: 수 ${host.state.lastMonitorCount}, 적용 ${state.applied.length}`);
    return true;
  });
}

// 네이티브 기능은 main.cjs 에서 앱 준비(whenReady) 전에 부팅된다. 그 시점에 screen 을 읽으면 Electron 이 예외를 던지고
// 기능 전체가 빠진다(설치 앱에서 실제로 일어났다). 설치 앱 조건으로 initCapability 를 불러 준비 전에 screen 을 건드리는지 본다.
async function runReadyOrder() {
  await checkAsync("설치 앱에서 initCapability 는 앱 준비 전에 screen 을 읽지 않고, 준비 뒤에 시작한다", async () => {
    let ready = false, readBeforeReady = false, startedAfterReady = false, resolveReady;
    const screen = {
      getAllDisplays() { if (!ready) readBeforeReady = true; else startedAfterReady = true; return [RIGHT_1920]; },
      on() {}, removeListener() {},
    };
    const handlers = new Map();
    const app = {
      isPackaged: true,
      whenReady: () => new Promise((resolve) => { resolveReady = resolve; }),
      once() {}, getLoginItemSettings: () => ({ openAtLogin: true }), setLoginItemSettings() {},
    };
    const ctx = { app, screen, stateDir: tempDir("ready"), isTrustedSender: () => true, error() {}, log() {},
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
    initCapability(ctx);
    if (readBeforeReady) throw new Error("앱 준비 전에 screen.getAllDisplays 를 불렀다");
    if (!handlers.has("ac-desklayout-disable")) throw new Error("준비 전에 IPC 가 등록되지 않았다");
    ready = true;
    resolveReady();
    await new Promise((r) => setTimeout(r, 0));
    // 검사 환경의 require("electron") 은 경로 문자열이라 이후 단계는 실패하고 기록만 남는다. 준비 뒤 screen 을 읽었는지만 본다.
    if (!startedAfterReady) throw new Error("앱 준비 뒤에도 시작하지 않았다");
    return true;
  });
}

export default async function runDeskLayout() {
  run();
  await runAsync();
  await runReadyOrder();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runDeskLayout();
  process.exit(summary());
}
