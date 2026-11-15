import { randomBytes as nodeRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { claudeHome, codexHome } from "../agent-homes.js";
import { imageFromRecord, readForward, readTailWindow } from "../agent-chat-transcript.js";
import stateHomeModule from "../state-home.cjs";
import { mediaImage, mediaText, resolveMediaImage } from "./media-links.js";
import { projectItem, projectTranscriptAppend } from "./projection.js";

const { stateHome } = stateHomeModule;
const PAGE_ITEMS = 50;
const PAGE_BYTES = 48 * 1024;
// 한 번에 읽는 기록 범위. 스크린샷이 든 줄은 수 MB 라 그보다 커야 줄을 통째로 읽음
const READ_BYTES = 32 * 1024 * 1024;
// 파일 끝의 마지막 완성 줄을 찾을 때 거슬러 읽는 한도. 쓰이는 중인 큰 줄 하나 때문에 많이 읽지 않게
const TAIL_PROBE_BYTES = 2 * 1024 * 1024;
const POLL_MS = 1000;
const CURSOR_LIMIT = 128;
// 폰이 그릴 수 있는 형식만. 한 번 응답에 담는 원본 바이트(base64 로 늘어도 큰 프레임 한도 안)
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_CHUNK_BYTES = 360 * 1024;
const MAX_IMAGE_LINE = 64 * 1024 * 1024;
const IMAGE_TEXT = "[이미지]";

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

// 항목 글 상한. 이미지 주소는 이 안에서 잘리지 않게 통째로 넣고 남는 것은 개수만 적음
const ITEM_TEXT = 4000;
const IMAGE_LINE = "![이미지](iris-image:" + "0".repeat(32) + ")";

// 글(파일 링크를 바꾼 뒤)을 이미지 주소 자리를 남기고 자르고, 이미지 주소를 줄마다 붙임
export function joinImages(text, refs) {
  const room = Math.max(0, ITEM_TEXT - (text ? 1 : 0));
  const fit = Math.min(refs.length, Math.floor((room + 1) / (IMAGE_LINE.length + 1)));
  const shown = refs.slice(0, fit).map((ref) => `![이미지](${ref})`);
  if (fit < refs.length) shown.push(`이미지 ${refs.length - fit}개 더`);
  const tail = shown.join("\n");
  if (!tail) return clip(text, ITEM_TEXT);
  const head = clip(text, Math.max(0, ITEM_TEXT - tail.length - 1));
  return head ? `${head}\n${tail}` : tail;
}

// 도구 결과 글에서 해석기가 이미지 자리에 넣은 "[이미지]" 줄만 이미지 수만큼 뺌. 문장 속 같은 글자는 둠
export function withoutImageLines(output, count) {
  let left = count;
  return String(output || "").split("\n").filter((line) => !(left > 0 && line === IMAGE_TEXT && left--)).join("\n").trim();
}

// source: { file, ino } 읽은 기록 파일. 이미지 블록은 그 파일의 줄 위치·서명으로 iris-image 주소를 만듦
function itemsOf(messages, agent, source) {
  const item = (value, refs = []) => projectItem({ ...value, text: joinImages(mediaText(value.text, agent), refs) });
  const image = (off, i, j, sig) => (source && Number.isSafeInteger(off)
    ? mediaImage(agent, { file: source.file, ino: source.ino, off, i, j, sig: typeof sig === "string" ? sig : null }) : null);
  const tools = new Map();
  const items = [];
  for (const message of messages || []) {
    if (!message || !["user", "assistant", "tool"].includes(message.role)) continue;
    const at = Number.isSafeInteger(message.ts) && message.ts >= 0 ? message.ts : undefined;
    const text = (message.blocks || []).filter((block) => block?.type === "text")
      .map((block) => block.text).join("\n").trim();
    const refs = (message.blocks || []).filter((block) => block?.type === "image")
      .map((block) => image(block.off, block.i, null, block.sig)).filter(Boolean);
    if (text || refs.length) items.push(item({ role: message.role, text, ...(at === undefined ? {} : { at }) }, refs));
    for (const block of message.blocks || []) {
      if (block?.type === "tool-call") {
        const tool = clip(block.name || "tool", 200) || "tool";
        if (block.id) tools.set(block.id, tool);
        items.push(item({ role: "tool", text: oneLine(block.input), tool, ...(at === undefined ? {} : { at }) }));
      } else if (block?.type === "tool-result") {
        const tool = block.id && tools.get(block.id);
        const refs = (Array.isArray(block.images) ? block.images : [])
          .map((spot) => image(block.off, spot.i, spot.j, spot.sig)).filter(Boolean);
        const output = refs.length ? withoutImageLines(block.output, refs.length) : String(block.output || "");
        if (output || refs.length) items.push(item({ role: "tool", text: output,
          ...(tool ? { tool } : {}), ...(at === undefined ? {} : { at }) }, refs));
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

function completeEndWithin(source, maximumBytes = TAIL_PROBE_BYTES) {
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

// off 에서 시작하는 한 줄을 JSON 으로. MAX_IMAGE_LINE 을 넘거나 깨진 줄은 null
function readLine(fd, size, off) {
  const chunks = [];
  let position = off;
  let total = 0;
  while (total < MAX_IMAGE_LINE && position < size) {
    const buffer = Buffer.alloc(Math.min(1024 * 1024, size - position));
    const got = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (got <= 0) break;
    const newline = buffer.subarray(0, got).indexOf(10);
    chunks.push(buffer.subarray(0, newline < 0 ? got : newline));
    total += newline < 0 ? got : newline;
    if (newline >= 0) break;
    position += got;
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

// from 뒤 첫 줄 끝 다음 위치. 읽기 범위보다 큰 줄을 건너뛸 때. 끝까지 개행이 없으면 null
function nextLineStart(fd, size, from) {
  const buffer = Buffer.alloc(1024 * 1024);
  for (let position = from; position < size;) {
    const got = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (got <= 0) return null;
    const newline = buffer.subarray(0, got).indexOf(10);
    if (newline >= 0) return position + newline + 1;
    position += got;
  }
  return null;
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
      return { items: itemsOf(window.messages, hit.agent, { file: hit.file, ino: stat.ino }).reverse(), end: window.start,
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

  // iris-image 이미지 바이트를 offset 부터 IMAGE_CHUNK_BYTES 만큼
  // - 조각마다 에이전트 기록 접근과 파일 inode 를 다시 확인. 줄의 이미지 서명이 다르면 expired
  // - 같은 이미지의 다음 조각마다 큰 줄을 다시 해석하지 않게 마지막 하나만 바이트를 둠. 파일 크기·수정 시각이 그대로일 때만 씀
  let lastImage = null;
  function image(media, offset) {
    const link = resolveMediaImage(media);
    if (!link) return { ok: false, error: "expired" };
    const hit = target(link.agent);
    if (!hit || hit.file !== link.file) return { ok: false, error: "expired" };
    let found = null;
    try {
      found = withFile(hit.file, (fd, stat) => {
        if (stat.ino !== link.ino || link.off >= stat.size) return null;
        if (lastImage?.media === media && lastImage.size === stat.size && lastImage.mtime === stat.mtimeMs) return lastImage;
        const record = readLine(fd, stat.size, link.off);
        const picked = imageFromRecord(record, link.i, link.j ?? null, IMAGE_MIMES);
        if (!picked || (link.sig && picked.sig !== link.sig)) return null;
        return (lastImage = { media, size: stat.size, mtime: stat.mtimeMs, mime: picked.mime, bytes: picked.bytes });
      });
    } catch {
      return { ok: false, error: "unavailable" };
    }
    if (!found) return { ok: false, error: "expired" };
    if (offset > found.bytes.length) return { ok: false, error: "invalid-request" };
    const data = found.bytes.subarray(offset, offset + IMAGE_CHUNK_BYTES);
    return { ok: true, mime: found.mime, size: found.bytes.length, offset, data: data.toString("base64") };
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
          // 읽기 범위보다 큰 줄: 뒤에 이어진 줄이 있으면 그 줄은 건너뛰고 다음 줄부터. 그대로 두면 이후 대화가 멈춤
          if (result.end === watch.end && maximum < stat.size) {
            const next = nextLineStart(fd, stat.size, maximum);
            if (next !== null) watch.end = next;
            return;
          }
          watch.end = result.end;
          watch.pending.push(...itemsOf(result.messages, hit.agent, { file: hit.file, ino: stat.ino }));
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

  return { page, watch, image, refreshAgent, closeConnection, close };
}
