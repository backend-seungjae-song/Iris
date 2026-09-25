// 복사 결과를 호출자가 받는지, 복사하지 못했을 때 성공 토스트가 뜨지 않는지 확인한다.
// copyText 는 앱 셸(main.js) 안의 함수라 모듈로 불러올 수 없어서, 그 함수 본문만 떼어
// window·navigator 대역을 주고 실행한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sliceBetween } from "../bin/slice-anchor.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function loadCopyText({ acHost, clipboard }) {
  const src = read("web/js/main.js");
  const body = sliceBetween(src, "function copyText(", "\n// docx/sheet 패널에", "copyText");
  const at = src.indexOf("function copyText(");
  const prefix = src.slice(at - 6, at) === "async " ? "async " : "";
  const window = { acHost };
  const navigator = clipboard === undefined ? {} : { clipboard };
  return new Function("window", "navigator", `${prefix}${body}\nreturn copyText;`)(window, navigator);
}

test("앱 경로: 메인 프로세스가 쓴 결과를 그대로 돌려준다", async () => {
  const seen = [];
  const ok = loadCopyText({ acHost: { writeClipboard: async (t) => { seen.push(t); return true; } } });
  assert.equal(await ok("/a/b"), true);
  assert.deepEqual(seen, ["/a/b"]);
  const refused = loadCopyText({ acHost: { writeClipboard: async () => false } });
  assert.equal(await refused("/a/b"), false);
  const thrown = loadCopyText({ acHost: { writeClipboard: async () => { throw new Error("no handler"); } } });
  assert.equal(await thrown("/a/b"), false);
});

test("웹 경로: 성공·거절·API 부재를 구분한다", async () => {
  const seen = [];
  const ok = loadCopyText({ clipboard: { writeText: async (t) => { seen.push(t); } } });
  assert.equal(await ok(42), true);
  assert.deepEqual(seen, ["42"]);
  const denied = loadCopyText({ clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) } });
  assert.equal(await denied("x"), false);
  const missing = loadCopyText({ clipboard: undefined });
  assert.equal(await missing("x"), false);
});

test("네이티브 쓰기는 결과를 돌려주는 호출이다", () => {
  const preload = read("native/electron/preload.cjs");
  const main = read("native/electron/main.cjs");
  assert.match(preload, /writeClipboard:\s*\(text\)\s*=>\s*ipcRenderer\.invoke\("ac-clipboard-write"/);
  assert.match(main, /ipcMain\.handle\("ac-clipboard-write",[^\n]*return true;[^\n]*return false;/);
  assert.doesNotMatch(main, /ipcMain\.on\("ac-clipboard-write"/);
  // 이 앱의 렌더러가 보낸 것만 받는다. 다른 privileged IPC 와 같은 판정(isTrustedSender)이다.
  assert.match(main, /ipcMain\.handle\("ac-clipboard-write", \(e, text\) => \{ if \(!isTrustedSender\(e\)\) return false;/);
  assert.match(main, /ipcMain\.on\("ac-clipboard-read", \(e\) => \{ if \(!isTrustedSender\(e\)\) \{ e\.returnValue = ""; return; \}/);
});

test("경로 복사 호출자는 결과를 보고 알린다", () => {
  const callers = {
    "web/js/main.js": 1,
    "web/js/herdr/agents.js": 1,
    "web/js/explorer/context-menu.js": 3,
    "web/js/panel/memo-admin.js": 2,
  };
  for (const [rel, count] of Object.entries(callers)) {
    const src = read(rel);
    // 결과를 보지 않고 곧바로 토스트를 띄우는 모양이 남아 있으면 실패한다.
    assert.doesNotMatch(src, /copyText\(.*?\);\s*showToast\(/, rel);
    const guarded = src.match(/copyText\(.*?\)\.then\(\(ok\) => showToast\(ok \?/g) || [];
    assert.equal(guarded.length, count, rel);
  }
});
