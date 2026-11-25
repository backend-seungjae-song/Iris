import assert from "node:assert/strict";
import test from "node:test";
import { createHttpHandler } from "../server/http-handler.js";

for (const origin of ["null", "https://example.test", undefined]) {
  test("미등록 탭의 다이얼로그 거부, Origin " + origin, () => {
    let status;
    const res = { writeHead(code) { status = code; return this; }, end() {} };
    createHttpHandler({})({ method: "GET", url: "/dialog-ask?wc=42",
      socket: { remoteAddress: "127.0.0.1" }, headers: { origin } }, res);
    assert.equal(status, 403);
  });
}
