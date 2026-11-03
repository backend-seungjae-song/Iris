// screenshot 의 dpr 은 결과 배율. 레티나(기기 배율 2)에서 dpr 2 를 clip.scale 에 그대로 넣어 같은 화면이 2×2 로 반복되던 사례
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createCaptureCommands } = require("../native/electron/cdp-cmd-capture.cjs");

function harness(t, ratio) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "capture-dpr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shots = [];
  const commands = createCaptureCommands({
    withLayout: async (_send, fn) => fn(), rectOf: async () => null, readZoom: async () => ({ on: false }), setZoom: async () => {},
    DRAW_MARKS: "() => 0", viewportClip: async () => ({ x: 0, y: 0, width: 1724, height: 886, ratio }), waitRenderIdle: async () => {},
    captureHold: null, stitchFullPage: async () => { throw Error("no"); }, screencastShot: async () => { throw Error("no"); },
    resetCdpSession: () => {}, pruneShots: () => {}, diffPng: async () => ({}), samePng: () => false, deviceEmulation: {}, cdpExecRaw: null,
    webContentsMod: null, fs, path, shotsDir: dir,
  });
  const send = async (method, params) => {
    if (method === "Page.captureScreenshot") { shots.push(params); return { data: Buffer.from("png").toString("base64") }; }
    if (method === "Runtime.evaluate") return { result: { value: { x: 10, y: 20, width: 100, height: 50, scale: 1 } } };
    return {};
  };
  const wc = { id: 1, getURL: () => "https://example.com/", getTitle: () => "예시" };
  return { shot: args => commands.screenshot(send, wc, args), shots };
}

test("기기 배율보다 높은 배율을 요청하지 않고, 요청한 dpr 이 기기 배율보다 크면 실제 배율과 함께 알린다", async t => {
  // dpr 3(clip.scale 1.5)도 아래쪽이 같은 화면의 반복으로 채워짐. 합성 화면은 기기 배율까지만 그려져 있음
  const retina = harness(t, 2);
  const two = await retina.shot({ dpr: 2 });
  assert.equal(retina.shots.at(-1).clip, undefined, "레티나에서 dpr 2 는 기본 촬영");
  assert.equal(two.dpr, 2);
  assert.equal(two.requestedDpr, undefined);
  const three = await retina.shot({ dpr: 3 });
  assert.equal(retina.shots.at(-1).clip, undefined, "기기 배율보다 올리지 않음");
  assert.equal(three.dpr, 2);
  assert.equal(three.requestedDpr, 3);
  assert.match(three.dprNote, /기기 배율 2까지만/);
  await retina.shot({ dpr: 2, element: "#total" });
  assert.equal(retina.shots.at(-1).clip.scale, 1, "요소 촬영도 기기 배율 위에 곱하지 않음");
  const plain = harness(t, 1);
  const one = await plain.shot({ dpr: 2 });
  assert.equal(plain.shots.at(-1).clip, undefined);
  assert.equal(one.dpr, 1);
  assert.equal(one.requestedDpr, 2);
});
