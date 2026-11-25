import { EventEmitter, once } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";

const MAX_FRAME_BYTES = 128 * 1024 * 1024;

export function connectCodexSocket(socketPath) {
  if (!path.isAbsolute(socketPath) || /[:\r\n\0]/.test(socketPath)) throw new TypeError("Codex 소켓 경로가 잘못되었습니다");
  return new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 5000, maxPayload: MAX_FRAME_BYTES });
}

export function createCodexAppServerProcess({ socketPath, command = "codex", onMessage }) {
  let connection;
  const connections = new Set();
  return {
    async resolvePrefix() { return { command, args: [] }; },
    spawn() {
      const child = new CodexSocketProcess(socketPath, onMessage);
      connections.add(child);
      child.once("exit", () => connections.delete(child));
      connection = child;
      return child;
    },
    close() { for (const child of connections) child.kill(); },
    request(method, params) {
      if (!connection) throw new Error("Codex 공유 서버 연결을 열지 않았습니다");
      return connection.request(method, params);
    },
  };
}

// Paseo는 ChildProcess의 입출력과 종료 이벤트를 사용하므로 Unix 소켓 연결만 닫음
class CodexSocketProcess extends EventEmitter {
  exitCode = null;
  signalCode = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  #ws;
  #serial = 0;
  #requests = new Map();

  constructor(socketPath, onMessage) {
    super();
    const ws = this.#ws = connectCodexSocket(socketPath);
    const opened = once(ws, "open");
    void opened.catch(() => {});
    const decoder = new StringDecoder("utf8");
    let tail = "";
    this.stdin = new Writable({
      write(chunk, _encoding, done) {
        const lines = (tail + decoder.write(chunk)).split("\n");
        tail = lines.pop();
        if (Buffer.byteLength(tail) > MAX_FRAME_BYTES) { done(new Error("Codex 요청이 너무 큽니다")); return; }
        void opened.then(async () => {
          for (const line of lines) {
            if (line) await new Promise((resolve, reject) => ws.send(line, (error) => error ? reject(error) : resolve()));
          }
        }).then(() => done(), done);
      },
      final(done) { ws.close(); done(); },
    });
    this.stdin.on("error", (error) => this.stderr.write(`${error.message}\n`));
    ws.on("message", (frame, isBinary) => {
      if (isBinary) { ws.close(1003); return; }
      let value;
      try { value = JSON.parse(frame); } catch {}
      if (typeof value?.id === "string" && value.id.startsWith("iris-codex:")) {
        this.#requests.get(value.id)?.(value);
        return;
      }
      if (value?.method) onMessage?.(value);
      if (!this.stdout.write(Buffer.concat([frame, Buffer.from("\n")]))) {
        ws.pause();
        this.stdout.once("drain", () => ws.resume());
      }
    });
    ws.on("error", (error) => this.stderr.write(`${error.message}\n`));
    ws.once("close", (code) => {
      for (const finish of this.#requests.values()) finish({ error: { message: "Codex 공유 서버 연결이 끊겼습니다" } });
      this.exitCode = code === 1000 || code === 1005 ? 0 : 1;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.exitCode, null);
      this.emit("close", this.exitCode, null);
    });
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = `iris-codex:${++this.#serial}`;
      const finish = (reply) => {
        clearTimeout(timer);
        this.#requests.delete(id);
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.result);
      };
      const timer = setTimeout(() => finish({ error: { message: "Codex 요청 응답 시간이 초과되었습니다" } }), 5000);
      this.#requests.set(id, finish);
      try {
        this.#ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) finish({ error });
        });
      } catch (error) { finish({ error }); }
    });
  }

  kill() {
    if (this.exitCode !== null) return false;
    this.#ws.terminate();
    return true;
  }
}
