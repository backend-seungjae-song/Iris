// Gemini CLI의 원본 세션 읽기 코드로 네이티브 대화 기록 복구
import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const geminiPin = /^@google\/gemini-cli@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const fullSessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function geminiCliPin(command) {
  return command?.length === 4 && command[0] === "npx" && command[1] === "-y" &&
    geminiPin.test(command[2]) && command[3] === "--acp" ? command[2] : null;
}

export async function readGeminiHistory(pin, cwd, sessionId) {
  if (!geminiPin.test(pin) || !fullSessionId.test(sessionId)) throw new Error("Gemini 세션 ID를 확인할 수 없습니다");
  try {
    const args = ["-y", "--offline", "--package", pin, "--", "node", fileURLToPath(import.meta.url), pin, sessionId];
    const { stdout } = await execute("npx", args, { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const result = JSON.parse(stdout);
    if (result.sessionId !== sessionId || !Array.isArray(result.events)) throw new Error("Gemini 기록 ID가 일치하지 않습니다");
    return result.events;
  } catch (error) {
    throw new Error("Gemini 터미널 대화 기록을 읽을 수 없습니다", { cause: error });
  }
}

async function findGeminiEntry(pin) {
  const version = pin.match(geminiPin)?.[1];
  if (!version) throw new Error("Gemini CLI 버전을 확인할 수 없습니다");
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const entry = await realpath(join(dir, "gemini")).catch(() => null);
    if (!entry) continue;
    const root = dirname(dirname(entry));
    const manifest = await readFile(join(root, "package.json"), "utf8").then(JSON.parse).catch(() => null);
    if (manifest?.name === "@google/gemini-cli" && manifest.version === version &&
      join(root, manifest.bin?.gemini ?? "") === entry) return entry;
  }
  throw new Error("선택한 버전의 Gemini CLI를 찾을 수 없습니다");
}

async function loadReader(pin) {
  const entry = await findGeminiEntry(pin);
  const launcher = await readFile(entry, "utf8");
  const mainPath = launcher.match(/await import\("\.\/(gemini-[A-Za-z0-9]+\.js)"\)/)?.[1];
  if (!mainPath) throw new Error("Gemini CLI 모듈을 확인할 수 없습니다");
  const dir = dirname(entry);
  const source = await readFile(join(dir, mainPath), "utf8");
  // 릴리스마다 이름이 바뀌는 번들 파일을 실제 import 선언에서 확인
  const imports = [...source.matchAll(/import\s+\{([^{}]*)\}\s+from "\.\/(chunk-[A-Za-z0-9]+\.js)"/g)];
  function getModule(name) {
    const modulePath = imports.find(([, symbols]) => symbols.split(",").some((symbol) => symbol.trim() === name))?.[2];
    if (!modulePath) throw new Error("Gemini CLI의 세션 읽기 코드를 확인할 수 없습니다");
    return import(pathToFileURL(join(dir, modulePath)));
  }
  const [{ SessionSelector, convertSessionToHistoryFormats }, { Storage }] = await Promise.all([
    getModule("SessionSelector"), getModule("Storage"),
  ]);
  return { SessionSelector, convertSessionToHistoryFormats, Storage };
}

async function readRecording(pin, sessionId) {
  if (!fullSessionId.test(sessionId)) throw new Error("Gemini 세션 ID를 확인할 수 없습니다");
  const { SessionSelector, convertSessionToHistoryFormats, Storage } = await loadReader(pin);
  const storage = new Storage(process.cwd());
  await storage.initialize();
  const selected = await new SessionSelector(storage).resolveSession(sessionId, { allowEmpty: true }).catch(async (error) => {
    const files = await readdir(join(storage.getProjectTempDir(), "chats")).catch((cause) => {
      if (cause.code !== "ENOENT") throw cause;
      return [];
    });
    const prefix = sessionId.slice(0, 8);
    if (files.some((file) => file.endsWith(`-${prefix}.jsonl`) || file.endsWith(`-${prefix}.json`))) throw error;
    return null;
  });
  if (!selected) return [];
  if (selected.sessionData.sessionId !== sessionId) throw new Error("Gemini 기록 ID가 일치하지 않습니다");
  const events = [];
  for (const message of selected.sessionData.messages) {
    const { uiHistory } = convertSessionToHistoryFormats([message]);
    for (const row of uiHistory) {
      const timestamp = message.timestamp;
      if (row.type === "user") {
        events.push({ type: "timeline", timestamp, item: { type: "user_message", messageId: message.id, text: row.text } });
      } else if (row.type === "gemini") {
        events.push({ type: "timeline", timestamp, item: { type: "assistant_message", messageId: message.id, text: row.text } });
      } else if (row.type === "thinking") {
        events.push({ type: "timeline", timestamp, item: { type: "reasoning", text: `**${row.thought.subject}**\n${row.thought.description}` } });
      } else if (row.type === "tool_group") {
        for (const tool of row.tools) {
          events.push({ type: "timeline", timestamp, item: {
            type: "tool_call", callId: tool.callId, name: tool.name, detail: { type: "unknown", input: tool.args, output: tool.resultDisplay },
            status: tool.status === "success" ? "completed" : "failed", error: null,
          } });
        }
      }
    }
  }
  return events;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [pin, sessionId] = process.argv.slice(2);
  const events = await readRecording(pin, sessionId);
  process.stdout.write(JSON.stringify({ sessionId, events }), () => process.exit(0));
}
