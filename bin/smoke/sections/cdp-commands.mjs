// 소유 범위: cdp-layout·cdp-cmd-page·cdp-cmd-inspect·cdp-cmd-native·cdp-cmd-input·cdp-upload.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·프로세스 API.
// 유지 조건: 검사 이름과 본문. cdp-control.mjs 를 하위 기능으로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/cdp-commands.mjs
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  cannotMeasure, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  browserRuntime, browserWindowManagerSource, cdpTransportSource, main, mainWindowSource,
  memoWindowManagerSource, nativeAx, pick, record, web, webview,
} from "../sources.mjs";
import { sliceBetween } from "../../slice-anchor.mjs";

const pathJoinTmp = () => path.join(tmpdir(), "iris-server-host-probe");

export default async function run() {
  console.log("[CDP 명령 — 화면 재기·이동·조회·입력·올리기]");
  {
    await checkAsync("CDP layout은 보이는 탭을 건드리지 않고 예외 뒤 임시 metrics를 걷는다", async () => {
      const { withLayout } = require_("../native/electron/cdp-layout.cjs");
      const visibleCalls = [];
      const visible = await withLayout(async (method) => {
        visibleCalls.push(method);
        return method === "Runtime.evaluate" ? { result: { value: 900 } } : {};
      }, async (applied) => applied);
      if (visible !== false) throw new Error("보이는 탭을 임시 layout으로 판정한다");
      if (visibleCalls.join(",") !== "Runtime.evaluate") throw new Error("보이는 탭의 metrics를 바꾼다");

      const hiddenCalls = [];
      let message = "";
      try {
        await withLayout(async (method) => {
          hiddenCalls.push(method);
          return method === "Runtime.evaluate" ? { result: { value: 0 } } : {};
        }, async (applied) => {
          if (!applied) throw new Error("숨은 탭에 임시 layout을 씌우지 않는다");
          throw new Error("layout-probe");
        });
      } catch (error) { message = error.message; }
      if (message !== "layout-probe") throw new Error("명령 본문의 오류를 보존하지 않는다");
      if (hiddenCalls.join(",") !== "Runtime.evaluate,Emulation.setDeviceMetricsOverride,Emulation.clearDeviceMetricsOverride") {
        throw new Error("fn 오류 뒤 임시 metrics를 되돌리지 않는다");
      }
      return true;
    });
    await checkAsync("CDP page back은 기록이 없으면 이동하지 않고 사유를 낸다", async () => {
      const { createPageCommands } = require_("../native/electron/cdp-cmd-page.cjs");
      let moved = 0;
      const sent = [];
      const commands = createPageCommands({ applyViewport: async () => ({ ok: true }) });
      const result = await commands.back(async (method, params) => { sent.push({ method, params }); return {}; }, {
        navigationHistory: { canGoBack: () => false, goBack: () => { moved++; } },
        getURL: () => "https://page.test/",
      }, {});
      if (moved !== 0) throw new Error("기록이 없는데 뒤로 이동한다");
      if (sent.length) throw new Error("기록이 없는데 CDP 명령을 보낸다");
      if (result?.ok !== false || result?.error !== "뒤로 갈 기록이 없습니다.") {
        throw new Error("기록 없음의 한국어 사유를 그대로 내지 않는다");
      }
      return true;
    });
    await checkAsync("CDP page wait은 readyState를 폴링하고 숫자는 고정 대기한다", async () => {
      const { createPageCommands } = require_("../native/electron/cdp-cmd-page.cjs");
      const commands = createPageCommands({ applyViewport: async () => ({ ok: true }) });
      const states = ["interactive", "complete"];
      const calls = [];
      const polled = await commands.wait(async (method, params) => {
        calls.push({ method, params });
        if (method !== "Runtime.evaluate" || params?.expression !== "document.readyState") {
          throw new Error("readyState 조회가 아닌 명령을 폴링한다");
        }
        return { result: { value: states.shift() } };
      }, {}, {});
      if (calls.length !== 2 || polled?.readyState !== "complete") {
        throw new Error(`readyState를 완료까지 폴링하지 않는다(${calls.length}회)`);
      }
      let fixedSent = false;
      const fixed = await commands.wait(async () => { fixedSent = true; return {}; }, {}, { ms: 0 });
      if (fixedSent) throw new Error("숫자 wait이 readyState를 조회한다");
      if (fixed?.ok !== true || fixed?.waited_ms !== 0) throw new Error("숫자 wait이 고정 대기 결과를 내지 않는다");
      return true;
    });
    // 선택자 하나가 여러 요소에 맞는 경우가 흔하다. 첫 요소만 보고 판정하면 사이드바 버튼을
    // 보면서 팝업 버튼을 확인했다고 잘못 판정한다.
    // 판정문이 만드는 페이지 쪽 식을 그대로 꺼내 가짜 DOM에서 실행해 확인한다.
    await checkAsync("판정은 맞은 요소 전부를 보고, 몇 곳이었는지 남긴다", async () => {
      const { createInspectCommands } = require_("../native/electron/cdp-cmd-inspect.cjs");
      let expr = null;
      const commands = createInspectCommands({
        buildSnapshot: async () => ({}), refRegistry: { recordSnapshot() {} },
        loginHint: async () => null, humanHint: async () => null, observation: {},
        downloadState: { snapshot: () => ({}) },
        cdpExecRaw: async () => ({ path: "/tmp/x.png" }),
        webContentsMod: () => ({}), fs: {}, path, IRIS_HOME: "/tmp/iris-smoke",
      });
      // 판정식은 맞은 요소의 라벨도 만든다. 그 코드가 참조하는 DOM 속성을 가짜 요소도 갖고 있어야
      // 이 검사가 측정하려는 것(맞은 요소 전부를 보는가)을 확인할 수 있다.
      const els = (...texts) => texts.map((t) => ({
        innerText: t, textContent: t, tagName: "DIV", value: null,
        getAttribute: () => null, labels: null,
      }));
      const runExpr = (list) => {
        const fn = new Function("__acQA", "document", `return ${expr}`);
        return JSON.parse(fn(() => list, { body: { innerText: "" }, getElementById: () => null }));
      };
      const send = async () => ({});
      send.all = async (_m, params) => { expr = params.expression; return [{ result: { value: JSON.stringify({ pass: true, found: true, got: "x", n: 1 }) } }]; };
      await commands.expect(send, { id: 1, getURL: () => "https://page.test/resale/listings" }, { sel: ".b", text: "매물 반려", mode: "contains" });
      if (!expr) cannotMeasure("판정 식을 못 꺼냈다");
      const hitLast = runExpr(els("이전 다음", "메뉴", "매물 승인 매물 반려"));
      if (hitLast.pass !== true) throw new Error("뒤쪽 요소가 맞는데 실패로 냈다 — 첫 요소만 보고 있다");
      if (hitLast.n !== 3 || hitLast.hit !== 2) throw new Error(`몇 곳 중 몇 번째인지 안 남긴다: ${JSON.stringify(hitLast)}`);
      const noneHit = runExpr(els("이전 다음", "메뉴"));
      if (noneHit.pass !== false || noneHit.n !== 2) throw new Error("아무 데도 없는데 통과로 냈다");
      // "없음"에 글자를 주면 그건 그 글자가 없다는 물음이다. 조용히 버리면 화면에 없는 글자도
      // "있다"가 되어, 없어야 할 것을 물은 판정이 통째로 뒤집힌다.
      expr = null;
      send.all = async (_m, params) => { expr = params.expression; return [{ result: { value: JSON.stringify({ pass: true, found: true, got: null, n: 1 }) } }]; };
      await commands.expect(send, { id: 1, getURL: () => "https://page.test/resale/listings" }, { sel: "dl", text: "OCR", mode: "absent" });
      const gone = runExpr(els("매물 ID 상품 판매자"));
      if (gone.pass !== true) throw new Error("그 글자가 없는데 실패로 냈다 — 글자를 안 보고 있다");
      const there = runExpr(els("OCR 결과 없음"));
      if (there.pass !== false) throw new Error("그 글자가 있는데 통과로 냈다");
      // 그 사실이 판정문에도 실려야 보고서를 읽는 사람이 되짚을 수 있다.
      send.all = async () => [{ result: { value: JSON.stringify({ pass: true, found: true, got: "매물 반려", n: 3, hit: 2 }) } }];
      const out = await commands.expect(send, { id: 1, getURL: () => "https://page.test/resale/listings" }, { sel: ".b", text: "매물 반려", mode: "contains" });
      if (!/3곳 중 3번째/.test(out.expected)) throw new Error(`판정문에 몇 곳인지가 없다: ${out.expected}`);
      // 그 줄이 무엇을 확인하는 화면인지는 판정이 정한다. 거쳐 가며 찍힌 화면은 여럿이지만
      // 판정이 일어난 화면은 하나뿐이라, 그 URL이 없으면 보고서가 무엇을 실을지 정할 수 없다.
      if (out.url !== "https://page.test/resale/listings")
        throw new Error(`판정을 내린 자리가 안 남았다: ${out.url}`);
      return true;
    });
    await checkAsync("CDP inspect expect는 실제 값으로 통과·실패를 판정한다", async () => {
      const { createInspectCommands } = require_("../native/electron/cdp-cmd-inspect.cjs");
      const wcModule = { marker: "inspect-web-contents" };
      const captures = [];
      const commands = createInspectCommands({
        buildSnapshot: async () => ({}),
        refRegistry: { recordSnapshot() {} },
        loginHint: async () => null,
        humanHint: async () => null,
        observation: {},
        downloadState: { snapshot: () => ({}) },
        cdpExecRaw: async (mod, wcId, cmd, args) => {
          captures.push({ mod, wcId, cmd, args });
          return { path: `/tmp/${captures.length}.png` };
        },
        webContentsMod: () => wcModule,
        fs: {}, path, IRIS_HOME: "/tmp/iris-smoke",
      });
      let actual = "완료";
      const send = async () => ({});
      send.all = async () => [{ result: { value: JSON.stringify({ pass: actual === "완료", found: true, got: actual }) } }];
      const wc = { id: 31, getURL: () => "https://page.test/resale/listings" };
      const passed = await commands.expect(send, wc, { sel: "#status", text: "완료", mode: "equals" });
      actual = "실제값";
      const failed = await commands.expect(send, wc, { sel: "#status", text: "완료", mode: "equals" });
      if (passed?.pass !== true || passed?.got !== "완료") throw new Error("맞는 실제 값을 통과로 내지 않는다");
      if (failed?.pass !== false || failed?.got !== "실제값" || failed?.found !== true) {
        throw new Error(`틀린 판정에 실제 값을 싣지 않는다(${JSON.stringify(failed)})`);
      }
      if (captures.length !== 2 || captures.some((call) => call.mod !== wcModule || call.wcId !== 31 || call.cmd !== "screenshot")) {
        throw new Error("expect 증거 촬영이 webContents WeakMap 접근자와 중첩 실행 경로를 타지 않는다");
      }
      return true;
    });
    await checkAsync("CDP inspect snapshot은 ref 표를 registry에 기록한다", async () => {
      const { createInspectCommands } = require_("../native/electron/cdp-cmd-inspect.cjs");
      const refMap = new Map([["e1", { backendDOMNodeId: 17 }]]);
      const recorded = [], frameCalls = [];
      const commands = createInspectCommands({
        buildSnapshot: async (_send, options) => {
          frameCalls.push(...options.frames);
          return { refMap, refs: ["e1"], snapshot: "button \"저장\" [ref=e1]", total: 1, shownCount: 1, bytes: 28 };
        },
        refRegistry: { recordSnapshot: (wcId, refs) => recorded.push({ wcId, refs }) },
        loginHint: async () => null,
        humanHint: async () => null,
        observation: {},
        downloadState: { snapshot: () => ({}) },
        cdpExecRaw: async () => ({}),
        webContentsMod: () => ({}),
        fs: {}, path, IRIS_HOME: "/tmp/iris-smoke",
      });
      const childSend = async () => ({});
      const send = async () => ({});
      send.frames = () => ["frame-1", null];
      send.on = (sid) => { if (sid !== "frame-1") throw new Error("빈 frame id를 넘긴다"); return childSend; };
      const result = await commands.snapshot(send, { id: 44, getURL: () => "https://inspect.test/", getTitle: () => "Inspect" }, {});
      if (recorded.length !== 1 || recorded[0].wcId !== 44 || recorded[0].refs !== refMap) {
        throw new Error("buildSnapshot이 만든 refMap을 같은 탭 registry에 기록하지 않는다");
      }
      if (frameCalls.length !== 1 || frameCalls[0].sid !== "frame-1" || frameCalls[0].send !== childSend) {
        throw new Error("snapshot이 자식 프레임 sender를 buildSnapshot에 넘기지 않는다");
      }
      if (result?.refCount !== 1 || result?.snapshot !== "button \"저장\" [ref=e1]") throw new Error("snapshot 결과를 보존하지 않는다");
      return true;
    });
    await checkAsync("CDP native login은 주입된 제공자만 거치고 비밀번호를 결과에 싣지 않는다", async () => {
      const { createNativeCommands } = require_("../native/electron/cdp-cmd-native.cjs");
      const calls = [], remembered = [];
      let provider = null;
      const commands = createNativeCommands({
        observation: {}, planFor: () => ({ queue: [], mode: null, text: null }), ctlSend: () => {},
        upload: { invalidPaths: () => [], arm() {} }, nodeFromArgs: async () => ({}),
        downloadState: { disarm() {}, arm() {}, snapshot: () => ({}) },
        loginProvider: () => provider,
        resultSafety: { rememberSecret: (id, secret) => remembered.push([id, secret]) },
        nativeAx: {}, fs: { mkdirSync() {} }, path, os: { homedir: () => "/tmp" },
      });
      const wc = { id: 9 };
      // 제공자가 없으면 성공을 반환하지 않고 앱 내부 오류로 드러낸다.
      const none = await commands.login(async () => ({}), wc, { username: "u" });
      if (!none || !none.error) throw new Error("제공자가 없는데 성공을 돌려준다");
      provider = async (target, opts) => { calls.push([target.id, opts.username]); return { ok: true, secret: "pw", who: "u" }; };
      const out = await commands.login(async () => ({}), wc, { username: "u" });
      if (calls.length !== 1 || calls[0][0] !== 9 || calls[0][1] !== "u") {
        throw new Error(`주입된 제공자를 거치지 않는다: ${JSON.stringify(calls)}`);
      }
      if (out.secret !== undefined) throw new Error("비밀번호가 결과에 실린다");
      if (remembered.length !== 1 || remembered[0][1] !== "pw") throw new Error("비밀번호를 가림막에 기억시키지 않는다");
      return true;
    });
    await checkAsync("CDP native dialogs는 무장·해제 상태와 사람 기본 경로를 보존한다", async () => {
      const { createNativeCommands } = require_("../native/electron/cdp-cmd-native.cjs");
      const plan = { queue: [], mode: null, text: null };
      const sent = [];
      const commands = createNativeCommands({
        observation: {},
        planFor: () => plan,
        ctlSend: (message) => sent.push(message),
        upload: { invalidPaths: () => [], arm() {} },
        nodeFromArgs: async () => ({ backendNodeId: 1, sid: null }),
        downloadState: { disarm() {}, arm() {}, snapshot: () => ({ last: null, once: false }) },
        loginProvider: () => null,
        resultSafety: { rememberSecret() {} },
        nativeAx: {},
        fs: { mkdirSync() {} }, path,
        os: { homedir: () => "/tmp" },
      });
      const wc = { id: 72 };
      const initial = await commands.dialogs(async () => ({}), wc, {});
      if (initial?.mode !== "off" || initial?.note !== "사람이 처리" || plan.mode !== null || plan.queue.length) {
        throw new Error("무장하지 않은 기본에서 사람이 보고 누르는 경로를 보존하지 않는다");
      }
      const armed = await commands.dialogs(async () => ({}), wc, { plan: "ok", text: "확인" });
      if (armed?.mode !== "ok" || plan.mode !== "ok" || plan.queue.length || plan.text !== "확인") {
        throw new Error("dialogs ok 무장이 계획 상태를 바꾸지 않는다");
      }
      const disarmed = await commands.dialogs(async () => ({}), wc, { plan: "off" });
      if (disarmed?.mode !== "off" || disarmed?.note !== "사람이 처리" || plan.mode !== null || plan.queue.length) {
        throw new Error("dialogs 해제가 계획을 비우고 사람 경로로 돌아가지 않는다");
      }
      if (sent.length !== 3 || sent[0]?.plan !== null || sent[1]?.plan?.mode !== "ok" || sent[2]?.plan !== null
        || sent.some((message) => message.wc !== 72 || message.type !== "browser-dialog-plan")) {
        throw new Error("dialogs 상태 전이를 서버 dialog plan에 같은 순서로 알리지 않는다");
      }
      return true;
    });
    await checkAsync("CDP input click은 withLayout 안에서 좌표를 얻는다", async () => {
      const { createInputCommands } = require_("../native/electron/cdp-cmd-input.cjs");
      let inLayout = false, layoutCalls = 0, boxInside = false;
      const sent = [];
      const send = async (method, params) => {
        sent.push({ method, params });
        if (method === "DOM.getBoxModel") {
          boxInside = inLayout;
          return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
        }
        return {};
      };
      send.on = () => send;
      const commands = createInputCommands({
        withLayout: async (_send, fn) => {
          layoutCalls++;
          inLayout = true;
          try { return await fn(false); } finally { inLayout = false; }
        },
        nodeFromArgs: async () => ({ backendNodeId: 41, sid: null }),
        insertTextInChunks: async () => {},
        isTabShown: () => true,
        run: async () => ({ ok: true }),
        webContentsMod: () => ({}),
      });
      const result = await commands.click(send, { id: 73 }, { ref: "e41" });
      const mouse = sent.filter((call) => call.method === "Input.dispatchMouseEvent");
      if (layoutCalls !== 1 || !boxInside || inLayout) throw new Error("click 좌표를 withLayout 경계 밖에서 얻는다");
      if (mouse.length !== 3 || result?.at?.x !== 10 || result?.at?.y !== 5 || result?.via !== "input") {
        throw new Error("click이 얻은 좌표로 사람 입력 사건 세 개를 보내지 않는다");
      }
      return true;
    });
    await checkAsync("CDP input fill은 run click을 거쳐 세 단계와 via를 보존한다", async () => {
      const { createInputCommands } = require_("../native/electron/cdp-cmd-input.cjs");
      const runScenario = async (verifications, forced) => {
        const runCalls = [], sent = [], wcModule = { marker: "fake-web-contents" };
        const send = async (method, params) => {
          sent.push({ method, params });
          if (method !== "Runtime.evaluate") return {};
          const expression = params?.expression || "";
          if (expression.includes("입력칸에 포커스가 없습니다")) return { result: { value: forced } };
          if (expression.includes("return {ok:v===")) return { result: { value: verifications.shift() } };
          return {};
        };
        send.on = () => send;
        const commands = createInputCommands({
          withLayout: async (_send, fn) => await fn(false),
          nodeFromArgs: async () => ({ backendNodeId: 52, sid: null }),
          insertTextInChunks: async () => {},
          isTabShown: () => true,
          run: async (...args) => { runCalls.push(args); return { ok: true }; },
          webContentsMod: () => wcModule,
        });
        const result = await commands.fill(send, { id: 84 }, { ref: "e52", sel: "#field", text: "iris" });
        return { result, runCalls, sent, wcModule };
      };

      const firstInput = await runScenario([{ ok: true, contenteditable: false }], null);
      const firstRich = await runScenario([{ ok: true, contenteditable: true }], null);
      const clickedInput = await runScenario([{ ok: false }, { ok: true, contenteditable: false }], null);
      const clickedRich = await runScenario([{ ok: false }, { ok: true, contenteditable: true }], null);
      const directInput = await runScenario([{ ok: false }, { ok: false }], { ok: true, contenteditable: false });
      const directRich = await runScenario([{ ok: false }, { ok: false }], { ok: true, contenteditable: true });
      const vias = [firstInput, firstRich, clickedInput, clickedRich, directInput, directRich].map((probe) => probe.result?.via);
      const expectedVias = ["입력", "리치 편집기 입력", "눌러서 입력", "눌러서 리치 편집기 입력", "값 직접 설정", "리치 편집기 직접 설정"];
      if (vias.join("|") !== expectedVias.join("|")) throw new Error(`fill via 단계가 달라졌다: ${vias.join("|")}`);
      if ([firstInput, firstRich, clickedInput, clickedRich, directInput, directRich]
        .some((probe) => !probe.sent.some((call) => call.method === "DOM.focus"))) {
        throw new Error("fill이 입력 전에 대상 요소에 CDP focus를 주지 않는다");
      }
      if (firstInput.runCalls.length || firstRich.runCalls.length) throw new Error("첫 입력 성공 뒤에도 click을 부른다");
      for (const probe of [clickedInput, clickedRich, directInput, directRich]) {
        const call = probe.runCalls[0];
        if (probe.runCalls.length !== 1 || call?.[2] !== "click" || call?.[3]?.ref !== "e52" || call?.[4] !== probe.wcModule) {
          throw new Error("첫 입력 실패 뒤 run을 통해 click을 부르지 않는다");
        }
      }
      return true;
    });
    await checkAsync("CDP upload 계획은 절대경로만 받고 한 번 소비되며 없으면 사람 차례를 알린다", async () => {
      const { createUploadController } = require_("../native/electron/cdp-upload.cjs");
      let dialogCalls = 0;
      const sent = [];
      const upload = createUploadController({
        isAbsolute: path.isAbsolute,
        existsSync: (file) => file === "/tmp/ready.txt",
        showOpenDialog: async () => { dialogCalls++; return { canceled: true, filePaths: [] }; },
        windowFromWebContents: () => null,
        recordUpload: () => {},
        clearChooser: () => {},
      });
      const invalid = upload.invalidPaths(["relative.txt", "/tmp/ready.txt"]);
      if (invalid.join(",") !== "relative.txt") throw new Error("상대경로를 업로드 대상으로 받는다");
      upload.arm(71, ["/tmp/ready.txt"], 60000);
      const first = upload.takePlan(71);
      if (first.askHuman || first.files?.[0] !== "/tmp/ready.txt") throw new Error("무장한 파일을 한 번 쓰지 못한다");
      const second = upload.takePlan(71);
      if (!second.askHuman || second.files !== null) throw new Error("소비한 계획이 사라지지 않거나 사람 차례를 숨긴다");

      upload.arm(72, ["/tmp/ready.txt"], 60000);
      await upload.serveFileChooser(async (method, params) => { sent.push({ method, params }); return {}; },
        { id: 72, hostWebContents: {} }, { backendNodeId: 9, mode: "selectSingle" });
      if (dialogCalls !== 0) throw new Error("무장한 파일이 있는데 사람 선택창을 연다");
      if (!sent.some((call) => call.method === "DOM.setFileInputFiles" && call.params.files[0] === "/tmp/ready.txt")) {
        throw new Error("무장한 파일을 DOM 입력에 넣지 않는다");
      }
      await upload.serveFileChooser(async () => ({}), { id: 72, hostWebContents: {} },
        { backendNodeId: 9, mode: "selectSingle" });
      if (dialogCalls !== 1) throw new Error("계획이 없는데 사람에게 묻지 않는다");
      return true;
    });
  }
}
