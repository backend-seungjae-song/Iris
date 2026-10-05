// 도킹(전역 하나)한 뒤 다른 스페이스로 가면 그 스페이스의 브라우저 탭이 가운데 목록에 없어 도킹 영역이 비고,
// ⌥2 를 눌러도 열 탭이 없었다. 도킹 전환 순간에 그때 스페이스의 탭만 넣었기 때문이다.
// 같은 자리에서 시트·문서 탭에도 webview 를 만들어 서버 탭 제목이 about:blank 로 덮였다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const src = readFileSync(new URL("../web/js/browser/dock.js", import.meta.url), "utf8");
const fn = sliceBetween(src, "export function reconcileConsoleDock()", "\n}\n");

test("도킹 중이면 전환 순간이 아니어도 가운데 스페이스의 웹 탭을 가운데 목록에 넣는다", () => {
  const branch = sliceBetween(fn, "} else if (nowDocked) {", "} else if (!nowDocked && consoleDocked) {");
  assert.match(branch, /const sp = getCenterSpace\(\) \|\| consoleSpace\(\);/);
  assert.match(branch, /const stabs = dockedWebTabs\(sp\);/);
  assert.match(branch, /for \(const st of stabs\)/);
  assert.match(branch, /addTab\(sp, \{ id: st\.id, kind: "browser"/);
});

test("도킹 대상은 kind 가 없거나 browser 인 웹 탭뿐이다", () => {
  const helper = sliceBetween(src, "function dockedWebTabs(sp) {", "\n}\n");
  assert.match(helper, /\(!st\.kind \|\| st\.kind === "browser"\)/);
  const enter = sliceBetween(fn, "if (nowDocked && !consoleDocked) {", "} else if (nowDocked) {");
  assert.match(enter, /const stabs = dockedWebTabs\(sp\);/);
});

// 처음 가는 스페이스는 고른 탭이 없어 탭 줄만 있고 가운데가 비었다. 한 번 고르면 그 뒤로는 유지됐다.
test("도킹 중 고른 탭이 없는 스페이스는 그 스페이스에서 보던 웹 탭을 고른다", () => {
  const branch = sliceBetween(fn, "} else if (nowDocked) {", "} else if (!nowDocked && consoleDocked) {");
  assert.match(branch, /if \(stabs\.length && !\(cur && getTabs\(sp\)\.some\(\(t\) => t\.id === cur\)\)\) \{/);
  assert.match(branch, /setActiveTab\(sp, \(stabs\.some\(\(st\) => st\.id === saved\) && saved\) \|\| stabs\[0\]\.id\);\s*renderTabs\(\); showActiveTab\(\);/);
});
