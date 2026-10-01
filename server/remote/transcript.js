import { randomBytes as nodeRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { claudeHome, codexHome } from "../agent-homes.js";
import { readForward, readTailWindow } from "../agent-chat-transcript.js";
import stateHomeModule from "../state-home.cjs";
import { mediaText } from "./media-links.js";
import { projectItem, projectTranscriptAppend } from "./projection.js";

const { stateHome } = stateHomeModule;
const PAGE_ITEMS = 50;
const PAGE_BYTES = 48 * 1024;
const READ_BYTES = 2 * 1024 * 1024;
const POLL_MS = 1000;
const CURSOR_LIMIT = 128;

function inside(root, file) {
  return !!root && (file === root || file.startsWith(root + path.sep));
}

function real(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

function clip(value, limit) {
  const chars = Array.from(String(value || ""));
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}

function oneLine(value) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { text = ""; }
  return clip(String(text || "").replace(/\s+/g, " ").trim(), 200);
}

function itemsOf(messages, agent) {
  const item = (value) => projectItem({ ...value, text: clip(mediaText(value.text, agent), 4000) });
  const tools = new Map();
  const items = [];
  for (const message of messages || []) {
    if (!message || !["user", "assistant", "tool"].includes(message.role)) continue;
    const at = Number.isSafeInteger(message.ts) && message.ts >= 0 ? message.ts : undefined;
    const text = (message.blocks || []).filter((block) => block?.type === "text")
      .map((block) => block.text).join("\n").trim();
    if (text) items.push(item({ role: message.role, text: clip(text, 4000), ...(at === undefined ? {} : { at }) }));
    for (const block of message.blocks || []) {
      if (block?.type === "tool-call") {
        const tool = clip(block.name || "tool", 200) || "tool";
        if (block.id) tools.set(block.id, tool);
        items.push(item({ role: "tool", text: oneLine(block.input), tool, ...(at === undefined ? {} : { at }) }));
      } else if (block?.type === "tool-result") {
        const tool = block.id && tools.get(block.id);
        const output = clip(block.output || "", 4000);
        if (output) items.push(item({ role: "tool", text: output,
          ...(tool ? { tool } : {}), ...(at === undefined ? {} : { at }) }));
      }
    }
  }
  return items;
}

function takePage(items) {
  const selected = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (selected.length ? 1 : 0);
    if (selected.length >= PAGE_ITEMS || bytes + itemBytes > PAGE_BYTES) break;
    selected.push(item);
    bytes += itemBytes;
  }
  return { selected, rest: items.slice(selected.length) };
}

function fileSource(fd, size) {
  return { size, readAt: (buffer, position) => fs.readSync(fd, buffer, 0, buffer.length, position) };
}

function withFile(file, fn) {
  const fd = fs.openSync(file, "r");
  try { return fn(fd, fs.fstatSync(fd)); } finally { fs.closeSync(fd); }
}

function completeEndWithin(source, maximumBytes = READ_BYTES) {
  let position = source.size;
  let read = 0;
  while (position > 0 && read < maximumBytes) {
    const length = Math.min(64 * 1024, position, maximumBytes - read);
    position -= length;
    const buffer = Buffer.alloc(length);
    const got = source.readAt(buffer, position);
    read += got;
    const newline = buffer.subarray(0, got).lastIndexOf(10);
    if (newline >= 0) return { end: position + newline + 1, read };
    if (got < length) break;
  }
  return { end: 0, read };
}

export function createTranscriptService(options = {}) {
  const agents = options.agents;
  if (!agents || typeof agents.resolve !== "function") throw new TypeError("agent store is required");
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const allowedRoots = [real(claudeHome("projects")), real(codexHome("sessions"))].filter(Boolean);
  const forbiddenRoot = real(options.stateDir || stateHome());
  const cursors = new Map();
  const watches = new Map();

  function target(agentRef) {
    const agent = agents.resolve(agentRef);
    if (!agent) return null;
    const candidate = agent.kind === "claude" ? agent.source.transcriptFile
      : agent.kind === "codex" ? agent.source.sessionFile : null;
    const file = candidate ? real(candidate) : null;
    if (!file || !allowedRoots.some((root) => inside(root, file)) || inside(forbiddenRoot, file)) return null;
    return { agent, file, kind: agent.kind };
  }

  function cursorMap(connId) {
    let map = cursors.get(connId);
    if (!map) { map = new Map(); cursors.set(connId, map); }
    return map;
  }

  function saveCursor(connId, value) {
    const map = cursorMap(connId);
    let token;
    for (let attempt = 0; !token && attempt < 64; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (!map.has(candidate)) token = candidate;
    }
    if (!token) throw new Error("transcript-cursor-unavailable");
    map.set(token, value);
    while (map.size > CURSOR_LIMIT) map.delete(map.keys().next().value);
    return token;
  }

  function readOlder(hit, end) {
    return withFile(hit.file, (fd, stat) => {
      const boundedEnd = Math.min(Math.max(0, end), stat.size);
      const source = fileSource(fd, stat.size);
      const tail = end == null ? completeEndWithin(source) : { end: boundedEnd, read: 0 };
      const complete = tail.end;
      const stopAt = Math.max(0, complete - (READ_BYTES - tail.read));
      const window = readTailWindow(source, { end: complete, stopAt, want: PAGE_ITEMS, kind: hit.kind });
      return { items: itemsOf(window.messages, hit.agent).reverse(), end: window.start,
        hasOlder: window.hasOlder || stopAt > 0 };
    });
  }

  function page(connId, agentRef, before) {
    const hit = target(agentRef);
    if (!hit) return { ok: false, error: "forbidden" };
    let pending = [];
    let end = null;
    let hasOlder = false;
    if (before !== undefined) {
      const map = cursors.get(connId);
      const cursor = map?.get(before);
      if (!cursor || cursor.agent !== agentRef || cursor.file !== hit.file) return { ok: false, error: "invalid-request" };
      map.delete(before);
      pending = cursor.pending;
      end = cursor.end;
      hasOlder = cursor.hasOlder;
    }
    if (!pending.length && (end === null || hasOlder)) {
      try {
        const read = readOlder(hit, end);
        pending = read.items;
        end = read.end;
        hasOlder = read.hasOlder;
      } catch {
        return { ok: false, error: "unavailable" };
      }
    }
    const taken = takePage(pending);
    const next = taken.rest.length || hasOlder
      ? saveCursor(connId, { agent: agentRef, file: hit.file, pending: taken.rest, end, hasOlder }) : null;
    return { ok: true, items: taken.selected, before: next };
  }

  function stopWatch(connId) {
    const watch = watches.get(connId);
    if (!watch) return false;
    watch.closed = true;
    if (watch.timer) clearTimer(watch.timer);
    watches.delete(connId);
    return true;
  }

  function schedule(watch, delay = POLL_MS) {
    if (watch.closed) return;
    watch.timer = setTimer(() => void poll(watch), delay);
    watch.timer?.unref?.();
  }

  async function poll(watch) {
    if (watch.closed || watch.busy) return;
    watch.busy = true;
    try {
      const hit = target(watch.agent);
      if (!hit) return;
      if (hit.file !== watch.file) {
        watch.file = hit.file;
        watch.kind = hit.kind;
        watch.pending = [];
        watch.end = withFile(hit.file, (fd, stat) => completeEndWithin(fileSource(fd, stat.size)).end);
      }
      if (!watch.pending.length) {
        withFile(hit.file, (fd, stat) => {
          if (stat.size < watch.end) {
            watch.end = completeEndWithin(fileSource(fd, stat.size)).end;
            return;
          }
          const maximum = Math.min(stat.size, watch.end + READ_BYTES);
          const result = readForward(fileSource(fd, maximum), watch.end, watch.kind);
          watch.end = result.end;
          watch.pending.push(...itemsOf(result.messages, hit.agent));
        });
      }
      if (watch.pending.length) {
        const taken = takePage(watch.pending);
        watch.pending = taken.rest;
        if (taken.selected.length) watch.send(projectTranscriptAppend({ agent: watch.agent, items: taken.selected }));
      }
    } catch {}
    finally {
      watch.busy = false;
      schedule(watch);
    }
  }

  function watch(connId, agentRef, send) {
    const hit = target(agentRef);
    if (!hit) return { ok: false, error: "forbidden" };
    let end;
    try { end = withFile(hit.file, (fd, stat) => completeEndWithin(fileSource(fd, stat.size)).end); }
    catch { return { ok: false, error: "unavailable" }; }
    stopWatch(connId);
    const record = { connId, agent: agentRef, file: hit.file, kind: hit.kind, end, pending: [],
      send, timer: null, busy: false, closed: false };
    watches.set(connId, record);
    schedule(record);
    return { ok: true };
  }

  function closeConnection(connId) {
    stopWatch(connId);
    cursors.delete(connId);
  }

  function close() {
    for (const connId of [...watches.keys()]) stopWatch(connId);
    cursors.clear();
  }

  function refreshAgent(agentRef) {
    for (const watch of watches.values()) {
      if (watch.agent !== agentRef || watch.busy) continue;
      if (watch.timer) clearTimer(watch.timer);
      schedule(watch, 0);
    }
  }

  return { page, watch, refreshAgent, closeConnection, close };
}
