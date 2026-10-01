import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function withResponse(reply, run) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { seen.push(JSON.parse(body)); reply(res); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "iris-mcp-transport-"));
  const child = spawn(process.execPath, [process.env.IRIS_MCP_UNDER_TEST || new URL("../bin/iris-mcp.mjs", import.meta.url).pathname], {
    env: { ...process.env, IRIS_PORT: String(server.address().port), IRIS_STATE_DIR: state, IRIS_SESSION: "transport-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timer;
  try {
    const response = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP가 1500ms 안에 결과를 반환하지 않았습니다: ${stderr}`)), 1500);
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "notify", arguments: { level: "info", title: "transport fixture" } } }) + "\n");
    });
    clearTimeout(timer);
    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);
    await run(response.result);
    assert.equal(seen.length, 1, "명령을 자동 재전송하지 않는다");
    assert.equal(seen[0].cmd, "notify");
  } finally {
    clearTimeout(timer);
    child.kill();
    await exited;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(state, { recursive: true, force: true });
  }
}

test("MCP HTTP 정상 JSON은 그대로 도구 결과로 반환한다", async () => {
  await withResponse((res) => res.end(JSON.stringify({ ok: true, data: { id: "transport-fixture" } })), (result) => {
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).id, "transport-fixture");
  });
});

test("MCP HTTP 오류 JSON은 오류 결과로 반환한다", async () => {
  await withResponse((res) => res.end(JSON.stringify({ ok: false, error: "fixture refusal" })), (result) => {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /fixture refusal/);
  });
});

test("MCP HTTP 잘못된 JSON은 파싱 오류로 반환한다", async () => {
  await withResponse((res) => res.end("not-json"), (result) => {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /응답 파싱 실패/);
  });
});

test("MCP HTTP 응답이 중간에 끊기면 오류로 끝내고 명령을 반복하지 않는다", async () => {
  await withResponse((res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    res.write('{"ok":');
    setImmediate(() => res.destroy());
  }, (result) => {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /응답.*끊겼|응답.*중단/);
    assert.match(result.content[0].text, /처리됐을 수/);
  });
});
