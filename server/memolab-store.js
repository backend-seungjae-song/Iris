import fs from "node:fs";
import path from "node:path";

import { stateHome } from "./state-home.cjs";

// 메모랩 전용 저장소. 브라우저 localStorage 를 대신하는 한 파일.
//
// 소유 범위
//   ~/.iris/memolab.json 하나와 그 파일의 rev. 읽기·쓰기·충돌 판정이 전부 여기에 있다.
//
// 제공 API
//   readState() · writeState(data, rev) · handleMemolabState(req, res). 그 밖의 것은 없다.
//
// 의존 대상
//   경로는 state-home 에만 의존한다. 여기서 경로를 다시 조합하면 개발 서버와 설치본이 같은
//   파일을 쓰게 되고, 그 결과 데이터가 삭제된 적이 있다.
//
// 유지 조건
//   쓰기는 임시 파일에 기록한 뒤 rename 한다. 바로 덮어쓰면 쓰기가 중단될 때 원본이
//   일부만 남아, 다음에 열 때 판 전체가 사라진다.
//   덮어쓰기 전에 현재 내용을 memolab-history/ 에 남긴다. rename 은 파일이 일부만 남지 않게
//   할 뿐, 이전 내용을 다시 보는 요구는 충족하지 못한다.
//   읽기 실패에 빈 상태를 반환하지 않는다. 그러면 다음 저장이 정상 원본을 덮어쓴다.
//   rev 와 데이터 형식을 확인한 뒤에만 저장한다. rev 가 없으면 충돌 검사를 건너뛰게 되어
//   빈 PUT `{}` 이 200 으로 통과하고 이후 읽기가 data:null 을 반환한다.
//   정상 화면은 항상 rev 를 보내지만, 그 보장은 화면이 아니라 이 경계가 해야 한다.
//   rev 는 저장할 때마다 1 씩 증가한다. 클라이언트가 보낸 rev 와 다르면 거절한다.
//   그래야 두 곳에서 연 판이 서로의 내용을 덮어쓰지 않는다.
//
// 영향 범위
//   server/http-handler.js 의 /memolab-state 라우트, web/memolab/store.js.
//   용도와 화면·저장·라우트의 정본: docs/memolab.md

const FILE = path.join(stateHome(), "memolab.json");
/* 화면 상태는 다른 파일이다.

   접힘·지도 배율·현재 열어 둔 판까지 한 rev 에 묶여 있었다. 그래서 다른 창에서 배율만
   바꿔도 판 전체가 저장됐고, 서로 다른 판을 편집하는 두 창이 충돌했으며, 상대 창의
   탐색 상태까지 전달됐다.
   변경 단위가 다르면 파일도 rev 도 달라야 한다. 이쪽은 표시 설정이라 마지막에 쓴 값이
   적용되고, 충돌 판정도 이전본도 두지 않는다. 잃어도 다시 설정하면 되는 값이다. */
const UI_FILE = path.join(stateHome(), "memolab-ui.json");
const HIST = path.join(stateHome(), "memolab-history");
const MAX_BYTES = 8 * 1024 * 1024;
// 보관할 이전본 개수. 판 하나가 10KB 안팎이라 200개라도 2MB 정도이고,
// 저장이 400ms 에 한 번 모여서 실행되므로 이 정도면 몇 시간을 복원할 수 있다.
const HIST_KEEP = 200;

/* 덮어쓰기 전에 현재 내용을 따로 보관한다.

   상태 폴더를 통째로 복사해 덮어쓴 적이 있는데, 이 파일은 임시파일 rename 방식이라
   이전본을 남기지 않아 한 시간 분량을 복원할 수 없었다.

   rename 은 쓰기가 중단돼도 파일이 일부만 남지 않게 할 뿐, 이전 내용을 다시 보는 요구는
   충족하지 못한다.

   실패해도 저장은 진행한다. 이전본 보관에 실패했다고 현재 내용까지 저장하지 않으면
   손실이 더 크다. */
function keepOld(prevRaw, prevRev) {
  if (!prevRaw) return;
  try {
    fs.mkdirSync(HIST, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(HIST, `r${String(prevRev).padStart(6, "0")}-${stamp}.json`), prevRaw);
    const old = fs.readdirSync(HIST).filter((f) => f.endsWith(".json")).sort();
    for (const f of old.slice(0, Math.max(0, old.length - HIST_KEEP))) {
      try { fs.unlinkSync(path.join(HIST, f)); } catch { /* 지우다 실패해도 저장은 진행 */ }
    }
  } catch { /* 이전본을 남기지 못해도 현재 내용은 저장한다 */ }
}

function emptyState() {
  return { rev: 0, data: null };
}

export function readState() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, "utf8");
  } catch (e) {
    // 파일이 아직 없는 것은 실패가 아니다. 처음 실행하면 이 경로로 들어온다.
    if (e && e.code === "ENOENT") return emptyState();
    throw e;
  }
  const parsed = JSON.parse(raw);
  const rev = Number.isInteger(parsed?.rev) && parsed.rev >= 0 ? parsed.rev : 0;
  return { rev, data: parsed?.data ?? null };
}

// 저장 가능한 형식인지 확인한다. 판이 배열이고 판마다 id 가 있어야 한다.
function shaped(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (!Array.isArray(data.boards) || !data.boards.length) return false;
  return data.boards.every((b) => b && typeof b === "object" && typeof b.id === "string" && b.id);
}

export function writeState(data, rev) {
  if (!shaped(data)) return { ok: false, bad: "판 모양이 아님", rev: readState().rev };
  if (!Number.isInteger(rev) || rev < 0) return { ok: false, bad: "rev 없음", rev: readState().rev };
  const cur = readState();
  if (rev !== cur.rev) return { ok: false, conflict: true, rev: cur.rev };
  const next = { rev: cur.rev + 1, data };
  const body = JSON.stringify(next);
  if (body.length > MAX_BYTES) return { ok: false, tooBig: true, rev: cur.rev };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  let prevRaw = null;
  try { prevRaw = fs.readFileSync(FILE, "utf8"); } catch { /* 처음 쓰는 것 */ }
  keepOld(prevRaw, cur.rev);
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, FILE);
  return { ok: true, rev: next.rev };
}

export function readUI() {
  try {
    const parsed = JSON.parse(fs.readFileSync(UI_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/* 창 상태를 전부 저장한다. 접힘·배율뿐 아니라 현재 연 판도 여기 포함된다.

   화면은 current 도 함께 보내므로 저장하는 쪽에서 그 필드를 버리면 새로 열 때마다
   기본 판으로 돌아간다. 보내는 필드와 저장하는 필드를 맞춰 두어야 한다. */
export function writeUI(view) {
  if (!view || typeof view !== "object" || Array.isArray(view)) return { ok: false, bad: "화면 상태 모양이 아님" };
  const ui = view.ui && typeof view.ui === "object" && !Array.isArray(view.ui) ? view.ui : {};
  const current = typeof view.current === "string" ? view.current : "";
  const body = JSON.stringify({ ui, current });
  if (body.length > MAX_BYTES) return { ok: false, tooBig: true };
  fs.mkdirSync(path.dirname(UI_FILE), { recursive: true });
  const tmp = `${UI_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, UI_FILE);
  return { ok: true };
}

export function handleMemolabUI(req, res) {
  if (req.method === "GET") {
    const saved = readUI();
    send(res, 200, { ok: true, ui: saved.ui || {}, current: saved.current || "" });
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > MAX_BYTES) req.destroy(); });
  req.on("end", () => {
    let j;
    try { j = JSON.parse(body || "{}"); } catch {
      send(res, 400, { ok: false, error: "bad json" });
      return;
    }
    try {
      const out = writeUI(j);
      send(res, out.ok ? 200 : out.bad ? 400 : 413, out);
    } catch (e) {
      send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });
}

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function handleMemolabState(req, res) {
  if (req.method === "GET") {
    let cur;
    try { cur = readState(); } catch (e) {
      send(res, 500, { ok: false, error: String(e?.message || e) });
      return;
    }
    // rev 만 조회하는 요청이 있다. rev 가 같으면 본문을 보내지 않는다. 몇 초마다 도는
    // 확인이라 판 전체를 매번 전송하면 부담이 크다.
    const asked = new URL(req.url, "http://127.0.0.1").searchParams.get("rev");
    if (asked != null && Number(asked) === cur.rev) { send(res, 200, { ok: true, same: true, rev: cur.rev }); return; }
    send(res, 200, { ok: true, rev: cur.rev, data: cur.data });
    return;
  }

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > MAX_BYTES) req.destroy(); });
  req.on("end", () => {
    let j;
    try { j = JSON.parse(body || "{}"); } catch {
      send(res, 400, { ok: false, error: "bad json" });
      return;
    }
    try {
      const out = writeState(j.data, j.rev);
      const code = out.ok ? 200 : out.conflict ? 409 : out.bad ? 400 : 413;
      send(res, code, out);
    } catch (e) {
      send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  });
}
