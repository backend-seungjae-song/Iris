import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const dir = new URL("../native/electron/", import.meta.url);

// Electron 43 의 webContents.debugger 는 붙은 채 수거되면 Chromium 에 끊긴 연결이 남아 앱 본체가 죽음
// (2026-10-29 15:33 크래시, DevToolsSession::DispatchProtocolResponseOrNotification)

test("붙어 있는 동안 참조를 유지하고 detach 때 놓음", () => {
  const { pinWhileAttached, pinnedCount } = require("../native/electron/debugger-pin.cjs");
  const before = pinnedCount();
  const dbg = new EventEmitter();
  pinWhileAttached(dbg);
  pinWhileAttached(dbg);
  assert.equal(pinnedCount(), before + 1, "같은 디버거는 한 번만");
  dbg.emit("detach", {}, "target closed");
  assert.equal(pinnedCount(), before);
  pinWhileAttached(dbg);
  assert.equal(pinnedCount(), before + 1, "다시 붙이면 다시 유지");
  dbg.emit("detach", {}, "target closed");
  assert.equal(pinnedCount(), before);
  assert.doesNotThrow(() => pinWhileAttached(null));
});

test("디버거를 붙이는 모든 곳이 붙인 직후 참조를 유지함", () => {
  const sites = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".cjs"))) {
    const src = readFileSync(new URL(name, dir), "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/\.attach\("1\.3"\)/.test(line)) return;
      const near = lines.slice(i, i + 3).join("\n");
      sites.push({ name, line: i + 1, ok: /pinWhileAttached\(/.test(near) });
    });
  }
  assert.ok(sites.length >= 3, `붙이는 곳 ${sites.length}곳`);
  assert.deepEqual(sites.filter((s) => !s.ok).map((s) => `${s.name}:${s.line}`), []);
});
