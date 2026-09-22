// 소유 범위: cdp-cmd-capture·cdp-capture-tools·cdp-observation·cdp-result-safety·cdp-overlay·cdp-hints.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. cdp-control.mjs 를 하위 기능으로 분리한 파일이므로,
//   본문은 원본과 바이트 단위로 같아야 한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs bin/smoke/sections/cdp-capture.mjs
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
  console.log("[CDP 증거 — 찍기·관측·가리기·덧그리기]");
  {
    await checkAsync("CDP capture shotsizes는 유효 크기마다 찍고 마지막에 원복한다", async () => {
      const { createCaptureCommands } = require_("../native/electron/cdp-cmd-capture.cjs");
      const wcModule = { marker: "capture-web-contents" };
      const applied = [], captures = [];
      const commands = createCaptureCommands({
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
        deviceEmulation: { apply: async (_wc, args) => { applied.push(args); return { ok: true }; } },
        cdpExecRaw: async (mod, wcId, cmd, args) => {
          captures.push({ mod, wcId, cmd, args });
          return { path: `/tmp/capture-${captures.length}.png` };
        },
        webContentsMod: () => wcModule,
        fs: {}, path, IRIS_HOME: "/tmp/iris-smoke",
      });
      const result = await commands.shotsizes(async () => ({}), { id: 58 }, {
        sizes: ["mobile", "모르는값", "1024x768"], settle: 1,
      });
      if (captures.length !== 2 || captures.some((call) => call.mod !== wcModule || call.wcId !== 58 || call.cmd !== "screenshot")) {
        throw new Error(`유효 크기마다 한 번씩 WeakMap 중첩 촬영하지 않는다(${captures.length}회)`);
      }
      if (applied.length !== 3 || applied[0]?.width !== 390 || applied[1]?.width !== 1024
        || applied[2]?.clear !== true || Object.keys(applied[2]).length !== 1) {
        throw new Error(`크기 순회 끝에 { clear: true }로 원복하지 않는다(${JSON.stringify(applied)})`);
      }
      const unknown = result?.shots?.find((shot) => shot.size === "모르는값");
      if (!unknown || unknown.path || unknown.error !== "모르는 크기 — 모바일·패드·데스크톱 또는 1024x768 형식") {
        throw new Error("모르는 크기를 건너뛰고 한국어 사유를 남기지 않는다");
      }
      return true;
    });
    // 긴 페이지 증거는 이 함수가 만든다. 결과가 어긋나면 장이 빠지거나, 문서 끝에서 clamp 된 위치를
    // 두 번 찍거나, 고정 헤더가 장마다 겹쳐 찍힌 그림이 그대로 전달된다.
    // 이어 붙이기는 보이지 않는 창의 canvas 가 하므로, 그 창을 주입해서 받아
    // 어느 타일이 어느 y 로 넘어가는지 확인한다.
    await checkAsync("CDP capture full-page는 끝에서 clamp 하고 고정 요소를 감췄다 되돌린다", async () => {
      const { createCdpCaptureTools } = require_("../native/electron/cdp-capture-tools.cjs");
      let currentScroll = 17, shot = 0, destroyed = 0;
      const captureAt = [], fixed = [];
      let handedTiles = null, canvasSize = null;
      class FakeOffscreenWindow {
        constructor(opts) {
          if (!opts?.webPreferences?.offscreen) throw new Error("보이는 창으로 합성한다");
          this.webContents = {
            executeJavaScript: async (script) => {
              canvasSize = /c\.width = (\d+); c\.height = (\d+)/.exec(script)?.slice(1).map(Number);
              handedTiles = JSON.parse(/for \(const t of (\[.*?\])\) \{/s.exec(script)[1]);
              return "data:image/png;base64," + Buffer.from("stitched").toString("base64");
            },
          };
        }
        async loadURL() {}
        destroy() { destroyed++; }
      }
      const tools = createCdpCaptureTools({ refRegistry: {}, fs: {}, path, nativeImage: {}, BrowserWindow: FakeOffscreenWindow });
      const send = async (method, params = {}) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssContentSize: { width: 1, height: 250 }, cssVisualViewport: { clientHeight: 120 } };
        }
        if (method === "Page.captureScreenshot") {
          captureAt.push(currentScroll);
          return { data: Buffer.from("t" + (++shot)).toString("base64") };
        }
        if (method !== "Runtime.evaluate") throw new Error(`뜻밖의 CDP 명령 ${method}`);
        const expression = String(params.expression || "");
        if (expression === "scrollY") return { result: { value: currentScroll } };
        if (expression.includes("new Promise((res)") && expression.includes("scrollTo(0,")) {
          const want = Number((/scrollTo\(0,\s*(\d+)\)/.exec(expression) || [])[1]);
          currentScroll = Math.min(want, 130); // 문서 끝에서 실제 브라우저처럼 clamp한다.
          return { result: { value: currentScroll } };
        }
        if (expression.includes("window.__acFixed = Array")) { fixed.push("hide"); return { result: { value: 1 } }; }
        if (expression.includes("window.__acFixed = null")) { fixed.push("restore"); return { result: { value: 1 } }; }
        const restore = /scrollTo\(0,\s*(\d+)\)/.exec(expression);
        if (restore) { currentScroll = Number(restore[1]); return { result: { value: currentScroll } }; }
        return { result: { value: null } };
      };
      const result = await tools.stitchFullPage(send, { dpr: 1, settle: 0 });
      // 0 → 120 → (240 을 요청했지만 문서 끝이라) 130. 끝에서 clamp 되는 경로를 실제로 실행한다.
      if (captureAt.join(",") !== "0,120,130") {
        throw new Error(`끝 clamp·겹침 갈래를 거치지 않았다(${captureAt.join(",")})`);
      }
      // 넘겨진 타일의 y 는 요청한 위치가 아니라 실제로 찍힌 위치여야 한다.
      if (!handedTiles || handedTiles.map((t) => t.y).join(",") !== "0,120,130") {
        throw new Error(`타일 자리가 실제 scroll 과 다르다(${JSON.stringify(handedTiles?.map((t) => t.y))})`);
      }
      if (handedTiles.map((t) => Buffer.from(t.d, "base64").toString()).join(",") !== "t1,t2,t3") {
        throw new Error("찍은 장과 넘긴 장이 어긋난다");
      }
      if (!canvasSize || canvasSize[0] !== 1 || canvasSize[1] !== 250) {
        throw new Error(`합성 화폭이 문서 크기가 아니다(${JSON.stringify(canvasSize)})`);
      }
      if (result.info?.tiles !== 3) throw new Error(`타일 수를 ${result.info?.tiles} 로 보고한다`);
      if (destroyed !== 1) throw new Error(`보이지 않는 창을 ${destroyed}번 닫는다 — 한 번이어야 한다`);
      if (currentScroll !== 17 || fixed.join(",") !== "hide,restore") {
        throw new Error(`고정 요소·원래 scroll을 복원하지 않는다(scroll=${currentScroll}, fixed=${fixed.join(",")})`);
      }
      if (!Buffer.isBuffer(result.png) || result.png.toString() !== "stitched") throw new Error("합친 PNG를 반환하지 않는다");
      return true;
    });
    await checkAsync("CDP capture pruneShots는 60장 상한을 넘은 PNG만 지운다", async () => {
      const { createCdpCaptureTools } = require_("../native/electron/cdp-capture-tools.cjs");
      const current = 900_000_000;
      const names = Array.from({ length: 62 }, (_, index) => `shot-${String(index).padStart(2, "0")}.png`);
      const removed = [];
      let scans = 0;
      const fsProbe = {
        readdirSync: () => { scans++; return [...names, "keep.txt"]; },
        statSync: (file) => ({ mtimeMs: current - Number((/shot-(\d+)/.exec(file) || [])[1]) }),
        unlinkSync: (file) => removed.push(path.basename(file)),
      };
      const tools = createCdpCaptureTools({ refRegistry: {}, fs: fsProbe, path, nativeImage: {}, now: () => current });
      tools.pruneShots("/shots");
      tools.pruneShots("/shots"); // 1분 안 재호출은 디렉터리를 다시 훑지 않는다.
      if (scans !== 1) throw new Error(`정리 throttle이 디렉터리를 ${scans}번 훑는다`);
      if (removed.join(",") !== "shot-60.png,shot-61.png") {
        throw new Error(`상한 안쪽까지 지우거나 넘은 것을 남긴다(${removed.join(",")})`);
      }
      return true;
    });
    await checkAsync("CDP capture diffPng는 threshold 아래·같음·초과 pixel을 가른다", async () => {
      const { createCdpCaptureTools } = require_("../native/electron/cdp-capture-tools.cjs");
      const a = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
      const b = Buffer.from([7, 8, 8, 255, 8, 8, 8, 255, 9, 8, 8, 255]); // RGB 합 차이 23, 24, 25
      const written = [];
      let diffBitmap = null;
      const image = (bitmap) => ({ getSize: () => ({ width: 3, height: 1 }), toBitmap: () => bitmap });
      const nativeImageProbe = {
        createFromPath: (file) => image(file === "a.png" ? a : b),
        createFromBitmap: (bitmap, size) => { diffBitmap = { bitmap: Buffer.from(bitmap), size }; return { toPNG: () => Buffer.from("diff") }; },
      };
      const fsProbe = { mkdirSync() {}, writeFileSync: (file, data) => written.push([file, data.toString()]) };
      const tools = createCdpCaptureTools({ refRegistry: {}, fs: fsProbe, path, nativeImage: nativeImageProbe });
      const result = tools.diffPng("a.png", "b.png", "/shots/diff.png", 24);
      if (result.changed !== 1 || result.total !== 3 || result.ratio !== 33.33 || result.note !== undefined) {
        throw new Error(`threshold 판정·반환 형태가 다르다(${JSON.stringify(result)})`);
      }
      if (!diffBitmap || diffBitmap.size.width !== 3 || diffBitmap.bitmap[4 + 2] === 255
        || diffBitmap.bitmap[8] !== 60 || diffBitmap.bitmap[8 + 1] !== 59 || diffBitmap.bitmap[8 + 2] !== 255) {
        throw new Error("threshold와 같은 pixel을 빨갛게 칠하거나 초과 pixel을 표시하지 않는다");
      }
      if (written.length !== 1 || written[0][0] !== "/shots/diff.png" || written[0][1] !== "diff") {
        throw new Error("diff PNG를 요청한 경로에 한 번 쓰지 않는다");
      }
      return true;
    });
    // 저장된 로그인은 허용 목록에 오른 (사이트, 아이디) 에만 채우고, 그 판정은 주입받은
    // 제공자가 한다. login 이 제공자를 거치지 않으면 허용 목록이 적용되지 않는다.
    // 채운 비밀번호는 결과에 담기지 않고 가림막에만 보관해야 한다.
    // 조립부를 빈 제공자로 바꿔도 실패하는 검사가 없어서 이 검사를 추가했다.
    check("CDP observation 로그 버퍼는 상한을 넘으면 앞에서 버린다", () => {
      const { createObservation } = require_("../native/electron/cdp-observation.cjs");
      const observation = createObservation({
        captureHold: async () => false, isTabShown: () => false, now: () => 1000,
        shotsDir: tmpdir(), setTimeoutFn: () => ({}),
      });
      for (let i = 0; i < 170; i++) observation.recordConsole(83001, { level: "error", text: `log-${i}` });
      const seen = observation.observe(83001, "all", 500);
      if (seen.console.length !== 150) throw new Error(`로그 버퍼가 ${seen.console.length}건 — 상한 150이 아니다`);
      if (seen.console[0].text !== "log-20" || seen.console[149].text !== "log-169") {
        throw new Error("상한을 넘은 로그를 앞에서 버리지 않는다");
      }
      observation.forget(83001);
      return true;
    });
    await checkAsync("CDP observation은 같은 지문의 알림을 탭마다 한 번만 찍는다", async () => {
      const { createObservation } = require_("../native/electron/cdp-observation.cjs");
      const calls = [], holds = [];
      const observation = createObservation({
        captureHold: async (_id, on) => { holds.push(on); return true; }, isTabShown: () => false,
        now: () => 2000, shotsDir: tmpdir(), setTimeoutFn: () => ({}),
      });
      const send = async (method, params) => { calls.push({ method, params }); return {}; };
      await observation.noteMoment(83002, send, { kind: "born", id: 1, text: "저장 123건", why: "role" });
      await observation.noteMoment(83002, send, { kind: "born", id: 2, text: "저장 456건", why: "role" });
      if (calls.filter((call) => call.method === "Page.captureScreenshot").length !== 1) {
        throw new Error("같은 지문의 알림을 두 번 찍는다");
      }
      if (holds.join(",") !== "true,false") throw new Error("순간 UI hold/unhold가 한 쌍이 아니다");
      if (observation.observe(83002, "all", 20).moments.length !== 1) throw new Error("같은 지문이 장부에 쌓인다");
      observation.forget(83002);
      return true;
    });
    // 가려진 창이 합성을 멈추는 문제는 창을 올리지 않고 가림 판정을 꺼서 해결한다
    // (background-tab.mjs 의 두 검사가 그 부분을 강제한다). 여기서는 붙잡기가 창을 건드리지 않는지만 확인한다.
    check("붙잡기는 창을 건드리지 않는다", () => {
      const body = sliceBetween(main, "setCaptureHold(async (wcId, on) => {", "\n});");
      return !/BrowserWindow\.fromWebContents\(host\)/.test(body)
        && !/moveTop|showInactive|\.restore\(\)/.test(body)
        && /host\.send\('ac-capture-hold'|host\.send\("ac-capture-hold"/.test(body);
    });
    // 못 찍었을 때 "페이지가 멈췄다"고만 알리면 정상인 페이지를 원인으로 잘못 조사하게 된다.
    check("못 찍은 이유에 최소화·숨김 창을 함께 적는다", () => {
      const src = read("native/electron/cdp-control.cjs");
      return /cmd === "screenshot" \|\| cmd === "observe"/.test(src)
        && /최소화·숨김/.test(src) && /browser_ask_user/.test(src);
    });
    await checkAsync("CDP observation은 도는 애니메이션이 없으면 한 번 보고 바로 놓는다", async () => {
      const { createObservation } = require_("../native/electron/cdp-observation.cjs");
      let calls = 0;
      const observation = createObservation({
        captureHold: async () => false, isTabShown: () => false, now: () => 3000,
        shotsDir: tmpdir(), setTimeoutFn: () => { throw new Error("정지 화면에서 기다린다"); },
      });
      await observation.settleAnimations(async (method) => {
        calls++;
        if (method !== "Runtime.evaluate") throw new Error(`뜻밖의 명령 ${method}`);
        return { result: { value: 0 } };
      });
      if (calls !== 1) throw new Error(`정지 화면을 ${calls}번 확인한다`);
      return true;
    });
    await checkAsync("CDP observation moment drain은 비우고 두 번 드러내지 않는다", async () => {
      const { createObservation } = require_("../native/electron/cdp-observation.cjs");
      const observation = createObservation({
        captureHold: async () => false, isTabShown: () => true, now: () => 4000,
        shotsDir: tmpdir(), setTimeoutFn: () => ({}),
      });
      await observation.noteMoment(83003, async () => ({}),
        { kind: "born", id: 1, text: "한 번만 보낼 알림", why: "role" });
      const first = observation.drainMoments(83003);
      if (!first || first.list.length !== 1) throw new Error("처음 drain에서 알림이 나오지 않는다");
      first.commit();
      if (observation.drainMoments(83003) !== null) throw new Error("drain한 알림이 두 번 드러난다");
      observation.forget(83003);
      return true;
    });
    check("CDP 결과 안전은 기억한 비밀번호만 중첩 결과에서 가리고 forget 뒤 보존한다", () => {
      const safety = require_("../native/electron/cdp-result-safety.cjs");
      const wcId = 81001;
      safety.forgetSecrets(wcId);
      safety.rememberSecret(wcId, "swordfish-42");
      const result = safety.redactSecrets(wcId, {
        text: "prefix swordfish-42 suffix",
        nested: ["swordfish-42", { untouched: "ordinary" }],
      });
      if (JSON.stringify(result).includes("swordfish-42")) throw new Error("중첩 결과에 기억한 비밀번호가 남는다");
      if (result.text !== "prefix •••••••• suffix" || result.nested[0] !== "••••••••") {
        throw new Error("문자열과 객체·배열을 같은 경계에서 가리지 않는다");
      }
      if (result.nested[1].untouched !== "ordinary") throw new Error("비밀번호가 아닌 값까지 지운다");

      safety.forgetSecrets(wcId);
      const afterForget = safety.redactSecrets(wcId, { text: "swordfish-42", keep: "ordinary" });
      if (afterForget.text !== "swordfish-42" || afterForget.keep !== "ordinary") {
        throw new Error("forget 뒤에도 가리거나 다른 값을 지운다");
      }
      safety.rememberSecret(wcId, "");
      safety.rememberSecret(wcId, "ab");
      if (safety.redactSecrets(wcId, "empty ab ordinary") !== "empty ab ordinary") {
        throw new Error("빈 문자열이나 3자 미만 값을 기억한다");
      }
      safety.forgetSecrets(wcId);
      return true;
    });
    await checkAsync("CDP overlay는 identifier를 교체하고 늦은 프레임에 재주입하며 off에서 전부 걷는다", async () => {
      const overlay = require_("../native/electron/cdp-overlay.cjs");
      const wcId = 82001;
      const calls = [];
      let sequence = 0;
      const send = async (method, params, sid) => {
        const call = { method, params, sid };
        calls.push(call);
        if (method === "Page.addScriptToEvaluateOnNewDocument") {
          call.result = { identifier: `script-${++sequence}` };
          return call.result;
        }
        return {};
      };
      const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
      overlay.injectAllFrames(wcId, "pick", "overlay-on", true, send, ["child-a"]);
      await settle();
      overlay.injectAllFrames(wcId, "pick", "overlay-on", true, send, ["child-a"]);
      await settle();
      const firstRemoval = calls.filter((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument");
      if (firstRemoval.length !== 1 || firstRemoval[0].params.identifier !== "script-1") {
        throw new Error("같은 세션 재주입에서 이전 identifier를 한 벌로 교체하지 않는다");
      }

      const lateStart = calls.length;
      overlay.injectActive(wcId, "late-oopif", send, false);
      await settle();
      if (!calls.some((call) => call.sid === "late-oopif" && call.method === "Runtime.evaluate")) {
        throw new Error("늦게 뜬 OOPIF 현재 문서에 overlay를 다시 심지 않는다");
      }
      if (!calls.some((call) => call.sid === "late-oopif" && call.method === "Page.addScriptToEvaluateOnNewDocument")) {
        throw new Error("늦게 뜬 OOPIF 다음 문서에 overlay를 유지하지 않는다");
      }
      const lateMethods = calls.slice(lateStart).map((call) => call.method);
      if (lateMethods.join(",") !== "Runtime.evaluate,Page.addScriptToEvaluateOnNewDocument") {
        throw new Error("늦은 child 주입 순서가 바뀐다");
      }

      const offStart = calls.length;
      overlay.injectAllFrames(wcId, "pick", "overlay-off", false, send, ["child-a", "late-oopif"]);
      await settle();
      const offRemovals = calls.slice(offStart)
        .filter((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument")
        .map((call) => call.params.identifier).sort();
      if (offRemovals.join(",") !== "script-2,script-3") {
        throw new Error("off가 현재 세션들의 identifier를 전부 제거하지 않는다");
      }
      const afterOff = calls.length;
      overlay.injectActive(wcId, "later-oopif", send, false);
      await settle();
      if (calls.length !== afterOff) throw new Error("off 뒤 늦은 프레임에 overlay가 되살아난다");

      const rootCalls = [];
      const rootSend = async (method, params, sid) => {
        rootCalls.push({ method, params, sid });
        return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "root-script" } : {};
      };
      overlay.injectAllFrames(82002, "record", "root-overlay", true, rootSend, []);
      overlay.injectActive(82002, null, rootSend, true);
      await settle();
      if (rootCalls.slice(0, 2).map((call) => call.method).join(",")
          !== "Page.addScriptToEvaluateOnNewDocument,Runtime.evaluate") {
        throw new Error("root prime 주입 순서가 바뀐다");
      }
      overlay.injectAllFrames(82002, "record", "root-off", false, rootSend, [null]);
      await settle();
      return true;
    });
    await checkAsync("CDP hints는 로그인 가능성과 사람 개입 필요를 결과에서 숨기지 않는다", async () => {
      const { loginHint, humanHint } = require_("../native/electron/cdp-hints.cjs");
      const login = await loginHint(async () => ({ result: { value: "https://login.test" } }));
      if (!login || !login.includes("https://login.test") || !login.includes("login 먼저")) {
        throw new Error("로그인 가능 힌트를 숨긴다");
      }
      const noLogin = await loginHint(async () => ({ result: { value: "" } }));
      if (noLogin !== null) throw new Error("로그인 칸이 없는데 로그인 힌트를 만든다");

      const human = await humanHint(async () => ({ result: { value: ["결제 창", "캡차"] } }));
      if (!human || !human.includes("결제 창 · 캡차") || !human.includes("browser_ask_user")) {
        throw new Error("사람 개입 힌트를 숨긴다");
      }
      const noHuman = await humanHint(async () => ({ result: { value: [] } }));
      if (noHuman !== null) throw new Error("강한 신호가 없는데 사람 개입 힌트를 만든다");
      return true;
    });

    // 소스 패턴 검사 대신 실제로 실행한다. download-state 는 Electron 에 의존하지 않는 순수 상태라
    // 실행할 수 있고, 그래야 계약 헤더가 명시한 전이가 실제로 일어나는지 확인된다.
    // 소스 패턴 검사는 동작을 확인하지 못한다. pending 을 비우는 줄을 지워도 전부 통과했다.
  }
}
