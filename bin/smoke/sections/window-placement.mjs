// 소유 범위: main-window·browser-window-manager·memo-window-manager 의 창 생성·자리·제목 계약.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. 이 파일들은 50-two-flows.mjs 를 기능별로 분리한 것이고,
//   분리하면서 검사 본문을 바꾸지 않았고, 인구조사 해시로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/window-placement.mjs
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import { check, checkAsync, read, readAll, require_, ROOT, sourceFiles } from "../core.mjs";
import {
  browserRuntime, browserWindowManagerSource, cdpTransportSource, main, mainWindowSource,
  memoWindowManagerSource, nativeAx, pick, record, web, webview,
} from "../sources.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

const pathJoinTmp = () => path.join(tmpdir(), "iris-server-host-probe");

export default async function run() {
  console.log("[창 자리 — 제목·복원·임시 자리·파티션]");
  {

    function createMainWindowProbe({ saved = null, visible = true, outcomes = ["resolve"] } = {}) {
      const loads = [], timers = new Map(), held = new Map(), placed = [], owned = [];
      let nextTimer = 1, alive = 0;
      class FakeBrowserWindow {
        static fromWebContents() { return null; }
        constructor(options) {
          this.options = options; this.handlers = {}; this.destroyed = false;
          const webHandlers = {};
          this.webContents = {
            on: (event, handler) => { (webHandlers[event] = webHandlers[event] || []).push(handler); },
            setWindowOpenHandler: (handler) => { this.openHandler = handler; },
          };
        }
        on(event, handler) { (this.handlers[event] = this.handlers[event] || []).push(handler); }
        once(event, handler) { this.on(event, handler); }
        emit(event) { for (const handler of this.handlers[event] || []) handler(); }
        isDestroyed() { return this.destroyed; }
        maximize() {}
        show() {}
        setFullScreen() {}
        loadURL(url) {
          loads.push(url);
          const outcome = outcomes.shift() || "resolve";
          if (outcome === "throw") throw new Error("sync load failure");
          return outcome === "reject" ? Promise.reject(new Error("async load failure")) : Promise.resolve();
        }
      }
      const appHandlers = {};
      const fakeSetTimeout = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; };
      const fakeClearTimeout = (id) => timers.delete(id);
      const windowLayout = {
        applySavedBounds: () => saved,
        boundsVisible: () => visible,
        restoreWhenDisplayReturns: (window, record, place) => held.set(window, { record, place }),
        placeSavedBounds: (window, record) => placed.push({ window, record }),
        ownWindowTitle: (window, title) => owned.push({ window, title }),
        trackWindowBounds: () => {},
      };
      const { createMainWindow } = require_("../native/electron/main-window.cjs");
      const manager = createMainWindow({
        app: { on: (event, handler) => { (appHandlers[event] = appHandlers[event] || []).push(handler); } },
        BrowserWindow: FakeBrowserWindow,
        shell: { openExternal: () => {} }, webContents: {}, windowLayout,
        guardWebviewPartition: () => {}, pinHiddenViewportById: () => {},
        preloadPath: "/preload.cjs", webviewPreloadPath: "/webview-preload.cjs",
        appUrl: "http://127.0.0.1:4291", audioDiagEnabled: false, noThrottleOpt: false,
        markAppAlive: () => { alive++; }, console: { log: () => {} },
        setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, setImmediate: (fn) => fn(),
      });
      const runNextTimer = () => {
        const entry = timers.entries().next().value;
        if (!entry) throw new Error("실행할 retry timer가 없다");
        const [id, timer] = entry; timers.delete(id); timer.fn();
        return timer.ms;
      };
      return { manager, loads, timers, held, placed, owned, alive: () => alive, runNextTimer };
    }

    await checkAsync("main-window는 첫 로드 실패 뒤 다시 시도하고 성공 뒤 timer를 남기지 않는다", async () => {
      for (const failure of ["reject", "throw"]) {
        const probe = createMainWindowProbe({ outcomes: [failure, "resolve"] });
        probe.manager.createWindow();
        await Promise.resolve(); await Promise.resolve();
        if (probe.loads.length !== 1 || probe.timers.size !== 1) {
          throw new Error(`${failure} 첫 실패 뒤 load ${probe.loads.length}번·timer ${probe.timers.size}개`);
        }
        const delay = probe.runNextTimer();
        await Promise.resolve(); await Promise.resolve();
        if (delay !== 1200) throw new Error(`${failure} retry 간격이 ${delay}ms`);
        if (probe.loads.join(",") !== "http://127.0.0.1:4291,http://127.0.0.1:4291") {
          throw new Error(`${failure} retry URL이 ${probe.loads.join(",")}`);
        }
        if (probe.timers.size) throw new Error(`${failure} 성공 뒤 timer ${probe.timers.size}개가 남는다`);
      }
      return true;
    });

    await checkAsync("main-window는 저장된 자리가 안 보일 때만 그 자리를 들고 기다린다", async () => {
      const saved = { x: 2400, y: 40, width: 1180, height: 800 };
      const hidden = createMainWindowProbe({ saved, visible: false });
      hidden.manager.createWindow();
      await Promise.resolve();
      const hiddenWindow = hidden.manager.getWindow(), waiting = hidden.held.get(hiddenWindow);
      if (!waiting || waiting.record !== saved) throw new Error("안 보이는 저장 자리를 대기표에 넣지 않는다");
      waiting.place();
      if (hidden.placed.length !== 1 || hidden.placed[0].record !== saved) throw new Error("기다리던 저장 자리로 돌아가지 않는다");
      const visible = createMainWindowProbe({ saved, visible: true });
      visible.manager.createWindow();
      await Promise.resolve();
      if (visible.held.size) throw new Error("이미 보이는 저장 자리도 기다린다");
      if (hidden.owned.length !== 1 || visible.owned.length !== 1) throw new Error("메인 창 제목 소유가 창마다 한 번이 아니다");
      return true;
    });

    check("창마다 제목이 다르고, 페이지가 그것을 덮지 못한다", () => {
      // 창 넷 중 셋의 제목이 "Iris"로 표시된다(확인 결과). 생성자 title을 지정해도 마찬가지인데,
      // 창들이 같은 페이지를 열고, 그 페이지의 <title>이 창 제목을 덮기 때문이다. 그러면
      // Mission Control·창 전환·Dock 어디에서도 어느 창인지 고를 수 없다.
      const nativeAll = readAll("native");
      const titles = [...nativeAll.matchAll(/^\s*(?:title|(?:alwaysOnTop: record\.alwaysOnTop,\s*\n\s*)?title):\s*(.+?),\s*$/gm)].map((m) => m[1]);
      const named = ["Iris — 콘솔", "Iris — 공유 브라우저", "Iris — 브라우저", "Iris — 공유 메모", "Iris — 메모"]
        .every((t) => nativeAll.includes(`"${t}"`));
      // 창 넷(메인·브라우저·공유 브라우저·메모) 전부가 제목을 소유해야 한다. 하나만 빠져도
      // 그 창은 다시 "Iris"가 된다.
      // 정의 하나와 호출 셋을 따로 검사한다. 합쳐서 ">= 4" 로 두면 창 하나가 이 함수를 호출하지 않게
      // 되어도 다른 곳에 호출이 하나 더 생기면 통과한다. 창 셋이 각각 호출하는 것을 검사해야 한다.
      // 소유 모듈은 window-layout 하나이고, 창 셋이 각각 그 모듈을 직접 호출한다. 래퍼를 두지 않는 것이
      // 이 검사의 전제다. 래퍼를 두면 호출 위치가 하나로 합쳐져 창 하나가 빠져도 드러나지 않는다.
      const owned = (nativeAll.match(/function ownWindowTitle\(/g) || []).length === 1
        && (mainWindowSource.match(/windowLayout\.ownWindowTitle\(/g) || []).length === 1
        && (browserWindowManagerSource.match(/windowLayout\.ownWindowTitle\(/g) || []).length === 1
        && (memoWindowManagerSource.match(/windowLayout\.ownWindowTitle\(/g) || []).length === 1;
      // preventDefault는 BrowserWindow 이벤트에서만 듣는다. webContents에 걸면 조용히 아무 일도
      // 일어나지 않는다(확인 결과: 그렇게 배포하면 창 셋의 제목이 "Iris"로 남는다).
      // 차단 방식의 소유 모듈은 window-layout 이다. 부정 조건은 native 전체를 검사한다. 어느 파일에서든
      // webContents 쪽에 걸면 오류 없이 동작하지 않기 때문이다.
      const prevents = /function ownWindowTitle\([\s\S]{0,400}\bw\.on\("page-title-updated", \(ev\) => \{ ev\.preventDefault\(\); stamp\(\); \}\)/.test(read("native/electron/window-layout.cjs"))
        && !/webContents\.on\("page-title-updated", \(ev\) => \{ ev\.preventDefault\(\); \}\)/.test(nativeAll);
      return named && owned && prevents && titles.length > 0;
    });

    // 코드 모양이 아니라 실제로 실행해 검사한다. 여기가 어긋나면 마지막 로그인·쿠키가 디스크에 기록되지 않고,
    // 다음 실행에서 로그아웃으로만 나타나 원인을 찾기 어렵다.
    await checkAsync("종료 전에 모든 파티션을 비우고, 실패해도 나간다", async () => {
      const { createStorageLifecycle } = require_("../native/electron/storage-lifecycle.cjs");
      const settle = () => new Promise((r) => setTimeout(r, 0));
      {
        const flushed = [], quits = [];
        const life = createStorageLifecycle({
          forEachHardened: async (fn) => { for (const p of ["persist:a", "persist:b", "persist:c"]) await fn(p); },
          flushPartition: async (p) => { flushed.push(p); },
          isReady: () => true, quit: () => quits.push(1),
          wait: () => new Promise(() => {}), log: () => {},
        });
        let prevented = 0;
        const ev = { preventDefault: () => { prevented++; } };
        life.handleBeforeQuit(ev);
        life.handleBeforeQuit(ev);          // 도는 동안 두 번째 요청이 새 비우기를 시작하면 안 된다
        await settle(); await settle();
        if (flushed.join(",") !== "persist:a,persist:b,persist:c") throw new Error(`비운 파티션이 ${flushed.join(",")}`);
        if (prevented !== 2) throw new Error(`종료를 ${prevented}번만 붙잡았다`);
        if (quits.length !== 1) throw new Error(`quit 이 ${quits.length}번`);
      }
      {
        // 비우기가 실패해도 종료는 진행한다
        const quits = [];
        const life = createStorageLifecycle({
          forEachHardened: async () => { throw new Error("디스크 없음"); },
          flushPartition: async () => {},
          isReady: () => true, quit: () => quits.push(1),
          wait: () => new Promise(() => {}), log: () => {},
        });
        life.handleBeforeQuit({ preventDefault: () => {} });
        await settle(); await settle();
        if (quits.length !== 1) throw new Error("비우기가 실패하니 안 나간다");
      }
      {
        // ready 전 종료는 대기하지 않는다. 등록된 세션이 없다
        let prevented = 0;
        const life = createStorageLifecycle({
          forEachHardened: async () => { throw new Error("불리면 안 된다"); },
          flushPartition: async () => {}, isReady: () => false,
          quit: () => {}, wait: () => new Promise(() => {}), log: () => {},
        });
        life.handleBeforeQuit({ preventDefault: () => { prevented++; } });
        if (prevented) throw new Error("ready 전인데 종료를 붙잡는다");
      }
      return true;
    });

    // 연결만 보면 순서를 확인할 수 없다. 대기 중 저장이 실제로 막히는지, 모니터가 돌아오면 실제로
    // 복원되는지, 사용자가 옮기면 대기를 중단하는지는 실행해야 알 수 있다. 어긋나면 다음 실행에서
    // 창들이 한 화면에 겹쳐 쌓이고, 그 시점에는 원래 위치가 이미 지워져 있다.
    check("자리를 기다리는 동안 임시 자리가 원래 자리를 덮지 않는다", () => {
      const { createWindowLayout } = require_("../native/electron/window-layout.cjs");
      const listeners = {};
      let displayAdded = null;
      const fakeScreen = {
        on: (ev, fn) => { if (ev === "display-added") displayAdded = fn; },
        getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
        getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      };
      const written = [];
      let visible = false;   // 그 창의 모니터는 아직 안 붙었다
      // 모니터 구성이 막 바뀐 직후인지는 시각으로만 갈린다. 검사가 1.5초를 실제로 기다리면
      // 스위트가 그만큼 느려지고, 느린 검사는 실행되지 않는다. 그래서 시계를 주입한다.
      let clock = 100000;
      const settled = () => { clock += 5000; };
      const layout = createWindowLayout({
        screen: fakeScreen,
        windowBoundsVisible: () => visible,
        readUiState: () => ({}),
        writeUiState: (patch) => written.push(patch),
        now: () => clock,
      });
      const w = {
        isDestroyed: () => false,
        on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        once: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        getNormalBounds: () => ({ x: 10, y: 10, width: 800, height: 600 }),
        getBounds: () => ({ x: 10, y: 10, width: 800, height: 600 }),
        isMaximized: () => false, isFullScreen: () => false,
        setBounds() { this.placed = true; }, setFullScreen() {}, maximize() {},
      };
      const want = { x: 2000, y: 0, width: 900, height: 700 };
      let placed = 0;
      layout.restoreWhenDisplayReturns(w, want, () => { placed++; });
      layout.trackWindowBounds(w, "k");
      // 대기 중. 창이 닫히며 위치를 저장하려 해도 원래 위치를 덮지 않는다
      for (const fn of listeners.close || []) fn();
      if (written.length) throw new Error(`기다리는 중인데 ${written.length}건 저장했다`);
      // 모니터가 돌아왔다
      visible = true;
      if (!displayAdded) throw new Error("display-added 를 안 듣고 있다");
      displayAdded();
      if (placed !== 1) throw new Error(`모니터가 왔는데 ${placed}번 되돌렸다`);
      // 연결 직후에는 OS 가 창들을 옮기는 중이므로 그 위치를 저장하면 안 된다
      for (const fn of listeners.close || []) fn();
      if (written.length) throw new Error(`모니터가 막 붙었는데 ${written.length}건 저장했다`);
      // 자리가 잡히고 나면 저장한다
      settled();
      for (const fn of listeners.close || []) fn();
      if (written.length !== 1) throw new Error(`자리가 잡혔는데 ${written.length}건 저장했다`);
      // 사용자가 직접 옮기면 대기를 중단한다. 모니터가 다시 연결되지 않을 수 있다
      const w2 = { ...w, isDestroyed: () => false };
      const l2 = {};
      w2.on = (ev, fn) => { (l2[ev] = l2[ev] || []).push(fn); };
      w2.once = w2.on;
      let placed2 = 0;
      visible = false;
      layout.restoreWhenDisplayReturns(w2, want, () => { placed2++; });
      settled();   // 사람의 손은 구성이 바뀐 직후가 아니라 그 뒤에 온다
      for (const fn of l2["will-move"] || []) fn();
      visible = true;
      displayAdded();
      if (placed2 !== 0) throw new Error("사람이 옮겼는데도 되돌린다");
      return true;
    });

    // 여기까지는 실행 시점의 처리다. 위치가 어긋나는 것은 그다음이다. 앱이 켜져 있는
    // 동안 모니터를 뽑으면 macOS 가 창들을 남은 화면으로 밀어 넣고, 0.5초 뒤 그 자리가 저장되어
    // 원래 위치를 덮는다(확인 결과: 3→1→3 으로 바꾸면 창들이 서로 다른 위치로 이동한다).
    check("돌아가는 중에 모니터가 빠져도 원래 자리를 지우지 않는다", () => {
      const { createWindowLayout } = require_("../native/electron/window-layout.cjs");
      const on = {};
      const fakeScreen = {
        on: (ev, fn) => { (on[ev] = on[ev] || []).push(fn); },
        getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
        getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      };
      const fire = (ev) => { for (const fn of on[ev] || []) fn(); };
      const written = [];
      let clock = 100000;
      const settled = () => { clock += 5000; };
      // 이 창의 저장된 위치는 오른쪽 모니터다. visible 이 그 모니터의 연결 여부를 대신한다.
      const saved = { x: 2000, y: 0, width: 900, height: 700 };
      let visible = true;
      const layout = createWindowLayout({
        screen: fakeScreen,
        windowBoundsVisible: () => visible,
        readUiState: () => ({ k: saved }),
        writeUiState: (patch) => written.push(patch),
        now: () => clock,
      });
      const listeners = {};
      let placed = null;
      const w = {
        isDestroyed: () => false,
        on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        once: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        // macOS 가 창을 왼쪽 모니터로 옮긴 뒤의 위치
        getNormalBounds: () => ({ x: 10, y: 10, width: 900, height: 700 }),
        getBounds: () => ({ x: 10, y: 10, width: 900, height: 700 }),
        isMaximized: () => false, isFullScreen: () => false,
        setBounds(b) { placed = b; }, setFullScreen() {}, maximize() {},
      };
      layout.trackWindowBounds(w, "k");
      // 평소에는 저장한다. 그러지 않으면 이 검사가 아무것도 확인하지 못한다
      settled();
      for (const fn of listeners.close || []) fn();
      if (written.length !== 1) throw new Error(`평소에 ${written.length}건 저장했다 — 계측기가 깨졌다`);
      written.length = 0;

      // 모니터를 뽑았다
      visible = false;
      fire("display-removed");
      // OS 가 민 자리로 저장이 들어온다(close·move 어느 쪽이든 같은 save 를 탄다)
      for (const fn of listeners.close || []) fn();
      if (written.length) throw new Error(`모니터가 빠졌는데 ${written.length}건 저장했다`);
      // 시간이 지나도 저장하지 않는다. 그 창의 모니터가 아직 연결되지 않았다
      settled();
      for (const fn of listeners.close || []) fn();
      if (written.length) throw new Error(`한참 뒤에도 ${written.length}건 저장했다`);

      // 다시 연결하면 원래 위치로 복원된다
      visible = true;
      fire("display-added");
      if (!placed || placed.x !== saved.x) throw new Error(`되돌린 자리가 ${JSON.stringify(placed)}`);
      settled();
      for (const fn of listeners.close || []) fn();
      if (written.length !== 1) throw new Error(`자리가 잡혔는데 ${written.length}건 저장했다`);
      return true;
    });

    // OS 가 옮긴 이동과 사용자가 끈 이동은 이벤트로 구분되지 않는다. 시각으로만 갈리는데, 그 판정이
    // 없으면 모니터를 뽑는 순간 발생하는 will-move 가 곧바로 대기를 중단해 위 방어가 무효가 된다.
    check("모니터가 막 바뀐 직후의 이동은 사람이 옮긴 것으로 세지 않는다", () => {
      const { createWindowLayout } = require_("../native/electron/window-layout.cjs");
      const on = {};
      const fakeScreen = {
        on: (ev, fn) => { (on[ev] = on[ev] || []).push(fn); },
        getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
        getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      };
      const fire = (ev) => { for (const fn of on[ev] || []) fn(); };
      let clock = 100000, visible = true;
      const saved = { x: 2000, y: 0, width: 900, height: 700 };
      const layout = createWindowLayout({
        screen: fakeScreen, windowBoundsVisible: () => visible,
        readUiState: () => ({ k: saved }), writeUiState: () => {}, now: () => clock,
      });
      const mk = () => {
        const l = {};
        return { l, w: { isDestroyed: () => false,
          on: (ev, fn) => { (l[ev] = l[ev] || []).push(fn); },
          once: (ev, fn) => { (l[ev] = l[ev] || []).push(fn); },
          getNormalBounds: () => ({ x: 10, y: 10, width: 900, height: 700 }),
          getBounds: () => ({ x: 10, y: 10, width: 900, height: 700 }),
          isMaximized: () => false, isFullScreen: () => false,
          setBounds() { this.placed = true; }, setFullScreen() {}, maximize() {} } };
      };
      // (가) 분리 직후 OS 가 옮긴 이동. 대기가 유지돼야 한다
      { const { l, w } = mk();
        layout.trackWindowBounds(w, "k");
        visible = false; fire("display-removed");
        for (const fn of l["will-move"] || []) fn();
        if (!layout.isAwaiting(w)) throw new Error("OS 가 민 이동에 기다림을 접었다");
      }
      // (나) 시간이 지난 뒤 사용자가 끈 이동. 대기를 중단해야 한다. 모니터가 다시 연결되지 않을 수 있다.
      { const { l, w } = mk();
        layout.trackWindowBounds(w, "k");
        visible = false; fire("display-removed");
        clock += 5000;
        for (const fn of l["will-move"] || []) fn();
        if (layout.isAwaiting(w)) throw new Error("사람이 옮겼는데 기다림을 안 접었다");
      }
      return true;
    });

    check("모니터가 아직 없는 창은 임시 자리를 저장하지 않는다", () => {
      // 판정 자체는 test/window-bounds.mjs 가 확인한다. 여기서 확인하는 것은 연결이다. 판정이 맞아도
      // 창 넷 중 하나라도 이 연결이 빠지면 그 창만 어긋나고, 화면으로만 확인된다.
      const nativeAll2 = readAll("native");
      const layout = read("native/electron/window-layout.cjs");
      const held = (nativeAll2.match(/function restoreWhenDisplayReturns\(/g) || []).length === 1
        && (nativeAll2.match(/windowLayout\.restoreWhenDisplayReturns\(/g) || []).length === 3; // 창 셋이 각각 부른다
      // 대기 중 임시 위치를 거르는 소유 모듈은 window-layout 이다. 메모 record 경로도 그
      // snapshot 을 받아 쓰며, 위치 계산을 다시 구현하지 않는다.
      const suppressed = /function snapshotWindowBounds\(w\) \{[\s\S]{0,160}awaitingDisplay\.has\(w\)\) return null;/.test(layout)
        && /const snapshot = windowLayout\.snapshotWindowBounds\(w\);\n\s*if \(!snapshot\) return;/.test(memoWindowManagerSource)
        && !/getNormalBounds|getDisplayMatching/.test(memoWindowManagerSource);
      // 줄 간격으로 검사하지 않는다. 사이에 주석·기록이 한 줄만 늘어도 통과하던 검사가 실패한다
      // (확인 결과: 진단 기록을 넣자 500자를 넘겨 이 검사가 실패했다).
      // 두 사실을 따로 검사한다: 모니터 연결을 수신하는가, 그리고 대기 목록의 창을 해제하는가.
      const returns = /screen\.on\("display-added"/.test(layout)
        && /for \(const \[w, entry\] of \[\.\.\.awaitingDisplay\]\)/.test(layout)
        && /entry\.place\(\)/.test(layout);
      const userWins = /w\.on\("will-move", giveUp\); w\.on\("will-resize", giveUp\);/.test(layout);
      return held && suppressed && returns && userWins;
    });

  }
}
