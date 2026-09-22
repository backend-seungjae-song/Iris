import fs from "node:fs";
import path from "node:path";

import * as archive from "./archive.js";
import { bindSpaceFolder } from "./browser-state-owner.js";
import { resolveCodexSession } from "./codex-session.js";
import { requestRecompute as recompute, snapshot } from "./runtime-state.js";

// 보관·복원 WebSocket handler와 복원 흐름의 단일 소유 모듈.
//
// 소유 범위
//   archive.* 요청 경계, 세션 tail/key 수집, space/tab 복원 계획과 순차 resume 실행.
//
// 제공 API
//   lock 뒤 archive store를 여는 initArchiveHandlers와 archive namespace의 handleArchive 함수.
//
// 의존 대상
//   archive/runtime/browser-state owner와 codex-session resolver에 의존하고,
//   Herdr 서비스와 broadcast port는 composition root에서 주입받으며 다른 handler를 import하지 않는다.
//
// 유지 조건
//   로컬 gate, 복원 키 확인→tail 읽기→archive 기록→pane/workspace close 순서,
//   기본 탭 재사용·세션 사이 1500ms 간격·응답 envelope와 recompute 시점.
//
// 영향 범위
//   server/index.js의 archive 초기화·namespace dispatch·초기 snapshot·shutdown flush 연결,
//   server/workspace-handlers.js의 공용 space-folder binding과 archive.js 저장 계약,
//   bin/smoke.mjs 보관 소유 검사 및 test/archive-state-isolation.mjs·shutdown-flush.mjs.

let herdr;
let broadcast;

export function initArchiveHandlers(deps) {
  herdr = deps.herdr;
  broadcast = deps.broadcast;
  archive.load();
}

function broadcastArchives() { broadcast({ type: "archives", items: archive.list() }); }

// 보관 직전에 남길 마지막 내용. 세션 기록에서 읽는 것이 우선이다. herdr의 pane.read는 화면에
// 보이는 만큼(≈55줄)만 반환해서 요청한 200줄을 화면에서는 얻을 수 없다. 기록이 없으면 화면
// 내용을 대신 남기고, 둘 다 실패해도 보관은 그대로 진행한다. 내용을 읽지 못한 것이 세션 키를
// 버릴 이유는 아니다.
async function readTail(paneId, agentKind, uuid, file) {
  try {
    const t = archive.transcriptTail(agentKind, uuid, archive.TAIL_LINES, file);
    if (t && t.trim()) return t;
  } catch {}
  try {
    const r = await herdr.paneRead(paneId, "recent", "text", true, archive.TAIL_LINES);
    const t = typeof r === "string" ? r : (r?.text || r?.content || "");
    return String(t || "").split("\n").slice(-archive.TAIL_LINES).join("\n");
  } catch { return null; }
}

// 보관 직전의 세션 키. claude는 herdr가 준 값이 그대로 키다. codex는 프로세스에서 찾은 값이라
// 그 사이 대화가 바뀌었으면 최신이 아닐 수 있어서 닫기 직전에 다시 찾는다. 오래된 키로 보관하면
// 복원할 때 다른 대화가 열리고, 보관된 대화는 복원할 방법이 없어진다.
async function sessionKey(a) {
  if (String(a.agent || "").toLowerCase() === "codex") {
    const hit = await resolveCodexSession(herdr, a.paneId);
    if (hit) return hit;
  }
  return a.sessionUuid ? { uuid: a.sessionUuid, file: a.sessionFile || null } : null;
}

export function handleArchive(ws, msg) {
  const fail = (m) => ws.send(JSON.stringify({ type: "archive-error", message: String(m && m.message || m) }));
  if (msg.type === "archive.list") { ws.send(JSON.stringify({ type: "archives", items: archive.list() })); return; }
  if (!ws._local) { fail("원격에서는 보관 조작 불가(AC5)"); return; }

  if (msg.type === "archive.forget") { if (archive.remove(msg.id)) broadcastArchives(); return; }

  if (msg.type === "archive.agent") {
    const a = snapshot().state.find((x) => x.paneId === msg.paneId);
    if (!a) { fail("그 에이전트를 찾을 수 없습니다."); return; }
    if (!archive.canResume(a.agent)) { fail(`${a.agent} 세션을 잇는 방법을 모릅니다 — 접지 않았습니다.`); return; }
    const w = snapshot().workspaces.find((x) => x.id === a.workspaceId);
    (async () => {
      // 복원할 키가 없으면 보관하지 않는다. 보관하는 순간 복구할 수 없게 된다.
      const key = await sessionKey(a);
      if (!key) { fail("세션 id가 없어 되살릴 수 없습니다 — 접지 않았습니다."); return; }
      const tail = await readTail(a.paneId, a.agent, key.uuid, key.file);   // 닫은 뒤에는 읽을 수 없다
      archive.add(archive.agentEntry({ ...a, sessionUuid: key.uuid }, w?.label, w?.folder, tail));
      broadcastArchives();
      try { await herdr.paneClose(a.paneId); } catch (e) { fail(e); }
      recompute();
    })();
    return;
  }

  if (msg.type === "archive.space") {
    const w = snapshot().workspaces.find((x) => x.id === msg.workspaceId);
    if (!w) { fail("그 스페이스를 찾을 수 없습니다."); return; }
    const mine = snapshot().state.filter((x) => x.workspaceId === w.id);
    (async () => {
      // 폴더를 모르면 복원할 수 없다. state의 folder는 에이전트 cwd에서 유추한 값이라
      // 에이전트가 없는 스페이스에서는 비어 있고, 그럴 때는 pane에서 직접 읽는다.
      let folder = w.folder;
      if (!folder) { try { folder = (await herdr.paneList(w.id))[0]?.cwd || null; } catch {} }
      if (!folder) { fail("이 스페이스의 폴더를 알 수 없어 접지 않았습니다 — 되살릴 방법이 없습니다."); return; }
      // 키는 닫기 직전에 확정한다(codex는 여기서 다시 찾는다). 키가 없는 항목은 기록하지 못한다.
      const keys = await Promise.all(mine.map((x) => (archive.canResume(x.agent) ? sessionKey(x) : null)));
      const keep = mine.map((x, i) => (keys[i] ? { ...x, sessionUuid: keys[i].uuid, sessionFile: keys[i].file } : null)).filter(Boolean);
      const lost = mine.length - keep.length;
      const tails = await Promise.all(keep.map((x) => readTail(x.paneId, x.agent, x.sessionUuid, x.sessionFile)));
      const entries = keep.map((x, i) => archive.agentEntry(x, w.label, folder, tails[i]));
      archive.addMany(entries);
      // 탭 구성도 함께 남긴다. 세션이 붙지 않은 터미널 탭도 그 스페이스의 일부다.
      const entryByTab = new Map(keep.map((x, i) => [x.tabId, entries[i].id]));
      const tabs = (snapshot().tabs[w.id] || []).map((t) => ({ label: t.label || "", entry: entryByTab.get(t.tabId) || null }));
      archive.add(archive.spaceEntry(w.label, folder, entries.map((e) => e.id), tabs));
      broadcastArchives();
      if (lost) ws.send(JSON.stringify({ type: "archive-note", message: `세션 id가 없는 에이전트 ${lost}개는 기록하지 못했습니다.` }));
      try { await herdr.workspaceClose(w.id); } catch (e) { fail(e); }
      recompute();
    })();
    return;
  }

  if (msg.type === "archive.restore") {
    // 폴더로 요청하면 그 스페이스 그룹 전체가 대상이다. 세션만 따로 보관한 경우에도 보관함에는
    // 스페이스 단위로 묶여 보이므로 복원도 같은 단위로 받는다.
    if (msg.spaceCwd) { restoreSpaceGroup(ws, String(msg.spaceCwd)).catch((err) => fail(err)); return; }
    const e = archive.get(msg.id);
    if (!e) { fail("보관 항목을 찾을 수 없습니다."); return; }
    restoreArchive(ws, e).catch((err) => fail(err));
    return;
  }

  if (msg.type === "archive.forgetSpace") {
    const cwd = String(msg.spaceCwd || "");
    const gone = archive.list().filter((x) => sameDir(x.cwd, cwd) || sameDir(x.spaceCwd, cwd));
    for (const x of gone) archive.remove(x.id);
    if (gone.length) broadcastArchives();
    return;
  }
}

// 셸에 그대로 입력하는 문자열이라 인용을 직접 처리한다. 폴더 이름에 공백·따옴표가 있어도 안전하다.
function shq(s) { return "'" + String(s).replace(/'/g, `'\\''`) + "'"; }

// 복원 규칙:
//   스페이스 → 그 스페이스와 안의 세션 전부
//   세션     → 그 스페이스가 보관 중이면 스페이스도 함께 복원하고, 세션은 해당 항목만
// 같은 폴더인지 심링크를 풀어서 비교한다. herdr는 실경로(/private/tmp/…)를 반환하지만 입력되거나
// 저장된 값은 심링크 경로(/tmp/…)일 수 있어서, 그대로 비교하면 같은 폴더를 다르게 판정한다.
function realDir(p) {
  if (!p) return "";
  try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
}
const sameDir = (a, b) => !!a && !!b && realDir(a) === realDir(b);
const liveSpaceOf = (cwd) => (cwd ? snapshot().workspaces.find((w) => sameDir(w.folder, cwd)) : null);

// 스페이스 확보. 이미 실행 중이면 그것을 쓰고, 보관 중이면 복원하면서 그 항목을 보관함에서 뺀다.
// 새로 만들면 herdr가 기본 탭 하나를 함께 만들므로 그 탭을 첫 세션이 쓰도록 반환한다.
// 그러지 않으면 복원할 때마다 빈 탭이 하나 남는다.
// 생성·복원 응답 직후에는 recompute 전이라도 요청한 폴더 객체에 임시로 바인딩한다. 이후 herdr의
// 검증된 identity가 다른 폴더 객체로 이동하면 workspace runtime이 그 객체로 바꾼다.
async function ensureSpace(cwd, label) {
  if (!cwd) throw new Error("이 항목에는 폴더가 없어 되살릴 수 없습니다.");
  const archived = archive.list().find((x) => x.kind === "space" && sameDir(x.cwd, cwd));
  const live = liveSpaceOf(cwd);
  if (live) { bindSpaceFolder(live.id, cwd); if (archived) archive.remove(archived.id); return { wsId: live.id, spare: null, archived }; }
  // 복원할 때도 이름은 herdr에 맡긴다. 보관 전 이름이 폴더 이름과 같았다면 넘기지 않아야
  // 복원 후에도 폴더 이름을 따라간다. 넘기면 herdr가 custom_name으로 고정해 되돌릴 수 없다.
  // 폴더 이름과 달랐다면 사용자가 herdr에서 직접 지은 이름이므로 그대로 복원한다.
  const want = label || archived?.label || null;
  const keepName = want && want !== path.basename(cwd) ? want : null;
  const res = await herdr.workspaceCreate({ cwd, label: keepName, focus: true });
  const wsId = res?.workspace?.workspace_id || null;
  if (!wsId) throw new Error("스페이스를 만들지 못했습니다.");
  // 만든 즉시 폴더에 바인딩한다. 다음 recompute를 기다리면 그 사이의 조작이 임시 키(새 id)로
  // 저장돼 복원한 스페이스의 설정이 두 곳으로 갈라진다.
  bindSpaceFolder(wsId, cwd);
  if (archived) archive.remove(archived.id);
  const spare = res?.root_pane?.pane_id
    ? { tabId: res?.tab?.tab_id || res?.root_pane?.tab_id || null, paneId: res.root_pane.pane_id, cwd: res.root_pane.cwd }
    : null;
  return { wsId, spare, archived };
}

// 쓸 탭 하나를 확보한다. 남는 기본 탭이 있으면 그것을 쓰고(빈 탭을 남기지 않는다), 없으면 만든다.
async function takeTab(wsId, spareRef, label) {
  let slot = spareRef.spare;
  if (slot) spareRef.spare = null;
  else {
    const res = await herdr.tabCreate(wsId);
    slot = { tabId: res?.tab?.tab_id || null, paneId: res?.root_pane?.pane_id || null, cwd: res?.root_pane?.cwd };
  }
  if (!slot.paneId) throw new Error("탭을 만들었지만 그 안의 pane을 찾지 못했습니다.");
  if (slot.tabId && label) { try { await herdr.tabRename(slot.tabId, label); } catch {} }
  return slot;
}

// 세션 하나를 복원한다. 탭을 확보해 이름을 붙이고 그 pane에 resume 명령을 입력한다.
// agent.start에 tab_id를 주면 그 탭에 pane이 하나 더 생겨 빈 셸이 남으므로 직접 입력한다.
async function reviveAgent(wsId, spareRef, e) {
  const argv = archive.resumeArgv(e.agent, e.session);
  if (!argv) throw new Error(`${e.agent} 세션을 잇는 방법을 모릅니다.`);
  const slot = await takeTab(wsId, spareRef, e.name);
  // 탭은 스페이스 폴더에서 시작한다. 세션이 그 아래 다른 폴더에 있었으면 먼저 옮긴다.
  const cmd = (sameDir(e.cwd, slot.cwd) || !e.cwd ? "" : `cd ${shq(e.cwd)} && `) + argv.map(shq).join(" ");
  await herdr.paneSendText(slot.paneId, cmd + "\r");
  archive.remove(e.id);
  return slot.tabId;
}

// 세션을 연달아 실행할 때 두는 간격. claude 기동이 겹치지 않으면서, 여러 개를 복원할 때
// 사용자가 기다리기 어렵지 않은 값이다.
const REVIVE_GAP_MS = 1500;

// 스페이스 그룹 전체 복원. 화면에서 이 그룹 아래 보이는 것과 같은 기준(폴더)으로 모은다.
// 묶여 보이던 항목이 복원에서 빠지면 화면과 동작이 일치하지 않는다.
async function restoreSpaceGroup(ws, cwd) {
  const all = archive.list();
  const head = all.find((x) => x.kind === "space" && sameDir(x.cwd, cwd));
  const kids = all.filter((x) => x.kind === "agent" && sameDir(x.spaceCwd, cwd));
  if (!head && !kids.length) throw new Error("되살릴 항목이 없습니다.");
  const space = await ensureSpace(cwd, head?.label || kids[0]?.spaceLabel);
  const wsId = space.wsId;
  // 저장해둔 탭 구성이 있으면 그 순서대로 복원하고, 세션이 붙지 않은 터미널 탭도 함께 만든다.
  // 구성이 없으면(세션만 따로 보관한 그룹) 세션만 순서대로 복원한다.
  const byId = new Map(kids.map((k) => [k.id, k]));
  const plan = (head?.tabs || []).length
    ? head.tabs.map((t) => ({ label: t.label, entry: t.entry && byId.get(t.entry) ? byId.get(t.entry) : null }))
    : kids.map((k) => ({ label: k.name, entry: k }));
  const planned = new Set(plan.map((p) => p.entry?.id).filter(Boolean));
  for (const k of kids) if (!planned.has(k.id)) plan.push({ label: k.name, entry: k });   // 구성에 없던 세션도 빠뜨리지 않는다

  let ok = 0, plainTabs = 0; const failed = [];
  // 하나씩 간격을 두고 실행한다. 순차로 호출해도 claude 기동은 비동기라 간격이 없으면 8개가
  // 동시에 올라와, 보관한 이유인 메모리 사용량이 그대로 돌아온다.
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    ws.send(JSON.stringify({ type: "archive-progress", spaceCwd: cwd, done: i, total: plan.length, name: p.entry ? (p.entry.name || p.entry.agent) : (p.label || "터미널 탭") }));
    try {
      if (p.entry) { await reviveAgent(wsId, space, p.entry); ok++; }
      else { await takeTab(wsId, space, p.label); plainTabs++; }   // 세션 없는 탭은 이름만 복원
    } catch (err) { failed.push(`${p.entry?.name || p.label || "탭"}: ${err.message || err}`); }
    broadcastArchives();                                  // 복원된 항목부터 목록에서 빠진다
    if (i < plan.length - 1 && p.entry) await new Promise((r) => setTimeout(r, REVIVE_GAP_MS));
  }
  if (failed.length) ws.send(JSON.stringify({ type: "archive-error", message: `세션 ${failed.length}개를 못 살렸습니다 — ${failed.join(" / ")}` }));
  broadcastArchives(); recompute();
  ws.send(JSON.stringify({ type: "archive-restored", workspaceId: wsId,
    note: ok || plainTabs
      ? `스페이스를 되살렸습니다 — 세션 ${ok}개${plainTabs ? `, 탭 ${plainTabs}개` : ""}.`
      : "스페이스를 되살렸습니다." }));
}

async function restoreArchive(ws, e) {
  // 스페이스 항목이면 그 그룹 전체가 대상이다.
  if (e.kind === "space") { await restoreSpaceGroup(ws, e.cwd); return; }
  // 세션 하나: 그 스페이스가 보관 중이면 함께 복원하고(ensureSpace가 처리), 세션은 이 항목만.
  const space = await ensureSpace(e.spaceCwd || e.cwd, e.spaceLabel);
  const tabId = await reviveAgent(space.wsId, space, e);
  broadcastArchives(); recompute();
  ws.send(JSON.stringify({ type: "archive-restored", id: e.id, workspaceId: space.wsId, tabId }));
}
