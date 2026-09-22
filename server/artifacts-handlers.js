// 부산물 폴더를 집계해 창에 전달한다. 정리 화면이 무엇을 표시할지 여기서 정한다.
//
// 소유 범위
//   부산물 종류별 개수·크기의 계산, 종류 하나를 날짜로 묶은 요약, 날짜 하나의 항목 목록,
//   항목 하나의 미리보기 데이터, 그리고 앱이 시작할 때 한 번 실행하는 마이그레이션.
//
// 제공 API
//   initArtifactsHandlers() · handleArtifacts(ws, msg). 그 밖의 것은 없다.
//
// 의존 대상
//   artifacts-home.cjs 의 종류 표와 경로. 경로를 여기서 다시 조합하지 않는다.
//
// 유지 조건
//   삭제하지 않는다. 이 파일은 읽고 집계만 한다. 삭제는 창이 휴지통(acHost.trashItem)으로
//   보내야 사용자가 복원할 수 있고, 서버가 직접 지우면 영구 삭제가 된다.
//   로컬 연결에만 응답한다. 부산물 경로는 사용자 홈 아래의 실제 경로라 원격이 조회할 대상이 아니다.
//   탐색 깊이에 상한을 둔다. 상한이 없으면 심링크 순환 하나로 서버가 멈춘다.
//   미리보기는 부산물 폴더 안만 연다. 심링크를 해석한 뒤 판정하지 않으면 폴더 밖 파일이 열린다.
//   날짜 비우기에 쓰는 경로 목록에는 화면 상한을 걸지 않는다. 목록 상한이 곧 삭제 상한이 되면
//   비운 뒤에도 항목이 남는다.
//
// 영향 범위
//   server/index.js 의 초기화·dispatch, web/js/devtool/artifacts-page.js 가 받는
//   artifacts · artifacts-entries · artifacts-day · artifacts-preview 메시지 계약.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs server/artifacts-handlers.js
import fs from "node:fs";
import path from "node:path";

import { ARTIFACT_KINDS, artifactDir, artifactsHome, migrateArtifacts } from "./artifacts-home.cjs";

// 한 번에 전송하는 최대 줄 수. 항목이 수천 개여도 실제로 보는 것은 앞쪽이고, 전부 보내면
// 그 메시지 하나가 창을 멈춘다. 나머지 개수는 숫자로 알린다.
const MAX_ENTRIES = 300;
// 폴더를 탐색하는 최대 깊이. 심링크 순환을 만나도 여기서 멈춘다.
const MAX_DEPTH = 8;
// 미리보기 상한. 텍스트는 앞부분만으로 내용을 알 수 있고, 이미지는 이 크기를 넘으면 창에 싣지 않는다.
const PREVIEW_TEXT_BYTES = 64 * 1024;
const PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
const TEXT_EXT = new Set([".md", ".txt", ".json", ".jsonl", ".log", ".csv", ".html", ".css", ".js", ".mjs", ".cjs", ".yml", ".yaml", ".diff", ".patch", ""]);
const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 항목의 날짜. 파일 생성 시각을 로컬 시간대로 읽는다. 어제 찍은 항목을 찾을 때의 기준은
// UTC 가 아니라 사용자의 로컬 날짜다.
function dayOf(ms) {
  const d = new Date(Number(ms) || 0);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function measure(target, depth = 0) {
  let count = 0, bytes = 0, mtime = 0;
  let stat;
  try { stat = fs.lstatSync(target); } catch { return { count, bytes, mtime }; }
  if (stat.isSymbolicLink()) return { count: 1, bytes: 0, mtime: stat.mtimeMs };
  if (!stat.isDirectory()) return { count: 1, bytes: stat.size, mtime: stat.mtimeMs };
  if (depth >= MAX_DEPTH) return { count: 0, bytes: 0, mtime: stat.mtimeMs };
  mtime = stat.mtimeMs;
  let names = [];
  try { names = fs.readdirSync(target); } catch { return { count, bytes, mtime }; }
  for (const name of names) {
    const inner = measure(path.join(target, name), depth + 1);
    count += inner.count;
    bytes += inner.bytes;
    if (inner.mtime > mtime) mtime = inner.mtime;
  }
  return { count, bytes, mtime };
}

function kindsWire() {
  const kinds = ARTIFACT_KINDS.map((kind) => {
    const dir = artifactDir(kind.id);
    const { count, bytes } = measure(dir);
    return { id: kind.id, label: kind.label, desc: kind.desc, dir, count, bytes };
  });
  return {
    type: "artifacts",
    home: artifactsHome(),
    kinds,
    total: {
      count: kinds.reduce((n, k) => n + k.count, 0),
      bytes: kinds.reduce((n, k) => n + k.bytes, 0),
    },
  };
}

// 종류 하나의 항목을 모두 집계해 최신순으로 정렬한다. 날짜 요약과 날짜별 목록이 여기서 나온다.
function rowsOf(kindId) {
  const dir = artifactDir(kindId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const rows = [];
  for (const name of names) {
    const target = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(target); } catch { continue; }
    const isDir = stat.isDirectory() && !stat.isSymbolicLink();
    const inner = isDir ? measure(target) : { count: 1, bytes: stat.size, mtime: stat.mtimeMs };
    rows.push({
      name, path: target, dir: isDir,
      count: inner.count, bytes: inner.bytes, mtime: inner.mtime, day: dayOf(inner.mtime),
    });
  }
  // 최신순으로 정렬한다. 찾는 항목도 지우는 항목도 대개 최근 것이다.
  rows.sort((a, b) => b.mtime - a.mtime);
  return { dir, rows };
}

function entriesWire(rawKind) {
  const kind = ARTIFACT_KINDS.find((k) => k.id === rawKind);
  if (!kind) return { type: "artifacts-entries", kind: String(rawKind || ""), dir: "", days: [] };
  const { dir, rows } = rowsOf(kind.id);
  const byDay = new Map();
  for (const row of rows) {
    const cur = byDay.get(row.day) || { date: row.day, count: 0, bytes: 0, items: 0 };
    cur.count += row.count;
    cur.bytes += row.bytes;
    cur.items += 1;
    byDay.set(row.day, cur);
  }
  return {
    type: "artifacts-entries",
    kind: kind.id,
    dir,
    days: [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

function dayWire(rawKind, rawDate) {
  const kind = ARTIFACT_KINDS.find((k) => k.id === rawKind);
  const date = String(rawDate || "");
  if (!kind || !DAY_RE.test(date)) {
    return { type: "artifacts-day", kind: String(rawKind || ""), date, dir: "", entries: [], paths: [], more: 0 };
  }
  const { dir, rows } = rowsOf(kind.id);
  const mine = rows.filter((row) => row.day === date);
  return {
    type: "artifacts-day",
    kind: kind.id,
    date,
    dir,
    entries: mine.slice(0, MAX_ENTRIES),
    // 비우기는 화면에 표시되지 않은 항목까지 지운다.
    paths: mine.map((row) => row.path),
    more: Math.max(0, mine.length - MAX_ENTRIES),
  };
}

// 부산물 폴더 안의 실제 경로인지 확인한다. 심링크를 해석한 뒤 판정하지 않으면 폴더 밖 파일이 열린다.
function insideArtifacts(target) {
  let home;
  try { home = fs.realpathSync(artifactsHome()); } catch { return null; }
  let real;
  try { real = fs.realpathSync(target); } catch { return null; }
  const rel = path.relative(home, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return real;
}

function previewWire(rawPath) {
  const asked = String(rawPath || "");
  const out = (extra) => ({ type: "artifacts-preview", path: asked, ...extra });
  if (!path.isAbsolute(asked)) return out({ error: "절대 경로가 아닙니다" });
  const real = insideArtifacts(asked);
  if (!real) return out({ error: "부산물 폴더 안의 파일이 아닙니다" });
  let stat;
  try { stat = fs.statSync(real); } catch { return out({ error: "파일이 없습니다" }); }
  const name = path.basename(real);
  if (stat.isDirectory()) {
    const { rows } = rowsOfDir(real);
    return out({ what: "dir", name, entries: rows.slice(0, MAX_ENTRIES), more: Math.max(0, rows.length - MAX_ENTRIES) });
  }
  const ext = path.extname(real).toLowerCase();
  if (IMAGE_MIME[ext]) {
    if (stat.size > PREVIEW_IMAGE_BYTES) return out({ what: "too-big", name, bytes: stat.size });
    try {
      return out({ what: "image", name, mime: IMAGE_MIME[ext], bytes: stat.size, data: fs.readFileSync(real).toString("base64") });
    } catch (e) { return out({ error: "그림을 읽지 못했습니다" }); }
  }
  if (TEXT_EXT.has(ext)) {
    try {
      const fd = fs.openSync(real, "r");
      const buf = Buffer.alloc(Math.min(stat.size, PREVIEW_TEXT_BYTES));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return out({ what: "text", name, bytes: stat.size, truncated: stat.size > read, text: buf.slice(0, read).toString("utf8") });
    } catch (e) { return out({ error: "글을 읽지 못했습니다" }); }
  }
  return out({ what: "other", name, bytes: stat.size });
}

// 폴더 하나의 바로 아래 항목. 미리보기가 폴더를 열어 보일 때 쓴다.
function rowsOfDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const rows = [];
  for (const name of names) {
    const target = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(target); } catch { continue; }
    const isDir = stat.isDirectory() && !stat.isSymbolicLink();
    const inner = isDir ? measure(target) : { count: 1, bytes: stat.size, mtime: stat.mtimeMs };
    rows.push({ name, path: target, dir: isDir, count: inner.count, bytes: inner.bytes, mtime: inner.mtime });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return { rows };
}

// 이전 경로에 쌓인 파일을 새 경로로 옮긴다. 앱 시작 시 한 번이면 충분하고, 그 뒤로는 생산자가
// 처음부터 새 경로에 쓴다.
export function initArtifactsHandlers() {
  try { migrateArtifacts(); } catch {}
}

export function handleArtifacts(ws, msg) {
  if (!ws._local) return;
  if (msg.type === "artifacts.list") ws.send(JSON.stringify(kindsWire()));
  else if (msg.type === "artifacts.entries") ws.send(JSON.stringify(entriesWire(msg.kind)));
  else if (msg.type === "artifacts.day") ws.send(JSON.stringify(dayWire(msg.kind, msg.date)));
  else if (msg.type === "artifacts.preview") ws.send(JSON.stringify(previewWire(msg.path)));
}
