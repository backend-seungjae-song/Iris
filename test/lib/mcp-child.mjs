// MCP(bin/iris-mcp.mjs)를 가짜 앱 서버에 붙여 실제로 띄운다. 서버에 간 명령과 돌아온 결과를 본다.
// IRIS_MCP_UNDER_TEST 로 다른 파일을 띄우면 결함 주입 사본을 같은 검사로 돌릴 수 있다.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..", "..");

export async function withMcp(reply, fn, { limitMs = 20000 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      seen.push({ cmd: m.cmd, args: m.args });
      res.end(JSON.stringify(reply(m.cmd, m.args)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "iris-mcp-then-"));
  const child = spawn(process.execPath, [process.env.IRIS_MCP_UNDER_TEST || path.join(root, "bin", "iris-mcp.mjs")], {
    env: { ...process.env, IRIS_PORT: String(server.address().port), IRIS_STATE_DIR: state, IRIS_SESSION: "then-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const callTool = (name, args) => new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, (m) => resolve(m.result));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  // 멈춘 MCP 를 기다리다 검사 전체가 끝나지 않는 일을 막는다. 넘기면 실패로 끝내고 자식과 서버를 정리한다.
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`MCP 가 ${limitMs}ms 안에 끝나지 않았다`)), limitMs); });
  try { await Promise.race([fn(callTool, seen, state), limit]); }
  finally {
    clearTimeout(timer);
    child.kill();
    server.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
}

