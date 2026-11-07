import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// PANE_SRC: 고치기 전 판의 emulator/pane.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ PANE_SRC: "/js/emulator/pane.js" });

// 가짜 host 로 실제 pane 을 마운트해 화면 상태를 읽는 공통 준비
const SETUP = `
  const { mountEmulatorPane } = await import("/js/emulator/pane.js");
  const settle = (ms = 40) => new Promise((ok) => setTimeout(ok, ms));
  const info = { deviceUdid: "D1", device: "D1", streamUrl: "http://127.0.0.1:1/stream.mjpeg", wsUrl: "ws://127.0.0.1:1/ws" };
  let listMode = "ok", started = 0, stopped = 0, frameCb = null, autoCb = null;
  const jpeg = await new Promise((ok) => { const c = document.createElement("canvas"); c.width = 20; c.height = 40; c.getContext("2d").fillRect(0, 0, 20, 40); c.toBlob((b) => b.arrayBuffer().then(ok), "image/jpeg"); });
  const host = {
    getSettings: async () => ({ ok: true, settings: {} }),
    rpc: async (method) => {
      if (method === "emulator.listDevices") {
        if (listMode === "fail") throw new Error("목록 실패");
        return { ok: true, result: [{ id: "D1", name: "iPhone 15", state: "booted", detail: "iOS 17", isAvailable: true }] };
      }
      if (method === "emulator.attach") return { ok: true, result: { attached: true, info } };
      return { ok: true, result: {} };
    },
    startFrameStream: async () => ({ streamId: "s" + (++started) }),
    stopFrameStream: async () => { stopped++; },
    onFrameStreamFrame: (cb) => { frameCb = cb; return () => {}; },
    onFrameStreamError: () => () => {},
    onAutoAttach: (cb) => { autoCb = cb; return () => {}; },
  };
  const root = document.createElement("div"); root.style.cssText = "width:500px;height:800px"; document.body.append(root);
  const pane = mountEmulatorPane(root, { host, workspaceId: "w1", onDeviceChange() {} });
  const sendFrame = async () => { frameCb({ streamId: "s" + started, bytes: jpeg }); await settle(); };
  await settle(300);
  await sendFrame();
  const img = () => root.querySelector("img.emu-screen-media");
  const status = () => root.querySelector(".emu-screen-status");
`;

test("같은 세션 재안내·회전·창 가림 뒤에도 마지막 화면을 지우지 않고, 목록 실패가 기기 정보를 지우지 않음", async () => {
  const r = await withWebPage((page) => page.evaluate(async (setup) => {
    const run = new (Object.getPrototypeOf(async () => {}).constructor)(setup + `
      const out = { firstImg: !!img(), startedAtFirst: started };
      const img0 = img();
      // C8: 이미 붙은 같은 기기를 다시 알림
      autoCb({ worktreeId: "w1", info: { ...info } }); await settle();
      out.reannounce = { started, sameImg: img() === img0, hasImg: !!img() };
      // C8: 회전 — 새 스트림을 열지만 첫 새 프레임 전까지 마지막 화면 유지
      const rotate = root.querySelector('button[aria-label="회전"]');
      rotate.click(); await settle(80);
      out.rotate = { started, hasImg: !!img(), statusHidden: status().hidden };
      await sendFrame();
      out.rotateFrame = { hasImg: !!img(), statusHidden: status().hidden };
      // C9: 창 가림 — 유예 뒤 스트림은 멈추되 마지막 화면은 유지, 돌아오면 다시 연결
      const stopBefore = stopped;
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange")); await settle(700);
      out.parked = { stopped: stopped - stopBefore, hasImg: !!img() };
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      const startBefore = started;
      document.dispatchEvent(new Event("visibilitychange")); await settle(80);
      out.resumed = { restarted: started - startBefore, hasImg: !!img() };
      await sendFrame();
      // C13: 기기 목록 새로고침 실패
      out.rtBefore = root.querySelector(".emu-tb-rt").textContent;
      listMode = "fail";
      root.querySelector(".emu-tb-dd button").dispatchEvent(new Event("pointerdown")); await settle(80);
      out.rtAfter = root.querySelector(".emu-tb-rt").textContent;
      out.dropdownDisabled = root.querySelector(".emu-tb-dd button").disabled;
      pane.dispose();
      return out;
    `);
    return await run();
  }, SETUP), { overrides });
  // 항목마다 따로 판정해 어긋난 것을 한 번에 모두 보여 줌
  const fails = [];
  const eq = (a, b, m) => { if (a !== b) fails.push(`${m} (실제 ${a}, 기대 ${b})`); };
  const ne = (a, b, m) => { if (a === b) fails.push(m); };
  eq(r.firstImg, true, "처음 프레임이 오면 화면이 뜸");
  eq(r.reannounce.started, r.startedAtFirst, "이미 붙은 같은 세션 재안내에는 스트림을 다시 열지 않음");
  eq(r.reannounce.sameImg, true, "재안내에 화면 요소를 유지");
  eq(r.rotate.started, r.startedAtFirst + 1, "회전은 새 스트림을 엶");
  eq(r.rotate.hasImg, true, "첫 새 프레임 전까지 마지막 화면 유지");
  eq(r.rotate.statusHidden, true, "빈 화면 안내를 띄우지 않음");
  eq(r.rotateFrame.hasImg, true);
  eq(r.parked.stopped, 1, "유예 뒤 스트림은 멈춤(자원 절약 유지)");
  eq(r.parked.hasImg, true, "멈춰도 마지막 화면은 남김");
  eq(r.resumed.restarted, 1, "돌아오면 다시 연결");
  eq(r.resumed.hasImg, true, "돌아온 직후 검은 화면 대신 마지막 화면");
  ne(r.rtBefore, "", "런타임 이름이 보임");
  eq(r.rtAfter, r.rtBefore, "목록 확인이 실패해도 런타임 이름 유지");
  eq(r.dropdownDisabled, false, "기기 드롭다운이 잠기지 않음");
  assert.deepEqual(fails, [], "어긋난 항목");
});
