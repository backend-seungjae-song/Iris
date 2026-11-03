import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { iosSwitchFrames, hasKoreanKeyboard, switchInputLanguage, ANDROID_SWITCH_COMMAND } = require("../native/electron/emulator/input-language.cjs");

test("iOS 한/영 전환은 Ctrl 을 누른 채 Space 를 한 번 누른다", () => {
  assert.deepEqual(iosSwitchFrames(), [
    { type: "down", usage: 224 }, { type: "down", usage: 44 },
    { type: "up", usage: 44 }, { type: "up", usage: 224 },
  ]);
});

test("기기 키보드 목록에서 한국어 키보드 유무를 읽는다", () => {
  assert.equal(hasKoreanKeyboard('(\n "en_US@sw=QWERTY;hw=Automatic",\n "ko_KR@sw=Korean;hw=Automatic",\n "emoji@sw=Emoji"\n)'), true);
  assert.equal(hasKoreanKeyboard('(\n "en_US@sw=QWERTY;hw=Automatic",\n "emoji@sw=Emoji"\n)'), false);
  // 목록 키가 없으면 기기 언어 기본값이라 알 수 없음
  assert.equal(hasKoreanKeyboard(null), null);
});

function fakeBridge(kind) {
  const calls = [];
  return {
    calls,
    async resolveTarget(opts) { calls.push(["resolve", opts]); return { backend: { kind, resolveDeviceId: async (d) => d }, device: "DEV" }; },
    async exec(command, opts) { calls.push(["exec", command, opts]); },
  };
}

test("Android 는 언어 전환 키를 adb 로 보낸다", async () => {
  const bridge = fakeBridge("android");
  const result = await switchInputLanguage({ bridge, target: { worktreeId: "w1" }, readKeyboards: async () => { throw new Error("부르면 안 됨"); } });
  assert.deepEqual(bridge.calls.at(-1), ["exec", ANDROID_SWITCH_COMMAND, { worktreeId: "w1" }]);
  assert.equal(ANDROID_SWITCH_COMMAND, "input keyevent 204");
  assert.deepEqual(result, {});
});

test("iOS 는 그 기기 키보드를 확인하고 화면이 보낼 Ctrl+Space 프레임을 돌려준다", async () => {
  const read = [];
  const result = await switchInputLanguage({ bridge: fakeBridge("ios"), target: { worktreeId: "w1" },
    readKeyboards: async (udid) => { read.push(udid); return '("ko_KR@sw=Korean;hw=Automatic")'; } });
  assert.deepEqual(read, ["DEV"]);
  assert.deepEqual(result, { frames: iosSwitchFrames() });
});

test("iOS 기기 목록 키가 없으면 그대로 돌려준다", async () => {
  const result = await switchInputLanguage({ bridge: fakeBridge("ios"), target: { worktreeId: "w1" }, readKeyboards: async () => null });
  assert.deepEqual(result, { frames: iosSwitchFrames() });
});

test("iOS 기기에 한국어 키보드가 없으면 프레임 없이 알린다", async () => {
  await assert.rejects(switchInputLanguage({ bridge: fakeBridge("ios"), target: { worktreeId: "w1" },
    readKeyboards: async () => '("en_US@sw=QWERTY;hw=Automatic")' }),
  (e) => e.code === "no_korean_keyboard" && /한국어 키보드/.test(e.message));
});
