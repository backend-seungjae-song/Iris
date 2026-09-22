// 소유 범위: 전체 페이지를 이어 붙일 때 화면 배율(device pixel)을 문서 좌표(CSS pixel)로
//   되돌리는 산술. 한 장씩 내려가는 간격과 붙일 때의 크기.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: cdp-capture-tools 의 주입 계약(BrowserWindow 를 받아 쓴다), node:vm.
// 유지 조건: 계측기 자기시험을 먼저 둔다. 배율을 되돌리지 않는 옛 산술을 실제로 잡는지
//   그 자리에서 확인한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부른다.
//   현재 목록 확인: node bin/importers.mjs bin/smoke/sections/full-page-stitch.mjs
import vm from "node:vm";

import { checkAsync, require_ } from "../core.mjs";

const { createCdpCaptureTools } = require_("../native/electron/cdp-capture-tools.cjs");

// IHDR 까지만 있는 PNG 머리. 이어 붙이는 쪽은 앞 24바이트에서 크기를 읽는다.
function pngHead(w, h) {
  const b = Buffer.alloc(48);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
}

// 붙이는 창을 흉내 낸다. 실제 캔버스 대신 drawImage 가 받은 값을 모은다.
function fakeWindow(calls) {
  return class {
    constructor() {
      this.webContents = {
        executeJavaScript: async (src) => {
          const sandbox = {
            document: {
              createElement: () => ({
                width: 0, height: 0,
                getContext: () => ({ drawImage: (...a) => calls.push(a.slice(1)) }),
                toDataURL: () => "data:image/png;base64,QUJD",
              }),
            },
            Image: class {
              set src(v) {
                const head = Buffer.from(String(v).split(",")[1].slice(0, 64), "base64");
                this.naturalWidth = head.readUInt32BE(16);
                this.naturalHeight = head.readUInt32BE(20);
                if (this.onload) this.onload();
              }
            },
          };
          return vm.runInNewContext(`(async () => ${src})()`, sandbox, { timeout: 5000 });
        },
      };
    }
    loadURL() { return Promise.resolve(); }
    destroy() {}
  };
}

// 2배 화면에서 1000×2000 페이지를 찍는 회차를 흉내 낸다. 장은 2000×1000(device) 로 온다.
function fakeSend({ tileW, tileH, vw, vh, W, H }) {
  return async (method, params) => {
    if (method === "Page.getLayoutMetrics") {
      return { cssContentSize: { width: W, height: H }, cssVisualViewport: { clientWidth: vw, clientHeight: vh } };
    }
    if (method === "Page.captureScreenshot") return { data: pngHead(tileW, tileH) + "A".repeat(200) };
    if (method === "Runtime.evaluate") {
      const e = String(params.expression || "");
      const m = e.match(/scrollTo\(0,\s*(\d+)\)/);
      return { result: { value: m ? Number(m[1]) : 0 } };
    }
    return {};
  };
}

async function stitchOnce(opts) {
  const calls = [];
  const tools = createCdpCaptureTools({
    refRegistry: {}, fs: {}, path: {}, nativeImage: {}, BrowserWindow: fakeWindow(calls),
  });
  const r = await tools.stitchFullPage(fakeSend(opts), { dpr: 2, settle: 0 });
  return { calls, info: r.info };
}

export default async function run() {
  console.log("[전체 페이지 이어 붙이기 — 화면 배율을 문서 좌표로 되돌린다]");

  const scene = { tileW: 2000, tileH: 1000, vw: 1000, vh: 500, W: 1000, H: 2000 };

  await checkAsync("계측기가 배율을 안 되돌린 붙이기를 실제로 집어낸다", async () => {
    // 옛 산술: 장을 찍힌 픽셀 그대로 붙이고 간격도 장 높이 그대로 쓴다.
    const calls = [];
    const Win = fakeWindow(calls);
    const win = new Win();
    await win.webContents.executeJavaScript(`(async () => {
      const c = document.createElement("canvas"); c.width = 1000; c.height = 2000;
      const g = c.getContext("2d");
      for (const t of ${JSON.stringify([{ y: 0, d: pngHead(2000, 1000) }])}) {
        const im = new Image();
        await new Promise((res) => { im.onload = res; im.onerror = res; im.src = "data:image/png;base64," + t.d; });
        if (im.naturalWidth) g.drawImage(im, 0, t.y);
      }
      return c.toDataURL("image/png");
    })()`.replace(/^\(async \(\) => /, "").replace(/\)\(\)$/, ""));
    if (calls.length !== 1) throw new Error(`옛 산술을 못 돌렸다 — 호출 ${calls.length}회`);
    if (calls[0].length !== 2) throw new Error("옛 산술이 크기를 주고 있다 — 표본이 위반이 아니다");
    return true;
  });

  await checkAsync("장은 문서 폭에 맞춰 줄여 붙인다", async () => {
    const { calls } = await stitchOnce(scene);
    if (!calls.length) throw new Error("아무 장도 안 붙였다");
    for (const [x, y, dw, dh] of calls) {
      if (x !== 0) throw new Error(`가로 자리가 ${x}`);
      if (dw !== scene.W) throw new Error(`붙인 폭이 ${dw} — 문서 폭 ${scene.W} 가 아니다`);
      if (dh !== scene.tileH / 2) throw new Error(`붙인 높이가 ${dh} — 배율을 안 되돌렸다`);
      if (!Number.isFinite(y)) throw new Error("세로 자리를 못 읽는다");
    }
    return true;
  });

  await checkAsync("내려가는 간격도 문서 좌표다", async () => {
    const { calls } = await stitchOnce(scene);
    const ys = calls.map((c) => c[1]).sort((a, b) => a - b);
    // 1000×2000 문서를 500 CSS 높이 화면으로 훑으면 네 장이다. 배율을 안 되돌리면 두 장에서
    // 끝나고 아래 절반이 통째로 빈다.
    if (ys.length !== 4) throw new Error(`장이 ${ys.length}개 — 배율만큼 건너뛰었다`);
    if (ys.join(",") !== "0,500,1000,1500") throw new Error(`자리가 ${ys.join(",")}`);
    return true;
  });
}
