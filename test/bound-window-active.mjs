// 한 탭에 묶인 창이 자기 탭을 비추는가.
//
// 배경: 탭을 빼서 만든 창 둘이 같은 페이지를 표시했다. activeBySpace 가 스페이스마다
// 하나뿐인데 모든 창이 그것을 따랐기 때문이다.
//
// 판정은 web/js/browser/active-tab.js 하나가 소유한다. 그 파일이 값만 받고 값만 돌려주므로
// DOM 없이 그대로 돌려 본다. 부르는 자리가 그 판정을 실제로 쓰는지는 아래 마지막 두 개가 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { activeIdFor, mayWriteSharedActive } from "../web/js/browser/active-tab.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

test("묶인 창은 공유 활성 탭이 무엇이든 자기 탭을 비춘다", () => {
  // 이것이 그 결함이다. 스페이스의 활성 탭이 A 여도 B 에 묶인 창은 B 를 표시해야 한다.
  assert.equal(activeIdFor({ boundTab: "B", spaceActive: "A" }), "B");
  assert.equal(activeIdFor({ boundTab: "B", spaceActive: null }), "B");
  // 창 둘이 각각 다른 탭에 묶이면 서로 다른 것을 표시한다. 이것이 "따로 동작"이다.
  const one = activeIdFor({ boundTab: "B", spaceActive: "A" });
  const two = activeIdFor({ boundTab: "C", spaceActive: "A" });
  assert.notEqual(one, two, "묶인 창 둘이 같은 것을 비춘다");
});

test("안 묶인 창은 스페이스가 공유하는 활성 탭을 따른다", () => {
  assert.equal(activeIdFor({ boundTab: null, spaceActive: "A" }), "A");
  assert.equal(activeIdFor({ boundTab: null, spaceActive: null }), null);
  assert.equal(activeIdFor({}), null);
});

test("떨어져 나간 탭은 원래 창의 활성 탭이 될 수 없다", () => {
  // 탭을 빼내면 원래 창의 띠에서는 감춰진다. 그래도 화면이 그 페이지를 계속 표시하면 안 된다.
  const order = ["a", "b", "c"];
  const hidden = new Set(["b"]);
  assert.equal(activeIdFor({ spaceActive: "b", hidden, order }), "c", "뒤의 탭으로 안 옮겼다");
});

test("맨 뒤 탭이 떨어지면 앞으로 옮긴다", () => {
  const order = ["a", "b", "c"];
  assert.equal(activeIdFor({ spaceActive: "c", hidden: new Set(["c"]), order }), "b");
});

test("전부 떨어져 나갔으면 비출 것이 없다", () => {
  const order = ["a", "b"];
  assert.equal(activeIdFor({ spaceActive: "a", hidden: new Set(["a", "b"]), order }), null);
});

test("안 떨어진 탭이 활성이면 그대로 둔다", () => {
  const order = ["a", "b", "c"];
  const hidden = new Set(["b"]);
  assert.equal(activeIdFor({ spaceActive: "a", hidden, order }), "a", "멀쩡한 활성 탭을 옮겼다");
  assert.equal(activeIdFor({ spaceActive: "a", hidden: new Set(), order }), "a");
  assert.equal(activeIdFor({ spaceActive: "a" }), "a", "감춘 목록이 없는데 옮겼다");
});

test("묶인 창은 감춘 목록과 무관하게 자기 탭이다", () => {
  // 묶인 창에서는 detach.hidden 이 null 이다. 그래도 자기 탭을 표시해야 한다.
  assert.equal(activeIdFor({ boundTab: "b", spaceActive: "a", hidden: new Set(["b"]), order: ["a", "b"] }), "b");
});

test("묶인 창은 공유 활성 탭을 옮기지 않는다", () => {
  // 옮기면 원래 창이 "거기서는 감춰진 탭"을 가리키게 된다.
  assert.equal(mayWriteSharedActive("B"), false);
  assert.equal(mayWriteSharedActive(null), true);
  assert.equal(mayWriteSharedActive(undefined), true);
});

test("활성 탭을 읽는 자리가 이 판정을 쓴다", () => {
  // 판정이 한 곳에 있어도 부르는 자리가 옛 길로 읽으면 아무 소용이 없다.
  const wv = read("web/js/browser/webview.js");
  assert.match(wv, /activeIdFor\(\{/, "webview 가 판정을 안 쓴다");
  // 감춘 목록을 안 넘기면 판정이 떨어져 나간 탭을 못 걸러내, 원래 창이 그 페이지를 계속 표시한다.
  assert.match(wv, /hidden: callHook\("detach\.hidden"\)/, "webview 가 감춘 목록을 안 넘긴다");
  assert.match(wv, /order: bmTabs\(\)/, "webview 가 탭 순서를 안 넘긴다");
  const dock = read("web/js/browser/dock.js");
  assert.doesNotMatch(dock, /const act = bmActiveId\(\)/, "dock 이 공유 활성 탭을 직접 읽는다");
  assert.match(dock, /const act = activeBrowserId\(\)/, "dock 이 이 창의 활성 탭을 안 읽는다");
});

test("떨어진 목록이 바뀌면 화면까지 다시 맞춘다", () => {
  // 판정만 고치고 다시 호출하는 자리를 만들지 않으면 띠에서 칩만 사라지고 화면은 그대로다.
  // 어느 탭을 표시할지는 reconcileBrowserMode 가 정한다. 띠만 다시 그리면 그 판정을 안 거친다.
  const cap = read("web/js/browser/detach-tab.js");
  assert.match(cap, /ctx\.redrawBrowser/, "기능이 띠만 다시 그린다");
  assert.doesNotMatch(cap, /ctx\.renderBmTabs/, "기능이 아직 띠만 그리는 길을 들고 있다");

  const frame = read("web/js/main.js");
  assert.match(frame, /redrawBrowser:/, "틀이 다시 맞추기를 안 넘긴다");
  assert.match(frame, /redrawBrowser: \(\) => \{ if \(BROWSER_MODE\) reconcileBrowserMode\(\)/,
    "다시 맞추기가 reconcileBrowserMode 를 안 부른다");
});

test("공유 활성 탭을 옮기는 자리가 이 판정을 쓴다", () => {
  for (const rel of ["web/js/browser/tabs.js", "web/js/core/keynav.js"]) {
    const src = read(rel);
    assert.match(src, /mayWriteSharedActive\(/, rel + " 가 판정 없이 공유 활성 탭을 옮긴다");
  }
});
