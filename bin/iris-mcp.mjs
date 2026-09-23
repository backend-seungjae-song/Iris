#!/usr/bin/env node
// iris-mcp: Iris 브라우저 제어를 MCP 도구로 노출한다(stdio).
// iris-browser CLI와 같은 표면·같은 경로(POST /browser-cmd)를 쓴다. 서버가 루프백 전용(AC5)이므로
// 이 프로세스도 같은 머신에서만 동작한다. 새 권한을 열지 않고 CLI로 할 수 있는 것만 할 수 있다.
//
// 세션 식별: HERDR_PANE_ID(또는 IRIS_SESSION)를 먼저 쓴다. Codex가 MCP를 띄울 때 그 환경을 넘기지
// 않는 경우에는 MCP의 프로세스 조상과 herdr pane의 실제 프로세스를 대조한다. 세션별로 탭을
// 고정할 수 있어 여러 AI 세션이 서로 다른 탭을 동시에 조종해도 섞이지 않는다.
//
// 등록: claude mcp add --scope user iris-mcp -- node <이 파일 경로>
// stdout은 JSON-RPC 전용이다. 로그는 반드시 stderr로.
import http from "node:http";
import net from "node:net";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { stateHome } from "../server/state-home.cjs";
import { artifactDir } from "../server/artifacts-home.cjs";

// 이 회차가 장부로 실행되는지 본다. 장부에 닫힌 줄이 하나라도 있으면 화면은 그 장부를 그린다.
// 그때 steps가 비는 것은 "아무것도 실행하지 않았다"가 아니라 "손으로 쓸 자리가 없다"는 뜻이다.
function hasLedgerRows(runId) {
  if (!runId) return false;
  try {
    const txt = fs.readFileSync(path.join(artifactDir("qa"), String(runId), "journal.jsonl"), "utf8");
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.kind === "row" && e.act === "close") return true; } catch {}
    }
  } catch {}
  return false;
}
import { port as acPort } from "../server/env.cjs";
import crypto from "node:crypto";
import { bulkPolicy } from "../server/bulk-fill.js";

// 상태 폴더. 개발 인스턴스와 설치된 앱이 같은 폴더를 쓰면 개발 회차의 QA 장부·매크로·탭
// 기록이 설치된 앱 것과 섞이고, 그러면 "이 증거가 어느 쪽 것인가"를 확인할 수 없다.
// 어디인지는 state-home.cjs 한 곳이 정한다.
const IRIS_HOME = stateHome();

const PORT = acPort();
const EXPLICIT_SESSION = process.env.IRIS_SESSION || process.env.HERDR_PANE_ID || null;
const HERDR_SOCK = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const log = (...a) => process.stderr.write("[iris-mcp] " + a.join(" ") + "\n");

function herdrCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(HERDR_SOCK, () => {
      socket.write(JSON.stringify({ id: "iris-mcp", method, params }) + "\n");
    });
    let buf = "", done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      fn(value);
    };
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); }
      catch { finish(reject, new Error("herdr bad response")); return; }
      if (msg.error) finish(reject, new Error(msg.error.message || "herdr error"));
      else finish(resolve, msg.result ?? msg);
    });
    socket.on("error", (e) => finish(reject, e));
    setTimeout(() => finish(reject, new Error(`herdr timeout: ${method}`)), 2000);
  });
}

function processAncestry() {
  return new Promise((resolve) => {
    childProcess.execFile("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 2000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err && !stdout) { resolve([]); return; }
      const parents = new Map();
      for (const line of String(stdout || "").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) parents.set(Number(m[1]), Number(m[2]));
      }
      const out = [], seen = new Set();
      let pid = process.pid;
      while (pid > 1 && !seen.has(pid) && out.length < 32) {
        out.push(pid); seen.add(pid); pid = parents.get(pid) || 0;
      }
      resolve(out);
    });
  });
}

// 가장 가까운 조상 프로세스가 속한 pane 하나만 고른다. 같은 거리에서 둘 이상 맞으면 잘못된 탭을
// 여는 것보다 세션 없음으로 막는 편이 안전하다.
function chooseHerdrPane(agents, processInfos, ancestry) {
  const rank = new Map((ancestry || []).map((pid, i) => [Number(pid), i]));
  const hits = [];
  for (let i = 0; i < (agents || []).length; i++) {
    const pane = agents[i]?.pane_id;
    if (!pane) continue;
    const raw = processInfos[i];
    const info = raw?.process_info || raw || {};
    const pids = [info.shell_pid, ...(Array.isArray(info.foreground_processes)
      ? info.foreground_processes.map((p) => p.pid) : [])].map(Number).filter(Number.isFinite);
    const scores = pids.map((pid) => rank.get(pid)).filter((v) => v != null);
    if (scores.length) hits.push({ pane: String(pane), score: Math.min(...scores) });
  }
  if (!hits.length) return null;
  const best = Math.min(...hits.map((h) => h.score));
  const panes = [...new Set(hits.filter((h) => h.score === best).map((h) => h.pane))];
  return panes.length === 1 ? panes[0] : null;
}

let discoveredSession = null, sessionLookup = null, lastSessionMiss = 0;
async function currentSession() {
  if (EXPLICIT_SESSION) return EXPLICIT_SESSION;
  if (discoveredSession) return discoveredSession;
  if (sessionLookup) return sessionLookup;
  if (Date.now() - lastSessionMiss < 1000) return null;
  sessionLookup = (async () => {
    try {
      const [listed, ancestry] = await Promise.all([herdrCall("agent.list"), processAncestry()]);
      const agents = listed?.agents || [];
      const infos = await Promise.all(agents.map((a) =>
        herdrCall("pane.process_info", { pane_id: a.pane_id }).catch(() => null)));
      const pane = chooseHerdrPane(agents, infos, ancestry);
      if (pane) {
        discoveredSession = pane;
        log("세션 자동 해석 —", pane);
        return pane;
      }
    } catch {}
    lastSessionMiss = Date.now();
    return null;
  })();
  try { return await sessionLookup; }
  finally { sessionLookup = null; }
}

// 확인 보고서와 판정 영수증은 bin/mcp/report.mjs 가 소유한다. 여기서는 도구 연결만 한다.
// 보고서 화면이 바뀌는 이유와 MCP 표면이 바뀌는 이유는 다르고, 섞어 두면 하나를 고칠 때마다
// 다른 하나를 함께 읽어야 한다.
import {
  buildReport, addReceipt, receiptById, receiptsOfRun, coverGaps, pairProblems, unshotClaims,
  writeMarks, readMarks, BASIS, unverifiedOutsideLedger,
} from "./mcp/report.mjs";
import { createAppSurface } from "./mcp/app.mjs";

// 보고서는 Iris 탭으로 연다. 파일 경로만 건네면 OS 기본 브라우저(크롬)가 받아서 사람이 보는
// 자리가 이 앱 밖으로 나간다. 세션·스페이스가 끊기고 그 자리에서 바로 다시 확인할 수도
// 없다. parallel로 여는 이유는 회차가 쓰던 탭을 덮으면 확인 중이던 화면이
// 사라지기 때문이다. 탭을 못 열어도 경로가 남으므로 보고서는 나간다.
async function openInIris(res, handoff) {
  if (!res || !res.ok || !res.path) return res;
  try {
    const t = await call("newtab", {
      url: "file://" + res.path, parallel: true,
      title: (handoff ? "안내서 " : "보고서 ") + (res.runId || ""),
    });
    const d = (t && t.data) || {};
    res.reportTab = d.handle || d.tab || null;
  } catch { /* 무시 */ }
  return res;
}

// 회차는 세션이 아니라 요청에 포함된다. 세션은 QA 회차가 아니라 herdr pane이고, 한 pane에서
// MCP·CLI·재생기가 같은 세션 값을 공유하므로 세션에만 묶어두면 회차 둘이 겹칠 때 나중 것이
// 앞 것을 가로챈다. 재생기처럼 별도 프로세스로 들어오는 경우는 환경변수로 이어받는다.
let CURRENT_RUN = process.env.IRIS_RUN_ID || null;

// 서버를 지나지 않는 계측기(앱 idb 경로)가 같은 회차 장부에 합류하는 통로. 회차가 안 열려
// 있으면 그대로 지나간다. 회차 없이 쓰는 단발 확인을 깨지 않는다.
// 장부가 거절한 사실을 남기지 않으면 부르는 쪽은 null을 받고 그대로 넘어간다.
// 그러면 source "moment"가 허용값 목록에서 빠진 것을 전 회차 0건이 될 때까지 알 수 없다.
// 거절은 드물고, 드문 것을 기록하지 않으면 드러나지 않는다.
async function journal(event) {
  if (!CURRENT_RUN) return null;
  const r = await call("journal", { event });
  if (!r || !r.ok) {
    console.error(`[iris] 장부가 거절했다 — kind=${event && event.kind} source=${event && event.source}: ${(r && r.error) || "응답 없음"}`);
    return null;
  }
  return r.data;
}

// 증거를 만드는 도구가 회차 없이 불리면 그 장면은 상태 폴더에만 남는다. 거기는 60장·7일로
// 정리되므로(cdp-control의 pruneShots) 보고할 때쯤이면 앞부분이 이미 지워져 있고, 게이트는
// 그것을 "안 찍었다"와 구별하지 못한다. 제대로 실행한 회차가 통째로 거부되거나 장면이 일부만
// 저장된다. 확인 결과: 한 세션에서 2,481장을 찍고 62장이 남았다. 회차를 여는 단계가 어느 절차에도
// 없어 browser_run 실호출이 0회였기 때문이다.
//
// 그래서 기억해서 부르게 하지 않는다. 증거가 생기는 순간에 열린다. 회차가 열려 있으면 서버가
// 장면을 회차 폴더로 굳히고 굳은 경로를 돌려주므로, 보고서에 실리는 경로가 지워지지 않는다.
// 조회만 하는 도구는 열지 않는다. 회차 없이 쓰는 단발 확인을 회차로 만들지 않기 위해서다.
// 잠깐 떴다 사라진 알림. 서버가 뜨는 순간에 찍어 결과에 얹어 준다. 여기서 두 가지를 한다.
//
// 하나는 그 장면을 회차에 굳히는 것이다. 상태 폴더의 낱장은 60장·7일로 정리되므로 보고할
// 때쯤이면 없다. 회차 장부로 보내야 보고서에 포함된 경로가 살아 있다.
//
// 다른 하나는 처음 보는 알림인지 가리는 것이다. 이미 완성된 제품의 모든 알림마다 "이 UI가
// 맞는지" 판정을 요구하면 비용이 감당 안 된다. 그래서 문구에서 값만
// 자리표로 바꾼 지문을 장부에 쌓아 두고, 처음 보는 지문일 때만 판정을 요구한다. 문구가
// 실제로 달라지면 지문도 달라지므로 그것도 새 알림으로 올라온다.
const NOTICE_BOOK = path.join(IRIS_HOME, "notices.json");
function readNotices() {
  try { return JSON.parse(fs.readFileSync(NOTICE_BOOK, "utf8")) || {}; } catch { return {}; }
}
function writeNotices(book) {
  try { fs.mkdirSync(IRIS_HOME, { recursive: true }); fs.writeFileSync(NOTICE_BOOK, JSON.stringify(book, null, 2)); } catch {}
}
async function absorbMoments(r) {
  const ms = r && r.data && Array.isArray(r.data.moments) ? r.data.moments : null;
  if (!ms || !ms.length) return "";
  const book = readNotices();
  const lines = [];
  let dirty = false;
  for (const m of ms) {
    const key = m.print || m.text;
    const known = book[key];
    if (known) { known.seen = (known.seen || 1) + 1; known.last = Date.now(); }
    else { book[key] = { first: Date.now(), last: Date.now(), seen: 1, text: m.text }; }
    dirty = true;
    let shot = m.shot;
    if (shot) {
      // 사라진 알림은 다시 찍을 수 없고 이번 한 번뿐이다. 그래서 문구만이 아니라
      // 얼마나 떠 있었는지·몇 번째로 본 것인지까지 같이 남긴다.
      const j = await journal({ kind: "artifact", source: "moment", shot,
        caption: "잠깐 뜬 알림: " + m.text,
        detail: { 문구: m.text, 떠있던초: m.lived != null ? Number((m.lived / 1000).toFixed(1)) : undefined,
          몇번째: known ? (known.seen || 1) : 1, print: m.print || undefined } });
      if (j && j.shot) shot = j.shot;
      // 장부가 안 받으면 이 장면은 상태 폴더에만 남고 60장·7일 정리에 밀려 사라진다. 조용히
      // null을 받고 넘어가면, source "moment"가 허용값에 없어 전 회차 0건이 되어도
      // 그 사실을 알 수 없다(확인 결과).
      if (!j) lines.push("  (장부에 안 실렸다 — 회차가 없거나 서버가 거절했다. 이 장면은 정리에 밀려 사라진다)");
    }
    const age = known ? `이미 본 알림(${known.seen}번째)` : "처음 보는 알림 — 문구와 생김새가 맞는지 확인할 것";
    lines.push(`· "${m.text}" — ${age}` + (m.lived ? ` · ${(m.lived / 1000).toFixed(1)}초 떠 있었다` : "")
      + (shot ? `\n  장면: ${shot}` : `\n  (${m.note || "못 찍었다"})`));
  }
  if (dirty) writeNotices(book);
  return "\n\n잠깐 뜬 알림 " + ms.length + "건 — 사라졌으므로 화면에는 남아 있지 않다:\n" + lines.join("\n");
}

const EVIDENCE_TOOLS = new Set([
  "browser_screenshot", "browser_expect", "browser_observe", "browser_diff",
  "browser_shot_sizes", "browser_pdf", "browser_a11y_check",
  "app_screenshot", "app_expect", "app_observe",
]);
async function ensureRun(name) {
  if (CURRENT_RUN || !EVIDENCE_TOOLS.has(name)) return;
  try {
    const r = await call("run", { action: "begin" });
    if (r && r.ok && r.data && r.data.runId) CURRENT_RUN = r.data.runId;
  } catch { /* 못 열어도 확인은 진행한다: 여는 것이 목적이 아니라 증거를 남기는 것이 목적이다 */ }
}

async function call(cmd, args = {}) {
  const session = await currentSession();
  return new Promise((resolve) => {
    // tab 이 undefined면 payload에 넣지 않는다(고정/스페이스 폴백을 그대로 쓰게).
    if (args.tab == null) delete args.tab;
    const payload = JSON.stringify({ cmd, args, session, ...(CURRENT_RUN ? { run: CURRENT_RUN } : {}) });
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/browser-cmd", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve({ ok: false, error: "응답 파싱 실패: " + body.slice(0, 200) }); }
        });
      });
    req.on("error", (e) => resolve({ ok: false, error: `Iris에 연결할 수 없습니다(127.0.0.1:${PORT}) — 앱이 실행 중인지 확인하세요. ${e.message}` }));
    req.end(payload);
  });
}

// 모바일 앱 표면(iOS·Android)은 bin/mcp/app.mjs 가 소유한다. 브라우저 표면과 바뀌는 이유가 다르고,
// 그쪽은 대상 기기(Iris 에뮬레이터 탭)만 서버에 묻고 조작은 idb·adb 를 직접 부른다.
// 앱 영수증도 회차를 달고 나가야 한다. 그러지 않으면 웹만 회차로 나뉘고 앱은 전역으로 남는다.
const appSurface = createAppSurface({ currentSession, journal, call,
  addReceipt: (d, serverId) => addReceipt(d, serverId, CURRENT_RUN) });
const MAX_DEVICES = appSurface.MAX_DEVICES;
// 요소 지정은 snapshot ref(@e5)와 CSS 선택자를 모두 받는다. 둘 다 없으면 서버가 거부한다.
const TARGET = {
  ref: { type: "string", description: "browser_snapshot이 준 참조(@e5). 스냅샷을 뜬 직후에만 유효." },
  selector: { type: "string", description: "CSS 선택자. 스냅샷 없이 바로 쓸 수 있고 페이지가 바뀌어도 유효." },
};
const pickTarget = (a) => (a.ref ? { ref: String(a.ref) } : { sel: String(a.selector || "") });

const TOOLS = [
  { name: "browser_snapshot",
    desc: "현재 페이지의 접근성 스냅샷(요소 참조 @e1… 포함). 무엇이 있는지 모를 때 가장 먼저 쓴다. "
      + "큰 화면은 바이트 예산에서 끊기고 이어 볼 커서를 함께 준다 — 전체를 다시 받지 말고 커서로 잇거나 "
      + "role·name·region으로 좁혀라. 끊겨도 잘린 구간의 경고·상태·제목은 요약으로 따라온다.",
    schema: {
      role: { type: "string", description: "이 역할만(button·heading·alert·text input…). 부분 일치." },
      name: { type: "string", description: "이 이름을 포함하는 것만. 부분 일치." },
      region: { type: "string", description: "이 landmark 안쪽만(navigation·main·[장바구니]…)." },
      cursor: { type: "number", description: "지난 호출이 준 이어보기 위치." },
      budget: { type: "number", description: "직렬화 바이트 상한. 기본 20000." },
    },
    run: (a, C) => C("snapshot", {
      role: a.role, name: a.name, region: a.region,
      cursor: a.cursor != null ? Number(a.cursor) : undefined,
      budget: a.budget != null ? Number(a.budget) : undefined,
    }) },
  { name: "browser_click", desc: "요소를 클릭한다.", schema: TARGET, run: (a, C) => C("click", pickTarget(a)) },
  { name: "browser_dblclick", desc: "요소를 더블클릭한다.", schema: TARGET, run: (a, C) => C("dblclick", pickTarget(a)) },
  { name: "browser_hover", desc: "요소 위로 마우스를 올린다(hover 메뉴 펼치기).", schema: TARGET, run: (a, C) => C("hover", pickTarget(a)) },
  { name: "browser_fill", desc: "입력칸에 포커스하고 기존 내용을 지운 뒤 입력한다.",
    schema: { ...TARGET, text: { type: "string", description: "넣을 값" } },
    run: (a, C) => C("fill", { ...pickTarget(a), text: String(a.text ?? "") }) },
  // 대량 기입. 사람 경로로 한 칸씩 치는 것을 서버 안에서 반복할 뿐이지만, 되돌리기 어려운
  // 경우에 쓰이므로 두 단계로 나눈다. plan으로 무엇이 어디에 들어갈지 보고, 그 묶음
  // 그대로만 commit된다(값이 한 자라도 바뀌면 표가 달라지므로 토큰이 어긋난다).
  { name: "browser_bulk_fill",
    desc: "지금 커서 자리에서부터 값을 한 칸씩 연달아 넣는다. 시트 열처럼 같은 동작을 수십·수백 번 반복해야 할 때만 쓴다 — "
      + "그 외에는 browser_fill 을 쓴다. 먼저 커서를 넣을 첫 칸에 클릭으로 두고, action:\"plan\"으로 무엇이 들어갈지 확인한 뒤 "
      + "받은 token으로 action:\"commit\"한다. 로컬 주소는 그대로 들어가고, 원격 주소는 사람에게 보여 승인받은 뒤에만 들어간다 "
      + "— 원격은 한 번 덮으면 남의 기록이 사라지기 때문이다. 이 회차가 확인하기로 선언한 표면(run begin의 surfaces)에서는 거부한다: "
      + "판정하는 화면은 한 칸씩 밟는 것이 목적이다.",
    schema: {
      action: { type: "string", enum: ["plan", "commit"], description: "기본 plan" },
      tab: { type: "string", description: "넣을 탭. 반드시 명시한다 — 물려받지 않는다." },
      values: { type: "array", items: { type: "string" }, description: "칸 하나에 하나씩, 순서대로." },
      advance: { type: "string", enum: ["Enter", "Tab", "ArrowDown", "ArrowRight"], description: "한 칸 친 뒤 이동할 방향키. 기본 Enter(아래)." },
      token: { type: "string", description: "commit에 필요. plan이 준 값 그대로." },
      allowFormula: { type: "boolean", description: "=·+·- 로 시작하는 값을 허용(시트가 계산식으로 읽는다). 기본 거부." },
      pauseMs: { type: "number", description: "칸 사이 간격(ms, 최대 200). 화면이 못 따라올 때만." },
    },
    req: ["tab", "values"],
    run: async (a, C) => {
      const tab = String(a.tab || "").trim();
      if (!tab) return { ok: false, error: "tab 을 명시하세요 — 대량 기입은 어느 탭인지 물려받지 않습니다." };
      const values = Array.isArray(a.values) ? a.values.map((v) => String(v ?? "")) : [];
      const advance = String(a.advance || "Enter");
      const where = "web:" + tab;
      const token = crypto.createHash("sha256")
        .update([tab, advance, String(!!a.allowFormula), ...values].join("\u0000")).digest("hex").slice(0, 16);

      const u = await C("url", { tab });
      const url = (u && u.data && (u.data.url || u.data.href)) || "";
      const st = await C("run", { action: "status" });
      const surfaces = (st && st.data && st.data.surfaces) || [];
      const pol = bulkPolicy({ url, values, where, surfaces, approved: false, allowFormula: !!a.allowFormula });
      if (pol.mode === "deny") return { ok: false, error: pol.reason };

      const head = values.slice(0, 3), tail = values.length > 6 ? values.slice(-3) : [];
      const preview = { 탭: tab, 주소: url, 칸수: values.length, 이동: advance,
        처음: head, ...(tail.length ? { 마지막: tail } : {}),
        판정: pol.mode === "free" ? "로컬 — 그대로 들어갑니다" : "원격 — commit에서 사람에게 승인을 받습니다" };

      if (String(a.action || "plan") !== "commit") {
        const shot = await C("screenshot", { tab });
        return { ok: true, data: { ...preview, token,
          before: (shot && shot.data && (shot.data.shot || shot.data.path)) || null,
          note: "커서가 첫 칸에 있는지 이 사진으로 확인하고, 같은 인자에 token을 실어 commit하세요." } };
      }

      if (String(a.token || "") !== token) {
        return { ok: false, error: "token이 인자와 맞지 않습니다 — plan 이후 값·탭·이동키가 바뀌었습니다. 다시 plan하세요.", token };
      }

      let approved = false;
      if (pol.mode === "confirm") {
        const ask = await C("ask", { tab, title: "대량 기입 승인",
          message: `${(() => { try { return new URL(url).host; } catch { return url; } })()} 에 ${values.length}칸을 연달아 넣습니다`
            + ` (처음: ${head.join(" / ")}${values.length > 3 ? " …" : ""}). 커서 자리와 값을 보고 골라 주세요.`,
          choices: ["승인", "취소"], wait: 240, ready: true });
        approved = !!(ask && ask.data && ask.data.done);
        if (!approved) {
          return { ok: false, error: "사람이 승인하지 않았습니다 — 아무것도 넣지 않았습니다."
            + (ask && ask.data ? ` (응답: ${ask.data.answer})` : "") };
        }
      }

      const r = await C("bulkfill", { tab, values, advance, where, approved,
        allowFormula: !!a.allowFormula, pauseMs: a.pauseMs });
      const after = await C("screenshot", { tab });
      const d = (r && r.data) || {};
      return { ...r, data: { ...d, 탭: tab, after: (after && after.data && (after.data.shot || after.data.path)) || null,
        ...(d.typed != null && d.typed !== values.length
          ? { 경고: `${values.length}칸 중 ${d.typed}칸만 들어갔습니다 — 표가 중간까지만 쓰여 있습니다. 화면을 보고 이어서 할지 되돌릴지 정하세요.` }
          : {}) } };
    } },
  { name: "browser_focus", desc: "요소에 포커스만 준다. 자동완성 목록·달력처럼 칸에 들어가야 열리는 것을 여는 데 쓴다 — browser_fill 은 글까지 넣어 버려 이 상태를 만들 수 없다.",
    schema: TARGET, run: (a, C) => C("focus", pickTarget(a)) },
  { name: "browser_clear", desc: "입력칸 내용만 비운다(새 값은 넣지 않는다). 지우고 그대로 두어야 할 때 쓴다.",
    schema: TARGET, run: (a, C) => C("clear", pickTarget(a)) },
  { name: "browser_check", desc: "체크박스·라디오를 원하는 상태로 맞춘다. 클릭과 달리 지금 상태를 읽고 필요할 때만 누르므로, 같은 명령을 두 번 돌려도 결과가 같다.",
    schema: { ...TARGET, on: { type: "boolean", description: "켤지 여부. 생략하면 켠다. 라디오는 끌 수 없다" } },
    run: (a, C) => C("check", { ...pickTarget(a), value: a.on === false ? false : true }) },
  { name: "browser_pdf", desc: "지금 페이지를 인쇄 레이아웃 그대로 PDF로 저장한다. 스크린샷과 다른 자리다 — 스크린샷은 화면에 보이는 픽셀이라 스크롤 밖이 잘리고 인쇄 전용 스타일이 안 걸린다. 여러 장짜리 표·주문서·영수증을 증거로 남길 때 쓴다.",
    schema: { path: { type: "string", description: "저장 경로. 생략하면 앱 폴더에 만든다" },
      landscape: { type: "boolean", description: "가로 방향" },
      background: { type: "boolean", description: "배경색·배경이미지 포함(기본 포함). 끄면 표 음영이 사라진다" },
      pages: { type: "string", description: "페이지 범위 — 예 \"1-3\"" },
      scale: { type: "number", description: "배율 0.1~2" } },
    run: (a, C) => C("pdf", { path: a.path, landscape: !!a.landscape,
      background: a.background !== false, pages: a.pages, scale: a.scale }) },
  { name: "browser_select", desc: "<select> 드롭다운에서 옵션을 고른다(표시 텍스트 또는 value).",
    schema: { ...TARGET, value: { type: "string", description: "옵션의 표시 텍스트 또는 value" } },
    run: (a, C) => C("select", { ...pickTarget(a), value: String(a.value ?? "") }) },
  { name: "browser_type", desc: "지금 포커스된 곳에 텍스트를 친다(요소 지정 없이).",
    schema: { text: { type: "string" } }, req: ["text"], run: (a, C) => C("type", { text: String(a.text) }) },
  { name: "browser_key",
    desc: "키를 누른다. 수식키는 앞에 붙여 한 문자열로 준다 — \"Enter\"·\"Tab\"·\"Escape\"·\"ArrowDown\"·\"Shift+Enter\"·\"Meta+K\"·\"Ctrl+Shift+P\"·\"a\". shift·ctrl·alt·meta(cmd)를 조합할 수 있고, 글자 키는 그대로 적는다. 별도 도구가 따로 있지 않다.",
    schema: { key: { type: "string", description: "예: Enter · Tab · Shift+Enter · Meta+K · Ctrl+Shift+P · a" } },
    req: ["key"], run: (a, C) => C("key", { key: String(a.key) }) },
  // 주소로 건너뛴 화면은 확인된 화면이 아니다. 그 사이의 조건·오류를 하나도 지나지 않기 때문이다.
  { name: "browser_goto",
    desc: "다른 사이트로 넘어가거나 첫 화면을 연다. 지금 보고 있는 사이트 안에서는 쓰지 않는다 — 같은 사이트 안을 주소로 건너뛰면 서버가 거부한다. "
      + "사람은 사이트 안에서 주소를 치지 않고 누른다. 그 안에서 이동할 때는 browser_snapshot으로 무엇이 있는지 보고 그 링크·버튼을 browser_click 한다.",
    schema: { url: { type: "string" },
      reason: { type: "string", description: "그 경로 자체가 확인 대상이 아니어서 굳이 주소로 가야 할 때의 이유(딥링크·리다이렉트 확인 등). 적으면 통과하되 회차 기록에 '주소로 건너뜀'으로 남아 보고서에서 눌러서 간 단계와 구별된다. 눌러서 갈 수 있는 곳에는 쓰지 않는다." } },
    req: ["url"],
    run: (a, C) => C("goto", { url: String(a.url), ...(a.reason ? { reason: String(a.reason) } : {}) }) },
  { name: "browser_history", desc: "뒤로·앞으로·새로고침(리로드·refresh·F5·⌘R). 페이지를 그대로 다시 부를 때는 이것을 쓴다 — 같은 주소로 browser_goto 하거나 browser_new_tab을 다시 부르는 것은 새로고침이 아니다.",
    schema: { action: { type: "string", enum: ["back", "forward", "reload"] } }, req: ["action"],
    run: (a, C) => C(String(a.action)) },
  { name: "browser_scroll", desc: "스크롤한다. to를 주면 절대 위치, amount를 주면 상대 이동.",
    schema: { to: { type: "number", description: "절대 y 좌표" },
      amount: { type: "string", description: "down·up·top·bottom 또는 픽셀 수(상대 이동)" } },
    run: (a, C) => (a.to != null ? C("scrollto", { y: Number(a.to) }) : C("scroll", { amount: String(a.amount || "down") })) },
  { name: "browser_wait", desc: "로드 완료를 기다린다. ms를 주면 그만큼 고정 대기, 없으면 readyState 완료까지(최대 10초).",
    schema: { ms: { type: "number" } }, run: (a, C) => C("wait", a.ms != null ? { ms: Number(a.ms) } : {}) },
  { name: "browser_viewport", desc: "탭 화면 크기를 지정한다(반응형 확인). 뷰포트·배율·미디어쿼리가 모두 따라온다. clear를 주면 원래 크기로.",
    schema: { width: { type: "number" }, height: { type: "number" },
      dpr: { type: "number", description: "화면 배율(기본은 창 배율 그대로)" },
      clear: { type: "boolean", description: "지정을 해제하고 원래 크기로" } },
    run: (a, C) => (a.clear ? C("viewport", { clear: true })
      : C("viewport", { width: Number(a.width), height: Number(a.height), ...(a.dpr != null ? { dpr: Number(a.dpr) } : {}) })) },
  { name: "browser_text", desc: "본문 텍스트(innerText)를 가져온다.", schema: {}, run: (a, C) => C("text") },
  { name: "browser_url", desc: "현재 URL과 제목.", schema: {}, run: (a, C) => C("url") },
  { name: "browser_eval",
    desc: "페이지에서 JS를 실행하고 결과를 받는다 — 읽는 용도다. 값을 읽고 세고 계산하는 데 쓴다. "
      + "누르기·값 넣기·주소 이동·폼 제출은 서버가 거부한다(.click()·.value=·location=·submit() 등). "
      + "그런 조작은 browser_click·browser_fill·browser_select·browser_key로 한다 — JS로 부른 조작은 포커스·hover·키·기본동작·가려짐 판정을 건너뛰어서, 실제로는 눌리지 않는 버튼도 눌린 것처럼 통과한다.",
    schema: { expression: { type: "string" } }, req: ["expression"],
    run: (a, C) => C("eval", { expression: String(a.expression) }) },
  // 스크린샷은 "찍혔다"가 아니라 "이게 됐다"를 사람이 알아보게 하는 증거다. 그래서 표시를 같이 그린다.
  // mark로 볼 곳에 번호와 설명을 붙이고, caption으로 이 장면이 무엇을 증명하는지 한 줄 적는다.
  { name: "browser_screenshot",
    desc: "화면을 PNG로 저장한다. mark로 볼 곳에 번호·테두리·설명을 얹고 caption으로 이 장면이 무엇을 증명하는지 적는다 — 사람이 결과만 보고 판단할 수 있게. element면 그 요소만, full이면 페이지 전체, mask는 비밀 가림.",
    schema: {
      caption: { type: "string", description: "이 장면이 증명하는 것 한 줄(화면 아래 띠로 박힌다)" },
      mark: { type: "array", description: "표시할 곳들. 각 항목 {sel|ref, label?, color?} — ref는 snapshot의 그 ref 그대로",
        items: { type: "object", properties: { sel: { type: "string" }, ref: { type: "string" }, label: { type: "string" }, color: { type: "string" } } } },
      mask: { type: "array", description: "가릴 곳(비밀·개인정보). 선택자 문자열 배열", items: { type: "string" } },
      element: { type: "string", description: "이 선택자 영역만 잘라 찍는다" },
      full: { type: "boolean", description: "true면 스크롤 포함 페이지 전체" },
      dpr: { type: "number", description: "배율(2면 레티나 — 보고서에서 글자가 안 뭉갠다). zoom을 건드리지 말고 이것을 쓴다." },
      settle: { type: "number", description: "그리기가 끝나길 기다릴 상한 ms(기본 600). 재조회·애니메이션 중인 화면을 반쯤 찍지 않게." },
      path: { type: "string", description: "저장 경로(미지정이면 상태 폴더의 shots/)" },
      tab: { type: "string", description: "이 명령만 이 탭에서" } },
    run: (a, C) => C("screenshot", { caption: a.caption, mark: a.mark, mask: a.mask, element: a.element, full: a.full, dpr: a.dpr, settle: a.settle, path: a.path, tab: a.tab }) },
  // 스크린샷이 폴더에 흩어져 있으면 사람은 열어보지 않는다. 순서대로 묶어 한 장으로 만든다.
  { name: "browser_report",
    desc: "확인한 것들을 한 장짜리 HTML로 묶는다(이미지 포함, 어디로 옮겨도 열림). kind=review는 내가 확인한 결과를 사람이 훑어보는 보고서, kind=handoff는 남이 실제 서버에서 같은 경로를 밟도록 넘기는 정적 안내서다. 실린 이미지는 실행 폴더에 이름을 갖고 남아 다음 회귀의 '전' 장이자 안내서의 기준 이미지가 된다. 통과(pass)는 browser_expect가 준 receipt가 있어야 적을 수 있다.",
    schema: {
      title: { type: "string", description: "제목(무엇을 확인했는지)" },
      summary: { type: "string", description: "한 줄 요약. 설명이 아니라 사실." },
      kind: { type: "string", enum: ["review", "proof", "regression", "handoff"],
        description: "이 회차가 무엇이었나. review=결함 찾기(기본) · proof=됐다는 보고 · regression=전과 같은지 · handoff=남이 밟도록 넘기는 안내서. handoff만 판정 없이 절차·기대·기준 이미지를 싣는다. 이 값은 회차에 남아 나중에 '지난번 그거'를 찾는 열쇠가 된다." },
      steps: { type: "array", description: "단계들. {name, action?, before?, after?, diff?, expected?, via?, receipt?, receipts?, verdict: pass|fail|info}. expected를 적었으면 그 화면이 있어야 한다 — 판정과 무관하다. 한 동작이 여러 화면을 지나면 항목을 나누지 말고 via에 순서대로 넣는다. 한 화면에서 여러 곳을 확인했으면 receipts에 영수증을 다 넣는다 — 각각 자기 장면이 실린다. 글로만 적은 것은 확인이 아니다.",
        items: { type: "object", properties: {
          name: { type: "string", description: "이 단계가 확인하는 것" },
          action: { type: "string", description: "무엇을 했나(handoff에선 무엇을 하라)" },
          before: { type: "string", description: "조작 전 스크린샷 경로" },
          after: { type: "string", description: "조작 후 스크린샷 경로" },
          via: { type: "array", items: { type: "string" }, description: "전과 후 사이에 거쳐간 화면들(확인 다이얼로그 등)을 순서대로. 한 동작이 여러 화면을 지나도 항목은 하나다 — 나누면 읽는 사람이 같은 것을 두세 번 읽는다." },
          unchanged: { type: "boolean", description: "이 동작으로 화면이 안 바뀌는 것이 기대일 때만. 전과 후가 같은 그림이면 기본은 거부다." },
          diff: { type: "string", description: "browser_diff가 만든 비교 이미지 경로" },
          shot: { type: "string", description: "after의 옛 이름(호환)" },
          expected: { type: "string" }, got: { type: "string" },
          receipt: { type: "string", description: "browser_expect가 돌려준 판정 영수증 id(r1…). pass엔 필수." },
          at: { type: "string", description: "이 단계의 시각. 훑는 표에서 지문이 된다 — 거꾸로 가면 건너뛴 단계나 옛 장면 재사용이 드러난다." },
          noShot: { type: "string", description: "그 화면을 찍을 수 없었던 사유. expected를 적은 단계는 사진이 없으면 보고서가 만들어지지 않는다 — 정말 못 찍었을 때만 여기에 이유를 적고, 그 문장이 보고서에 그대로 실린다. 판정을 info로 내려 피하지 않는다." },
          entityId: { type: "string", description: "이 단계가 소비한 엔터티의 실제 ID. 중간에 다른 데이터로 갈아탔는지가 여기서 보인다." },
          wiring: { type: "string", description: "이 단계가 돈 배선. 한 줄만 다르면 한쪽에서 만들고 다른 쪽에서 조회한 것이다." },
          basis: { type: "string", enum: ["spec", "plan", "code", "user", "assumed"],
            description: "이 단계의 기대(expected)가 어디서 왔는가. spec=명세, plan=기획서, code=코드를 읽어 확인, user=사용자가 정해 줌, assumed=출처 없이 내가 정함. pass엔 필수 — 화면을 보고 기대를 만들면 구현이 곧 명세가 되어 그 통과는 아무것도 보증하지 않는다." },
          basisNote: { type: "string", description: "그 출처를 짚는 한 줄. spec이면 문서와 대목, code면 파일:줄, user면 사용자가 한 말. assumed면 무엇을 어떤 근거로 그렇게 잡았는지를 그 자리에서 읽고 알 수 있게 — 읽는 사람이 다른 문서를 찾아보지 않아도 되게 쓴다." },
          verdict: { type: "string", enum: ["pass", "fail", "info"] } } } },
      overview: { type: "object", description: "보고서 맨 위. 이 보고서 한 장으로 사용자의 최종 요구(기능 단위)·AI가 어떻게 이해하고 구현했는지·어느 케이스가 스크린샷으로 확인했는지를 대조하게 한다. 개발자가 아닌 사람이 읽을 말로 쓰고 코드·선택자·저장소 키를 쓰지 않는다. 장부 회차의 기본 지면에만 실린다.",
        properties: {
          features: { type: "array", description: "사용자의 최종 요구를 기능 단위로 종합한 목록. 요청 발화를 하나씩 옮기지 않는다. 기능마다 {name, need: 교정·결정까지 반영한 최종 요구(줄 배열), understood: AI 이해(줄 배열), built: 구현한 것(줄 배열), cases: 확인한 줄 id 배열, gaps?: 케이스로 확인하지 않은 부분(줄 배열), why?: 케이스가 하나도 없는 이유}.",
            items: { type: "object", properties: { name: { type: "string" }, need: { type: ["string", "array"] }, understood: { type: ["string", "array"] },
              built: { type: ["string", "array"] }, cases: { type: "array", items: { type: "string" } }, gaps: { type: ["string", "array"] }, why: { type: "string" } } } },
          diagrams: { type: "array", description: "역할별 흐름도. {title?, lanes: 역할 이름 배열(제품마다 다름: 사용자·운영자·제휴사 등), steps: [{id, lane, text, col?, focal?}], links: [{from, to, focal?, dashed?}]}. 한 장에 역할 5·단계 9·연결 12·강조 2까지.",
            items: { type: "object" } },
          scope: { type: ["string", "array"], description: "이번 확인 범위와 확인하지 못한 부분(줄 배열)" } } },
      resume: { type: "object", description: "앞 회차를 이어받는다. 이미 통과했고 그 사이에 아무것도 안 바뀐 구간을 다시 밟는 것은 시간만 쓰고 새로 아는 것이 없다. 이어받은 단계는 '이어받음'으로 표시되어 이번에 밟지 않았다는 사실이 지면에 남는다.",
        properties: {
          from: { type: "string", description: "이어받을 회차 id(run-…). 그 회차의 통과 단계를 그대로 물려받는다." },
          redo: { type: "array", items: { type: "string" }, description: "그중 다시 밟을 단계 이름들. 고친 곳과 그 영향이 닿는 곳을 넣는다 — 여기 없는 단계는 '그때 확인된 그대로'라고 이 회차가 주장하는 것이 된다." } } },
      run: { type: "object", description: "review: 회차 요약. 맨 앞에 실려 이 회차를 믿을 만한지 먼저 판단하게 한다.",
        properties: {
          intent: { type: "string", description: "사용자가 정한 조합(어느 화면·서버·저장소로 돌기로 했는가). 실측한 배선과 함께 맨 앞에 선다 — 무엇을 확인한 회차인지가 여기서 정해진다." },
          agreed: { type: "array", items: { type: "object", properties: {
            what: { type: "string", description: "확인하기로 한 것 하나. 항목 하나는 주장 하나다 — '+'·'·'·','로 둘을 묶으면 단계 하나로 덮이고 나머지 절반이 지면에서 사라진다." },
            covers: { type: "array", items: { type: "string" }, description: "이 항목을 덮은 단계. 단계 이름(앞부분만도 된다) 또는 번호. 짐작하지 않으므로 반드시 적는다 — 안 적으면 보고서가 만들어지지 않는다." },
            added: { type: "string", enum: ["start", "mid"], description: "밟기 전부터인가, 회차 도중에 들어왔는가" } } },
            description: "확인하기로 한 것. 밟기 전에 사용자와 합의한 목록이며, 회차 도중 요구가 들어오면 하던 것을 끊지 말고 여기에 더한다(added:\"mid\"). 이 목록이 있어야 확인 못 한 것이 계산된다 — 없으면 애초에 목록에 없던 항목은 빠져도 아무 데도 안 남는다.",
            items: { type: "object", properties: {
              what: { type: "string", description: "확인하기로 한 것 한 줄" },
              added: { type: "string", enum: ["start", "mid"], description: "start=시작할 때 합의(기본) · mid=회차 도중 들어와 더한 것" } } } },
          allowance: { type: "string", description: "쓰기를 어디까지 허용받았는가" },
          discarded: { type: "array", description: "결과 근거에서 뺀 구간. 잘못 밟았거나 조건이 어긋나 다시 밟은 구간을 여기 적는다 — 게이트가 이 선언을 보고 그 구간의 위반을 계산에서 뺀다. 지면에도 그대로 실리므로 무엇을 왜 뺐는지 읽는 사람이 안다.",
            items: { type: "object", properties: {
              receipts: { type: "array", items: { type: "string" }, description: "그 구간에서 나온 판정 영수증들" },
              why: { type: "string", description: "왜 뺐는지 — 한 줄로는 부족하다. 무엇이 어긋나서 그 구간이 근거가 될 수 없는지" } } } },
          wiring: { type: "string", description: "실측한 배선과 그 판정 상태" },
          entity: { type: "string", description: "대상 엔터티와 그 ID" },
          scope: { type: "string", description: "격리 수단" },
          started: { type: "string" }, finished: { type: "string" },
          startedEmpty: { type: "boolean", description: "대상 데이터가 없는 상태에서 시작했는가" },
          teardown: { type: "string", description: "정리 결과" },
          unverified: { type: "array", description: "확인 못 한 것. 비면 '다 확인됨'이 아니라 '없다고 적었다'이다.",
            items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } } } } } },
      target: { type: "string", description: "handoff: 확인할 주소·환경" },
      setup: { type: "string", description: "handoff: 미리 필요한 것(계정 종류 등). 비밀은 적지 않는다." },
      runId: { type: "string", description: "같은 실행에 이어 붙일 때. 미지정이면 새로 만든다." },
      path: { type: "string", description: "저장 경로(미지정이면 실행 폴더 안)" } },
    req: ["steps"],
    run: async (a) => {
      try {
        const steps = Array.isArray(a.steps) ? a.steps : [];
        // 통과는 인상이 아니라 사실이어야 한다. 근거 없는 통과·기록과 어긋나는 통과는 문서로 나가지 못한다.
        if (a.kind !== "handoff") {
          const bad = [];
          steps.forEach((s, i) => {
            const v = s.verdict || "pass";
            if (v !== "pass") return;
            const rc = receiptById(s.receipt || (Array.isArray(s.receipts) ? s.receipts[0] : null));
            if (!rc) bad.push(`${i + 1}번 "${s.name || ""}" — 통과 근거가 없다. browser_expect로 확인하고 그 receipt를 붙일 것.`);
            else if (!rc.pass) bad.push(`${i + 1}번 "${s.name || ""}" — ${rc.id}는 안 됨으로 기록돼 있다. 통과로 적을 수 없다.`);
            // 통과에 근거가 붙듯 기대에도 출처가 붙는다. 고를 수 있는 값에 assumed가 있으므로
            // 여기서 막히는 일은 없다. 없는 출처를 지어내는 대신 없다고 적으면 지나간다.
            const bs = BASIS[String(s.basis || "")];
            if (!bs) bad.push(`${i + 1}번 "${s.name || ""}" — 기대가 어디서 왔는지 없다. basis에 spec·plan·code·user·assumed 중 하나를 적을 것(출처가 없으면 assumed).`);
            else if (!String(s.basisNote || "").trim()) bad.push(`${i + 1}번 "${s.name || ""}" — basis가 ${s.basis}인데 basisNote가 비었다. 여기에 적을 것 — ${bs.need}.`);
          });
          if (bad.length) return { ok: false, error: "통과는 도구가 확인한 사실에서만 나온다.\n" + bad.join("\n") };
          // 이어받기는 다시 실행하는 수고를 더는 장치이지 실행하지 않아도 되게 하는 장치가 아니다.
          // 앞 회차를 지목하고 redo를 비우고 steps를 비우면 아무것도 실행하지 않은 채 앞 회차의
          // 통과를 그대로 다시 발행할 수 있다. 화면에는 "이번에 밟은 단계 0개"가 남지만
          // 맨 위 결론은 여전히 다 됐다고 말한다.
          // 공집합은 모든 규칙을 만족하므로, 아무것도 확인하지 않은 회차가 가장 깨끗한 보고서를
          // 낸다. 확인이 없으면 보고할 것도 없다.
          // 다만 원장 회차는 단계를 직접 쓰지 않는다. 화면이 장부를 그대로 그리므로 steps가
          // 비는 것이 정상이다. 그래서 "빈손"의 뜻이 둘로 갈린다: 아무것도 실행하지 않은 회차와,
          // 실행한 것이 전부 장부에 있는 회차. 장부에 닫힌 줄이 있으면 뒤쪽이다.
          // (확인 결과: 이 구분이 없으면 원장 회차가 자기 보고서를 도구로 낼 수 없고,
          //  그래서 직접 작성하는 우회가 생긴다. 게이트가 막는 것이 그 우회다.)
          const ledgerRows = hasLedgerRows(a.runId || CURRENT_RUN);
          if (!steps.length && !ledgerRows && !(a.resume && a.resume.from) && String(a.kind || "") !== "handoff")
            return { ok: false, error:
              "단계가 하나도 없다. 확인한 것이 없으면 보고서가 아니다.\n"
              + "무엇 하나라도 확인했다면 그 단계를 steps에 넣는다 — 확인하지 못했다면 그 사실은 "
              + "run.unverified에 적는다." };
          if (a.resume && a.resume.from && !steps.length && !ledgerRows)
            return { ok: false, error:
              "이어받기만으로는 회차가 되지 않는다. 이번에 밟은 단계가 하나도 없다.\n"
              + "다시 볼 것이 정말 없다면 그것은 새 회차가 아니라 앞 회차의 보고서다 — 그것을 그대로 쓴다.\n"
              + "무언가를 다시 확인했다면 그 단계를 steps에 넣는다." };
          // 확인하기로 한 것이 없으면 빠뜨린 항목이 어디에도 남지 않는다. 목록에 없던 것은
          // 빠져도 티가 안 나고, 읽는 사람은 그것이 빠졌다는 사실조차 알 수 없다.
          const agreed = (a.run && Array.isArray(a.run.agreed) ? a.run.agreed : [])
            .filter((x) => x && String(x.what || "").trim());
          // 원장 회차에서는 줄 자체가 "확인하기로 한 것"이다. 실행 전에 선언해야 열리므로
          // 목록이 이미 있고, 같은 것을 agreed에 다시 옮겨 적게 하면 직접 쓰는 단계가 되살아난다.
          if (!agreed.length && ledgerRows) { /* 장부가 목록이다 */ }
          else if (!agreed.length) return { ok: false, error:
            "확인하기로 한 것이 없다. run.agreed에 밟기 전에 합의한 목록을 넣을 것 — "
            + "[{what:\"쿠폰 등록\", added:\"start\"}, …]. 회차 도중 들어온 요구는 added:\"mid\"로 더한다.\n"
            + "이 목록이 있어야 '확인하기로 한 것 − 확인한 것 = 빠뜨린 것'이 계산된다." };
        }
        // 실행하지 못한 것을 남기는 기능은 그대로 두고 경로만 하나로 모은다. 판정은 report.mjs가 한다.
        if (String(a.kind || "") !== "handoff") {
          const bypass = unverifiedOutsideLedger(a.run, hasLedgerRows(a.runId || CURRENT_RUN));
          if (bypass) return { ok: false, error: bypass };
        }
        // 합의한 것과 실행한 것을 잇는다. 수만 맞대면 19개 합의·21단계에서도 한 항목이 통째로
        // 확인되지 않은 채 지나간다(확인 결과).
        if (String(a.kind || "") !== "handoff") {
          const gaps = coverGaps(
            (a.run && Array.isArray(a.run.agreed) ? a.run.agreed : []).filter((x) => x && String(x.what || "").trim()),
            steps);
          if (gaps.length) return { ok: false, error:
            `확인하기로 한 것과 밟은 단계가 안 이어진다 — ${gaps.length}건.\n`
            + gaps.slice(0, 12).map((g) => "  " + g).join("\n")
            + (gaps.length > 12 ? `\n  … 외 ${gaps.length - 12}건` : "")
            + "\n\n항목 하나는 주장 하나다. 둘을 묶으면 단계 하나로 덮이고 나머지 절반은 재현도\n"
            + "판정도 장면도 없이 지면에서 사라진다.\n"
            + "각 항목에 그것을 덮은 단계를 covers로 적는다 — covers:[\"R11 …\"] 또는 covers:[2].\n"
            + "못 밟은 항목은 지우지 말고 run.unverified에 사유와 함께 남긴다(원장 회차는 줄로 세워 gray·blue로 닫는다)." };
        }
        // 전/후 짝이 그 동작의 앞뒤인가.
        const pairs = pairProblems(steps);
        if (pairs.length && String(a.kind || "") !== "handoff") return { ok: false, error:
          `"전"과 "후"가 그 동작의 앞뒤가 아니다 — ${pairs.length}건.\n`
          + pairs.slice(0, 12).map((b) => "  " + b).join("\n")
          + (pairs.length > 12 ? `\n  … 외 ${pairs.length - 12}건` : "")
          + "\n\n한 동작은 한 항목이다. 누르기 → 확인 다이얼로그 → 반영을 항목 셋으로 나누면\n"
          + "읽는 사람이 같은 것을 세 번 읽는다. 하나로 합치고 거쳐간 화면은 via에 순서대로 넣는다:\n"
          + '  { name:"판매 제한 해제", before:"목록.png", via:["다이얼로그.png"], after:"해제됨.png" }\n'
          + "전은 누르기 직전, 후는 끝난 뒤 그 화면에서 찍은 것이어야 한다.\n"
          + "직전 상태를 못 찍었으면 before를 비운다 — 없는 것이 남의 것보다 낫다.\n"
          + "정말 화면이 안 바뀌는 것이 기대라면 그 단계에 unchanged:true를 적는다." };
        // 사진 없는 주장은 여기서 멈춘다. 만든 뒤에 딱지로 알리면 그 보고서는 이미 나간 뒤다.
        // 넘기기 문서는 판정이 아니라 절차라 이 검사를 받지 않는다. 거기 기대 이미지는 "이렇게
        // 보이면 정상"이지 "이렇게 보였다"가 아니다.
        const unshot = unshotClaims(steps, String(a.kind || "") === "handoff");
        if (unshot.length) return { ok: false, error:
          `화면을 주장했는데 그 화면이 없는 단계가 ${unshot.length}개다.\n`
          + unshot.slice(0, 12).join("\n")
          + (unshot.length > 12 ? `\n… 외 ${unshot.length - 12}건` : "")
          + "\n\n됐다는 것도 실측이다 — 정상 동작이야말로 사진이 있어야 다음 회차에서 비교된다.\n"
          + "그 자리를 다시 밟아 browser_expect(영수증에 장면이 딸려 온다)나 browser_screenshot을 남긴다.\n"
          + "찍을 수 없었다면 그 단계의 noShot에 사유를 적는다 — 보고서에 그대로 실린다.\n"
          + "판정을 info로 내리거나 expected를 지워서 통과시키지 않는다." };
        return await openInIris(buildReport({ title: a.title, summary: a.summary, steps, out: a.path,
          kind: a.kind, runId: a.runId, target: a.target, setup: a.setup, run: a.run, resume: a.resume,
          overview: a.overview }),
          a.kind === "handoff");
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    } },
  // 판정과 증거는 같은 순간의 것이어야 한다. 따로 하면 그 사이에 화면이 바뀐다.
  { name: "browser_expect",
    desc: "조건을 확인하고 그 판정 근거를 표시한 스크린샷까지 한 번에 남긴다. 통과/실패와 실제 값, 증거 이미지 경로를 돌려준다.",
    schema: { selector: { type: "string", description: "확인할 요소(CSS 선택자)" },
      text: { type: "string", description: "기대하는 텍스트(contains/equals일 때)" },
      mode: { type: "string", enum: ["contains", "equals", "exists", "absent"], description: "기본 contains(text 있을 때)·exists(없을 때)" },
      label: { type: "string", description: "확인 대상을 화면에 보이는 이름으로(예: '주간 미션 스위치'). 보고서 기본 지면은 선택자 대신 이 이름을 싣는다" },
      dpr: { type: "number", description: "증거 이미지 배율(2면 레티나)" },
      tab: { type: "string" } },
    req: ["selector"],
    run: async (a, C) => {
      const r = await C("expect", { sel: String(a.selector), text: a.text, mode: a.mode, label: a.label, dpr: a.dpr, tab: a.tab });
      // 이 순간의 사실을 영수증으로 남긴다. 보고서의 통과는 이 기록에서만 나온다.
      if (r && r.ok && r.data) {
        const rc = addReceipt({ selector: String(a.selector), label: a.label || null, mode: a.mode || (a.text == null ? "exists" : "contains"),
          want: a.text == null ? null : String(a.text), expected: r.data.expected, displayExpected: r.data.displayExpected, element: r.data.element, got: r.data.got,
          pass: !!r.data.pass, found: !!r.data.found, shot: r.data.shot || null }, r.data.receipt, CURRENT_RUN);
        r.data.receipt = rc.id;
      }
      return r;
    } },
  // "바뀌었다"를 말이 아니라 그림으로.
  { name: "browser_diff",
    desc: "스크린샷 두 장을 픽셀로 비교해 달라진 곳만 빨갛게 칠한 이미지를 만든다. 회귀 확인·전후 비교용.",
    schema: { before: { type: "string", description: "이전 PNG 경로" }, after: { type: "string", description: "이후 PNG 경로" },
      threshold: { type: "number", description: "무시할 색 차이(기본 24)" }, path: { type: "string" }, tab: { type: "string" } },
    req: ["before", "after"],
    run: (a, C) => C("diff", { before: String(a.before), after: String(a.after), threshold: a.threshold, path: a.path, tab: a.tab }) },
  // 반응형은 폭을 바꿔가며 같은 화면을 보는 일이다. 한 번에 실행하고 원래 크기로 되돌린다.
  { name: "browser_shot_sizes",
    desc: "모바일·패드·데스크톱(또는 1024x768 형식) 크기로 차례로 바꿔가며 각각 찍고 원래 크기로 되돌린다. 반응형 확인용.",
    schema: { sizes: { type: "array", items: { type: "string" }, description: "기본 [모바일, 패드, 데스크톱]" },
      caption: { type: "string" }, dpr: { type: "number" }, settle: { type: "number", description: "전환 후 대기 ms(기본 700)" },
      tab: { type: "string" } },
    run: (a, C) => C("shotsizes", { sizes: a.sizes, caption: a.caption, dpr: a.dpr, settle: a.settle, tab: a.tab }) },
  // 눈으로 확인되지 않는 결함. 이름 없는 버튼, alt 없는 이미지, 라벨 없는 입력칸, 옅은 글자.
  { name: "browser_a11y_check",
    desc: "접근성 결함을 찾는다 — 이름 없는 버튼·링크, alt 없는 이미지, 라벨 없는 입력칸, 대비 부족 글자. 위치(선택자 경로)까지 돌려준다.",
    schema: { tab: { type: "string" } }, run: (a, C) => C("a11y", { tab: a.tab }) },
  // 무엇을 했는지는 서버가 이미 기록한다. 보고서 단계를 다시 쓰지 않도록 그것을 그대로 받는다.
  { name: "browser_trace",
    desc: "이 세션이 지금까지 한 조작(클릭·입력·이동)의 기록. 보고서 단계로 그대로 옮겨 쓸 수 있다. clear를 주면 읽고 비운다.",
    schema: { clear: { type: "boolean" } }, run: (a, C) => C("trace", { clear: !!a.clear }) },
  { name: "browser_observe", desc: "닫힌 루프 QA: 스크린샷 + 콘솔 오류 + 예외 + 네트워크 실패 + 뜬 대화상자를 한 번에. 뭔가 안 될 때 원인을 찾는 첫 도구.",
    schema: { limit: { type: "number" }, level: { type: "string", enum: ["error", "warn", "all"] },
      screenshot: { type: "boolean", description: "false면 스크린샷 생략" } },
    run: (a, C) => C("observe", { limit: a.limit, level: a.level, screenshot: a.screenshot }) },
  { name: "browser_dialogs", desc: "alert·confirm 자동 응답을 무장/해제한다. 기본은 해제 — 사람이 보고 누른다. 'ok'·'cancel'은 이후 전부, 'ok,cancel'처럼 쉼표로 주면 뜨는 순서대로 답하고 다 쓰면 다시 사람에게 넘긴다.",
    schema: { plan: { type: "string", description: "off · ok · cancel · 쉼표로 이은 순서(예: ok,cancel,ok)" },
      promptText: { type: "string", description: "prompt 대화상자에 넣을 값" } },
    req: ["plan"], run: (a, C) => C("dialogs", { plan: String(a.plan), text: a.promptText }) },
  // 네이티브 창은 CDP 밖이다. 파일 선택·저장 패널은 뜨는 순간 사람이 누를 때까지 전부 멈춘다.
  { name: "browser_upload", desc: "페이지에 로컬 파일을 넣는다(네이티브 파일 선택 창을 띄우지 않는다). 파일 입력칸을 알면 ref/sel로 지목하고, 버튼이 숨은 입력을 여는 형태면 지목 없이 먼저 부른 뒤 그 버튼을 누른다.",
    schema: { paths: { type: "array", items: { type: "string" }, description: "올릴 파일 절대경로" }, ref: { type: "string" }, sel: { type: "string" }, timeout: { type: "number" } },
    req: ["paths"],
    run: (a, C) => C("upload", { paths: a.paths, ref: a.ref, sel: a.sel, timeout: a.timeout }) },
  { name: "browser_download", desc: "다운로드 저장 위치를 무장한다. 무장하면 네이티브 저장 창 없이 그 폴더에 저장된다. off면 사람이 고른다(기본).",
    schema: { dir: { type: "string", description: "절대경로 폴더, 또는 off" }, once: { type: "boolean", description: "다음 한 번만" } },
    run: (a, C) => C("download", { dir: a.dir, once: a.once }) },
  { name: "browser_native_windows", desc: "OS가 그린 창·시트를 본다(파일 패널·권한 시트·인쇄 창 등 CDP로는 안 보이는 층). 뭔가 멈춰 있는데 원인을 모를 때 확인한다.",
    schema: {}, run: (a, C) => C("nativewin") },
  { name: "browser_native_click", desc: "네이티브 창·시트의 버튼을 이름으로 누른다. 먼저 browser_native_windows로 버튼 이름을 확인한다.",
    schema: { button: { type: "string" } }, req: ["button"],
    run: (a, C) => C("nativeclick", { button: a.button }) },
  { name: "browser_dialog", desc: "지금 떠 있는 alert/confirm/prompt를 닫는다. 확인 창은 탭이 아니라 창에 붙어서, 뜬 채로 두면 그 창의 조작이 통째로 막힌다. 이 명령은 다른 명령이 그 창에 막혀 있어도 실행된다.",
    schema: { answer: { type: "string", enum: ["ok", "cancel"] }, text: { type: "string" } },
    run: (a, C) => C("dialog", { answer: a.answer || "cancel", ...(a.text != null ? { text: a.text } : {}) }) },
  { name: "browser_login", desc: "저장된 로그인으로 이 페이지의 아이디/비밀번호 칸을 채운다. 사용자가 앱의 [🔑 로그인]에서 허용한 (사이트, 아이디)만 가능하다. 허용된 계정이 여럿이면 목록을 돌려주니 하나를 골라 다시 부른다. 비밀번호 값은 돌아오지 않고 이 탭의 명령 결과에서도 가려진다. 채운 뒤 로그인 버튼은 직접 눌러야 한다. 저장된 계정이 없거나 허용되지 않았으면 사용자에게 알림이 가고 사람이 로그인한다.",
    schema: { username: { type: "string", description: "허용된 계정이 여럿일 때 고를 아이디" } },
    run: (a, C) => C("login", a.username != null ? { username: a.username } : {}) },
  { name: "browser_native_key", desc: "네이티브 창에 escape 또는 enter를 보낸다. 파일 열기·저장 패널은 버튼이 그룹 안에 중첩돼 이름으로 못 짚는 경우가 많은데 이 둘은 항상 통한다 — 뜬 창을 닫는 가장 확실한 길.",
    schema: { key: { type: "string", enum: ["escape", "enter"] } },
    run: (a, C) => C("nativekey", { key: a["key"] || "escape" }) },
  { name: "browser_new_tab", desc: "이 세션이 쓸 탭을 확보한다. 이미 쓰던 탭이 있으면 새로 만들지 않고 그 탭을 쓴다(주소를 주면 거기로 이동) — 탭이 늘수록 사람의 브라우저가 어지러워진다. 정말 새 탭이 필요한 경우는 두 페이지를 동시에 살려둬야 할 때와 다른 계정·프로필로 열어야 할 때뿐이고, 그때만 parallel을 준다. 탭은 백그라운드로 열려 사용자 화면을 가로채지 않고, 정체성에 묶여 있어 앱 재시작 뒤에도 같은 탭이다. "
      + "새로고침에는 쓰지 않는다 — 페이지를 그대로 다시 부르는 것은 browser_history {action:\"reload\"}다. 같은 흐름에서 다음 화면으로 넘어가는 것은 browser_goto이고, 이 도구는 '쓸 탭을 얻는' 자리에만 쓴다. "
      + "사람이 지목해 준 탭에 다른 사이트를 실으려 하면 덮지 않고 어느 길인지 알려 준다.",
    schema: { url: { type: "string", description: "열 주소(http/https). 생략하면 구글." },
      title: { type: "string", description: "탭에 붙일 이름 — 사용자가 어느 에이전트의 탭인지 알아보게." },
      parallel: { type: "boolean", description: "true면 쓰던 탭을 두고 하나 더 만든다. 두 화면이 동시에 살아 있어야 할 때만 — 예: 같은 사이트의 프론트와 어드민을 함께 보며 비교." },
      profile: { type: "string", description: "로그인 칸(프로필) 이름. 같은 사이트에 다른 계정으로 로그인해야 할 때 필수 — 칸을 안 가르면 쿠키가 하나라 한쪽이 로그아웃된다. 쓸 수 있는 이름은 browser_tabs의 profiles에 있다. 없는 계정용 칸은 사람이 앱에서 만들어 로그인해야 한다." } },
    run: (a, C) => C("newtab", { url: a.url, title: a.title, parallel: a.parallel, profile: a.profile }) },
  { name: "browser_ask_user", desc: "사람을 부른다. 결제·본인확인·캡차·약관 동의처럼 AI가 대신하면 안 되거나 대신할 수 없는 자리, 그리고 되돌리기 어려운 일에 승인을 받아야 하는 자리에서 쓴다. 사용자 화면을 빼앗지 않고 우측 상단 알림으로 부르며, 알림의 [그 탭으로](앱이면 [그 앱으로]) 버튼이 그 자리까지 데려간다. 무엇을 고를지는 choices로 네가 정한다. 사람이 끝냈다고 답할 때까지 붙잡고 기다린다(그 탭으로 간 것만으로는 돌려주지 않는다). 부르고 나서 턴을 끝내지 마라 — 이 도구의 답을 받고 화면을 확인해 이어서 진행한다. 시간 안에 답이 없으면 같은 인자로 다시 불러 이어 기다린다(알림은 다시 뜨지 않고 그 부름을 이어받는다).",
    schema: { message: { type: "string", description: "무엇을 해달라는지 한 줄. 예: 결제 수단을 선택하고 결제해 주세요." },
      title: { type: "string", description: "알림 제목(생략 가능)." },
      tab: { type: "string", description: "그 자리가 있는 탭. 생략하면 이 세션이 쓰는 탭." },
      device: { type: "string", description: "브라우저가 아니라 기기 앱(iOS 시뮬레이터·Android)에서 해야 하는 자리면 그 기기(app_targets의 udid·시리얼·이름). 주면 알림이 [그 앱으로]로 바뀌고, 눌렀을 때 그 기기가 열린 Iris 에뮬레이터 탭으로 데려간다. tab과 함께 주지 않는다." },
      choices: { type: "array", items: { type: "string" }, maxItems: 4,
        description: "사람이 고를 답을 직접 정한다(최대 4개). 예: [\"네\",\"아니오\"] · [\"승인\",\"취소\",\"나중에\"]. 첫 번째가 진행을 뜻하는 답이고 그것을 고르면 done:true로 온다. 생략하면 예전대로 [확인] 하나이며 다 했음/못 했음만 받는다. 답은 고른 글자 그대로 answer에 온다." },
      wait: { type: "number", description: "사람의 응답을 기다릴 초(기본 180, 0이면 안 기다림, 한 호출 최대 240 — 넘으면 다시 불러 이어 기다린다)." },
      ready: { type: "boolean", description: "네가 채울 수 있는 칸을 다 채웠다는 확인. 화면에 아직 채울 수 있는 필수 칸이 남아 있으면 이 도구는 부르지 않고 그 목록을 돌려준다 — 값을 모르면 탭을 넘기지 말고 사용자에게 값만 물어 네가 채워라. 사람만 할 수 있는 부분(카드·비밀번호·인증번호·본인확인)만 남았을 때 true." } },
    // 기기 이름은 udid·시리얼로 바꿔 보낸다. 서버는 그 값의 모양으로 iOS 와 Android 를 가른다.
    run: async (a, C) => C("ask", { message: a.message, title: a.title, tab: a.tab,
      device: a.device ? (await appSurface.simTarget(a.device)) || a.device : a.device,
      choices: Array.isArray(a.choices) ? a.choices : undefined, wait: a.wait, ready: a.ready }) },
  { name: "browser_picks", desc: "사용자가 화면에서 직접 고른 요소들(최근 10개). 고르는 순간 그 탭은 이 세션이 만질 수 있게 열리지만(권한) 대상 탭이 바뀌지는 않는다 — 그 탭을 직접 다뤄야 할 때만 tab에 그 핸들을 넣어라. 터미널에 붙은 글은 사람이 읽는 형식이고, 이 도구는 선택자·대체 선택자·속성·소스 파일 같은 원본 필드를 준다.",
    schema: {}, run: (a, C) => C("picks") },
  // ── 모바일 앱(iOS·Android) ──
  // 브라우저와 같은 QA 방식을 앱에도 쓴다. 판정은 여기서도 app_expect의 영수증에서만 나오고,
  // 보고서·실행 폴더·전후 비교는 브라우저와 같은 것을 쓴다.
  ...appSurface.tools,
  { name: "browser_tabs", desc: "열린 브라우저 탭 목록(핸들·URL·제목)과 이 세션이 고정한 탭, 그리고 쓸 수 있는 로그인 칸(profiles).", schema: {}, run: (a, C) => C("tabs") },
  // 회차를 열면 그때부터 서버가 모든 조작·판정·장면을 회차 폴더에 한 줄씩 덧붙인다. 그 파일이
  // 회차의 원본이고, manifest·보고서는 거기서 파생된다. 나중에 기억해 서술한 것이 정본이 되면
  // 그 서술 자체가 환각 표면이 되기 때문이다.
  { name: "browser_run",
    desc: "QA 회차를 연다·닫는다·조회한다. begin으로 열면 이후 이 세션의 모든 조작·판정·장면이 회차 폴더의 events.jsonl에 순번과 함께 덧붙여진다(덮어쓰지 않고, 실패도 남는다). 그 로그가 회차의 원본이라 manifest의 단계·영수증을 손으로 쓰지 않고 파생할 수 있다. 같은 runId로 다시 begin하면 이어 붙는다. 확인을 시작하기 전에 연다.",
    schema: { action: { type: "string", enum: ["begin", "end", "status"], description: "기본 status" },
      runId: { type: "string", description: "begin에서 이어 붙일 회차. 미지정이면 새로 만든다." },
      kind: { type: "string", enum: ["review", "proof", "regression"],
        description: "이 회차가 무엇인가. proof·regression은 밟기 전에 rows(원장)가 있어야 열린다 — 무엇을 확인할지 먼저 적어야 화면을 보고 기대를 만드는 일이 없다. review는 빈 원장으로 열고, 탐색이 발견한 것이 줄을 만든다. 기본 review." },
      rows: { type: "array", description: "확인할 줄. 요구 하나가 줄 하나가 아니라 (요구 × 조건) 하나다 — 같은 요구라도 조건이 다르면 동작이 다르고, 그 조건들이 곧 확인 대상이다.",
        items: { type: "object", properties: {
          id: { type: "string", description: "줄 번호(U5 등)" },
          what: { type: "string", description: "이 조건에서 무엇이 성립해야 하는가" },
          given: { type: "string", description: "이 줄이 성립하려면 세계가 어떠해야 하는가. 조건이 같은 줄들은 한 번의 준비로 함께 밟는다 — 정확히 적을수록 준비가 줄어든다." },
          basis: { type: "string", enum: ["spec", "plan", "user", "code", "assumed"],
            description: "이 기대가 어디서 왔는가. spec·plan·user는 못 지켰을 때 색이 red로 고정된다 — 문서·기획에 적힌 것과 사용자가 그렇게 하라고 한 것은 경중을 따질 자리가 아니다." },
          basisNote: { type: "string", description: "출처를 짚는 한 줄" },
          paths: { type: "array", items: { type: "string" },
            description: "이 요구가 가지는 경로: 정상·경계·실패. 선언한 것 중 안 밟은 것이 있으면 그 줄은 안 닫힌다." },
          quote: { type: "string", description: "근거 문서에 적힌 문장 그대로. 보고서가 이것을 실어 읽는 사람이 원문을 안 열어도 되게 한다." },
          source: { type: "string", description: "그 문장이 어디의 몇 행인가(파일:행)." },
          sourceShot: { type: "string", description: "그 문서를 띄워 찍은 화면 경로." },
          covers: { type: "array", items: { type: "string" }, description: "이 줄이 list의 어느 항목을 보는가." },
          } } },
      list: { type: "array", description: "이 회차가 확인하기로 한 목록들. 앞 회차의 지적 목록과 \"알림 발생 자리\" 같은 코드에서 뜬 목록을 함께 들 수 있다. 보고서 맨 앞에 서고, 줄의 covers로 이어져 어느 항목을 누가 봤는지가 보인다. 아무 줄도 안 본 항목이 있으면 회차가 안 닫힌다 — 한 자리만 밟고 그 동작을 확인했다고 적을 수 없다.",
        items: { type: "object", properties: {
          name: { type: "string", description: "그 목록의 이름" },
          source: { type: "string", description: "어디서 온 목록인가(파일 경로·문서)" },
          from: { type: "object", description: "항목을 파일에서 떠 온다. 손으로 옮겨 적으면 옮긴 사람이 아는 것만 목록이 되고, 빠진 차원은 티도 안 난다 — 알림처럼 발생 자리가 여섯인 동작이 한 줄로 닫힌 적이 있다. 코드가 여섯을 가지면 목록도 여섯이다.",
            properties: {
              source: { type: "string", description: "읽을 파일 경로" },
              usedIn: { type: "string", description: "부르는 자리를 셀 폴더. 목록을 한 파일에서 뜨면 그 파일이 진실이라는 전제가 생긴다 — 선언만 있고 아무도 안 부르는 자리는 목록에는 서도 실제로는 안 나간다. 여기 폴더를 주면 항목 id를 부르는 파일이 하나도 없는 항목에 \"부르는 자리 없음\" 표가 붙는다." },
              pick: { type: "string", description: "찾을 규칙(정규식). 괄호가 있으면 그 안이 항목 id, 없으면 매치 전체. 예: \"async (\\\\w+)\\\\(\" · \"[A-Z_]+ = '([a-z_]+)'\". 아무것도 못 찾으면 목록을 안 만들고 거절한다." } } },
          shot: { type: "string", description: "그 목록을 띄워 찍은 화면" },
          items: { type: "array", description: "직접 적는 항목. from과 함께 쓰면 코드가 안 보여주는 것(설정 기본값·껐을 때)을 더한다.",
            items: { type: "object", properties: {
              id: { type: "string", description: "항목 번호(L1 등). 줄의 covers가 이것을 가리킨다." },
              text: { type: "string", description: "항목 내용" },
              was: { type: "string", description: "그때 무엇이었나(지난 회차의 상태)" },
              shot: { type: "string", description: "그 항목의 그때 화면" } } } } } } },
      force: { type: "boolean", description: "end에서 원장이 안 닫혔어도 닫는다. 쓰지 않는 것이 기본." },
      surfaces: { type: "array", items: { type: "string" },
        description: "이 회차가 확인할 표면을 begin에서 선언한다 — \"app\"·\"web:<탭핸들>\" 형태. 앱과 웹과 CMS를 섞어도 되지만 무엇을 볼지는 시작할 때 정한다. 여기 적힌 표면은 대량 기입이 거부된다(판정하는 화면은 한 칸씩 밟는다)." } },
    run: async (a, C) => {
      const act = a.action || "status";
      const r = await C("run", { action: act, runId: a.runId || CURRENT_RUN || undefined,
        ...(a.kind ? { kind: String(a.kind) } : {}),
        ...(Array.isArray(a.rows) && a.rows.length ? { rows: a.rows } : {}),
        ...(a.list && typeof a.list === "object" ? { list: a.list } : {}),   // 배열도 객체 하나도 받는다
        ...(a.force ? { force: true } : {}),
        ...(Array.isArray(a.surfaces) && a.surfaces.length ? { surfaces: a.surfaces } : {}) });
      // 받은 회차를 이 프로세스가 들고 다니며 이후 모든 호출에 싣는다.
      if (r && r.ok && r.data) CURRENT_RUN = act === "end" ? null : (r.data.runId || CURRENT_RUN);
      return r;
    } },
  // 회차의 단위는 단계가 아니라 요구 줄이다. 단계를 직접 쓰는 경로를 없애면 사진 없는
  // 단계도, 전후 불일치도, 과분할도 생길 수 없는 형태가 된다.
  { name: "browser_row",
    desc: "요구 줄을 만들고 열고 닫는다. 줄을 열면 그때부터의 장면·판정만 그 줄의 증거가 된다 — 열기 전 것은 세지 않는다. 그 한 규칙이 '기대가 화면보다 먼저'와 '찾았으면 재현하라'를 같이 세운다. 증거 수는 서버가 세므로 적어 넣지 않는다.",
    schema: { action: { type: "string", enum: ["declare", "basis", "covers", "open", "close", "aside", "note", "void", "list"],
        description: "declare=줄 만들기(review에서 발견한 것도 여기로) · basis=근거 원문 붙이기 · covers=이미 만든 줄을 목록 항목에 잇기(목록이 회차 중간에 들어왔을 때) · open=밟기 시작 · close=이 경로 끝 · aside=그 줄의 화면이 아닌 장면 떼어내기 · note=설계·기획 문제 · void=잘못 물은 판정 무효 · list=지금 원장" },
      row: { type: "string", description: "open·close·note에서 줄 번호. declare에서는 객체를 넣는다." },
      path: { type: "string", enum: ["정상", "경계", "실패"], description: "open·close에서 어느 경로인가" },
      color: { type: "string", enum: ["red", "orange", "yellow", "green", "blue", "gray"],
        description: "close의 판정. red=흐름이 깨진다 · orange=쓰기 어렵다 · yellow=수정 권함 · green=정상 · blue=사용자가 정해야 함 · gray=분류 불가. basis가 spec·plan·user인 줄이 미충족이면 red 말고는 거부된다." },
      note: { type: "string", description: "close에서 한 줄 설명" },
      id: { type: "string", description: "declare: 줄 번호(U5 등)" },
      what: { type: "string", description: "declare: 이 조건에서 무엇이 성립해야 하는가 / note: 무엇을 봤는가 / basis: 이미 선언된 줄의 설명 교정 — 원래 선언은 장부에 남고 교정이 뒤에 붙는다" },
      given: { type: "string", description: "declare: 이 줄이 성립하려면 세계가 어떠해야 하는가" },
      basis: { type: "string", enum: ["spec", "plan", "user", "code", "assumed"],
        description: "declare: 이 기대가 어디서 왔는가. spec·plan·user는 미충족 시 red 고정." },
      basisNote: { type: "string", description: "declare: 출처를 짚는 한 줄. basis 액션에서 주면 이미 선언된 줄의 근거 한 줄을 교정한다 — 원래 선언은 장부에 그대로 남고 교정이 뒤에 붙는다." },
      paths: { type: "array", items: { type: "string" }, description: "declare: 정상·경계·실패 중 이 요구가 가지는 것" },
      decide: { type: "string", description: "note: 무엇을 정해야 하는가. 이게 없으면 노트가 아니라 감상이다." },
      why: { type: "string", description: "note: 왜 결함이 아닌가. 왜 결정이 필요한 자리인가를 함께 적는다." },
      options: { type: "array", description: "note·close(blue): 고를 수 있는 갈래. 둘 이상 — 하나뿐이면 그건 갈래가 아니라 통보다. 정하는 사람은 이 화면을 안 봤고 코드도 안 읽는다. 각 갈래는 무엇을 하는 것이고 고르면 무엇이 달라지는지가 그 자리에서 끝나야 한다.",
        items: { type: "object", properties: {
          pick: { type: "string", description: "무엇을 한다 — 동작 한 줄" },
          then: { type: "string", description: "고르면 이렇게 된다 — 결과 한 줄" },
          cost: { type: "string", description: "대신 잃는 것·드는 것. 없으면 비운다." } },
          required: ["pick", "then"] } },
      lean: { type: "string", description: "note·close(blue): 내가 어느 쪽으로 기우는지와 그 이유. 결정이 아니라 참고 — 없으면 비운다." },
      simple: { type: "boolean", description: "note·close(blue): 근거도 갈래도 필요 없는 간단한 결정. 지면에 \"간단한 결정\"으로 표시된다 — 빠져나가는 자리가 아니라 보이는 자리다." },
      shot: { type: "string", description: "note·declare: 그 자리의 장면. declare에서는 근거 문서를 띄워 찍은 화면(sourceShot)." },
      quote: { type: "string", description: "declare·basis·note: 근거 문서에 적힌 문장 그대로. 옮겨 적지 말고 그대로 — 요약하면 원문이 아니다. 보고서가 이 문장을 실어 읽는 사람이 원문을 안 열어도 되게 한다." },
      source: { type: "string", description: "declare·basis·note: 그 문장이 어디의 몇 행인가(파일:행, 문서 제목과 대목)." },
      sourceShot: { type: "string", description: "declare·basis: 그 문서를 띄워 찍은 화면 경로." },
      covers: { type: "array", items: { type: "string" }, description: "declare·covers: 이 줄이 목록의 어느 항목을 보는가(browser_run begin의 list 항목 id). covers action으로 이미 만든 줄에 나중에 붙일 수 있다 — 덮지 않고 더한다. 목록에 없는 id는 거절한다." },
      receipt: { type: "string", description: "void: 무효로 만들 판정 영수증(r3 등)." },
      frames: { type: "array", items: { type: "string" }, description: "aside: 이 줄의 것이 아닌 장면 파일 경로들." },
      runId: { type: "string", description: "어느 회차의 줄인가. browser_run begin이 돌려준 값을 그대로 싣는다 — 안 실으면 이 세션이 마지막에 연 회차로 간다. 회차 둘이 겹칠 때 그 기본값이 무너진다." } },
    run: async (a, C) => {
      const act = String(a.action || "list");
      if (act === "declare") {
        const r0 = (a.row && typeof a.row === "object") ? a.row : a;
        return C("row", { action: "declare", runId: a.runId || CURRENT_RUN || undefined,
          row: { id: r0.id, what: r0.what, given: r0.given, basis: r0.basis,
            basisNote: r0.basisNote, paths: r0.paths, quote: r0.quote, source: r0.source,
            sourceShot: r0.sourceShot || r0.shot, covers: r0.covers } });
      }
      if (act === "note") return C("row", { action: "note", runId: a.runId || CURRENT_RUN || undefined,
        note: { what: a.what, decide: a.decide, why: a.why, row: a.row, shot: a.shot,
          quote: a.quote, source: a.source, options: a.options, lean: a.lean, simple: a.simple } });
      if (act === "basis") return C("row", { action: "basis", runId: a.runId || CURRENT_RUN || undefined,
        row: a.row, basis: { quote: a.quote, source: a.source, shot: a.sourceShot || a.shot,
          note: a.basisNote, what: a.what } });
      // 스키마만 있고 전달자가 없으면 값이 서버까지 안 간다.
      if (act === "covers") return C("row", { action: "covers", runId: a.runId || CURRENT_RUN || undefined,
        row: a.row, covers: a.covers });
      if (act === "void") return C("row", { action: "void", runId: a.runId || CURRENT_RUN || undefined,
        receipt: a.receipt, why: a.why });
      if (act === "aside") return C("row", { action: "aside", runId: a.runId || CURRENT_RUN || undefined,
        row: a.row, path: a.path, frames: a.frames, why: a.why });
      return C("row", { action: act, runId: a.runId || CURRENT_RUN || undefined,
        row: a.row, path: a.path, color: a.color, note: a.note,
        options: a.options, lean: a.lean, simple: a.simple });
    } },
  { name: "browser_target", desc: "이 세션이 조종할 탭을 고정한다. 여러 번 부르면 최대 4개까지 들고 있고, 지정 없는 명령은 그중 마지막으로 쓴 탭으로 간다(전부에 돌리려면 각 도구의 tab에 목록을 준다). tab 없이 부르면 지금 들고 있는 것을 조회하고, clear로 놓는다 — clear와 tab을 함께 주면 그 하나만 놓는다.",
    schema: { tab: { type: "string", description: "browser_tabs가 준 안정 핸들(예: claude-tab-a3f9k2). 여러 개를 들려면 하나씩 여러 번 부른다." }, clear: { type: "boolean" } },
    run: (a, C) => (a.clear ? C("untarget", a.tab != null ? { tab: String(a.tab) } : {})
                            : C("target", a.tab != null ? { tab: String(a.tab) } : {})) },
];

// 어느 탭에서 실행할지는 모든 조작 도구가 공통으로 받는다. 지목받은 탭이 여러 개일 때
// 고정을 계속 바꾸지 않고 한 세션이 여러 탭을 오가며 작업할 수 있어야 한다.
// 목록을 주면 그 탭들에 동시에 돈다(최대 4). 그룹으로 탭을 묶어두는 이유가 여럿을 함께 다루기
// 위해서라, 한 번에 하나만 받으면 그 묶음을 쓸 수 없다.
const TAB_PARAM = { tab: {
  type: ["string", "array"], items: { type: "string" }, maxItems: 4,
  description: "이 호출만 지정한 탭에서 실행. browser_tabs가 준 핸들(예: claude-tab-a3f9k2)을 쓴다 — 핸들은 앱을 재시작해도 같은 탭을 가리킨다. 여러 개를 주면(배열 또는 쉼표, 최대 4) 그 탭들에 같은 명령을 동시에 돌리고 결과를 대상별로 돌려준다. 생략하면 고정된 탭, 고정이 없으면 이 세션 그룹의 탭.",
} };
const NO_TAB = new Set(["browser_tabs", "browser_target", "browser_new_tab", "browser_report", "browser_trace", "browser_picks", "app_picks"]);
// 앱 도구는 탭 대신 기기를 고른다. 기기를 여럿 켜 두고 동시성을 재현하는 일이 흔해서
// 탭과 같은 규칙으로 목록도 받는다. 하나면 그것만, 여럿이면 동시에 실행한다.
const DEVICE_PARAM = { device: {
  type: ["string", "array"], items: { type: "string" }, maxItems: 4,
  description: "이 호출만 지정한 기기에서 실행. app_targets가 준 udid·Android 시리얼(앞자리만 적어도 됨) 또는 기기 이름. 여러 개를 주면(배열 또는 쉼표, 최대 4) 그 기기들에 같은 명령을 동시에 돌리고 결과를 기기별로 돌려준다. 생략하면 켜져 있는 첫 기기.",
} };
const NO_DEVICE = new Set(["app_targets", "app_target", "app_picks"]);   // 목록·고정 자체는 대상을 받지 않는다
// 도구가 실제로 받는 인자표. 목록에 내는 것과 호출을 검사하는 것이 같은 표여야 한다.
// 둘로 나뉘면 "목록엔 있는데 검사는 모르는" 인자가 생긴다.
function schemaOf(t) {
  return t.app
    ? (NO_DEVICE.has(t.name) ? t.schema : { ...t.schema, ...DEVICE_PARAM })
    : (NO_TAB.has(t.name) ? t.schema : { ...t.schema, ...TAB_PARAM });
}
const toolList = TOOLS.map((t) => ({
  name: t.name, description: t.desc,
  inputSchema: { type: "object", properties: schemaOf(t), ...(t.req ? { required: t.req } : {}) },
}));

// 스키마 밖 인자와 값을 조용히 버리지 않는다.
//
// mode에 "count"를 주면 도구가 거절하지 않고 기본 모드로 바꿔 "null 포함" 판정을 내고,
// 기대 문자열을 value로 주면 text가 빈 채로 판정이 나간다(확인 결과: 한 회차에서
// 영수증 셋이 그렇게 만들어졌다). 물은 적 없는 질문의 답이 통과로 남으면 QA 판정은
// 화면과 무관해지고, 그 통과는 보고서에서 실제 통과와 구별되지 않는다.
//
// 거절은 다음에 할 일을 함께 준다. 이름이 비슷하면 짚어 주고, 아니면 받는 이름을 다 편다.
function argFault(t, a) {
  const s = schemaOf(t), names = Object.keys(s);
  for (const k of Object.keys(a)) {
    if (k.startsWith("_")) continue;            // 호출자가 붙이는 메타는 도구 인자가 아니다
    if (k in s) continue;
    const lk = k.toLowerCase();
    const near = names.filter((n) => {
      const ln = n.toLowerCase();
      return ln.includes(lk) || lk.includes(ln);
    });
    return `${t.name}이 받지 않는 인자입니다: ${k}\n`
      + (near.length ? `혹시 ${near.join(" · ")}입니까?\n` : "")
      + `받는 이름: ${names.join(" · ")}`;
  }
  for (const [k, v] of Object.entries(a)) {
    const e = s[k] && s[k].enum;
    if (e && v != null && !e.includes(v)) {
      return `${t.name}의 ${k}는 ${e.join(" · ")} 중 하나입니다(받은 값: ${JSON.stringify(v)}).`;
    }
  }
  return null;
}
const byName = new Map(TOOLS.map((t) => [t.name, t]));
// 기기 목록 파싱과 동시 실행. 브라우저 쪽은 서버(runBrowserCmd)가 나눠 실행하지만 앱 도구는
// 서버를 거치지 않고 여기서 idb를 부르므로, 같은 규칙을 이 층에 둔다.
function deviceList(device) {
  const arr = (Array.isArray(device) ? device : String(device).split(","))
    .map((s) => String(s).trim()).filter(Boolean);
  return [...new Set(arr)];   // 같은 기기를 두 번 적어도 두 번 돌리지 않는다
}
async function runOnDevices(t, a, devs, C) {
  if (!devs.length) return { ok: false, error: "대상 기기가 비어 있습니다." };
  if (devs.length > MAX_DEVICES) return { ok: false, error: `한 번에 최대 ${MAX_DEVICES}대까지 조작합니다(요청 ${devs.length}대).` };
  const rs = await Promise.all(devs.map((d) =>
    Promise.resolve().then(() => t.run({ ...a, device: d }, C))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))));
  const per = devs.map((d, i) => ({ device: d, ...(rs[i] || { ok: false, error: "결과 없음" }) }));
  const okCount = per.filter((r) => r.ok).length;
  return {
    ok: okCount === per.length,   // 절반만 된 것을 성공이라 부르지 않는다
    multi: true, count: per.length, okCount,
    error: okCount === per.length ? undefined
      : per.filter((r) => !r.ok).map((r) => `${r.device}: ${r.error || "실패"}`).join(" / "),
    targets: per,
  };
}

// 결과를 사람과 모델이 같이 읽는 텍스트로. 스냅샷·텍스트처럼 큰 것은 본문만, 나머지는 JSON.
function render(name, r) {
  // 여러 탭에 동시에 실행한 결과. 대상마다 따로 접어 보여준다. 하나로 합치면 어느 화면에서 무엇이
  // 나왔는지 사라지는데, 그것을 알려고 여럿에 실행한 것이다. 실패한 대상도 함께 보고한다.
  if (r.multi && Array.isArray(r.targets)) {
    const parts = r.targets.map((t) => {
      const one = render(name, t);
      return `── ${t.tab || t.device} ${t.ok ? "" : "(실패) "}──\n${one.text}`;
    });
    return { text: `대상 ${r.count}개 중 ${r.okCount}개 성공\n\n${parts.join("\n\n")}`, isError: r.okCount === 0 };
  }
  if (!r.ok) return { text: "오류: " + (r.error || "알 수 없음"), isError: true };
  const d = r.data || {};
  // 로그인 칸이 보이면 그 힌트를 본문 맨 앞에 둔다. 아래로 밀면 긴 스냅샷에 묻힌다.
  const lh = (d.humanHint ? d.humanHint + "\n\n" : "") + (d.loginHint ? d.loginHint + "\n\n" : "");
  if (name === "browser_snapshot") {
    const scope = d.query ? " · 좁힘 " + Object.entries(d.query).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    const cut = d.truncated ? ` · ${d.shown}/${d.lines}줄만` : "";
    return { text: `${lh}URL: ${d.url || ""} · ${d.refCount || 0} refs${scope}${cut}\n\n${d.snapshot || "(빈 스냅샷)"}` };
  }
  if (name === "browser_text") return { text: d.text || "" };
  if (name === "app_snapshot") return { text: `앱 ${d.app || ""} · 요소 ${d.count}개 · 화면 ${d.screen ? d.screen.width + "x" + d.screen.height : "?"}\n\n${d.snapshot || "(빈 화면)"}` };
  if (name === "app_observe") return { text: `앱 ${d.app || ""} · 요소 ${d.elements}개${d.alerts && d.alerts.length ? " · 떠 있는 것: " + d.alerts.join(", ") : ""}\n장면: ${d.shot || "(못 찍음)"}\n\n${d.snapshot || ""}` };
  if (name === "browser_new_tab") return { text: `탭 @${d.handle} 생성·고정 (스페이스 ${d.space})\n${d.url || ""}\n\n${d.note || ""}`.trim() };
  if (name === "browser_eval") return { text: typeof d.value === "string" ? d.value : JSON.stringify(d.value) };
  // 경로는 사람이 그대로 열 수 있게 맨 앞에 둔다. 표시를 못 찾은 것이 있으면 그냥 넘기지 않는다.
  if (name === "browser_report") {
    const un = r.unreported ?? d.unreported;
    const failed = r.failed ?? d.failed;
    const tab = r.reportTab || d.reportTab;
    const led = r.ledger || d.ledger;   // 원장 회차는 단계가 아니라 줄로 센다
    return { text: `보고서: ${r.path || d.path}`
      + (tab ? `\nIris 탭 ${tab} 으로 열어 두었다 — 사용자에게는 이 탭을 알린다(크롬으로 보내지 않는다).` : "")
      + `\n실행 폴더: ${r.store || d.store} (runId ${r.runId || d.runId} — 안내서를 같은 실행에 붙이려면 이 값을 넘긴다)\n`
      + (led
        ? `줄 ${led.rows}개 — ${[["red", "흐름 깨짐"], ["orange", "쓰기 어려움"], ["yellow", "수정 권함"],
            ["green", "정상"], ["blue", "정해야 함"], ["gray", "분류 불가"]]
            .filter(([k]) => led[k]).map(([k, l]) => `${l} ${led[k]}`).join(" · ")}`
        : failed == null ? `${r.steps ?? d.steps}단계`
        : `${r.steps ?? d.steps}단계 · 확인 ${r.checks ?? d.checks ?? 0}건 · 안 됨 ${failed}건`
          + ((r.unverified ?? d.unverified) ? ` · 미확인 ${r.unverified ?? d.unverified}건` : ""))
      + (un ? `\n보고서에 없는 확인 ${un}건 — 보고서 끝에 사실 그대로 실렸다.` : "") };
  }
  if (name === "browser_screenshot") {
    const miss = (d.missing || []).length ? `\n표시 못 찾음: ${(d.missing || []).join(", ")}` : "";
    return { text: `${d.path}\n${d.title || ""} · ${d.url || ""}${d.marked ? `\n표시 ${d.marked}곳` : ""}${d.caption ? `\n설명: ${d.caption}` : ""}${miss}` };
  }
  return { text: JSON.stringify(d, null, 2) };
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// stdin이 닫혀도 진행 중인 호출은 끝내고 응답한 뒤 종료한다. 바로 exit하면 마지막 도구 호출이
// 응답 없이 잘린다(클라이언트는 영영 기다리거나 타임아웃으로 실패한다).
let inFlight = 0, closing = false;
// stdout이 파이프면 쓰기가 비동기다. 그냥 exit하면 아직 나가지 않은 응답(도구 목록처럼 큰 것)이
// 통째로 버려진다. 빈 write의 콜백은 앞선 쓰기가 다 빠진 뒤에 불린다.
const maybeExit = () => { if (closing && inFlight === 0) process.stdout.write("", () => process.exit(0)); };

// 보고서 렌더러는 브라우저 없이도 검사할 수 있어야 한다. 그러지 못하면 "고쳤다"가 글로만
// 남는다. 직접 실행일 때만 stdio 루프를 연다. import하면 함수만 가져다 쓸 수 있다.
// 판정 함수는 내보낸다. 소스 모양으로만 검사하면 `false &&` 한 줄로 우회된다
// (변이 검사에서 확인했다).
export { buildReport, addReceipt, receiptsOfRun, chooseHerdrPane, coverGaps, pairProblems, unshotClaims,
  unverifiedOutsideLedger };
const RUN_AS_MAIN = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
const rl = RUN_AS_MAIN ? readline.createInterface({ input: process.stdin }) : { on() {} };
rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let m;
  try { m = JSON.parse(s); } catch { return; }
  const { id, method, params } = m;
  try {
    if (method === "initialize") {
      // 클라이언트가 부른 버전을 그대로 되돌려 준다. 버전 협상이 어긋나는 것을 막는다.
      const v = (params && params.protocolVersion) || "2025-06-18";
      return ok(id, { protocolVersion: v, capabilities: { tools: {} },
        serverInfo: { name: "iris-mcp", version: "1.0.0" },
        // 항상 붙는 글이라 짧게. 도구 설명에 이미 있는 것은 넣지 않고, 도구 목록만 봐서는 모르는
        // 사실 하나만 남긴다. 로그인 벽에서 사람에게 그냥 넘기는 일을 막기 위한 것이다.
        instructions: "사람이 쓰는 브라우저를 그대로 조종한다(로그인·쿠키 살아 있음). "
          + "로그인 벽에서 사람에게 넘기기 전에 browser_login을 먼저 불러라 — 사용자가 허용한 계정은 네가 채울 수 있다. "
          + "결제·본인확인처럼 사람이 해야만 하는 자리에서는 작업을 멈추고 대화로 부탁하지 말고 browser_ask_user를 불러라 — "
          + "사용자는 다른 스페이스나 다른 앱을 보고 있어 대화를 못 볼 수 있다. 그 도구가 알림으로 부르고 그 탭까지 데려간다. "
          + "화면은 사람이 하듯 밟아라 — 스냅샷을 보고 누르고 입력한다. 같은 사이트 안을 주소로 건너뛰거나 eval로 조작하는 것은 서버가 거부한다. "
          + "밟지 않은 경로는 확인된 것이 아니라서, 그렇게 '됐다'고 적은 것이 사람이 해보면 안 되는 경우가 많았다. "
          + "모바일 앱은 Iris 에뮬레이터 탭의 기기에서만 확인한다 — simctl·emulator·open -a Simulator로 기기를 따로 켜지 마라. "
          + "사용자는 Iris 탭만 본다. app_* 도구가 탭이 없으면 이 스페이스에 열고, 다른 기기가 필요하면 app_target이 그 탭을 바꾼다." });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return; // 알림은 응답 없음
    if (method === "ping") return ok(id, {});
    if (method === "tools/list") return ok(id, { tools: toolList });
    if (method === "tools/call") {
      const t = byName.get(params && params.name);
      if (!t) return err(id, -32602, "알 수 없는 도구: " + (params && params.name));
      inFlight++;
      try {
        const a = (params && params.arguments) || {};
        const fault = argFault(t, a);
        if (fault) { ok(id, { content: [{ type: "text", text: "오류: " + fault }], isError: true }); return; }
        // 도구마다 인자를 직접 조립하므로, tab은 요청 단위로 감싼 호출기가 얹는다.
        // 전역 상태로 두면 동시 호출이 서로의 대상을 덮어쓴다.
        const C = (cmd, args = {}) =>
          // 핸들은 문자열이다(claude-tab-a3f9k2). Number()로 바꾸면 NaN→null이 되어
          // 서버가 "탭 미지정"으로 읽고 고정 탭으로 간다. 목록은 쉼표로 이어 보낸다.
          // 갈라 태우는 것은 서버의 runBrowserCmd 한 곳에서만 한다.
          call(cmd, a.tab != null && !NO_TAB.has(t.name)
            ? { ...args, tab: Array.isArray(a.tab) ? a.tab.join(",") : String(a.tab) } : args);
        // 앱 도구는 서버를 거치지 않고 여기서 idb를 부른다. 그래서 여러 기기에 도는 것도 여기서
        // 나눠 실행한다. 기기마다 같은 run을 한 번씩 실행하고 결과를 기기별로 묶는다.
        // 증거 도구면 여기서 회차가 열린다. 도구가 돌기 전이라 첫 장면부터 회차 폴더로 굳는다.
        await ensureRun(t.name);
        const devs = t.app && !NO_DEVICE.has(t.name) && a.device != null ? deviceList(a.device) : null;
        const r = devs && devs.length !== 1
          ? await runOnDevices(t, a, devs, C)
          : await t.run(devs ? { ...a, device: devs[0] } : a, C);
        const out = render(t.name, r);
        const moment = await absorbMoments(r);      // 사라진 알림은 여기서 말해 주지 않으면 묻힌다
        ok(id, { content: [{ type: "text", text: out.text + moment }], ...(out.isError ? { isError: true } : {}) });
      } finally { inFlight--; maybeExit(); }
      return;
    }
    if (id !== undefined) err(id, -32601, "지원하지 않는 메서드: " + method);
  } catch (e) {
    log("처리 실패", method, String(e && e.message || e));
    if (id !== undefined) err(id, -32603, String(e && e.message || e));
  }
});
rl.on("close", () => { closing = true; maybeExit(); setTimeout(() => process.exit(0), 15000).unref(); });
