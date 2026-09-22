import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createBlankWorkbook, isSheetPath } from "./sheet.js";
import { enqueuePathIo } from "./path-io.js";
import {
  getGitStatusCache,
  isPathAllowed as fsPathAllowed,
  noteOpened,
  requestRecompute as recompute,
  saveAllowed,
  saveDeniedMsg,
  setGitStatusCache,
  snapshot,
} from "./runtime-state.js";

// 파일 탐색·감시·읽기·쓰기·조작·재귀 트리 WebSocket handler의 단일 소유 모듈.
//
// 소유 범위
//   fs.list/read/watch/write/op/tree의 경계·응답, git 장식 cache 소비와 폴더 watcher 생명주기.
//
// 제공 API
//   여섯 fs handler와 연결 종료 때 watcher를 회수하는 closeFsClient 함수.
//
// 의존 대상
//   node:fs/path/child_process, sheet 형식 helper, path-io queue, runtime-state의 경로·cache·opened port.
//
// 유지 조건
//   모든 경로 판정은 runtime-state를 거치고 mutation은 symlink 실제경로도 확인하며,
//   read/write 직렬화·응답 envelope·watch debounce·tree 상한과 파일 조작 순서·타이밍을 보존한다.
//
// 영향 범위
//   server/index.js의 fs dispatch·WebSocket close 연결과 sheet handler의 공용 path queue,
//   test/fs-path-boundary.mjs·test/file-*·test/sheet-* 및 bin/smoke.mjs 파일 I/O·watch·tree 검사.

// fs.list(폴더 트리, VSCode식): 워크스페이스 cwd와 그 하위 경로만 허용한다(임의 FS 열람 차단).
// 심링크 우회 방지(파일 조작 전용): 대상의 실제 경로(realpath)가 canonical 워크스페이스 루트 하위인지 검사.
// 문자열 접두사만 보는 fsPathAllowed는 "루트 하위의 심링크가 밖을 가리키는" 경우를 못 막는다 →
// mutation(rename/move/copy)은 존재하는 최근접 조상을 realpath로 해석한 뒤 남은 tail을 결합해 검증.
function realUnderRoot(abs) {
  try {
    if (typeof abs !== "string" || !abs) return false;
    const canonRoots = snapshot().allowedRoots.map((r) => { try { return fs.realpathSync.native(r); } catch { return path.resolve(r); } });
    let p = path.resolve(abs); const tail = [];
    while (!fs.existsSync(p)) { const parent = path.dirname(p); if (parent === p) break; tail.unshift(path.basename(p)); p = parent; }
    let real = p; try { real = fs.realpathSync.native(p); } catch { real = p; }
    const full = tail.length ? path.join(real, ...tail) : real;
    return canonRoots.some((root) => full === root || full.startsWith(root + path.sep));
  } catch { return false; }
}
export function handleFs(ws, msg) {
  if (msg.type !== "fs.list") return;
  const dir = msg.path;
  if (!dir || !fsPathAllowed(dir)) { ws.send(JSON.stringify({ type: "fs", path: dir || "", error: "허용되지 않은 경로" })); return; }
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const entries = items
      // VSCode처럼 닷파일·닷폴더 포함 전부 노출한다(이전엔 대부분 숨겨 일부 파일/폴더가 안 보였음).
      .slice(0, 5000)
      .map((e) => ({ name: e.name, dir: e.isDirectory(), path: path.join(dir, e.name) }))
      .sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
    ws.send(JSON.stringify({ type: "fs", path: dir, entries, git: gitStatusFor(dir) }));
  } catch (e) {
    ws.send(JSON.stringify({ type: "fs", path: dir, error: String(e.message || e) }));
  }
}

// git 상태(VSCode식 M/A/U/D): 요청 dir을 담은 repo의 porcelain을 파싱해 절대경로→상태 맵.
// repo root별로 짧게 캐시(2.5s)해 반복 fs.list의 git 호출을 줄인다.
function gitStatusFor(dir) {
  try {
    const root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 1500 }).trim();
    if (!root) return {};
    const cached = getGitStatusCache(root);
    if (!cached || Date.now() - cached.at > 2500) {
      const out = execFileSync("git", ["-C", root, "status", "--porcelain", "-uall"], { encoding: "utf8", timeout: 2500, maxBuffer: 4 * 1024 * 1024 });
      const map = {};
      for (const line of out.split("\n")) {
        if (line.length < 4) continue;
        const xy = line.slice(0, 2), rel = line.slice(3).replace(/^"(.*)"$/, "$1").split(" -> ").pop();
        const abs = path.join(root, rel);
        let s = "M";
        if (xy === "??") s = "U"; else if (/A/.test(xy)) s = "A"; else if (/D/.test(xy)) s = "D"; else if (/M|R|C/.test(xy)) s = "M"; else continue;
        map[abs] = s;
      }
      setGitStatusCache(root, { at: Date.now(), map });
    }
    // 요청 dir 하위 항목만 추려 보낸다.
    const full = getGitStatusCache(root).map, sub = {};
    for (const [p, s] of Object.entries(full)) if (p === dir || p.startsWith(dir + path.sep)) sub[p] = s;
    return sub;
  } catch { return {}; }
}

// 이 파일의 현재 디스크 상태를 나타내는 문자열. 창은 읽을 때 이 값을 저장해 두고
// 저장할 때 그대로 보낸다. 그 사이 다른 곳에서 수정했으면 값이 달라져 저장이 막힌다.
// docx 가 이미 같은 것을 baselineRevision 이라는 이름으로 쓴다(server/docx-handlers.js).
// 파일이 없으면 null 이다. 없음도 하나의 상태라 저장 시점에 그대로 비교한다.
// 없는 것과 읽지 못한 것은 다르다. 없으면 null 이고, 저장하면 다시 만들어진다는 뜻이다.
// 권한·I/O 문제로 읽지 못한 것을 null 로 처리하면 비교가 어긋나므로, 알 수 없으면 쓰지 않는다.
export function fileRevision(p) {
  try { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
  catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

// 파일 감시. 외부에서 바뀐 파일이 화면에 반영돼야 한다(VSCode와 같은 동작).
// 파일 하나를 직접 watch하지 않고 그 파일이 든 폴더를 watch한다: 대부분의 편집기·도구는 저장을
// 임시 파일을 쓰고 rename 하는 방식으로 하는데, 그러면 파일 watcher는 대상이 사라져 동작을 멈춘다(그 뒤로는
// 아무 변화도 안 온다). 폴더 watcher는 그 rename까지 이벤트로 본다. 폴더를 보므로 생성·삭제도 같이 온다.
const dirWatchers = new Map(); // dir → { w, clients:Set<ws>, timer, names:Set }
function watchDirFor(ws, dir) {
  if (!fsPathAllowed(dir)) return;
  let ent = dirWatchers.get(dir);
  if (!ent) {
    let w;
    try { w = fs.watch(dir, { persistent: false }); } catch { return; }
    ent = { w, clients: new Set(), timer: null, names: new Set() };
    w.on("error", () => { try { w.close(); } catch {} dirWatchers.delete(dir); });
    w.on("change", (_type, name) => {
      if (name) ent.names.add(String(name));
      if (ent.timer) return;
      // 한 번의 저장이 이벤트를 여러 개 낸다(rename+change 등). 묶어서 한 번만 알린다.
      ent.timer = setTimeout(() => {
        const names = [...ent.names]; ent.names.clear(); ent.timer = null;
        const payload = JSON.stringify({ type: "dir-changed", dir, names });
        for (const c of ent.clients) { try { if (c.readyState === 1) c.send(payload); } catch {} }
      }, 120);
    });
    dirWatchers.set(dir, ent);
  }
  ent.clients.add(ws);
}
function unwatchAll(ws) {
  for (const [dir, ent] of [...dirWatchers]) {
    ent.clients.delete(ws);
    if (!ent.clients.size) { try { ent.w.close(); } catch {} if (ent.timer) clearTimeout(ent.timer); dirWatchers.delete(dir); }
  }
}
// 클라이언트가 현재 보고 있는 폴더 목록을 전체로 보내고, 서버는 그 집합만 유지한다.
// 켰다 끄는 것을 따로 맞추지 않아도 되고, 새로고침으로 상태가 어긋나지 않는다.
export function handleFsWatch(ws, msg) {
  const want = Array.isArray(msg.dirs) ? msg.dirs.filter((d) => typeof d === "string").slice(0, 400) : [];
  unwatchAll(ws);
  for (const d of want) watchDirFor(ws, d);
}

// fs.read(파일 내용): 가운데 파일 뷰어용. 워크스페이스 하위 + 크기 제한.
export async function handleFsRead(ws, msg) {
  const done = (extra) => ws.send(JSON.stringify({ type: "file", path: p || "", requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, ...extra }));
  const p = msg.path;
  // 읽기 경계는 연결 출처에 따라 다르다. 같은 기기의 창(로컬)이 여는 파일은 사용자가 Finder로도
  // 열 수 있어 워크스페이스 밖(예: ~/Downloads/seed.sql)도 막지 않는다. 막으면 터미널에
  // 출력된 산출물 경로를 눌러도 열리지 않는다. 원격 연결은 기존대로
  // 에이전트 cwd 하위만 읽는다. 임의 파일 읽기가 원격으로 열리면 안 된다.
  if (!p || (!ws._local && !fsPathAllowed(p))) { done({ error: "허용되지 않은 경로" }); return; }
  await enqueuePathIo(p, async () => {
    try {
      const st = fs.statSync(p);
      // VSCode처럼 대용량도 연다. 극단적인 크기만 상한으로 막으며, 그 이상은 뷰어가 멈춘다.
      if (st.size > 20 * 1024 * 1024) { done({ error: "파일이 너무 큽니다(20MB 초과) — 열지 않음" }); return; }
      const buf = fs.readFileSync(p);
      // 바이너리를 utf8로 처리하면 뷰어에 깨진 문자가 수만 줄 표시된다. 앞부분에 NUL이 있으면
      // 텍스트가 아니므로(관례적 판정) 열지 않고 그 사실을 반환한다. 창은 이 응답을 받아 Finder로 보낸다.
      if (buf.subarray(0, 8000).includes(0)) {
        // 표로 열 수 있는 파일이 이 경로로 왔다면 창이 이전 화면 코드를 쓰고 있다는 뜻이다(새 코드는
        // 표 읽기 경로로 온다). 그대로 Finder로 넘기면 원인을 알 수 없으므로 로그를 남긴다.
        if (isSheetPath(p)) {
          console.log(`[sheet] 표 파일이 fs.read로 왔습니다(창이 옛 화면 코드) — ${p}`);
          done({ error: "표 뷰어가 있는 새 화면을 아직 못 받았습니다 — 앱에서 보기 → 강제 새로고침(⌘⇧R) 후 다시 열어 주세요", binary: true, staleClient: true });
          return;
        }
        done({ error: "텍스트 파일이 아닙니다 — 뷰어로 열지 않았습니다", binary: true });
        return;
      }
      const content = buf.toString("utf8");
      if (ws._local) noteOpened(p);   // 뷰어에 실제로 표시한 파일이 저장 가능한 파일이다
      done({ content, revision: createHash("sha256").update(buf).digest("hex") });
    } catch (e) {
      done({ error: String(e.message || e) });
    }
  });
}

// fs.write(파일 저장): 편집 후 저장. 로컬만 허용하고(AC5: 원격 임의 파일 쓰기 금지) 워크스페이스 하위만 쓴다.
//
// baselineRevision 을 함께 받으면 그것이 지금 디스크와 같을 때만 쓴다. 창이 읽어 간 뒤에 다른
// 쪽(에이전트·다른 편집기)이 같은 파일을 수정했으면 여기서 막고 conflict 로 응답한다. VSCode 가
// 저장 시점에 하는 처리와 같다. 보내지 않으면 검사 없이 덮어쓴다(사용자가 덮어쓰기를
// 선택한 재시도가 이 경로로 온다). 검사와 쓰기가 한 큐에서 이어져 그 사이에 간격이 생기지 않는다.
export async function handleFsWrite(ws, msg) {
  const done = (extra) => ws.send(JSON.stringify({ type: "file-saved", path: p || "", requestId: msg.requestId, space: msg.space, tabId: msg.tabId, reason: msg.reason, ...extra }));
  const p = msg.path;
  if (!ws._local) { done({ error: "원격에서는 저장 불가(AC5)" }); return; }
  if (!p || !saveAllowed(p) || typeof msg.content !== "string") { done({ error: saveDeniedMsg(p) }); return; }
  const baseline = typeof msg.baselineRevision === "string" ? msg.baselineRevision : null;
  if (baseline !== null && !/^[0-9a-f]{64}$/i.test(baseline)) { done({ error: "기준 revision이 올바르지 않습니다" }); return; }
  // 덮어쓰기는 기준 미전송이 아니라 별도 플래그로 온다. 기준이 빠진 것과 사용자가 덮어쓰기를
  // 선택한 것은 다르며, 둘을 같은 형태로 두면 기준을 잃은 창이 다른 곳의 변경을 지운다.
  const overwrite = msg.overwrite === true;
  await enqueuePathIo(p, async () => {
    try {
      if (!overwrite && baseline !== null) {
        const now = fileRevision(p);
        // 파일이 사라진 것은 충돌로 보지 않는다. 저장하면 다시 만들어지고 화면도 그렇게 안내한다.
        if (now !== null && now !== baseline) {
          done({ error: "이 파일이 밖에서 바뀌었습니다", conflict: true, diskRevision: now });
          return;
        }
      }
      fs.writeFileSync(p, msg.content, "utf8");
      done({ ok: true, revision: createHash("sha256").update(Buffer.from(msg.content, "utf8")).digest("hex") });
      recompute(); // git 상태 갱신 트리거
    } catch (e) {
      done({ error: String(e.message || e) });
    }
  });
}

// fs.op(파일 조작: create/rename/move/copy): VSCode식 파일 트리 컨텍스트 메뉴용.
// 로컬만(AC5), 소스·대상 모두 워크스페이스 root 하위(fsPathAllowed). 삭제는 Electron 휴지통(reversible)로 별도 처리.
export async function handleFsOp(ws, msg) {
  const op = msg.op;
  const reply = (o) => { try { ws.send(JSON.stringify({ type: "fs-op", op, ...o })); } catch {} };
  if (!ws._local) return reply({ ok: false, error: "원격에서는 파일 조작 불가(AC5)" });
  try {
    const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } }; // lstat: dangling symlink도 존재로
    if (op === "create-file" || op === "create-dir" || op === "create-sheet") {
      const destDir = msg.destDir;
      const name = String(msg.name || "").trim();
      if (!destDir || !fsPathAllowed(destDir) || !realUnderRoot(destDir)) return reply({ ok: false, error: "허용되지 않은 대상 경로" });
      if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") {
        return reply({ ok: false, error: "잘못된 이름" });
      }
      const absDestDir = path.resolve(destDir);
      let st; try { st = fs.statSync(absDestDir); } catch { return reply({ ok: false, error: "대상 폴더 없음" }); }
      if (!st.isDirectory()) return reply({ ok: false, error: "대상이 폴더가 아님" });
      const dest = path.join(absDestDir, name);
      if (!fsPathAllowed(dest) || !realUnderRoot(dest)) return reply({ ok: false, error: "대상 경로 불가" });
      return await enqueuePathIo(dest, async () => {
        if (exists(dest)) return reply({ ok: false, error: "같은 이름이 이미 있습니다" });
        try {
          if (op === "create-file") fs.writeFileSync(dest, "", { encoding: "utf8", flag: "wx", mode: 0o644 });
          else if (op === "create-dir") fs.mkdirSync(dest, { recursive: false, mode: 0o755 });
          else await createBlankWorkbook(dest);
        } catch (e) {
          if (e && e.code === "EEXIST") return reply({ ok: false, error: "같은 이름이 이미 있습니다" });
          throw e;
        }
        recompute();
        return reply({ ok: true, refresh: [absDestDir], parent: absDestDir, newPath: dest, created: op === "create-dir" ? "dir" : "file" });
      });
    }
    if (op === "rename") {
      const src = msg.path;
      const name = String(msg.name || "").trim();
      if (!src || !fsPathAllowed(src) || !realUnderRoot(src)) return reply({ ok: false, error: "허용되지 않은 경로" });
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return reply({ ok: false, error: "잘못된 이름" });
      const absSrc = path.resolve(src);
      const parent = path.dirname(absSrc);
      const dest = path.join(parent, name);
      if (!fsPathAllowed(dest) || !realUnderRoot(dest)) return reply({ ok: false, error: "대상 경로 불가" });
      return await enqueuePathIo(absSrc, async () => {
        if (exists(dest)) return reply({ ok: false, error: "같은 이름이 이미 있습니다" });
        fs.renameSync(absSrc, dest);
        recompute();
        return reply({ ok: true, refresh: [parent], from: absSrc, newPath: dest });
      });
    }
    if (op === "move" || op === "copy") {
      const src = msg.src, destDir = msg.destDir;
      if (!src || !fsPathAllowed(src) || !realUnderRoot(src)) return reply({ ok: false, error: "허용되지 않은 소스 경로" });
      if (!destDir || !fsPathAllowed(destDir) || !realUnderRoot(destDir)) return reply({ ok: false, error: "허용되지 않은 대상 경로" });
      const absSrc = path.resolve(src), absDestDir = path.resolve(destDir);
      let st; try { st = fs.statSync(absDestDir); } catch { return reply({ ok: false, error: "대상 폴더 없음" }); }
      if (!st.isDirectory()) return reply({ ok: false, error: "대상이 폴더가 아님" });
      // 사본 만들기는 같은 폴더에 다른 이름으로 두는 경우가 흔해(파일 메뉴 "사본 만들기") 이름을
      // 지정할 수 있게 한다. 이동은 위치만 바꾸는 조작이라 이름을 바꾸지 않는다.
      const destName = (op === "copy" && msg.name) ? String(msg.name).trim() : path.basename(absSrc);
      if (op === "copy" && msg.name && (!destName || destName.includes("/") || destName.includes("\\") || destName === "." || destName === "..")) {
        return reply({ ok: false, error: "잘못된 이름" });
      }
      const dest = path.join(absDestDir, destName);
      if (!fsPathAllowed(dest) || !realUnderRoot(dest)) return reply({ ok: false, error: "대상 경로 불가" });
      if (path.resolve(dest) === absSrc) return reply({ ok: false, error: "같은 위치" });
      if (op === "move" && (absDestDir === absSrc || absDestDir.startsWith(absSrc + path.sep))) return reply({ ok: false, error: "자기 하위로 이동 불가" });
      if (op === "move") {
        return await enqueuePathIo(absSrc, async () => {
          if (exists(dest)) return reply({ ok: false, error: "같은 이름이 이미 있습니다" });
          fs.renameSync(absSrc, dest);
          recompute();
          const refresh = [path.dirname(absSrc), absDestDir];
          return reply({ ok: true, refresh: [...new Set(refresh)], from: absSrc, newPath: dest, moved: true });
        });
      }
      if (exists(dest)) return reply({ ok: false, error: "같은 이름이 이미 있습니다" });
      fs.cpSync(absSrc, dest, { recursive: true, force: false, errorOnExist: true }); // force:false라야 errorOnExist 유효(덮어쓰기 방지)
      recompute();
      return reply({ ok: true, refresh: [absDestDir], from: absSrc, newPath: dest, moved: false, open: !!msg.open });
    }
    return reply({ ok: false, error: "알 수 없는 op" });
  } catch (e) { return reply({ ok: false, error: String(e && e.message || e) }); }
}

// fs.tree(재귀 파일 목록): ⌘⇧P 파일 검색용. 워크스페이스 root 하위 파일 전체를 한 번에 내려보내고
// 클라이언트가 fuzzy 매칭한다. allowedRoots 경계 안에서만, 잡음 디렉터리 제외 + 상한으로 유계.
const TREE_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "out", ".cache", ".turbo", "coverage", ".venv", "venv", "__pycache__", ".pnpm-store", "target", ".gradle", ".idea", ".DS_Store"]);
const TREE_MAX_FILES = 20000, TREE_MAX_ENTRIES = 400000; // 파일 상한 + 총 순회 상한(대형 트리 폭주 방지)
export function handleFsTree(ws, msg) {
  const root = msg.path;
  if (!root || !fsPathAllowed(root)) { ws.send(JSON.stringify({ type: "tree", root: root || "", error: "허용되지 않은 경로" })); return; }
  const files = []; let seen = 0, truncated = false;
  const walk = (dir) => {
    if (truncated) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      if (++seen > TREE_MAX_ENTRIES) { truncated = true; return; }
      const name = e.name;
      if (e.isDirectory()) {
        // VSCode처럼 닷폴더도 탐색(.working·.vscode·.config 등 안의 파일도 검색되게). .git·node_modules
        // 등 잡음·초대형 디렉터리만 제외한다(TREE_SKIP_DIRS).
        if (TREE_SKIP_DIRS.has(name)) continue;
        walk(path.join(dir, name));
        if (truncated) return;
      } else if (e.isFile()) {
        files.push(path.join(dir, name)); // 파일은 닷파일 포함 전부(스킵 디렉터리 하위만 제외됨)
        if (files.length >= TREE_MAX_FILES) { truncated = true; return; }
      }
    }
  };
  try {
    walk(path.resolve(root));
    ws.send(JSON.stringify({ type: "tree", root, files, truncated }));
  } catch (e) {
    ws.send(JSON.stringify({ type: "tree", root, error: String(e.message || e) }));
  }
}


export function closeFsClient(ws) { unwatchAll(ws); }
