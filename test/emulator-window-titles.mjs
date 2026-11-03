import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { emulatorWindowTitles } = require("../native/electron/emulator/window-titles.cjs");

const titles = (list) => Object.fromEntries(emulatorWindowTitles(list));

test("기기 없는 창은 에뮬레이터, 기종이 하나면 기종 이름", () => {
  assert.deepEqual(titles([{ key: "a", name: "" }, { key: "b", name: "iPhone 13", udid: "U1" }]),
    { a: "Iris — 에뮬레이터", b: "Iris — iPhone 13" });
});

test("같은 기종이 여럿이면 udid 순으로 1, 2, 3", () => {
  assert.deepEqual(titles([
    { key: "x", name: "iPhone 13", udid: "C" },
    { key: "y", name: "iPhone 13", udid: "A" },
    { key: "z", name: "iPhone 13", udid: "B" },
    { key: "p", name: "Pixel 8", udid: "emulator-5554" },
  ]), { y: "Iris — iPhone 13 1", z: "Iris — iPhone 13 2", x: "Iris — iPhone 13 3", p: "Iris — Pixel 8" });
});

test("여는 순서가 바뀌어도 같은 기기는 같은 번호", () => {
  const a = titles([{ key: "1", name: "iPhone 13", udid: "A" }, { key: "2", name: "iPhone 13", udid: "B" }]);
  const b = titles([{ key: "2", name: "iPhone 13", udid: "B" }, { key: "1", name: "iPhone 13", udid: "A" }]);
  assert.deepEqual(a, b);
});

test("이상한 입력은 건너뜀", () => {
  assert.deepEqual(titles([null, { name: "x" }, { key: "k", name: "  iPhone\n13  " }]), { k: "Iris — iPhone 13" });
  assert.deepEqual(titles(undefined), {});
});
