// media IPC가 같은 origin의 다른 Iris 창과 하위 프레임까지 구분하는지 검증한다.
//
// 소유 범위
//   main webContents 객체 동일성과 mainFrame 동일성을 포함한 좁은 신뢰 판정 카드.
//
// 제공 API
//   node --test test/ipc-trust.mjs 한 명령으로 C4 media 신뢰 경계를 판정한다.
//
// 의존 대상
//   ipc-trust.cjs의 순수 helper만 쓰며 Electron 창을 만들지 않는다.
//
// 유지 조건
//   origin만 같아서는 부족하고, 살아 있는 허용 webContents의 main frame 요청만 통과한다.
//
// 영향 범위
//   공급자는 main.cjs가 요청 시점에 건네는 메인 webContents이고 소비자는 switcher-host media op다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs test/ipc-trust.mjs

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isTrustedMainFrame } = require("../native/electron/ipc-trust.cjs");

const APP_URL = "http://127.0.0.1:4291/app";

function contents({ destroyed = false } = {}) {
  const mainFrame = { url: "http://127.0.0.1:4291/settings" };
  return { mainFrame, isDestroyed: () => destroyed };
}

test("같은 origin이어도 다른 webContents 요청은 거부한다", () => {
  const allowed = contents();
  const other = contents();
  assert.equal(isTrustedMainFrame({ sender: other, senderFrame: other.mainFrame }, APP_URL, allowed), false);
});

test("같은 webContents의 subframe 요청은 거부한다", () => {
  const allowed = contents();
  const subframe = { url: "http://127.0.0.1:4291/inside-frame" };
  assert.equal(isTrustedMainFrame({ sender: allowed, senderFrame: subframe }, APP_URL, allowed), false);
});

test("파괴된 main webContents 요청은 거부한다", () => {
  const allowed = contents({ destroyed: true });
  assert.equal(isTrustedMainFrame({ sender: allowed, senderFrame: allowed.mainFrame }, APP_URL, allowed), false);
});

test("정상 main frame 요청은 origin과 객체 동일성을 모두 통과한다", () => {
  const allowed = contents();
  assert.equal(isTrustedMainFrame({ sender: allowed, senderFrame: allowed.mainFrame }, APP_URL, allowed), true);
});
