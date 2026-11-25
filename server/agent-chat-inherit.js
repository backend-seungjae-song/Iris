import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import { claudeHome } from "./agent-homes.js";

export const INHERIT_COMMAND = "inherit";
const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PICK = /^⟦Iris⟧ 세션 (?:선택|지목)[^\r\n]*\r?\n([\s\S]*?)^⟦\/Iris⟧[ \t]*$/gm;

export function inheritPick(text) {
  const picks = [...text.matchAll(PICK)];
  const rest = text.replace(PICK, "").trim();
  if (!new RegExp(`^/${INHERIT_COMMAND}(?:\\s|$)`, "m").test(rest)) return null;
  if (rest !== `/${INHERIT_COMMAND}` || picks.length !== 1) {
    throw new Error("계승 명령과 Iris에서 지목한 세션 하나만 함께 보내세요");
  }
  const paneId = /^주소: herdr pane ([\w:-]{1,100})\r?$/m.exec(picks[0][1])?.[1];
  const sessionId = /^세션: ([\da-f-]+)\r?$/im.exec(picks[0][1])?.[1];
  if (!paneId || !UUID.test(sessionId || "")) throw new Error("지목한 세션의 주소나 ID가 없습니다");
  return { paneId, sessionId };
}

function sameSession(first, second) {
  return first && second && first.terminalId && first.terminalId === second.terminalId
    && first.kind === second.kind && first.sessionId === second.sessionId && first.cwd === second.cwd;
}

export async function resumeFromPick(paneId, pick, { current, importSession, resume }) {
  if (paneId === pick.paneId) throw new Error("이어받을 다른 세션을 지목하세요");
  const [source, target] = await Promise.all([current(pick.paneId), current(paneId)]);
  if (source?.sessionId !== pick.sessionId || !source.terminalId || !source.file) {
    throw new Error("지목한 세션이 바뀌었거나 기록을 찾을 수 없습니다");
  }
  if (!target?.idle || !target.terminalId || !target.sessionId) {
    throw new Error("명령을 보낸 창이 입력을 기다릴 때 다시 실행하세요");
  }
  if (source.kind === target.kind) throw new Error("다른 에이전트의 세션을 지목하세요");
  const imported = await importSession(source, target);
  if (!UUID.test(imported || "")) throw new Error("가져온 세션의 ID를 확인할 수 없습니다");

  try {
    const now = await current(paneId);
    if (!sameSession(target, now) || !now.idle) throw new Error("명령을 보낸 창이 바뀌었습니다");
    await resume(now, imported);
  } catch (error) {
    throw new Error(`${error.message}. 가져온 대화는 /resume ${imported}로 열 수 있습니다`, { cause: error });
  }
  return imported;
}

async function isNodeTransfer(file) {
  const resolved = await fs.realpath(file);
  const handle = await fs.open(resolved, "r");
  try {
    const bytes = Buffer.alloc(256);
    const { bytesRead } = await handle.read(bytes);
    const prefix = bytes.subarray(0, bytesRead);
    const firstLine = prefix.toString("utf8").split("\n", 1)[0];
    if (firstLine.startsWith("#!")) return /(?:^|[\s/])node(?:\s|$)/.test(firstLine.trimEnd());
    return /\.[cm]?js$/i.test(resolved) || (!path.extname(resolved) && !prefix.includes(0));
  } finally { await handle.close(); }
}

export async function importPickedSession(source, target) {
  if (!["claude", "codex"].includes(source.kind) || !["claude", "codex"].includes(target.kind)) {
    throw new Error("세션 계승은 Claude와 Codex 사이에서 사용할 수 있습니다");
  }
  const cwd = await fs.realpath(source.cwd);
  if (cwd !== await fs.realpath(target.cwd)) {
    throw new Error("원본과 명령을 보낸 창의 작업 폴더가 다릅니다. 원본과 같은 작업 폴더의 창에서 실행하세요");
  }
  if (target.kind === "claude") {
    return (await importCodexToClaude(source, cwd)).id;
  }
  const localBin = path.join(os.homedir(), ".local", "bin");
  let localTransfer;
  for (const dir of [...(process.env.PATH || "").split(path.delimiter), localBin].filter(path.isAbsolute)) {
    for (const name of process.platform === "win32" ? ["to-codex", "to-codex.exe", "to-codex.js"] : ["to-codex"]) {
      const candidate = path.join(dir, name);
      if ((await fs.stat(candidate).catch(() => null))?.isFile()) { localTransfer = candidate; break; }
    }
    if (localTransfer) break;
  }
  if (!localTransfer) throw new Error("to-codex 실행 파일을 찾을 수 없습니다");
  const env = { ...process.env, PATH: [localBin, process.env.PATH].filter(Boolean).join(path.delimiter) };
  const history = await readInheritanceHistory(source);
  await fs.mkdir(claudeHome("projects"), { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(claudeHome("projects"), "iris-inherit-"));
  try {
    const id = randomUUID();
    const transcript = path.join(directory, `${id}.jsonl`);
    await fs.writeFile(transcript, claudeTranscript(history, cwd, id), { flag: "wx", mode: 0o600 });
    const nodeScript = await isNodeTransfer(localTransfer);
    const args = ["--source", transcript, "--cwd", cwd, "--json"];
    if (nodeScript) {
      args.unshift(localTransfer);
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    const { stdout } = await run(nodeScript ? process.execPath : localTransfer, args, { cwd, env, timeout: 10_000 });
    return JSON.parse(stdout).threadId;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const RECENT_BYTES = 48 * 1024;
const RECENT_MESSAGES = 96;
const MESSAGE_BYTES = 8 * 1024;
const SUMMARY_BYTES = 12 * 1024;
const TOOL_BYTES = 2 * 1024;
const RUNTIME_TAGS = /<(environment_context|user_instructions|permissions instructions|recommended_plugins|app-context|agent_context|collaboration_mode)>[\s\S]*?<\/\1>/g;
const AGENTS_PREAMBLE = /^# AGENTS\.md instructions for[^\n]*\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/;

function messageText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => block?.text || "").filter(Boolean).join("\n") : "";
}

function toolText(label, value) {
  return { role: "assistant", tool: true, text: `[${label}]\n${typeof value === "string" ? value : JSON.stringify(value ?? null)}` };
}

function codexHistoryItem(payload) {
  if (payload?.type === "message" && ["user", "assistant"].includes(payload.role)) {
    const text = messageText(payload.content);
    return { role: payload.role, text: payload.role === "user" ? text.replace(AGENTS_PREAMBLE, "").replace(RUNTIME_TAGS, "").trim() : text };
  }
  if (["function_call", "custom_tool_call", "local_shell_call"].includes(payload?.type)) {
    const input = payload.arguments ?? payload.input ?? payload.action;
    return toolText(`Codex 도구 호출 · ${payload.name || payload.type}`, input);
  }
  if (["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(payload?.type)) {
    return toolText("Codex 도구 결과", payload.output);
  }
  return null;
}

function claudeHistoryItems(row) {
  if (!["user", "assistant"].includes(row.type) || row.isSidechain || row.isMeta || row.isVisibleInTranscriptOnly) return [];
  const content = row.message?.content;
  if (typeof content === "string") return [{ role: row.type, text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "text") return [{ role: row.type, text: block.text }];
    if (block?.type === "tool_use") return [toolText(`Claude 도구 호출 · ${block.name}`, block.input)];
    if (block?.type === "tool_result") return [toolText("Claude 도구 결과", messageText(block.content))];
    return [];
  });
}

function clipHistoryText(text, limit) {
  if (Buffer.byteLength(text) <= limit) return text;
  const buffer = Buffer.from(text);
  const marker = "\n[일부 생략]\n";
  const half = Math.floor((limit - Buffer.byteLength(marker)) / 2);
  let tail = buffer.length - half;
  while ((buffer[tail] & 0xc0) === 0x80) tail++;
  return new TextDecoder().decode(buffer.subarray(0, half), { stream: true }) + marker + buffer.toString("utf8", tail);
}

export async function readInheritanceHistory(source) {
  const { size } = await fs.stat(source.file);
  if (size === 0) throw new Error("가져올 기록이 비어 있습니다");
  const lines = readline.createInterface({ input: createReadStream(source.file, { end: size - 1 }), crlfDelay: Infinity });
  const isClaude = source.kind === "claude";
  const recent = [];
  let checked = false;
  let bytes = 0;
  let summary = null;
  let latestUser = null;
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isClaude && !checked) {
      if (row.type !== "session_meta" || row.payload?.id !== source.sessionId) throw new Error("Codex 기록의 세션 ID가 다릅니다");
      checked = true;
    }
    if (isClaude && row.sessionId && row.sessionId !== source.sessionId) continue;
    const compactText = isClaude
      ? (row.isCompactSummary && !row.isSidechain ? messageText(row.message?.content) : "")
      : (row.type === "compacted" ? row.payload?.message : "");
    if (typeof compactText === "string" && compactText.trim()) {
      summary = { role: "user", text: clipHistoryText(compactText, SUMMARY_BYTES), timestamp: row.timestamp };
      recent.length = 0;
      bytes = 0;
      latestUser = null;
      continue;
    }
    const items = isClaude ? claudeHistoryItems(row) : (row.type === "response_item" ? [codexHistoryItem(row.payload)] : []);
    for (const item of items) {
      if (typeof item?.text !== "string" || !item.text.trim()) continue;
      const text = clipHistoryText(item.text, item.tool ? TOOL_BYTES : MESSAGE_BYTES);
      const entry = { role: item.role, text, timestamp: row.timestamp };
      if (entry.role === "user") latestUser = entry;
      recent.push(entry);
      bytes += Buffer.byteLength(text);
      while (bytes > RECENT_BYTES || recent.length > RECENT_MESSAGES) {
        bytes -= Buffer.byteLength(recent.shift().text);
      }
    }
  }
  if (!latestUser && !summary) throw new Error("가져올 사용자 메시지가 없습니다");
  return [
    ...(summary ? [summary] : []),
    ...(latestUser && !recent.includes(latestUser) ? [latestUser] : []),
    ...recent,
  ];
}

function claudeTranscript(history, cwd, id) {
  let parentUuid = null;
  const rows = history.map(({ role, text, timestamp }) => {
    const uuid = randomUUID();
    const message = role === "user" ? { role, content: text } : {
      id: `msg_inherit_${uuid.replaceAll("-", "")}`, type: "message", role,
      model: "iris-imported", content: [{ type: "text", text }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    };
    const entry = {
      uuid, parentUuid, isSidechain: false, userType: "external", cwd, sessionId: id,
      timestamp: timestamp || new Date().toISOString(), entrypoint: "cli", type: role, message,
    };
    parentUuid = uuid;
    return JSON.stringify(entry);
  });
  return rows.join("\n") + "\n";
}

export async function importCodexToClaude(source, cwd, { projects = claudeHome("projects") } = {}) {
  const history = await readInheritanceHistory({ ...source, kind: "codex" });
  const id = randomUUID();
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const directory = path.join(projects, slug);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== path.join(await fs.realpath(projects), slug)) {
    throw new Error("Claude 기록 폴더가 다른 위치를 가리킵니다");
  }
  const transcript = path.join(directory, `${id}.jsonl`);
  const scratch = path.join(directory, `.${id}.tmp`);
  const handle = await fs.open(scratch, "wx", 0o600);
  try {
    await handle.writeFile(claudeTranscript(history, cwd, id));
    await handle.sync();
    await fs.link(scratch, transcript);
    return { id, transcript };
  } finally {
    await handle.close();
    await fs.unlink(scratch);
  }
}
