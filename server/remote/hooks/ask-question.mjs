import { connectAgent } from "../agent-endpoint.mjs";

const MAX_INPUT = 16 * 1024;
const CONNECT_TIMEOUT = 250;
const PROCESS_TIMEOUT = 300;
const socketPath = process.argv[2];
let raw = "";

function finish(socket) {
  if (finish.done) return;
  finish.done = true;
  socket?.destroy();
  process.exitCode = 0;
}

// 승인 화면이 무엇에 대한 것인지(도구 이름과 대상)를 도구 입력 필드에서 뽑는다. 화면 문구는 읽지 않는다.
function targetOf(tool, input) {
  const value = input?.command ?? input?.file_path ?? input?.notebook_path ?? input?.path ?? input?.url ?? input?.query ?? input?.pattern;
  return typeof value === "string" ? value.trim().replace(/\s*\n\s*/g, " ").slice(0, 300) : "";
}

function run(input) {
  if (!socketPath) return finish(null);
  const permission = input?.hook_event_name === "PermissionRequest" && typeof input.tool_name === "string"
    && input.tool_name.length > 0 && input.tool_name.length <= 128;
  const question = input?.hook_event_name === "PreToolUse" && input?.tool_name === "AskUserQuestion"
    && Array.isArray(input.tool_input?.questions);
  if (!permission && !question) return finish(null);
  const message = permission
    ? { type: "hint", tool: input.tool_name, target: targetOf(input.tool_name, input.tool_input) }
    : { type: "question", questions: input.tool_input.questions };
  const paneId = process.env.HERDR_PANE_ID || "";
  const cliSession = process.env.CLAUDE_CODE_SESSION_ID || input.session_id || "unknown";
  if (!paneId) return finish(null);
  const { socket, auth } = connectAgent(socketPath);
  socket.setEncoding("utf8");
  const connectTimer = setTimeout(() => finish(socket), CONNECT_TIMEOUT);
  const processTimer = setTimeout(() => finish(socket), PROCESS_TIMEOUT);
  connectTimer.unref?.(); processTimer.unref?.();
  socket.on("connect", () => {
    clearTimeout(connectTimer);
    socket.write(`${JSON.stringify({ role: "question-hook", v: 1, paneId, cliSession, ...auth })}\n`);
    socket.end(`${JSON.stringify(message)}\n`, () => finish(socket));
  });
  socket.on("error", () => finish(socket));
  socket.on("close", () => finish(socket));
}

const deadline = setTimeout(() => { finish(null); process.exit(0); }, PROCESS_TIMEOUT);
deadline.unref?.();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  if (Buffer.byteLength(raw) > MAX_INPUT) finish(null);
});
process.stdin.on("end", () => {
  if (finish.done || Buffer.byteLength(raw) > MAX_INPUT) return;
  try { run(JSON.parse(raw)); } catch { finish(null); }
});
