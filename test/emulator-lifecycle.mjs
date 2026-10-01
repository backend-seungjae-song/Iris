import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");

async function fixture(run, { deferVendor = false, failVendor = false } = {}) {
  let releaseVendor;
  const vendorGate = new Promise((resolve) => { releaseVendor = resolve; });
  if (!deferVendor) releaseVendor();
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end('<!doctype html><body><div id="header"><span id="header-label">기기</span></div><div id="a"></div><div id="b"></div></body>');
        return;
      }
      if (pathname === "/vendor/orca-emulator-pane.esm.js") {
        await vendorGate;
        if (failVendor) { res.writeHead(503); res.end(); return; }
      }
      if (!/^\/(?:js|vendor)\/[^.].*\.js$/.test(pathname) || pathname.includes("..")) {
        res.writeHead(404); res.end(); return;
      }
      const source = await readFile(new URL(`../web${pathname}`, import.meta.url));
      res.setHeader("Content-Type", "text/javascript");
      res.end(source);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ ...headlessLaunchOptions(), args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      window.mount = (await import("/js/emulator/pane.js")).mountEmulatorPane;
      window.calls = [];
      window.pendingAttach = new Map();
      window.sessions = new Map();
      window.settingsCalls = 0;
      window.deviceRows = [
        { id: "device-a", name: "iPhone A", state: "shutdown", detail: "iOS 18" },
        { id: "device-b", name: "iPhone B", state: "shutdown", detail: "iOS 18" },
      ];
      window.autoAttachListeners = new Set();
      window.sessionStoppedListeners = new Set();
      window.emitAutoAttach = (detail) => Promise.all([...autoAttachListeners].map((listener) => listener(detail)));
      window.emitSessionStopped = (detail) => [...sessionStoppedListeners].forEach((listener) => listener(detail));
      window.host = {
        async getSettings() { settingsCalls++; return { ok: true, settings: {} }; },
        onAutoAttach(listener) { autoAttachListeners.add(listener); return () => autoAttachListeners.delete(listener); },
        onSessionStopped(listener) { sessionStoppedListeners.add(listener); return () => sessionStoppedListeners.delete(listener); },
        async rpc(method, params) {
          calls.push({ method, params });
          if (method === "emulator.listDevices") return { ok: true, result: deviceRows };
          if (method === "emulator.attach") return new Promise((resolve) => pendingAttach.set(params.worktree, (info = { deviceUdid: params.device }) => {
            sessions.set(params.worktree, info.deviceUdid);
            resolve({ ok: true, result: { attached: true, info } });
          }));
          if (method === "emulator.shutdown") {
            const deviceUdid = sessions.get(params.worktree) || params.device;
            sessions.delete(params.worktree);
            return { ok: true, result: { deviceUdid } };
          }
          return { ok: true, result: {} };
        },
      };
      window.make = (element, workspaceId, deviceId, extra = {}) => mount(element, { host, workspaceId, deviceId, ...extra });
      window.settleVendor = async () => {
        try { await import("/vendor/orca-emulator-pane.esm.js"); } catch {}
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
    });
    await run(page, releaseVendor);
    assert.deepEqual(errors, [], "브라우저에서 예외가 발생하지 않는다");
  } finally {
    releaseVendor();
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function connectPair(page) {
  await page.evaluate(() => {
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "device-a");
    window.paneB = make(document.querySelector("#b"), "space:tab-b", "device-b");
    paneA.connect(); paneB.connect();
  });
  await page.waitForFunction(() => pendingAttach.size === 2);
}

test("attach 도중 화면을 옮겨도 세션을 종료하거나 새 화면을 지우지 않는다", async () => fixture(async (page) => {
  await connectPair(page);
  await page.evaluate(() => {
    paneA.dispose();
    const replacement = document.createElement("p");
    replacement.id = "replacement";
    document.querySelector("#a").append(replacement);
    pendingAttach.get("space:tab-a")();
    pendingAttach.get("space:tab-b")();
  });
  await page.waitForFunction(() => paneB.current().attached);
  const state = await page.evaluate(() => ({
    sessions: [...sessions],
    shutdowns: calls.filter((call) => call.method === "emulator.shutdown"),
    replacement: !!document.querySelector("#replacement"),
  }));
  assert.deepEqual(state.sessions, [["space:tab-a", "device-a"], ["space:tab-b", "device-b"]]);
  assert.deepEqual(state.shutdowns, []);
  assert.equal(state.replacement, true);
}));

test("닫힌 탭의 늦은 attach만 정리하고 다른 탭의 세션을 유지한다", async () => fixture(async (page) => {
  await connectPair(page);
  await page.evaluate(() => { pendingAttach.get("space:tab-b")(); paneA.close(); paneA.close(); });
  await page.waitForFunction(() => paneB.current().attached);
  assert.equal(await page.evaluate(() => calls.filter((call) => call.method === "emulator.shutdown").length), 1);
  await page.evaluate(() => pendingAttach.get("space:tab-a")());
  await page.waitForFunction(() => calls.filter((call) => call.method === "emulator.shutdown").length === 2);
  const state = await page.evaluate(() => ({
    sessions: [...sessions],
    shutdowns: calls.filter((call) => call.method === "emulator.shutdown").map((call) => call.params),
    attached: paneB.current().attached,
  }));
  assert.deepEqual(state.sessions, [["space:tab-b", "device-b"]]);
  assert.equal(state.attached, true);
  assert.deepEqual(state.shutdowns, [
    { worktree: "space:tab-a", managedOnly: true },
    { worktree: "space:tab-a", managedOnly: true },
  ]);
}));

test("번들 대기 중 dispose된 화면은 재사용한 container에 생성되지 않는다", async () => fixture(async (page, releaseVendor) => {
  await page.evaluate(() => {
    const container = document.querySelector("#a");
    window.oldPane = make(container, "space:tab-a", "device-a");
    oldPane.connect(); oldPane.dispose();
    window.newPane = make(container, "space:tab-b", "device-b");
  });
  releaseVendor();
  await page.evaluate(() => settleVendor());
  await page.waitForFunction(() => settingsCalls === 1 && document.querySelector(".emu-pane"));
  assert.deepEqual(await page.evaluate(() => ({
    settingsCalls, panes: document.querySelectorAll(".emu-pane").length,
    attaches: calls.filter((call) => call.method === "emulator.attach").length,
    shutdowns: calls.filter((call) => call.method === "emulator.shutdown").length,
  })), { settingsCalls: 1, panes: 1, attaches: 0, shutdowns: 0 });
}, { deferVendor: true }));

test("별도 창의 고정 기기는 이름·런타임·연결 상태를 보여 주고 선택기는 숨긴다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "device-a", { fixedDevice: true });
  });
  await page.waitForFunction(() => !paneA.current().initializing);
  assert.deepEqual(await page.evaluate(() => ({
    name: document.querySelector("#a .emu-tb-device-name").textContent,
    runtime: document.querySelector("#a .emu-tb-rt").textContent,
    status: document.querySelector("#a .emu-tb-status").textContent,
    selector: !!document.querySelector("#a .emu-tb-dd"),
  })), { name: "iPhone A", runtime: "iOS 18", status: "연결 안 됨", selector: false });
}));

test("다른 기기 종료는 무시하고 해당 세션 종료는 화면을 유지하며 연결을 해제한다", async () => fixture(async (page) => {
  await connectPair(page);
  await page.evaluate(() => { pendingAttach.get("space:tab-a")(); pendingAttach.get("space:tab-b")(); });
  await page.waitForFunction(() => paneA.current().attached && !paneA.current().loading && paneB.current().attached);
  await page.evaluate(() => emitSessionStopped({ worktree: "space:else", device: "device-c" }));
  assert.deepEqual(await page.evaluate(() => [paneA.current().attached, paneB.current().attached]), [true, true]);
  await page.evaluate(() => {
    const pending = emitAutoAttach({ worktreeId: "space:tab-a", info: { deviceUdid: "device-a", streamUrl: "scrcpy://device-a" } });
    emitSessionStopped({ worktree: "space:tab-a", device: "device-a" });
    return pending;
  });
  assert.deepEqual(await page.evaluate(() => [paneA.current().attached, paneB.current().attached]), [false, true]);
  assert.equal(await page.evaluate(() => !!document.querySelector("#a .emu-pane")), true);
  assert.equal(await page.evaluate(() => calls.filter((call) => call.method === "emulator.attach").length), 2);
  await page.evaluate(() => paneA.dispose());
  assert.equal(await page.evaluate(() => sessionStoppedListeners.size), 1);
}));

test("번들 대기 중 close는 해당 세션을 즉시 정리하고 화면을 만들지 않는다", async () => fixture(async (page, releaseVendor) => {
  await page.evaluate(() => {
    const container = document.querySelector("#a");
    const pane = make(container, "space:tab-a", "device-a");
    pane.close(); pane.close();
    container.textContent = "새 화면";
  });
  assert.equal(await page.evaluate(() => calls.filter((call) => call.method === "emulator.shutdown").length), 1);
  releaseVendor();
  await page.evaluate(() => settleVendor());
  assert.deepEqual(await page.evaluate(() => ({
    settingsCalls, text: document.querySelector("#a").textContent,
    shutdowns: calls.filter((call) => call.method === "emulator.shutdown").map((call) => call.params),
  })), { settingsCalls: 0, text: "새 화면", shutdowns: [{ worktree: "space:tab-a", managedOnly: true }] });
}, { deferVendor: true }));

test("dispose 뒤 번들 로딩 실패가 새 화면에 오류를 쓰지 않는다", async () => fixture(async (page, releaseVendor) => {
  await page.evaluate(() => {
    const container = document.querySelector("#a");
    const pane = make(container, "space:tab-a", "device-a");
    pane.dispose(); container.textContent = "새 화면";
  });
  releaseVendor();
  await page.evaluate(() => settleVendor());
  assert.equal(await page.evaluate(() => document.querySelector("#a").textContent), "새 화면");
}, { deferVendor: true, failVendor: true }));

test("외부 도구 막대와 고정 기기를 지원하고 stop은 화면을 유지한다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "device-a", {
      headerHost: document.querySelector("#header"), fixedDevice: true,
    });
    window.paneB = make(document.querySelector("#b"), "space:tab-b", "device-b");
    paneA.connect();
  });
  await page.waitForFunction(() => pendingAttach.has("space:tab-a") && document.querySelector("#b .emu-tb-dd"));
  await page.evaluate(() => pendingAttach.get("space:tab-a")());
  await page.waitForFunction(() => paneA.current().attached && !paneA.current().loading);
  assert.deepEqual(await page.evaluate(() => ({
    external: !!document.querySelector("#header .emu-toolbar"),
    internal: !!document.querySelector("#a .emu-toolbar"),
    redundant: !!document.querySelector("#header .emu-tb-dd, #header .emu-tb-rt, #header .emu-tb-status"),
  })), { external: true, internal: false, redundant: false });
  await page.evaluate(() => paneA.stop());
  assert.deepEqual(await page.evaluate(() => ({
    attached: paneA.current().attached,
    pane: !!document.querySelector("#a .emu-pane"),
    toolbar: !!document.querySelector("#header .emu-toolbar"),
    last: calls.filter((call) => call.method === "emulator.shutdown").at(-1).params,
  })), { attached: false, pane: true, toolbar: true, last: { device: "device-a", worktree: "space:tab-a" } });
  await page.evaluate(() => paneA.dispose());
  assert.deepEqual(await page.evaluate(() => ({
    toolbar: !!document.querySelector("#header .emu-toolbar"),
    label: !!document.querySelector("#header-label"),
    other: !!document.querySelector("#b .emu-tb-dd"),
  })), { toolbar: false, label: true, other: true });
}));

test("초기 설정·기기 목록·자동 attach가 끝날 때까지 loading을 유지한다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    host.getSettings = () => new Promise((resolve) => {
      window.releaseSettings = () => resolve({ ok: true, settings: {} });
    });
    const rpc = host.rpc;
    host.rpc = (method, params) => method === "emulator.listDevices"
      ? new Promise((resolve) => { window.releaseList = () => resolve({ ok: true, result: deviceRows }); })
      : rpc(method, params);
    deviceRows[0].state = "booted";
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "device-a", { fixedDevice: true });
  });
  await page.waitForFunction(() => window.releaseSettings);
  assert.deepEqual(await page.evaluate(() => [paneA.current().initializing, paneA.current().loading]), [true, true]);
  await page.evaluate(() => releaseSettings());
  await page.waitForFunction(() => window.releaseList);
  assert.equal(await page.evaluate(() => paneA.current().loading), true);
  await page.evaluate(() => releaseList());
  await page.waitForFunction(() => pendingAttach.has("space:tab-a"));
  assert.equal(await page.evaluate(() => paneA.current().loading), true);
  await page.evaluate(() => pendingAttach.get("space:tab-a")());
  await page.waitForFunction(() => !paneA.current().loading);
  assert.deepEqual(await page.evaluate(() => [paneA.current().initializing, paneA.current().attached]), [false, true]);
}));

test("고정 기기는 다른 autoAttach를 거절하고 목록에 없어도 지정한 기기만 요청한다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    deviceRows = [deviceRows[1]];
    deviceRows[0].state = "booted";
    window.changedDevices = [];
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "device-a", {
      fixedDevice: true, onDeviceChange: (id) => changedDevices.push(id),
    });
  });
  await page.waitForFunction(() => !paneA.current().initializing);
  await page.evaluate(() => emitAutoAttach({ worktreeId: "space:tab-a", info: {
    deviceUdid: "device-b", streamUrl: "scrcpy://device-b",
  } }));
  assert.deepEqual(await page.evaluate(() => ({ changedDevices, attached: paneA.current().attached,
    attaches: calls.filter((call) => call.method === "emulator.attach") })), { changedDevices: [], attached: false, attaches: [] });
  await page.evaluate(() => { void paneA.connect(); });
  await page.waitForFunction(() => pendingAttach.has("space:tab-a"));
  assert.equal(await page.evaluate(() => calls.find((call) => call.method === "emulator.attach").params.device), "device-a");
  await page.evaluate(() => pendingAttach.get("space:tab-a")());
  await page.waitForFunction(() => paneA.current().attached);
  assert.equal(await page.evaluate(() => paneA.current().udid), "device-a");
}));

test("Android AVD는 확인된 같은 기기의 serial로만 변경한다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    deviceRows = [{ id: "Pixel_A", name: "Pixel_A", state: "shutdown", detail: "Android" }];
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "Pixel_A", { fixedDevice: true });
  });
  await page.waitForFunction(() => !paneA.current().initializing);
  await page.evaluate(() => {
    deviceRows = [{ id: "emulator-5554", name: "Pixel_B", state: "booted", detail: "Android" }];
    return emitAutoAttach({ worktreeId: "space:tab-a", info: {
      deviceUdid: "emulator-5554", backend: "android", streamUrl: "scrcpy://emulator-5554",
    } });
  });
  assert.equal(await page.evaluate(() => paneA.current().attached), false);
  await page.evaluate(() => {
    deviceRows.push({ id: "Pixel_A", name: "Pixel_A", state: "shutdown", detail: "Android" });
    paneA.connect();
  });
  await page.waitForFunction(() => pendingAttach.has("space:tab-a"));
  await page.evaluate(() => {
    deviceRows.push({ id: "emulator-5556", name: "Pixel_A", state: "booted", detail: "Android" });
    pendingAttach.get("space:tab-a")({ deviceUdid: "emulator-5556", backend: "android" });
  });
  await page.waitForFunction(() => paneA.current().attached);
  assert.equal(await page.evaluate(() => paneA.current().udid), "emulator-5556");
  await page.evaluate(() => emitAutoAttach({ worktreeId: "space:tab-a", info: {
    deviceUdid: "emulator-5554", backend: "android", streamUrl: "scrcpy://emulator-5554",
  } }));
  assert.equal(await page.evaluate(() => paneA.current().udid), "emulator-5556");
}));

test("attach 중 stop은 완료를 기다려 해당 기기만 종료하고 결과를 반환한다", async () => fixture(async (page) => {
  await connectPair(page);
  await page.evaluate(() => {
    window.stopResult = null;
    window.stopPromise = paneA.stop().then((result) => { stopResult = result; });
    pendingAttach.get("space:tab-b")();
  });
  await page.waitForFunction(() => paneB.current().attached);
  assert.equal(await page.evaluate(() => stopResult), null);
  assert.equal(await page.evaluate(() => calls.filter((call) => call.method === "emulator.shutdown").length), 0);
  await page.evaluate(async () => { pendingAttach.get("space:tab-a")(); await stopPromise; });
  assert.deepEqual(await page.evaluate(() => ({
    stopResult, sessions: [...sessions], pane: !!document.querySelector("#a .emu-pane"),
    shutdowns: calls.filter((call) => call.method === "emulator.shutdown").map((call) => call.params),
  })), { stopResult: { ok: true, deviceUdid: "device-a" }, sessions: [["space:tab-b", "device-b"]], pane: true,
    shutdowns: [{ device: "device-a", worktree: "space:tab-a" }] });
}));

test("AVD autoAttach는 기기 목록에서 이름이 같은 serial을 확인한 뒤 적용한다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    deviceRows = [{ id: "Pixel_A", name: "Pixel_A", state: "shutdown", detail: "Android" }];
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "Pixel_A", { fixedDevice: true });
  });
  await page.waitForFunction(() => !paneA.current().initializing);
  await page.evaluate(() => {
    deviceRows = [{ id: "emulator-5554", name: "Pixel_B", state: "booted", detail: "Android" }];
    return emitAutoAttach({ worktreeId: "space:tab-a", info: {
      deviceUdid: "emulator-5554", backend: "android", streamUrl: "scrcpy://emulator-5554",
    } });
  });
  assert.equal(await page.evaluate(() => paneA.current().attached), false);
  await page.evaluate(() => {
    deviceRows.push({ id: "emulator-5556", name: "Pixel_A", state: "booted", detail: "Android" });
    return emitAutoAttach({ worktreeId: "space:tab-a", info: {
      deviceUdid: "emulator-5556", backend: "android", streamUrl: "scrcpy://emulator-5556",
    } });
  });
  assert.equal(await page.evaluate(() => paneA.current().udid), "emulator-5556");
}));

test("stop 실패는 성공으로 보고하지 않고 현재 연결과 오류를 보존한다", async () => fixture(async (page) => {
  await connectPair(page);
  await page.evaluate(() => { pendingAttach.get("space:tab-a")(); pendingAttach.get("space:tab-b")(); });
  await page.waitForFunction(() => paneA.current().attached && !paneA.current().loading);
  const result = await page.evaluate(async () => {
    const rpc = host.rpc;
    host.rpc = (method, params) => method === "emulator.shutdown"
      ? Promise.resolve({ ok: false, error: { message: "종료 실패" } }) : rpc(method, params);
    return paneA.stop();
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /종료 실패/);
  assert.equal(await page.evaluate(() => paneA.current().attached), true);
  assert.match(await page.evaluate(() => paneA.current().error), /종료 실패/);
}));

test("번들 대기 중 stop의 Promise는 실제 종료 결과까지 기다린다", async () => fixture(async (page, releaseVendor) => {
  await page.evaluate(() => {
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "device-a", { fixedDevice: true });
    paneA.connect();
    window.stopResult = null;
    window.stopPromise = paneA.stop().then((result) => { stopResult = result; });
  });
  assert.equal(await page.evaluate(() => stopResult), null);
  releaseVendor();
  await page.evaluate(() => stopPromise);
  assert.deepEqual(await page.evaluate(() => stopResult), { ok: true, deviceUdid: "device-a" });
  assert.equal(await page.evaluate(() => calls.some((call) => call.method === "emulator.attach")), false);
}, { deferVendor: true }));

test("connect Promise는 backend가 없는 재사용 AVD 세션을 확인하고 attach 완료까지 기다린다", async () => fixture(async (page, releaseVendor) => {
  await page.evaluate(() => {
    deviceRows = [{ id: "emulator-5554", name: "Pixel_A", state: "booted", detail: "Android" }];
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "Pixel_A", { fixedDevice: true });
    window.connectResult = null;
    window.connectPromise = paneA.connect().then((result) => { connectResult = result; });
  });
  assert.equal(await page.evaluate(() => connectResult), null);
  releaseVendor();
  await page.waitForFunction(() => pendingAttach.has("space:tab-a"));
  assert.equal(await page.evaluate(() => connectResult), null);
  await page.evaluate(async () => {
    pendingAttach.get("space:tab-a")({ deviceUdid: "emulator-5554" });
    await connectPromise;
  });
  assert.deepEqual(await page.evaluate(() => connectResult), { ok: true, udid: "emulator-5554" });
  assert.deepEqual(await page.evaluate(() => [paneA.current().udid, paneA.current().error]), ["emulator-5554", null]);
}, { deferVendor: true }));

test("Android 기기를 껐다 켜면 이전 serial 대신 AVD 이름으로 다시 요청한다", async () => fixture(async (page) => {
  await page.evaluate(() => {
    deviceRows = [{ id: "Pixel_A", name: "Pixel_A", state: "shutdown", detail: "Android" }];
    window.paneA = make(document.querySelector("#a"), "space:tab-a", "Pixel_A", { fixedDevice: true });
    void paneA.connect();
  });
  await page.waitForFunction(() => pendingAttach.has("space:tab-a"));
  await page.evaluate(() => {
    deviceRows = [{ id: "emulator-5554", name: "Pixel_A", state: "booted", detail: "Android" }];
    pendingAttach.get("space:tab-a")({ deviceUdid: "emulator-5554" });
  });
  await page.waitForFunction(() => paneA.current().attached && !paneA.current().loading);
  await page.evaluate(async () => {
    deviceRows = [{ id: "Pixel_A", name: "Pixel_A", state: "shutdown", detail: "Android" }];
    await paneA.stop();
    pendingAttach.delete("space:tab-a");
    void paneA.connect();
  });
  await page.waitForFunction(() => pendingAttach.has("space:tab-a"));
  assert.deepEqual(await page.evaluate(() => calls.filter((call) => call.method === "emulator.attach").map((call) => call.params.device)), ["Pixel_A", "Pixel_A"]);
  await page.evaluate(() => {
    deviceRows = [{ id: "emulator-5556", name: "Pixel_A", state: "booted", detail: "Android" }];
    pendingAttach.get("space:tab-a")({ deviceUdid: "emulator-5556" });
  });
  await page.waitForFunction(() => paneA.current().attached && !paneA.current().loading);
  assert.equal(await page.evaluate(() => paneA.current().udid), "emulator-5556");
}));
