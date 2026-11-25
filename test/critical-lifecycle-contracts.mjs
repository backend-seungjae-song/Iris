import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");

test("쿠키 스테이징은 첫 SQL 오류에서 중단한다", () => {
  const source = read("native/electron/cookie-import.cjs");
  assert.ok(source.includes('execFileSync("/usr/bin/sqlite3", ["-bail", staging]'));
});
test("회수 잠금은 PID가 들어 있는 파일을 링크해 획득한다", () => {
  const source = read("server/index.js").split("function reapDeadLock")[1];
  assert.ok(source.includes("fs.linkSync(tmp, reap)"));
});
test("중첩 팝업에도 같은 생성 핸들러와 크래시 가드를 등록한다", () => {
  const source = read("native/electron/webview-lifecycle.cjs");
  assert.ok(source.includes("guardCrashedSend(cwc)"));
  assert.ok(source.includes("attachPopup(cwc, grandWin)"));
});
test("preload의 이벤트 구독 API는 해제 함수를 반환한다", () => {
  const source = read("native/electron/preload.cjs");
  assert.match(source, /function subscribe\(channel, cb\)/);
  assert.doesNotMatch(source, /on[A-Z][A-Za-z]+: \(cb\) => ipcRenderer\.on\(/);
});
