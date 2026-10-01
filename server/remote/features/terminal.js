import { createKeyRowStore } from "../key-row.js";
import { redactPrivateText } from "../public-text.js";
import { createHash } from "node:crypto";

const MAX_SCREEN_BYTES = 48 * 1024;
const MAX_SCREEN_CELLS = 262144;
const POLL_MS = 300;

export function terminalMouseMode(raw, truncated = false) {
  if (truncated || typeof raw !== "string") return false;
  const modes = new Map();
  for (const match of raw.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    for (const mode of match[1].split(";").map(Number)) modes.set(mode, match[2] === "h");
  }
  return modes.get(1006) === true && [1000, 1002, 1003].some((mode) => modes.get(mode) === true);
}

const graphemes = new Intl.Segmenter("ko", { granularity: "grapheme" });
function cellWidth(text) {
  let result = 0;
  for (const { segment } of graphemes.segment(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))) {
    const point = segment.codePointAt(0);
    if (point < 32 || point >= 0x300 && point <= 0x36f || point >= 0xfe00 && point <= 0xfe0f) continue;
    result += point >= 0x1100 && point <= 0x115f || point === 0x2329 || point === 0x232a
      || point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f
      || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff
      || point >= 0xfe10 && point <= 0xfe19 || point >= 0xfe30 && point <= 0xfe6f
      || point >= 0xff00 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
      || point >= 0x1f1e6 && point <= 0x1faff || point >= 0x20000 && point <= 0x3fffd
      || segment.includes("\ufe0f") || segment.includes("\u20e3") ? 2 : 1;
  }
  return result;
}
function screenText(value, identifiers) {
  const safe = String(value).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "");
  const parts = safe.split(/(\x1b\[[0-9;:?]*[ -/]*[@-~])/g);
  const visible = parts.filter((_part, index) => index % 2 === 0).join("");
  // 색 코드가 경로·식별자 중간에 있어도 전체 문자열에서 찾는다. 같은 UTF-16 길이로 표시해 원문 위치를 유지한다.
  const marked = redactPrivateText(visible, identifiers, (_label, original) => "\0".repeat(original.length));
  if (marked === visible) return safe;
  let offset = 0;
  return parts.map((part, index) => {
    if (index % 2) return part;
    if (marked.slice(offset, offset + part.length) === part) { offset += part.length; return part; }
    const text = [...graphemes.segment(part)].map(({ segment, index: start }) =>
      marked.slice(offset + start, offset + start + segment.length) === segment
        ? segment : "•".repeat(cellWidth(segment))).join("");
    offset += part.length;
    return text;
  }).join("");
}

function textHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function terminalSelection(text, row) {
  // 줄 위치를 바꾸는 제어 코드가 남은 화면의 오선택 방지
  if (/\x1b\[(?![0-9;]*m)[0-9;?]*[ -/]*[@-~]/.test(text)) return null;
  const lines = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  const candidates = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*((?:(?:[›❯]\s*)?\d+[.)])|[›❯●○])\s+(\S.*)$/u);
    if (match) candidates.push({ row: index + 1, selected: /^[›❯●]/u.test(match[1]), numbered: /\d/.test(match[1]) });
  }
  // 한 목록과 한 선택 표시만 허용
  if (candidates.length < 2 || candidates.some((item, index) => index > 0 && item.row !== candidates[index - 1].row + 1)) return null;
  const selected = candidates.filter((item) => item.selected);
  if (selected.length !== 1 || !candidates.some((item) => item.row === row)) return null;
  if (candidates.some((item) => item.numbered !== candidates[0].numbered)) return null;
  return row - selected[0].row;
}

export function encodeTerminalMouse(message) {
  const point = (button, released = false) => `\x1b[<${button};${message.column};${message.row}${released ? "m" : "M"}`;
  const click = (button = 0) => point(button) + point(button, true);
  switch (message.action) {
    case "click": return click();
    case "double": return click() + click();
    case "context": return click(2);
    case "down": return point(0);
    case "drag": return point(32);
    case "up": return point(0, true);
    case "wheel": return point(message.dy < 0 ? 64 : 65);
    default: return null;
  }
}

function modifierCode(modifiers) {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0)
    + (modifiers.cmd ? 8 : 0);
}

export function encodeTerminalKey(key, modifiers) {
  const named = {
    Enter: "\r", Escape: "\x1b", Esc: "\x1b", Tab: "\t", Backspace: "\x7f",
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
    Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~", Delete: "\x1b[3~",
  };
  const hasModifiers = modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.cmd;
  if (!hasModifiers) return named[key] || key;
  if (!modifiers.cmd && !modifiers.shift && modifiers.ctrl && [...key].length === 1) {
    const code = key.toUpperCase().codePointAt(0);
    if (code >= 64 && code <= 95) return String.fromCodePoint(code - 64);
  }
  if (!modifiers.cmd && modifiers.alt && !modifiers.ctrl && !modifiers.shift) {
    return "\x1b" + (named[key] || key);
  }
  const arrows = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
  const mod = modifierCode(modifiers);
  if (arrows[key]) return `\x1b[1;${mod}${arrows[key]}`;
  const point = key === "Enter" ? 13 : key === "Tab" ? 9 : key === "Escape" || key === "Esc" ? 27
    : [...key].length === 1 ? key.codePointAt(0) : null;
  return point == null ? null : `\x1b[${point};${mod}u`;
}

export function createTerminalFeature(options) {
  const getHerdr = options.getHerdr || (() => null);
  const agents = options.agents;
  const send = options.send;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const keyRows = options.keyRows || createKeyRowStore({ stateDir: options.stateDir });
  const watches = new Map();

  function available() {
    const herdr = getHerdr();
    return !!herdr && typeof herdr.paneRead === "function" && typeof herdr.paneSendText === "function";
  }

  const now = options.now || Date.now;
  const touching = new Set();
  const lastTouch = new Map();
  const log = options.log || ((code) => console.warn(`[remote] ${code}`));
  function failure(code) { log(code); return { ok: false, code }; }

  async function geometry(herdr, paneId) {
    if (typeof herdr.call !== "function") return null;
    const result = await herdr.call("pane.layout", { pane_id: paneId });
    const rect = (result?.layout || result)?.panes?.find((pane) => pane.pane_id === paneId)?.rect;
    return Number.isSafeInteger(rect?.width) && Number.isSafeInteger(rect?.height)
      && rect.width > 0 && rect.height > 0 && rect.width <= 4096 && rect.height <= 4096
      ? { columns: rect.width, rows: rect.height } : null;
  }

  async function read(agent, mouse = true) {
    const herdr = getHerdr();
    if (!herdr || typeof herdr.paneRead !== "function") return null;
    try {
      const source = agent.source || {};
      const value = await herdr.paneRead(source.paneId, "visible", "ansi", false);
      const size = await geometry(herdr, source.paneId);
      let mouseMode = false;
      if (mouse && size) {
        // 화면 스냅샷에 모드 정보가 없으면 입력 금지
        try {
          const raw = await herdr.paneRead(source.paneId, "recent", "ansi", false);
          mouseMode = terminalMouseMode(raw?.text ?? raw, !!raw?.truncated);
        } catch { /* 모드 확인 실패 시 입력 금지 */ }
      }
      const original = value?.text ?? (typeof value === "string" ? value : "");
      const text = screenText(original,
        [source.paneId, source.sessionUuid, source.sessionId, source.terminalId, source.workspaceId]);
      const error = value?.truncated || Buffer.byteLength(text, "utf8") > MAX_SCREEN_BYTES || size && size.columns * size.rows > MAX_SCREEN_CELLS
        ? "terminal-frame-too-large" : size ? null : "terminal-layout-unavailable";
      const frame = { revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
        text: error === "terminal-frame-too-large" ? "" : text, truncated: false, mouseMode,
        ...(size || {}), ...(error ? { error } : {}) };
      frame.hash = textHash(JSON.stringify([original, size, mouseMode, error]));
      if (error) log(error);
      return frame;
    } catch {
      log("terminal-read-unavailable");
      return { revision: 0, text: "", truncated: false, hash: textHash("terminal-read-unavailable"), mouseMode: false, error: "terminal-read-unavailable" };
    }
  }

  function remember(record, frame) { record.revision = frame.revision; record.hash = frame.hash; record.frame = frame; }
  function push(record, frame) {
    if (frame && frame.hash !== record.hash) {
      remember(record, frame);
      send(record.connId, { type: "terminal.frame", agent: record.agentRef, ...frame });
    }
  }
  async function poll(record) {
    if (watches.get(record.connId) !== record || record.reading) return;
    record.reading = true;
    const agent = agents.resolve(record.agentRef);
    const frame = agent ? await read(agent) : null;
    record.reading = false;
    if (watches.get(record.connId) !== record) return;
    push(record, frame);
    record.timer = setTimer(() => { record.timer = null; void poll(record); }, POLL_MS);
    record.timer?.unref?.();
  }
  async function refresh(record) {
    if (!record || watches.get(record.connId) !== record || record.reading) return;
    record.reading = true;
    const agent = agents.resolve(record.agentRef);
    const frame = agent ? await read(agent) : null;
    record.reading = false;
    if (watches.get(record.connId) === record) push(record, frame);
  }
  async function touch(entry, message, mouse) {
    const record = watches.get(entry.connId);
    if (!record || record.agentRef !== message.agent) return failure("forbidden");
    if (touching.has(entry.connId) || now() - (lastTouch.get(entry.connId) ?? -Infinity) < 100) return failure("busy");
    touching.add(entry.connId); lastTouch.set(entry.connId, now());
    try {
      await agents.refresh?.();
      const agent = agents.resolve(message.agent);
      if (!agent) return failure("forbidden");
      const frame = await read(agent);
      if (!frame) return failure("unavailable");
      push(record, frame);
      if (frame.error) return failure(frame.error);
      if (frame.hash !== message.hash || frame.columns !== message.columns || frame.rows !== message.rows) return failure("terminal-stale-screen");
      if (!Number.isSafeInteger(message.row) || message.row < 1 || message.row > frame.rows
        || mouse && (!Number.isSafeInteger(message.column) || message.column < 1 || message.column > frame.columns)) return failure("invalid-request");
      let bytes;
      if (mouse) {
        if (!frame.mouseMode) return failure("terminal-mouse-unavailable");
        bytes = encodeTerminalMouse(message);
      } else {
        const difference = terminalSelection(frame.text, message.row);
        if (difference == null) return failure("terminal-selection-unavailable");
        bytes = (difference < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(difference)) + "\r";
      }
      if (!bytes) return failure("invalid-request");
      await agents.refresh?.();
      const current = agents.resolve(message.agent);
      if (!current || current.source.paneId !== agent.source.paneId) return failure("forbidden");
      const verifiedSize = await geometry(getHerdr(), current.source.paneId);
      if (verifiedSize?.columns !== frame.columns || verifiedSize?.rows !== frame.rows) return failure("terminal-stale-screen");
      await getHerdr().paneSendText(current.source.paneId, bytes);
      await refresh(record);
      return { ok: true };
    } catch { return failure("unavailable"); }
    finally { touching.delete(entry.connId); }
  }

  return {
    available,
    async watch(entry, agentRef) {
      await agents.refresh?.();
      const agent = agents.resolve(agentRef);
      if (!agent) return null;
      this.closeConnection(entry.connId);
      const record = { connId: entry.connId, agentRef, revision: 0, timer: null, reading: true };
      watches.set(entry.connId, record);
      const frame = await read(agent);
      record.reading = false;
      if (watches.get(entry.connId) !== record) return null;
      if (!frame) { watches.delete(entry.connId); return null; }
      remember(record, frame);
      record.timer = setTimer(() => { record.timer = null; void poll(record); }, POLL_MS);
      record.timer?.unref?.();
      return frame;
    },
    async input(agentRef, text) {
      await agents.refresh?.();
      const agent = agents.resolve(agentRef), herdr = getHerdr();
      if (!agent || !herdr?.paneSendText) return false;
      const current = agents.resolve(agentRef);
      if (!current) return false;
      try { await herdr.paneSendText(current.source.paneId, text); return true; } catch { return false; }
    },
    async submit(entry, agentRef, text) {
      const sent = await this.input(agentRef, `\x1b[200~${text.replace(/\r\n?/g, "\n")}\x1b[201~\r`);
      if (sent) await refresh(watches.get(entry.connId));
      return sent;
    },
    async key(agentRef, key, modifiers) {
      const encoded = encodeTerminalKey(key, modifiers);
      return encoded != null && this.input(agentRef, encoded);
    },
    async scrollback(agentRef) {
      await agents.refresh?.();
      const agent = agents.resolve(agentRef), herdr = getHerdr();
      if (!agent) return failure("forbidden");
      try {
        const value = await herdr.paneRead(agent.source.paneId, "recent", "ansi", false);
        const size = await geometry(herdr, agent.source.paneId);
        if (!size) return failure("terminal-layout-unavailable");
        const source = agent.source;
        const text = screenText(value?.text ?? "", [source.paneId, source.sessionUuid, source.sessionId, source.terminalId, source.workspaceId]);
        if (value?.truncated || Buffer.byteLength(text, "utf8") > MAX_SCREEN_BYTES) return failure("terminal-frame-too-large");
        const lineCount = Math.max(1, text.split(/\r?\n/).length);
        if (size.columns * lineCount > MAX_SCREEN_CELLS) return failure("terminal-frame-too-large");
        return { ok: true, text, columns: size.columns, lineCount };
      } catch { return failure("terminal-read-unavailable"); }
    },
    select(entry, message) { return touch(entry, message, false); },
    mouse(entry, message) { return touch(entry, message, true); },
    keys() { return keyRows.get(); },
    setKeys(keys) { return keyRows.set(keys); },
    closeConnection(connId) {
      const record = watches.get(connId);
      if (!record) return;
      if (record.timer) clearTimer(record.timer);
      watches.delete(connId);
      lastTouch.delete(connId);
    },
    close() { for (const connId of [...watches.keys()]) this.closeConnection(connId); },
  };
}
