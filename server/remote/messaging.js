import { execFile as nodeExecFile } from "node:child_process";
import { resolveCodexSession } from "../codex-session.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function paneMessage(text) {
  return `${BRACKETED_PASTE_START}${text.replace(/\r\n?/g, "\n")}${BRACKETED_PASTE_END}\r`;
}

export function createMessageBridge(options = {}) {
  const execFile = options.execFile || nodeExecFile;
  const codexExecutable = options.codexExecutable || "codex";
  const getHerdr = options.getHerdr || (() => null);
  let claudeChannel = null;

  function registerClaudeMessageChannel(channel) {
    if (!channel || typeof channel.send !== "function" || typeof channel.canSend !== "function") {
      throw new TypeError("Claude channel must provide send and canSend");
    }
    claudeChannel = channel;
    return () => { if (claudeChannel === channel) claudeChannel = null; };
  }

  function canMessage(agent) {
    if (agent.kind === "codex") return UUID.test(agent.source.sessionUuid || "");
    if (agent.kind !== "claude") return false;
    try {
      if (claudeChannel?.canSend(agent.source) === true) return true;
    } catch {}
    const herdr = getHerdr();
    return typeof agent.source?.paneId === "string" && !!agent.source.paneId
      && typeof herdr?.paneSendText === "function";
  }

  function sendCodex(agent, text) {
    const uuid = agent.source.sessionUuid;
    if (!UUID.test(uuid || "")) return Promise.resolve("failed");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        execFile(codexExecutable, ["queue", "--thread", uuid, "--message", text], {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        }, (error) => finish(error ? "failed" : "sent"));
      } catch {
        finish("failed");
      }
    });
  }

  async function send(agent, text, resolveCurrent) {
    if (!["codex", "claude"].includes(agent.kind)) return "unsupported";
    let current = typeof resolveCurrent === "function" ? resolveCurrent() : agent;
    if (!current) return "forbidden";
    try {
      if (current.kind === "claude" && claudeChannel?.canSend(current.source) === true) {
        current = typeof resolveCurrent === "function" ? resolveCurrent() : current;
        if (!current) return "forbidden";
        return await claudeChannel.send(current.source, text) === "sent" ? "sent" : "failed";
      }
    } catch {
      return "failed";
    }
    const herdr = getHerdr();
    current = typeof resolveCurrent === "function" ? resolveCurrent() : current;
    if (!current) return "forbidden";
    // 로컬 TUI는 --no-daemon일 수 있다. 전송 실패 뒤 queue로 재시도하면 중복 입력될 수 있다.
    if (current.kind === "codex" && typeof herdr?.paneSendText !== "function") return sendCodex(current, text);
    if (!current.source?.paneId || typeof herdr?.paneSendText !== "function") return "unsupported";
    try {
      if (current.kind === "codex" && typeof herdr.paneGet === "function") {
        const live = await resolveCodexSession(herdr, current.source.paneId);
        current = typeof resolveCurrent === "function" ? resolveCurrent() : current;
        if (!current || !live || live.uuid !== current.source.sessionUuid) return "forbidden";
      }
      await herdr.paneSendText(current.source.paneId, paneMessage(text));
      return "sent";
    } catch {
      return "failed";
    }
  }

  return { registerClaudeMessageChannel, canMessage, send };
}
