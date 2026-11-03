// iOS 시뮬레이터 입력(탭·스와이프·키·버튼). 사용처: MCP 앱 도구(app.mjs)·QA 모바일(server/qa-mobile.js)·붙여넣기(idb-paste.mjs)
//
// idb 입력 명령은 Xcode 27 에서 기기 안 dtuhidd 를 깨워 com.apple.coredevice.dtuhidd.active=1 로 만든다. 그 뒤로는
// Iris 에뮬레이터 탭의 사람 터치(serve-sim 도우미 경로)가 앱에 닿지 않고, 기기 안 backboardd 를 다시 시작해야만 풀린다
// (2026-10-17 기기 로그: dtuhidd 실행 9번 모두 idb_companion 의 hid.digitizer 연결 직후).
// 그래서 입력은 사람 터치와 같은 serve-sim 도우미 웹소켓으로만 보낸다. idb 는 접근성 트리·화면 캡처에만 쓴다.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const TOUCH = 3, BUTTON = 4, KEY = 6;
const SHIFT = 225, COMMAND = 227;

// US 자판 글자 → HID usage. serve-sim type 명령과 같은 표
const KEYMAP = (() => {
  const map = { " ": [44], "\n": [40], "\t": [43] };
  for (let i = 0; i < 26; i++) { map[String.fromCharCode(97 + i)] = [4 + i]; map[String.fromCharCode(65 + i)] = [4 + i, true]; }
  "1234567890".split("").forEach((c, i) => { map[c] = [30 + i]; });
  "!@#$%^&*()".split("").forEach((c, i) => { map[c] = [30 + i, true]; });
  const pairs = [["-", "_", 45], ["=", "+", 46], ["[", "{", 47], ["]", "}", 48], ["\\", "|", 49], [";", ":", 51], ["'", "\"", 52], ["\x60", "~", 53], [",", "<", 54], [".", ">", 55], ["/", "?", 56]];
  for (const [plain, shifted, usage] of pairs) { map[plain] = [usage]; map[shifted] = [usage, true]; }
  return map;
})();

export const typeable = (text) => [...String(text)].every((c) => c === "\r" || KEYMAP[c]);

export function keyEvents(text) {
  const events = [];
  for (const c of String(text)) {
    if (c === "\r") continue;
    const entry = KEYMAP[c];
    if (!entry) throw new Error(`도우미로 입력할 수 없는 글자입니다: ${JSON.stringify(c)}`);
    const [usage, shift] = entry;
    if (shift) events.push({ type: "down", usage: SHIFT });
    events.push({ type: "down", usage }, { type: "up", usage });
    if (shift) events.push({ type: "up", usage: SHIFT });
  }
  return events;
}

export const pressEvents = (usage) => [{ type: "down", usage }, { type: "up", usage }];
export const pasteEvents = () => [{ type: "down", usage: COMMAND }, { type: "down", usage: 25 }, { type: "up", usage: 25 }, { type: "up", usage: COMMAND }];

// 포인트 좌표를 화면 기준 0..1 로. 화면 밖은 가장자리로
export function normalize(x, y, size) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return { x: clamp(x / size.width), y: clamp(y / size.height) };
}

export function swipePoints(from, to, durationSec = 0.3, stepMs = 16) {
  const steps = Math.max(2, Math.round((Number(durationSec) || 0.3) * 1000 / stepMs));
  const points = [{ ...from, type: "begin" }];
  for (let i = 1; i < steps; i++) points.push({ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps, type: "move" });
  points.push({ ...to, type: "end" });
  return points;
}

// idb ui button 이름 → 도우미 버튼 이름. 도우미가 받는 버튼만
const BUTTONS = { HOME: "home", LOCK: "lock", SIDE_BUTTON: "lock" };
export const helperButton = (name) => BUTTONS[String(name).toUpperCase()] || null;

export function frame(tag, payload) {
  const json = Buffer.from(JSON.stringify(payload));
  return Buffer.concat([Buffer.from([tag]), json]);
}

// 도우미 주소. Iris 가 띄운 serve-sim 은 상태 파일을 남긴다. 실행한 프로세스와 임시 폴더가 다를 수 있어 ps 로도 찾는다
export function parseHelperPorts(psOutput, udid) {
  const ports = [];
  for (const line of String(psOutput).split("\n")) {
    if (!/(^|\/)serve-sim-bin\s/.test(line) || !line.includes(udid)) continue;
    const port = line.match(/--port\s+(\d+)/);
    if (port) ports.push(Number(port[1]));
  }
  return ports;
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, { encoding: "utf8", timeout: 5000 }, (error, stdout) => resolve(error ? "" : stdout)));

async function helperWsUrl(udid) {
  for (const dir of new Set([os.tmpdir(), process.env.TMPDIR].filter(Boolean))) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, "serve-sim", `server-${udid}.json`), "utf8"));
      if (typeof state.pid === "number") process.kill(state.pid, 0);
      if (typeof state.wsUrl === "string") return state.wsUrl;
    } catch {}
  }
  const [port] = parseHelperPorts(await run("/bin/ps", ["-axo", "command="]), udid);
  return port ? `ws://127.0.0.1:${port}/ws` : null;
}

const NO_HELPER = "이 기기의 화면 도우미(serve-sim)가 떠 있지 않아 입력을 보낼 수 없습니다. 기기가 Iris 에뮬레이터 탭에 열려 있으면 Iris가 도우미를 다시 띄우는데, 8초를 기다려도 뜨지 않았습니다. 탭이 없으면 Iris 에뮬레이터 탭에서 기기를 열고, 탭이 있으면 탭에 보이는 오류를 확인하세요.";
// 도우미가 끝나면 Iris 가 몇 초 안에 다시 띄움(native/electron/emulator/helper-watchdog.cjs, 3초 간격). 그 사이 입력은 기다렸다 보냄
const HELPER_WAIT_MS = 8000;

// 화면 크기(포인트). 접근성 트리의 Application 프레임. 회전하면 도우미 화면 크기가 바뀌므로 그 값과 함께 저장
const sizes = new Map();
async function pointSize(udid, wsUrl, readTree) {
  let key = udid;
  try {
    const config = await fetch(wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "/config"), { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    key = `${udid}:${config.width}x${config.height}`;
  } catch {}
  if (sizes.has(key)) return sizes.get(key);
  const tree = await readTree(udid);
  const app = (Array.isArray(tree) ? tree : []).find((e) => e && e.type === "Application" && e.frame && e.frame.width > 0 && e.frame.height > 0);
  if (!app) throw new Error("화면 크기를 읽지 못했습니다(접근성 트리에 Application 프레임 없음).");
  const size = { width: app.frame.width, height: app.frame.height };
  sizes.set(key, size);
  return size;
}

function send(wsUrl, frames, gapMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let i = 0;
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("도우미 연결 시간이 지났습니다.")); }, 10000);
    const next = () => {
      if (i >= frames.length) { setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 50); return; }
      ws.send(frames[i++]);
      setTimeout(next, gapMs);
    };
    ws.on("open", next);
    ws.on("error", (error) => { clearTimeout(timer); reject(new Error(`도우미에 보내지 못했습니다: ${error.message}`)); });
  });
}

// readTree(udid) → idb describe-all 결과. 좌표를 0..1 로 바꿀 화면 크기를 얻는 데만 쓴다
export function createIosHid({ readTree, locate = helperWsUrl, transmit = send, waitMs = HELPER_WAIT_MS, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const helper = async (udid) => {
    for (let waited = 0; ; waited += 500) {
      const url = await locate(udid);
      if (url) return url;
      if (waited >= waitMs) throw new Error(NO_HELPER);
      await pause(500);
    }
  };
  return {
    tap: async (udid, x, y) => {
      const url = await helper(udid);
      const p = normalize(x, y, await pointSize(udid, url, readTree));
      await transmit(url, [frame(TOUCH, { ...p, type: "begin" }), frame(TOUCH, { ...p, type: "end" })], 60);
    },
    swipe: async (udid, { x1, y1, x2, y2, duration }) => {
      const url = await helper(udid);
      const size = await pointSize(udid, url, readTree);
      await transmit(url, swipePoints(normalize(x1, y1, size), normalize(x2, y2, size), duration).map((p) => frame(TOUCH, p)), 16);
    },
    type: async (udid, text) => { await transmit(await helper(udid), keyEvents(text).map((e) => frame(KEY, e)), 4); },
    key: async (udid, usage) => { await transmit(await helper(udid), pressEvents(Number(usage)).map((e) => frame(KEY, e)), 4); },
    paste: async (udid) => { await transmit(await helper(udid), pasteEvents().map((e) => frame(KEY, e)), 4); },
    button: async (udid, name) => {
      const button = helperButton(name);
      if (!button) throw new Error(`iOS 시뮬레이터에는 ${name} 버튼을 보낼 수 없습니다(HOME·LOCK).`);
      await transmit(await helper(udid), [frame(BUTTON, { button })], 0);
    },
  };
}
