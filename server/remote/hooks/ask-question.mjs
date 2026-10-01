import net from "node:net";

import { questionHookOutput } from "./protocol.mjs";

const MAX_INPUT = 16 * 1024;
const MAX_LINE = 64 * 1024;
const CONNECT_TIMEOUT = 2_000;
const PROCESS_TIMEOUT = 595_000;
const socketPath = process.argv[2];
let raw = "";

function finish(socket, output) {
  if (finish.done) return;
  finish.done = true;
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  socket?.destroy();
  process.exitCode = 0;
}

function run(input) {
  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "AskUserQuestion"
    || !Array.isArray(input.tool_input?.questions) || !socketPath) return finish(null, null);
  const questions = input.tool_input.questions;
  const paneId = process.env.HERDR_PANE_ID || "";
  const cliSession = process.env.CLAUDE_CODE_SESSION_ID || input.session_id || "unknown";
  if (!paneId) return finish(null, null);
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  const connectTimer = setTimeout(() => finish(socket, null), CONNECT_TIMEOUT);
  const processTimer = setTimeout(() => finish(socket, null), PROCESS_TIMEOUT);
  connectTimer.unref?.(); processTimer.unref?.();
  socket.on("connect", () => {
    clearTimeout(connectTimer);
    socket.write(`${JSON.stringify({ role: "question-hook", v: 1, paneId, cliSession })}\n`);
    socket.write(`${JSON.stringify({ type: "question", questions })}\n`);
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) return finish(socket, null);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value?.type === "question.none") return finish(socket, null);
      if (value?.type !== "question.answer") continue;
      return finish(socket, questionHookOutput(questions, value.answers));
    }
  });
  socket.on("error", () => finish(socket, null));
  socket.on("close", () => finish(socket, null));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  if (Buffer.byteLength(raw) > MAX_INPUT) finish(null, null);
});
process.stdin.on("end", () => {
  if (finish.done || Buffer.byteLength(raw) > MAX_INPUT) return;
  try { run(JSON.parse(raw)); } catch { finish(null, null); }
});
