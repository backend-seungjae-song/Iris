// 소유 범위: cdp-control.cjs 의 handler 표와 cdp-session·cdp-transport·cdp-ref-registry, 그리고 실행기 슬롯 경합.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. cdp-control.mjs 를 하위 기능으로 나눈 것이고,
//   나누는 동안 본문을 수정하지 않았으며, 원본 대비 바이트 대조가 이를 보장한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 호출하며 sources 의 공유 상수 계약도 함께 확인한다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/cdp-session.mjs
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
  console.log("[CDP 자리 — 실행기 등록·세션·전송]");
  {
    const mainF = read("native/electron/main.cjs");
    const cdpF = read("native/electron/cdp-control.cjs");
    // 개발 인스턴스와 설치된 앱이 같은 서버에 붙으면 명령이 어느 쪽으로 갔는지 알 수 없어,
    // 존재하는 명령에도 없다는 응답이 돌아온다.
    // ref 는 탭 하나와 그 탭의 페이지 세대에 고정된다. 이 판정이 느슨해지면 이동한 뒤의 조작이
    // 이전 화면의 요소를 가리켜 잘못된 위치를 누르고, 화면은 정상으로 보이는데 결과만 틀린다.
    // 여기서도 소스 형태가 아니라 실제로 실행해서 확인한다. 순수한 상태 모듈이라 실행할 수 있다.
    check("ref 는 탭과 페이지 세대에 묶인다", () => {
      const reg = require_("../native/electron/cdp-ref-registry.cjs");
      reg.clear(1); reg.clear(2);
      let code = null;
      try { reg.resolveRef(1, "e1"); } catch (e) { code = e.code; }
      if (code !== "no_snapshot") throw new Error(`snapshot 전인데 ${code}`);
      reg.recordSnapshot(1, new Map([["e1", 111]]));
      if (reg.resolveRef(1, "e1") !== 111) throw new Error("찍어 둔 ref 를 못 찾는다");
      code = null;
      try { reg.resolveRef(1, "e9"); } catch (e) { code = e.code; }
      if (code !== "not_found") throw new Error(`모르는 ref 인데 ${code}`);
      // 다른 탭의 snapshot 으로 이 탭의 ref 가 다시 유효해지면 안 된다
      code = null;
      try { reg.resolveRef(2, "e1"); } catch (e) { code = e.code; }
      if (code !== "no_snapshot") throw new Error(`남의 탭 snapshot 을 빌려 쓴다 — ${code}`);
      reg.bumpNavigation(1);
      code = null;
      try { reg.resolveRef(1, "e1"); } catch (e) { code = e.code; }
      if (code !== "stale_ref") throw new Error(`페이지가 이동했는데 ${code}`);
      reg.recordSnapshot(1, new Map([["e1", 222]]));
      if (reg.resolveRef(1, "e1") !== 222) throw new Error("재-snapshot 뒤에도 안 산다");
      reg.clear(1); reg.clear(2);
      return true;
    });
    await checkAsync("CDP session은 같은 세션에 primer를 겹치지 않고 재부착 뒤 root·child를 다시 건다", async () => {
      const { createCdpSession } = require_("../native/electron/cdp-session.cjs");
      const handlers = {}, sent = [], reset = [], rootPrimers = [], childPrimers = [], rootOverlays = [], childOverlays = [];
      let attached = false, observationPrimes = 0;
      const dbg = {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; },
        on: (name, fn) => { handlers[name] = fn; },
        sendCommand: (method, params, sid) => { sent.push({ method, params, sid }); return Promise.resolve({}); },
      };
      const wcHandlers = {};
      const wc = {
        id: 61001, debugger: dbg,
        on: (name, fn) => { wcHandlers[name] = fn; },
        once: (name, fn) => { wcHandlers[name] = fn; },
      };
      const session = createCdpSession({
        observation: {
          prime: () => { observationPrimes++; }, forget() {}, momentPayload: () => null,
          recordConsole() {}, recordException() {}, recordNetwork() {}, setFileChooser() {}, closeDialog() {},
          openDialog: (_id, record) => record, noteRequest() {}, requestUrl: () => "",
        },
        hiddenViewport: { forget() {}, resetSession: (id) => reset.push(["viewport", id]) },
        overlay: {
          injectActive: (id, sid) => sid ? childOverlays.push([id, sid]) : rootOverlays.push(id),
          resetSession: (id) => reset.push(["overlay", id]),
        },
        refRegistry: { bumpNavigation() {}, clear() {}, clearSnapshot: (id) => reset.push(["ref", id]) },
        upload: { forget() {}, serveFileChooser: async () => {} },
        deviceEmulation: { forget() {} },
        ctlSend() {},
        tagError: (error, code) => { error.code = code; return error; },
        sessionDetachedCode: "session_detached",
      });
      session.registerSessionPrimer(wc.id,
        (_wc, _dbg) => rootPrimers.push("root"),
        (_dbg, sid) => childPrimers.push(sid));
      const sender = session.ensureAttached(wc);
      session.primeSession(wc); // 같은 debugger session에 두 번 걸어도 한 벌이어야 한다.
      if (rootPrimers.length !== 1 || observationPrimes !== 1 || rootOverlays.length !== 1) {
        throw new Error(`첫 세션 primer가 한 벌이 아니다(root=${rootPrimers.length}, observation=${observationPrimes}, overlay=${rootOverlays.length})`);
      }
      handlers.message(null, "Target.attachedToTarget", { sessionId: "child-a", targetInfo: { type: "iframe" } });
      handlers.message(null, "Target.attachedToTarget", { sessionId: "child-a", targetInfo: { type: "iframe" } });
      if (childPrimers.length !== 1 || childOverlays.length !== 1 || sender.frames().join(",") !== ",child-a") {
        throw new Error(`같은 자식 session에 primer가 겹친다(child=${childPrimers.length}, overlay=${childOverlays.length})`);
      }
      session.resetCdpSession(wc);
      if (rootPrimers.length !== 2 || observationPrimes !== 2 || rootOverlays.length !== 2) {
        throw new Error(`재부착 뒤 root primer가 다시 한 벌 걸리지 않는다(root=${rootPrimers.length}, observation=${observationPrimes}, overlay=${rootOverlays.length})`);
      }
      handlers.message(null, "Target.attachedToTarget", { sessionId: "child-a", targetInfo: { type: "iframe" } });
      handlers.message(null, "Target.attachedToTarget", { sessionId: "child-a", targetInfo: { type: "iframe" } });
      if (childPrimers.length !== 2 || childOverlays.length !== 2) {
        throw new Error(`재부착 뒤 child primer가 다시 한 벌 걸리지 않는다(child=${childPrimers.length}, overlay=${childOverlays.length})`);
      }
      if (reset.map(([kind]) => kind).join(",") !== "viewport,overlay,ref") {
        throw new Error(`재부착 정리 순서가 다르다(${reset.map(([kind]) => kind).join(",")})`);
      }
      const rootDomainEnables = sent.filter((call) => !call.sid && ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].includes(call.method));
      if (rootDomainEnables.length !== 8) throw new Error(`재부착 전후 root domain이 전부 다시 열리지 않는다(${rootDomainEnables.length})`);
      return true;
    });
    await checkAsync("CDP session dialog queue가 비면 사람이 처리하는 null mode로 돌아간다", async () => {
      const { createCdpSession } = require_("../native/electron/cdp-session.cjs");
      const session = createCdpSession({
        observation: {}, hiddenViewport: {}, overlay: {}, refRegistry: {}, upload: {}, deviceEmulation: {},
        ctlSend() {}, tagError: (error) => error, sessionDetachedCode: "session_detached",
      });
      const plan = session.planFor(61002);
      plan.queue = ["ok", "cancel"];
      plan.mode = null;
      const answers = [session.nextAnswer(61002), session.nextAnswer(61002), session.nextAnswer(61002)];
      if (answers[0] !== "ok" || answers[1] !== "cancel" || answers[2] !== null || plan.mode !== null || plan.queue.length) {
        throw new Error(`dialog queue 소진 뒤 사람 mode가 아니다(${JSON.stringify({ answers, plan })})`);
      }
      return true;
    });
    await checkAsync("CDP 실행기는 같은 pid 재연결을 받고 다른 살아 있는 pid를 거절한다", async () => {
      const runtime = await import("../../../server/browser-runtime.js");
      const socket = () => ({ readyState: 1, sent: [], send(text) { this.sent.push(JSON.parse(text)); } });
      const first = socket(), same = socket(), other = socket();
      const log = console.log, warn = console.warn;
      console.log = () => {}; console.warn = () => {};
      try {
        if (!runtime.registerCdpExecutor(first, { app: "/Applications/Iris.app", pid: 501 })) {
          throw new Error("첫 실행기 등록을 거절한다");
        }
        if (!runtime.registerCdpExecutor(same, { app: "/Applications/Iris.app", pid: 501 })) {
          throw new Error("같은 pid 재연결을 거절한다");
        }
        if (runtime.registerCdpExecutor(other, { app: "/tmp/Other.app", pid: 777 })) {
          throw new Error("다른 살아 있는 pid가 실행기 자리를 가져간다");
        }
        if (other.sent.length !== 1 || other.sent[0]?.type !== "cdp-executor-refused"
          || other.sent[0]?.holder?.pid !== 501 || other.sent[0]?.newcomer?.pid !== 777) {
          throw new Error(`다른 pid 거절 봉투가 사실을 보존하지 않는다(${JSON.stringify(other.sent)})`);
        }
        if (runtime.disconnectCdpExecutor(first) !== false || runtime.disconnectCdpExecutor(same) !== true) {
          throw new Error("재연결 뒤 현재 실행기 소유자가 같은 pid의 새 socket이 아니다");
        }
      } finally {
        runtime.disconnectCdpExecutor(same);
        console.log = log; console.warn = warn;
      }
      return true;
    });
    await checkAsync("CDP transport는 연결 전 보류분을 open 뒤 보내고 close 뒤 다시 붙는다", async () => {
      const { createCdpTransport } = require_("../native/electron/cdp-transport.cjs");
      const sockets = [], retries = [], cleared = [], execCalls = [];
      class WebSocketProbe {
        constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; this.sent = []; sockets.push(this); }
        on(name, fn) { this.handlers[name] = fn; }
        emit(name, data) { return this.handlers[name]?.(data); }
        send(text) { this.sent.push(JSON.parse(text)); }
        close() { this.readyState = 3; return this.emit("close", "closed"); }
        terminate() { this.terminated = true; }
      }
      const webContentsMod = { marker: "transport-web-contents" };
      const transport = createCdpTransport({
        WebSocket: WebSocketProbe,
        port: 4291,
        cdpExec: async (...args) => { execCalls.push(args); return { value: "done" }; },
        codedError: (code, message) => Object.assign(new Error(message), { code }),
        tabGoneCode: "tab_gone",
        execPath: "/Applications/Iris.app/Contents/MacOS/Iris",
        pid: 901,
        now: () => 1000,
        setTimeoutFn: (fn, ms) => { retries.push({ fn, ms }); return retries.length; },
        setIntervalFn: () => ({ unref() {} }),
        clearIntervalFn: (timer) => cleared.push(timer),
        log() {}, error() {},
      });
      transport.ctlSend({ type: "popup-before-server", wc: 41 });
      transport.setupCdpControl(webContentsMod);
      if (sockets.length !== 1 || sockets[0].url !== "ws://127.0.0.1:4291" || sockets[0].sent.length) {
        throw new Error("open 전인데 보류 메시지를 보내거나 올바른 port에 연결하지 않는다");
      }
      sockets[0].readyState = 1;
      await sockets[0].emit("open");
      if (sockets[0].sent.length !== 2 || sockets[0].sent[0]?.type !== "cdp-executor-register"
        || sockets[0].sent[1]?.type !== "popup-before-server") {
        throw new Error(`등록 다음에 보류분을 보내지 않는다(${JSON.stringify(sockets[0].sent)})`);
      }
      sockets[0].readyState = 3;
      await sockets[0].emit("close", "server-restart");
      transport.ctlSend({ type: "popup-during-gap", wc: 42 });
      if (retries.length !== 1 || retries[0].ms !== 1000) {
        throw new Error(`close 뒤 첫 재연결 backoff가 아니다(${JSON.stringify(retries.map((item) => item.ms))})`);
      }
      retries.shift().fn();
      if (sockets.length !== 2 || sockets[1].sent.length) throw new Error("재연결 socket을 새로 만들지 않는다");
      sockets[1].readyState = 1;
      await sockets[1].emit("open");
      if (sockets[1].sent.length !== 2 || sockets[1].sent[0]?.type !== "cdp-executor-register"
        || sockets[1].sent[1]?.type !== "popup-during-gap") {
        throw new Error(`재연결 뒤 단절 중 보류분을 보내지 않는다(${JSON.stringify(sockets[1].sent)})`);
      }
      await sockets[1].emit("message", Buffer.from(JSON.stringify({
        type: "cdp-exec", id: "cmd-1", wc: 77, cmd: "text", args: { limit: 3 },
      })));
      if (execCalls.length !== 1 || execCalls[0][0] !== webContentsMod || execCalls[0][1] !== 77
        || execCalls[0][2] !== "text" || execCalls[0][3]?.limit !== 3) {
        throw new Error("서버 명령이 주입된 cdpExec과 webContents 조립을 타지 않는다");
      }
      const result = sockets[1].sent.at(-1);
      if (result?.type !== "cdp-result" || result?.id !== "cmd-1" || result?.ok !== true || result?.data?.value !== "done") {
        throw new Error(`cdpExec 결과 봉투가 다르다(${JSON.stringify(result)})`);
      }
      if (cleared.length !== 1) throw new Error(`끊긴 socket heartbeat를 ${cleared.length}번 정리한다`);
      return true;
    });
    check("CDP handler 표와 default 안내 목록이 어긋나지 않는다", () => {
      const { createPageCommands } = require_("../native/electron/cdp-cmd-page.cjs");
      const { createInputCommands } = require_("../native/electron/cdp-cmd-input.cjs");
      const { createInspectCommands } = require_("../native/electron/cdp-cmd-inspect.cjs");
      const { createCaptureCommands } = require_("../native/electron/cdp-cmd-capture.cjs");
      const { createNativeCommands } = require_("../native/electron/cdp-cmd-native.cjs");
      const handlers = {
        ...createPageCommands({ applyViewport: async () => ({ ok: true }) }),
        ...createInputCommands({
          withLayout: async (_send, fn) => await fn(false),
          nodeFromArgs: async () => ({ backendNodeId: 1, sid: null }),
          insertTextInChunks: async () => {},
          isTabShown: () => true,
          run: async () => ({ ok: true }),
          webContentsMod: () => ({}),
        }),
        ...createInspectCommands({
          buildSnapshot: async () => ({ refMap: new Map(), refs: [], snapshot: "", total: 0, shownCount: 0, bytes: 0 }),
          refRegistry: { recordSnapshot() {} },
          loginHint: async () => null,
          humanHint: async () => null,
          observation: { observe: () => ({ console: [], exceptions: [], network: [], dialogs: [], moments: [], counts: {} }), clearDiagnostics() {} },
          downloadState: { snapshot: () => ({ dir: null, once: false, last: null, pending: null }) },
          cdpExecRaw: async () => ({ ok: true }),
          webContentsMod: () => ({}),
          fs: { mkdirSync() {}, writeFileSync() {} },
          path,
          IRIS_HOME: "/tmp/iris-smoke",
        }),
        ...createCaptureCommands({
          withLayout: async (_send, fn) => await fn(false),
          rectOf: async () => null,
          readZoom: async () => ({ on: false }),
          setZoom: async () => {},
          DRAW_MARKS: () => 0,
          viewportClip: async () => ({ x: 0, y: 0, width: 1, height: 1 }),
          waitRenderIdle: async () => {},
          captureHold: async () => false,
          stitchFullPage: async () => ({}),
          screencastShot: async () => Buffer.from("x"),
          resetCdpSession() {},
          pruneShots() {},
          diffPng: async () => ({ changed: 0, total: 1, ratio: 0 }),
          deviceEmulation: { apply: async () => ({ ok: true }) },
          cdpExecRaw: async () => ({ ok: true }),
          webContentsMod: () => ({}),
          fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} },
          path,
          IRIS_HOME: "/tmp/iris-smoke",
        }),
        ...createNativeCommands({
          observation: { dialogOpen: () => null, closeDialog() {} },
          planFor: () => ({ queue: [], mode: null, text: null }),
          ctlSend() {},
          upload: { invalidPaths: () => [], arm() {} },
          nodeFromArgs: async () => ({ backendNodeId: 1, sid: null }),
          downloadState: { disarm() {}, arm() {}, snapshot: () => ({ last: null, once: false }) },
          loginProvider: () => null,
          resultSafety: { rememberSecret() {} },
          nativeAx: { axDescribe: async () => ({}), axKey: async () => ({}), axClick: async () => ({}) },
          fs: { mkdirSync() {} },
          path,
          os: { homedir: () => "/tmp" },
        }),
      };
      const guide = sliceBetween(cdpF, "    // 무엇이 있는지 함께 알려 준다", "\n  }\n}\n\n// 탭 화면", "CDP default 안내 목록");
      const guideText = [...guide.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join("");
      const listedText = guideText.split("쓸 수 있는 것: ")[1];
      const expected = "snapshot text url screenshot shotsizes observe tabs goto back forward reload viewport wait click dblclick hover fill type bulkfill key select focus clear check scroll scrollto eval expect diff a11y locate pdf login upload download dialog dialogs nativewin nativeclick nativekey newtab target untarget";
      if (listedText !== expected) throw new Error("default 안내 목록의 기존 이름·순서가 달라졌다");
      const listed = new Set(listedText.split(/\s+/).filter(Boolean));
      const handlerNames = Object.keys(handlers);
      const missingFromGuide = handlerNames.filter((name) => !listed.has(name));
      if (missingFromGuide.length) throw new Error(`handler가 안내에서 빠졌다: ${missingFromGuide.join(", ")}`);

      const switchBody = sliceBetween(cdpF, "  switch (cmd) {", "    // 무엇이 있는지 함께 알려 준다", "남은 CDP switch");
      const reachable = new Set([...switchBody.matchAll(/case "([^"]+)"/g)].map((match) => match[1]));
      for (const name of handlerNames) reachable.add(name);
      // tabs·newtab·target·untarget는 CDP까지 내려오기 전에 서버 dispatcher가 처리한다.
      const outer = read("server/browser-commands.js");
      for (const match of outer.matchAll(/cmd === "([^"]+)"/g)) reachable.add(match[1]);
      const missingHandler = [...listed].filter((name) => !reachable.has(name));
      if (missingHandler.length) throw new Error(`안내됐지만 dispatcher가 없는 명령: ${missingHandler.join(", ")}`);
      // 반대 방향도 확인한다. 표만 대조하면 switch 에 남은 명령이 안내에서 빠져도 통과한다.
      // expect·diff·a11y·locate·shotsizes 가 그렇게 빠질 수 있어 적대 검사로 함께 확인한다.
      // 동작하는 명령이 안내에 없으면 사용자는 그런 명령이 없다는 응답을 받는다.
      const switchOnly = [...reachable].filter((name) => !listed.has(name)
        && !/^(tabs|newtab|target|untarget|ask|picks|app-picks)$/.test(name));
      const inSwitch = switchOnly.filter((name) => new RegExp(`case "${name}"`).test(switchBody));
      if (inSwitch.length) throw new Error(`돌아가는데 안내에 없는 명령: ${inSwitch.join(", ")}`);

      const assembly = sliceBetween(cdpF, "const commandHandlers", "// Input.insertText", "CDP handler 조립");
      if (!/\.\.\.createPageCommands/.test(assembly) || !/\.\.\.createInputCommands/.test(assembly)
        || !/\.\.\.createInspectCommands/.test(assembly)
        || !/\.\.\.createCaptureCommands/.test(assembly)
        || !/\.\.\.createNativeCommands/.test(assembly)
        || !/run: runCdpCmd/.test(assembly) || !/const handler = commandHandlers\[cmd\]/.test(cdpF)) {
        throw new Error("handler 표 조립이나 재귀 dispatcher 배선이 빠졌다");
      }
      // 표가 Object.prototype 을 상속하면 `toString`·`valueOf`·`constructor` 가 명령으로 잡혀
      // 안내 대신 잘못된 값이 반환된다. 소스 형태가 아니라 실제 표에서 확인한다.
      const table = Object.assign(Object.create(null), handlers);
      for (const name of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
        if (table[name] !== undefined) throw new Error(`상속 이름이 명령으로 잡힌다: ${name}`);
      }
      if (!/Object\.assign\(Object\.create\(null\)/.test(assembly)) {
        throw new Error("표를 상속 없는 객체 위에 세우지 않았다");
      }
      return true;
    });
    check("UI와 실행기가 같은 포트를 본다", () =>
      /const APP_PORT = acPort\(\);/.test(mainF)
      && /port: acPort\(\)/.test(cdpF)
      && /env\.cjs/.test(mainF) && /env\.cjs/.test(cdpF)
      && /new WebSocket\("ws:\/\/127\.0\.0\.1:" \+ port\)/.test(cdpTransportSource));
    check("실행기 포트가 어디에도 박혀 있지 않다", () =>
      !/ws:\/\/127\.0\.0\.1:4271/.test(cdpTransportSource) && !/"http:\/\/127\.0\.0\.1:4271"/.test(mainF));
    check("다른 앱이 실행기 자리를 조용히 가져가지 못한다", () =>
      /cdp-executor-refused/.test(browserRuntime)
      && /cdpExecutor\.pid !== Number\(msg\.pid\)/.test(browserRuntime));
    check("같은 프로세스의 재접속은 막지 않는다", () =>
      // 막으려는 것은 다른 앱 둘의 경합이지 재접속이 아니다. 재접속까지 막으면 앱이 실행
      // 중인데도 아무 동작도 하지 못하는 상태가 된다.
      /막으려는 것은 서로 다른 앱이 한 자리를 두고 경합하는 경우이지 재접속이 아니다/.test(browserRuntime));
    check("거절당한 쪽이 조용히 물러나지 않는다", () =>
      /실행기 자리를 얻지 못했습니다/.test(cdpTransportSource) && /자기 포트로 도세요/.test(cdpTransportSource));
  }
}
