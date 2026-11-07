import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// DEVICES_PANEL_SRC: 고치기 전 판의 emulator/devices-panel.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ DEVICES_PANEL_SRC: "/js/emulator/devices-panel.js" });

test("기기 패널을 다시 확인해도 아는 값·기기 줄을 유지하고, 확인이 한 번 실패해도 목록을 비우지 않음", async () => {
  const r = await withWebPage((page) => page.evaluate(async () => {
    const { mountDevicePanel } = await import("/js/emulator/devices-panel.js");
    const availability = { platform: "darwin", available: true, simctl: { ok: true }, serveSim: { ok: true },
      android: { sdkFound: false }, devices: [
        { udid: "A", name: "iPhone 13", runtime: "iOS 17", state: "Shutdown" },
        { udid: "B", name: "iPhone 15", runtime: "iOS 17", state: "Booted" }] };
    let mode = "ok", release = null;
    const host = {
      getSettings: async () => ({ ok: true, settings: { mobileEmulatorDefaultDeviceUdid: null, androidSdkPath: null } }),
      rpc: () => new Promise((res, rej) => { release = () => (mode === "ok" ? res({ ok: true, result: availability }) : rej(new Error("끊김"))); }),
    };
    const head = document.createElement("div"); document.body.append(head);
    const box = document.createElement("div"); document.body.append(box);
    const panel = mountDevicePanel(box, { host, headTools: head, onOpenDevice() {}, currentUdid: () => "B" });
    const settle = () => new Promise((ok) => setTimeout(ok, 30));
    await settle(); release(); await settle();
    const pill = () => head.querySelector(".emu-pill, [class*=pill]")?.textContent || "";
    const first = { pill: pill(), rows: box.querySelectorAll(".emu-dp-device").length };
    const rowNode = box.querySelector('.emu-dp-device[data-device="B"]');
    // 두 번째 확인: 응답을 기다리는 동안
    const p2 = panel.refresh(); await settle();
    const during = { pill: pill(), sameRow: box.querySelector('.emu-dp-device[data-device="B"]') === rowNode };
    release(); await p2; await settle();
    const after = { pill: pill(), sameRow: box.querySelector('.emu-dp-device[data-device="B"]') === rowNode };
    // 세 번째 확인이 실패
    mode = "fail";
    const p3 = panel.refresh(); await settle(); release(); await p3; await settle();
    const failed = { rows: box.querySelectorAll(".emu-dp-device").length, pill: pill(), note: box.parentElement.querySelector(".emu-dp-note")?.textContent || "", noteHidden: box.querySelector(".emu-dp-note")?.hidden };
    return { first, during, after, failed };
  }), { overrides });
  assert.equal(r.first.rows, 2);
  assert.equal(r.first.pill, "준비됨");
  assert.equal(r.during.pill, "준비됨", "다시 확인하는 동안에도 알던 상태를 유지");
  assert.equal(r.during.sameRow, true, "확인 중에 기기 줄을 다시 만들지 않음");
  assert.equal(r.after.sameRow, true, "같은 결과면 기기 줄을 다시 만들지 않음");
  assert.equal(r.failed.rows, 2, "한 번 실패해도 기기 목록을 비우지 않음");
  assert.equal(r.failed.pill, "준비됨");
  assert.equal(r.failed.noteHidden, false, "실패는 알림 칸에 알림");
});
