import { createKeyRowStore } from "../key-row.js";
import { redactPrivateText } from "../public-text.js";
import { createHash } from "node:crypto";
import { cellWidth } from "../../cell-width.js";

const MAX_SCREEN_BYTES = 48 * 1024;
const MAX_SCREEN_CELLS = 262144;
const SCROLLBACK_LINES = [400, 200, null];
const POLL_MS = 300;
const READ_TIMEOUT_MS = 2000;

export function terminalMouseMode(raw, truncated = false) {
  if (truncated || typeof raw !== "string") return false;
  const modes = new Map();
  for (const match of raw.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    for (const mode of match[1].split(";").map(Number)) modes.set(mode, match[2] === "h");
  }
  return modes.get(1006) === true && [1000, 1002, 1003].some((mode) => modes.get(mode) === true);
}

const graphemes = new Intl.Segmenter("ko", { granularity: "grapheme" });
function screenText(value, identifiers) {
  const safe = String(value).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "");
  const parts = safe.split(/(\x1b\[[0-9;:?]*[ -/]*[@-~])/g);
  const visible = parts.filter((_part, index) => index % 2 === 0).join("");
  // 색 코드로 나뉜 경로·식별자 검사와 원문 위치 보존
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

const MENU_ITEM = /^\s*((?:(?:[›❯]\s*)?\d+[.)])|[›❯●○])\s+(\S.*)$/u;
// 체크 목록 아래의 번호 없는 제출·다음 줄
const ACTION_LINE = /^\s+(?:[›❯]\s*)?(?:submit|next|done|제출|다음|완료)\s*$/iu;
// 목록 아래 키 안내 줄
export const KEY_HINT = /^(?:press\s+)?(?:enter|esc|tab|shift\+tab|ctrl\+[a-z]|←\/→|↑\/↓)(?=\s).*?(?:\bto\b|\bor\b|\bselect\b|\bback\b|\bcancel\b|\bconfirm\b|\bamend\b|\|)/iu;
const RULE = /^\s*[─━═\-_]{8,}\s*$/u;

// 선택 표시가 있는 목록 하나, 항목 사이의 들여쓴 설명 줄과 구분선 하나는 같은 목록으로 봄
// 줄바꿈으로 나뉜 조각 잇기. 앞 조각이 긴 경로로 끝나면 단어 중간에서 잘린 것이라 공백 없이 이음
export function joinFragments(pieces) {
  let out = "";
  for (const piece of pieces) {
    if (!out) { out = piece; continue; }
    const last = out.split(/\s+/).at(-1);
    out += (last.length >= 35 && last.includes("/") ? "" : " ") + piece;
  }
  return out;
}

export function promptList(text) {
  // 줄 위치를 바꾸는 제어 코드가 남은 화면의 오선택 방지
  if (/\x1b\[(?![0-9;]*m)[0-9;?]*[ -/]*[@-~]/.test(text)) return null;
  const lines = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  const candidates = [];
  lines.forEach((line, index) => {
    const match = line.match(MENU_ITEM);
    const action = ACTION_LINE.test(line);
    if (match || action) candidates.push({ row: index + 1, selected: /^\s*[›❯●]/u.test(line), numbered: action ? null : /\d/.test(match[1]),
      text: line.trim(), description: "" });
  });
  // ❯·› 표시가 우선이고, 없을 때만 ● 를 선택 표시로 봄(요약 목록의 ● 글머리와 구분)
  const arrows = candidates.filter(item => /^[›❯]/u.test(item.text));
  const marked = arrows.length ? arrows : candidates.filter(item => item.selected);
  const between = (from, to, allowRule) => {
    let rules = 0;
    for (let row = from + 1; row < to; row++) {
      const line = lines[row - 1];
      if (!line.trim()) continue;
      if (RULE.test(line)) { if (!allowRule || ++rules > 1) return false; continue; }
      if (!/^\s{3,}\S/.test(line)) return false;
    }
    return true;
  };
  // 표시 줄마다 이어지는 목록을 만들고, 선택지 2개 이상인 목록이 하나일 때만 인정.
  // 위쪽 대화 기록의 › 입력 줄은 선택지가 이어지지 않아 제외됨
  const lists = [];
  for (const mark of marked) {
    let start = candidates.indexOf(mark), end = start;
    while (start > 0 && between(candidates[start - 1].row, candidates[start].row, false)) start--;
    while (end < candidates.length - 1 && between(candidates[end].row, candidates[end + 1].row, true)) end++;
    const items = candidates.slice(start, end + 1);
    if (items.length >= 2 && items.filter(item => item.numbered !== null).every((item, _, kinds) => item.numbered === kinds[0].numbered)) lists.push({ items, mark });
  }
  if (lists.length !== 1) return null;
  const { items, mark: markedItem } = lists[0];
  items.forEach((item, index) => {
    const stop = index + 1 < items.length ? items[index + 1].row : Math.min(lines.length + 1, item.row + 6);
    const below = lines.slice(item.row, stop - 1).map(line => line.trim());
    // 하단 키 안내는 마지막 줄들이라, 좁은 화면에서 둘째 줄로 접힌 부분까지 첫 안내 줄부터 버림
    const footer = below.findIndex(line => KEY_HINT.test(line));
    item.description = joinFragments((footer < 0 ? below : below.slice(0, footer))
      .filter(line => line && !RULE.test(line) && !/^~\/\.claude\/plans\//.test(line))).slice(0, 300);
  });
  return { items, selectedIndex: items.indexOf(markedItem) };
}

export function terminalSelection(text, row) {
  const list = promptList(text);
  const index = list?.items.findIndex(item => item.row === row);
  return list && index >= 0 ? index - list.selectedIndex : null;
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
  const promptReads = new Map();
  const promptScreens = new Map();
  const selecting = new Set();
  const selectedScreens = new Map();
  const log = options.log || ((code) => console.warn(`[remote] ${code}`));
  function failure(code) { log(code); return { ok: false, code }; }

  async function limited(operation) {
    let timer;
    try {
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("terminal read timeout"),
          { code: "terminal-read-timeout" })), options.readTimeoutMs ?? READ_TIMEOUT_MS);
      });
      return await Promise.race([operation(), deadline]);
    } finally { clearTimeout(timer); }
  }
  function readReason(code) { log(`terminal-read reason=${code}`); }

  async function geometry(herdr, paneId) {
    if (typeof herdr.call !== "function") return null;
    const result = await limited(() => herdr.call("pane.layout", { pane_id: paneId }));
    const rect = (result?.layout || result)?.panes?.find((pane) => pane.pane_id === paneId)?.rect;
    return Number.isSafeInteger(rect?.width) && Number.isSafeInteger(rect?.height)
      && rect.width > 0 && rect.height > 0 && rect.width <= 4096 && rect.height <= 4096
      ? { columns: rect.width, rows: rect.height } : null;
  }

  async function read(agent, mouse = true, record = null) {
    const herdr = getHerdr();
    if (!herdr || typeof herdr.paneRead !== "function") return null;
    try {
      const source = agent.source || {};
      const value = await limited(() => herdr.paneRead(source.paneId, "visible", "ansi", false));
      let size;
      try { size = await geometry(herdr, source.paneId); }
      catch (error) {
        if (error.code === "terminal-read-timeout") throw error;
        size = null;
      }
      let mouseMode = false;
      let recentHash = null;
      if (size && (mouse || record)) {
        // 화면 스냅샷에 모드 정보가 없으면 입력 금지
        try {
          const raw = await limited(() => herdr.paneRead(source.paneId, "recent", "ansi", false));
          recentHash = textHash(raw?.text ?? (typeof raw === "string" ? raw : ""));
          mouseMode = !!size && terminalMouseMode(raw?.text ?? raw, !!raw?.truncated);
        } catch (error) {
          if (error.code === "terminal-read-timeout") throw error;
          readReason("terminal-recent-unavailable");
        }
      }
      const original = value?.text ?? (typeof value === "string" ? value : "");
      const text = screenText(original,
        [source.paneId, source.sessionUuid, source.sessionId, source.terminalId, source.workspaceId]);
      const visibleHash = textHash(original);
      let stale = false;
      if (record) {
        if (record.visibleHash !== visibleHash) {
          record.staleSince = null;
          record.recentChanges = 0;
          record.stale = false;
        } else if (recentHash && record.recentHash && recentHash !== record.recentHash) {
          record.staleSince ??= now();
          record.recentChanges = (record.recentChanges || 0) + 1;
          if (record.recentChanges >= 3 && now() - record.staleSince >= 2000) record.stale = true;
        }
        record.visibleHash = visibleHash;
        record.recentHash = recentHash;
        stale = record.stale;
      }
      const error = value?.truncated || Buffer.byteLength(text, "utf8") > MAX_SCREEN_BYTES || size && size.columns * size.rows > MAX_SCREEN_CELLS
        ? "terminal-frame-too-large" : !size ? "terminal-layout-unavailable" : stale ? "terminal-screen-stale" : null;
      const frame = { revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
        text: error === "terminal-frame-too-large" ? "" : text, truncated: false, mouseMode,
        ...(size || {}), ...(error ? { error } : {}) };
      frame.hash = textHash(JSON.stringify([original, size, mouseMode, error]));
      if (error) readReason(error);
      return frame;
    } catch (error) {
      const code = error.code === "terminal-read-timeout" || /herdr timeout:/.test(error.message || "")
        ? "terminal-read-timeout" : "terminal-read-unavailable";
      readReason(code);
      return { revision: 0, text: "", truncated: false, hash: textHash(code), mouseMode: false, error: code };
    }
  }

  function remember(record, frame) { record.revision = frame.revision; record.hash = frame.hash; record.frame = frame; }
  function push(record, frame) {
    if (frame && frame.hash !== record.hash) {
      remember(record, frame);
      send(record.connId, { type: "terminal.frame", agent: record.agentRef, ...frame });
    }
  }
  function schedule(record) {
    if (watches.get(record.connId) !== record || record.timer) return;
    record.timer = setTimer(() => { record.timer = null; void poll(record); }, POLL_MS);
    record.timer?.unref?.();
  }
  async function poll(record) {
    if (watches.get(record.connId) !== record) return;
    if (record.reading) { schedule(record); return; }
    record.reading = true;
    let frame;
    try {
      const agent = agents.resolve(record.agentRef);
      frame = agent ? await read(agent, true, record) : null;
    } catch {
      readReason("terminal-agent-unavailable");
    } finally { record.reading = false; }
    if (watches.get(record.connId) !== record) return;
    push(record, frame);
    schedule(record);
  }
  async function refresh(record) {
    if (!record || watches.get(record.connId) !== record || record.reading) return;
    record.reading = true;
    let frame;
    try {
      const agent = agents.resolve(record.agentRef);
      frame = agent ? await read(agent, true, record) : null;
    } catch {
      readReason("terminal-agent-unavailable");
    } finally { record.reading = false; }
    if (watches.get(record.connId) === record) push(record, frame);
  }
  async function touch(entry, message, mouse) {
    const reject = code => { if (!mouse) log(`prompt reason=${code}`); return failure(code); };
    const record = watches.get(entry.connId);
    if (!record || record.agentRef !== message.agent) return reject("forbidden");
    if (touching.has(entry.connId) || now() - (lastTouch.get(entry.connId) ?? -Infinity) < 100) return reject("busy");
    if (!mouse && selecting.has(message.agent)) return reject("busy");
    touching.add(entry.connId); lastTouch.set(entry.connId, now());
    if (!mouse) selecting.add(message.agent);
    try {
      await agents.refresh?.();
      const agent = agents.resolve(message.agent);
      if (!agent) return reject("forbidden");
      const frame = await read(agent, true, record);
      if (!frame) return reject("unavailable");
      push(record, frame);
      if (frame.error) return reject(frame.error);
      if (frame.hash !== message.hash || frame.columns !== message.columns || frame.rows !== message.rows) { log("prompt reason=stale-screen"); return reject("terminal-stale-screen"); }
      if (!Number.isSafeInteger(message.row) || message.row < 1 || message.row > frame.rows
        || mouse && (!Number.isSafeInteger(message.column) || message.column < 1 || message.column > frame.columns)) return reject("invalid-request");
      let bytes;
      if (mouse) {
        if (!frame.mouseMode) return reject("terminal-mouse-unavailable");
        bytes = encodeTerminalMouse(message);
      } else {
        if (promptScreens.get(message.agent) === frame.hash && selectedScreens.get(message.agent) === frame.hash) {
          log("prompt reason=already-submitted");
          return reject("terminal-stale-screen");
        }
        const difference = terminalSelection(frame.text, message.row);
        if (difference == null) return reject("terminal-selection-unavailable");
        bytes = (difference < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(difference)) + "\r";
      }
      if (!bytes) return reject("invalid-request");
      await agents.refresh?.();
      const current = agents.resolve(message.agent);
      if (!current || current.source.paneId !== agent.source.paneId) return reject("forbidden");
      const verifiedSize = await geometry(getHerdr(), current.source.paneId);
      if (verifiedSize?.columns !== frame.columns || verifiedSize?.rows !== frame.rows) return reject("terminal-stale-screen");
      if (!mouse && promptScreens.get(message.agent) === frame.hash) {
        selectedScreens.set(message.agent, frame.hash);
        if (selectedScreens.size > 128) selectedScreens.delete(selectedScreens.keys().next().value);
      }
      await getHerdr().paneSendText(current.source.paneId, bytes);
      await refresh(record);
      return { ok: true };
    } catch { return reject("unavailable"); }
    finally { touching.delete(entry.connId); if (!mouse) selecting.delete(message.agent); }
  }

  return {
    available,
    readPrompt(agent) {
      let record = promptReads.get(agent.ref);
      if (!record) {
        record = {}; promptReads.set(agent.ref, record);
        if (promptReads.size > 128) promptReads.delete(promptReads.keys().next().value);
      }
      return read(agent, true, record);
    },
    markPrompt(agent, hash) { promptScreens.set(agent, hash); if (promptScreens.size > 128) promptScreens.delete(promptScreens.keys().next().value); },
    async watch(entry, agentRef) {
      await agents.refresh?.();
      const agent = agents.resolve(agentRef);
      if (!agent) return null;
      this.closeConnection(entry.connId);
      const record = { connId: entry.connId, agentRef, revision: 0, timer: null, reading: true };
      watches.set(entry.connId, record);
      const frame = await read(agent, true, record);
      record.reading = false;
      if (watches.get(entry.connId) !== record) return null;
      if (!frame) { watches.delete(entry.connId); return null; }
      remember(record, frame);
      schedule(record);
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
        const size = await geometry(herdr, agent.source.paneId);
        if (!size) return failure("terminal-layout-unavailable");
        const source = agent.source;
        // 깊은 기록부터 시도, 크기 상한을 넘으면 줄 수를 줄이고 마지막은 herdr 기본 분량
        for (const lines of SCROLLBACK_LINES) {
          const value = await limited(() => herdr.paneRead(agent.source.paneId, "recent", "ansi", false, lines));
          const text = screenText(value?.text ?? "", [source.paneId, source.sessionUuid, source.sessionId, source.terminalId, source.workspaceId]);
          if (value?.truncated || Buffer.byteLength(text, "utf8") > MAX_SCREEN_BYTES) continue;
          const lineCount = Math.max(1, text.split(/\r?\n/).length);
          if (size.columns * lineCount > MAX_SCREEN_CELLS) continue;
          return { ok: true, text, columns: size.columns, lineCount };
        }
        return failure("terminal-frame-too-large");
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
