import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const guard = require("../native/electron/emulator/electron-guard.cjs");
const { registerEmulatorFrameStreamHandlers } = require("../native/electron/emulator/orca-emulator.cjs");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

// 초당 50프레임 MJPEG 서버
async function mjpegServer(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
    const timer = setInterval(() => res.write(Buffer.concat([
      Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`), JPEG, Buffer.from("\r\n")])), 20);
    req.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/stream.mjpeg`;
}

test("메인 프로세스는 포커스 없는 창에 에뮬레이터 화면을 초당 5프레임까지만 보낸다", async (t) => {
  const handlers = new Map();
  const win = { focused: false, isFocused: () => win.focused, isDestroyed: () => false };
  guard.configure({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: { fromWebContents: () => win },
    isTrustedSender: () => true,
  });
  registerEmulatorFrameStreamHandlers();
  let frames = 0;
  const owner = { isDestroyed: () => false, once() {}, removeListener() {},
    send: (channel) => { if (channel === "emulator:frameStreamFrame") frames++; } };
  const { streamId } = await handlers.get("emulator:frameStreamStart")({ sender: owner }, { streamUrl: await mjpegServer(t) });
  t.after(() => handlers.get("emulator:frameStreamStop")({ sender: owner }, { streamId }));

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const unfocused = frames;
  win.focused = true;
  frames = 0;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(unfocused >= 3 && unfocused <= 6, `포커스 없음 1초: ${unfocused}프레임`);
  assert.ok(frames >= 20, `포커스 있음 1초: ${frames}프레임`);
});
