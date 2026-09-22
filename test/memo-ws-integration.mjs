import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { memoVersion } from "../server/memo-dock-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, { timeout = 8_000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("timeout waiting for condition");
}

test("실제 WebSocket 경로가 로컬·공유 메모와 한 파일 보관을 연결한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-memo-ws-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), IRIS_PORT: String(port), IRIS_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGTERM");
    let exitTimer;
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => { exitTimer = setTimeout(resolve, 1_000); }),
    ]);
    clearTimeout(exitTimer);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const tokenPath = path.join(stateDir, "ui-token");
  await waitFor(() => fs.existsSync(tokenPath) && fs.readFileSync(tokenPath, "utf8").trim());
  // ui-token 은 서버가 초기화하는 동안 쓰이고 listen 은 그보다 나중이다. 파일만 보고 붙으면
  // 기계가 바쁠 때(전체 스위트 동시 실행) 그 틈에 들어가 ECONNREFUSED 로 실패한다.
  // 확인 결과: 단독 실행 30회는 실패 0회, 전체 스위트에서는 간헐 실패. 실제로 받는지까지 기다린다.
  await waitFor(() => new Promise((resolve) => {
    const probe = net.connect(port, "127.0.0.1");
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => { probe.destroy(); resolve(false); });
  }));
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  t.after(() => ws.close());
  const track = (socket) => {
    const messages = [], waiters = new Set();
    socket.on("message", (raw) => {
      let message; try { message = JSON.parse(raw.toString()); } catch { return; }
      messages.push(message);
      for (const waiter of [...waiters]) if (waiter.predicate(message)) { waiters.delete(waiter); waiter.resolve(message); }
    });
    const next = (predicate, timeout = 5_000) => new Promise((resolve, reject) => {
      const prior = messages.find(predicate); if (prior) { resolve(prior); return; }
      let timer;
      const waiter = { predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } }; waiters.add(waiter);
      timer = setTimeout(() => { if (!waiters.delete(waiter)) return; reject(new Error(`message timeout; stderr=${stderr.slice(-500)}`)); }, timeout);
    });
    return { next, send: (message) => socket.send(JSON.stringify(message)) };
  };
  const first = track(ws), next = first.next, send = first.send;

  send({ type: "ui-auth", token: fs.readFileSync(tokenPath, "utf8").trim() });
  assert.equal((await next((m) => m.type === "ui-auth")).ok, true);

  const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws2.once("open", resolve); ws2.once("error", reject); });
  t.after(() => ws2.close());
  const second = track(ws2);
  second.send({ type: "ui-auth", token: fs.readFileSync(tokenPath, "utf8").trim() });
  assert.equal((await second.next((m) => m.type === "ui-auth")).ok, true);

  const dockSpace = "memo-dock-space", emptyVersion = memoVersion("");
  send({ type: "memo.set", requestId: "dock-first", space: dockSpace, baseVersion: emptyVersion, text: "중앙 첫 본문" });
  const dockSaved = await next((m) => m.type === "memo-saved" && m.requestId === "dock-first");
  assert.equal(dockSaved.version, memoVersion("중앙 첫 본문"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "memos.json"), "utf8"))[dockSpace], "중앙 첫 본문",
    "ACK를 받았을 때는 이미 디스크 정본이 반영돼 있어야 한다");
  const dockBroadcast = await second.next((m) => m.type === "memo" && m.space === dockSpace);
  assert.deepEqual({ text: dockBroadcast.text, version: dockBroadcast.version },
    { text: "중앙 첫 본문", version: memoVersion("중앙 첫 본문") });

  second.send({ type: "memo.set", requestId: "dock-stale", space: dockSpace, baseVersion: emptyVersion, text: "중앙 둘째 본문" });
  const dockConflict = await second.next((m) => m.type === "memo-conflict" && m.requestId === "dock-stale");
  assert.equal(dockConflict.current.text, "중앙 첫 본문");
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "memos.json"), "utf8"))[dockSpace], "중앙 첫 본문");

  send({ type: "memo.note.create", requestId: "create-local", space: "memo-test-space", name: "통합 메모" });
  const created = await next((m) => m.type === "memo.note.created" && m.requestId === "create-local");
  assert.equal(created.note.name, "통합 메모");

  send({ type: "memo.doc.set", requestId: "save-local", scope: "local", space: created.storageSpace,
    noteId: created.note.id, baseRev: 0, text: "로컬 본문" });
  assert.equal((await next((m) => m.type === "memo.doc.saved" && m.requestId === "save-local")).rev, 1);
  const localBroadcast = await second.next((m) => m.type === "memo-notes"
    && m.localByKey?.[created.storageSpace]?.notes?.[created.note.id]?.text === "로컬 본문");
  assert.equal(localBroadcast.localByKey[created.storageSpace].notes[created.note.id].rev, 1);
  send({ type: "memo.doc.live", requestId: "live-local", scope: "local", space: created.storageSpace,
    noteId: created.note.id, source: "window-local", seq: 1, baseRev: 1, text: "로컬 본문 즉시" });
  const localLive = await second.next((m) => m.type === "memo.doc.live" && m.requestId === "live-local");
  assert.deepEqual({ storageSpace: localLive.storageSpace, noteId: localLive.noteId, text: localLive.text },
    { storageSpace: created.storageSpace, noteId: created.note.id, text: "로컬 본문 즉시" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "memo-notes.json"), "utf8"))
    .localBySpace[created.storageSpace].notes[created.note.id].text, "로컬 본문");

  send({ type: "memo.doc.set", requestId: "save-shared", scope: "shared", baseRev: 0, text: "공유 본문" });
  assert.equal((await next((m) => m.type === "memo.doc.saved" && m.requestId === "save-shared")).rev, 1);
  assert.equal((await second.next((m) => m.type === "memo-notes" && m.shared?.rev === 1)).shared.text, "공유 본문");

  send({ type: "memo.doc.live", requestId: "live-shared", scope: "shared", source: "window-one",
    seq: 1, baseRev: 1, text: "공유 본문 즉시" });
  const live = await second.next((m) => m.type === "memo.doc.live" && m.requestId === "live-shared");
  assert.deepEqual({ text: live.text, source: live.source, seq: live.seq },
    { text: "공유 본문 즉시", source: "window-one", seq: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "memo-notes.json"), "utf8")).shared.text, "공유 본문");

  send({ type: "memo.doc.set", requestId: "save-shared-live", scope: "shared", baseRev: 1, text: "공유 본문 즉시" });
  assert.equal((await next((m) => m.type === "memo.doc.saved" && m.requestId === "save-shared-live")).rev, 2);
  second.send({ type: "memo.doc.set", requestId: "save-shared-second", scope: "shared", baseRev: 2, text: "공유 본문 2" });
  assert.equal((await second.next((m) => m.type === "memo.doc.saved" && m.requestId === "save-shared-second")).rev, 3);
  assert.equal((await next((m) => m.type === "memo-notes" && m.shared?.rev === 3)).shared.text, "공유 본문 2");
  send({ type: "memo.doc.set", requestId: "save-shared-stale", scope: "shared", baseRev: 2, text: "오래된 창" });
  const conflict = await next((m) => m.type === "memo.doc.conflict" && m.requestId === "save-shared-stale");
  assert.equal(conflict.current.text, "공유 본문 2");

  send({ type: "memo.note.archive", requestId: "archive-local", scope: "local", space: created.storageSpace, noteId: created.note.id });
  await next((m) => m.type === "memo.note.archived" && m.requestId === "archive-local");
  send({ type: "memo.note.archive", requestId: "archive-shared", scope: "shared" });
  await next((m) => m.type === "memo.note.archived" && m.requestId === "archive-shared");

  const notes = JSON.parse(fs.readFileSync(path.join(stateDir, "memo-notes.json"), "utf8"));
  assert.equal(notes.localBySpace[created.storageSpace].notes[created.note.id].text, "로컬 본문");
  assert.equal(notes.shared.text, "공유 본문 2");
  const archives = JSON.parse(fs.readFileSync(path.join(stateDir, "memo-archives.json"), "utf8"));
  assert.equal(archives[created.storageSpace][0].blocks[0].name, "통합 메모");
  assert.equal(archives[created.storageSpace][0].blocks[0].text, "로컬 본문");
  assert.equal(archives.__shared__[0].blocks[0].text, "공유 본문 2");
});
