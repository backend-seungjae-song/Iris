import assert from "node:assert/strict";
import test from "node:test";

// herdr 가 없는 Mac 에서 앱을 처음 켜면 터미널은 재연결만 반복하고 스페이스 목록은 "오류"만 보였다.
// 서버가 herdr 가 없다는 것을 알아보고 사람이 할 일을 알 수 있는 응답을 줘야 한다.
process.env.HERDR_BIN = "/nonexistent/iris-test/herdr";
process.env.IRIS_HERDR_SESSION = `iris-test-missing-${process.pid}`;
const { HerdrClient } = await import("../server/herdr.js");
const { PtyManager, runnableHerdrBin } = await import("../server/pty.js");

test("herdr 소켓이 없으면 원문 ENOENT 대신 연결 안 됨 코드와 안내를 준다", async () => {
  await assert.rejects(new HerdrClient().workspaceList(), (e) => {
    assert.equal(e.code, "HERDR_UNREACHABLE");
    assert.doesNotMatch(e.message, /ENOENT|herdr\.sock/);
    assert.match(e.message, /herdr/);
    return true;
  });
});

test("실행할 수 있는 herdr 가 없으면 터미널을 띄우지 않고 null 을 돌려준다", () => {
  assert.equal(runnableHerdrBin(), null);
  const ws = {};
  assert.equal(new PtyManager().start(ws, 80, 24, () => {}), null);
});
