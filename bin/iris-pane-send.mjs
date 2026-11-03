#!/usr/bin/env node
// 다른 Claude Code·Codex 세션의 입력창에 글을 넣고 제출한다. 세션 지목 블록의 「보내기」 명령.
//
// 사용: iris-pane-send <paneId> "<글>"      입력창이 비어 있으면 보내고 제출됐는지 확인한다
//       iris-pane-send <paneId> --check     보내지 않고 입력창 상태만 출력한다
//       iris-pane-send <paneId> "<글>" --force   입력창을 판정하지 못해도 보낸다
//
// 빈 입력창의 안내 문구(Claude `Try "…"`, Codex `Ask Codex to do anything`)와 자동 추천 문구는
// 흐린 글자(SGR 2)로 그려진다. 색 없이 읽으면 사람이 쓰다 만 글과 구분되지 않아서, 보내는 세션이
// 빈 입력창을 보고 전송을 미뤘다. 그래서 색 정보째 읽고 흐리지 않은 글자만 사람이 쓴 글로 센다.
// pane 포커스는 보지 않는다. 사람이 그 pane 을 보고 있는 것과 입력창에 글을 쓰고 있는 것은 다르다.
//
// 입력창이 비었다는 것만으로는 제출 증거가 아니다. 큰 붙여넣기가 입력창에 나타나기 전에 읽으면
// 비어 보여서, 접힌 붙여넣기([Pasted text …])가 남았는데도 submitted:true 로 답한 사례가 있었다.
// 그래서 보낸 글의 첫 줄이 대화 기록에 새로 보이거나 세션이 working 이 된 뒤에만 제출로 본다.
//
// 종료 코드: 0 보냄(또는 --check 에서 비어 있음), 3 사람이 쓴 글이 있어 보내지 않음,
//            4 입력창을 찾지 못해 보내지 않음, 5 보냈지만 입력창에 글이 남아 제출되지 않음, 2 사용법·herdr 오류
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const run = promisify(execFile);
const RULE = /─{10,}/;
const SGR = /\x1b\[([0-9;]*)m/g;
const OTHER_ESC = /\x1b\[[0-9;?]*[A-Za-z]/g;

// 한 줄에서 흐리지 않은 글자만 남긴다. 흐림은 SGR 2 로 켜지고 22 나 0 으로 꺼진다.
// 줄마다 herdr 가 0 으로 시작하므로 흐림 상태는 줄을 넘기지 않는다.
export function plainText(line) {
  let dim = false, out = "", last = 0;
  for (const m of line.matchAll(SGR)) {
    if (!dim) out += line.slice(last, m.index);
    const params = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 38 || p === 48 || p === 58) { i += params[i + 1] === 2 ? 4 : 2; continue; }
      if (p === 2) dim = true;
      else if (p === 0 || p === 22) dim = false;
    }
    last = m.index + m[0].length;
  }
  if (!dim) out += line.slice(last);
  return out.replace(OTHER_ESC, "");
}

const strip = (line) => line.replace(SGR, "").replace(OTHER_ESC, "");
const clean = (s) => s.replace(/[\s ]+/g, " ").trim();

// 입력창의 줄들을 찾는다. 못 찾으면 null.
// Claude Code: 마지막 가로줄 바로 위의 마지막 ❯ 줄부터 그 가로줄 전까지. 위쪽 가로줄은 링크 같은
// 글이 들어가면 ─ 가 몇 개만 남아서 기준으로 쓰지 않는다.
// Codex: 마지막 › 줄부터 빈 줄 전까지.
function inputLines(lines, kind) {
  if (kind === "claude") {
    let bottom = -1;
    lines.forEach((l, i) => { if (RULE.test(strip(l))) bottom = i; });
    let start = -1;
    for (let i = bottom - 1; i >= 0 && !RULE.test(strip(lines[i])); i--) if (/^❯/.test(strip(lines[i]))) { start = i; break; }
    if (start < 0) return null;
    return { lines: lines.slice(start, bottom), glyph: "❯", start };
  }
  if (kind === "codex") {
    let start = -1;
    lines.forEach((l, i) => { if (/^›/.test(strip(l))) start = i; });
    if (start < 0) return null;
    const box = [lines[start]];
    for (let i = start + 1; i < lines.length && clean(strip(lines[i])); i++) box.push(lines[i]);
    return { lines: box, glyph: "›", start };
  }
  return null;
}

// 화면(색 포함)과 에이전트 종류로 입력창 상태를 정한다.
// empty: 사람이 쓴 글 없음(안내 문구만 있을 수 있음), draft: 사람이 쓴 글 있음, unknown: 입력창을 못 찾음.
export function inputState(screen, kind) {
  const found = inputLines(screen.replace(/\r/g, "").split("\n"), kind);
  if (!found) return { state: "unknown", draft: "", hint: "" };
  const text = (fn) => clean(found.lines.map(fn).join(" ").replace(found.glyph, ""));
  const draft = text(plainText);
  const shown = text(strip);
  return draft ? { state: "draft", draft, hint: "" } : { state: "empty", draft: "", hint: shown };
}

// 보낸 글의 첫 줄이 입력창 위(대화 기록)에 보이는 횟수. 줄바꿈 위치가 바뀌어도 맞게 공백을 빼고 센다
export function echoCount(screen, kind, text) {
  const lines = screen.replace(/\r/g, "").split("\n");
  const found = inputLines(lines, kind);
  const above = found ? lines.slice(0, found.start) : lines;
  const squash = (s) => s.replace(/[\s\u00a0]+/g, "");
  const first = String(text).split("\n").map(squash).find(Boolean) || "";
  const needle = first.slice(0, 24);
  if (!needle) return 0;
  return squash(above.map(strip).join("")).split(needle).length - 1;
}

async function herdr(args) {
  const { stdout } = await run("herdr", args, { maxBuffer: 8 << 20 });
  return stdout;
}

async function readScreen(pane) {
  return herdr(["pane", "read", pane, "--source", "visible", "--lines", "60", "--ansi"]);
}

async function readState(pane, kind) {
  return inputState(await readScreen(pane), kind);
}

async function agentStatus(pane) {
  return JSON.parse(await herdr(["pane", "get", pane]))?.result?.pane?.agent_status || "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const force = argv.includes("--force");
  const check = argv.includes("--check");
  const [pane, text] = argv.filter((a) => a !== "--force" && a !== "--check");
  if (!pane || (!check && !text)) {
    console.error('사용: iris-pane-send <paneId> "<글>" [--force] | iris-pane-send <paneId> --check');
    return 2;
  }
  const info = JSON.parse(await herdr(["pane", "get", pane]));
  const kind = info?.result?.pane?.agent || "";
  const beforeScreen = await readScreen(pane);
  const before = inputState(beforeScreen, kind);
  const report = (o) => console.log(JSON.stringify({ pane, kind, ...o }));
  if (check) { report(before); return before.state === "draft" ? 3 : before.state === "unknown" ? 4 : 0; }
  if (before.state === "draft") { report({ sent: false, ...before, reason: "입력창에 사람이 쓴 글이 있다" }); return 3; }
  if (before.state === "unknown" && !force) { report({ sent: false, ...before, reason: "입력창을 찾지 못했다(--force 로 보낼 수 있다)" }); return 4; }
  const echoed = echoCount(beforeScreen, kind, text);
  const wasWorking = info?.result?.pane?.agent_status === "working";
  await herdr(["pane", "run", pane, text]);
  // 0.5초 간격으로 6초까지 확인. 보내기 전 입력창이 비어 있었으므로 1초 넘게 남은 글은 이번에 보낸 글이고, Enter 를 한 번 더 보냄
  let after = before, evidence = null, retriedEnter = false, draftSince = null;
  for (let i = 1; i <= 12 && !evidence; i++) {
    await sleep(500);
    const screen = await readScreen(pane);
    after = inputState(screen, kind);
    if (after.state === "draft") {
      draftSince ??= i;
      if (!retriedEnter && i - draftSince >= 2) { await herdr(["pane", "send-keys", pane, "Enter"]); retriedEnter = true; draftSince = null; }
      continue;
    }
    draftSince = null;
    if (after.state !== "empty") continue;
    if (echoCount(screen, kind, text) > echoed) evidence = "echo";
    else if (!wasWorking && await agentStatus(pane) === "working") evidence = "working";
  }
  const extra = retriedEnter ? { retriedEnter } : {};
  if (after.state === "draft") { report({ sent: true, submitted: false, draft: after.draft, ...extra }); return 5; }
  if (evidence) { report({ sent: true, submitted: true, evidence, ...extra }); return 0; }
  report({ sent: true, submitted: "unknown", ...extra, reason: "입력창은 비었지만 대화 기록과 세션 상태에서 제출을 확인하지 못했다" });
  return 0;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`iris-pane-send: ${e.stderr || e.message}`);
    process.exit(2);
  });
}
