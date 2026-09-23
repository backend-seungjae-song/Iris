import fs from "node:fs";
import path from "node:path";

import { artifactDir } from "./artifacts-home.cjs";

// QA 브라우저 trace와 회차 journal·receipt·artifact 상태의 단일 owner.
//
// 소유 범위
//   session trace, run/session 결속, 단조 seq·accepted/completed·receipt 수와 회차 파일 persistence.
//
// 제공 API
//   run/journal/trace 명령 handler, accepted/completed 기록 함수와 bulkfill용 runSurfaces 조회 port.
//
// 의존 대상
//   node:fs/path와 state-home의 상태 루트에만 의존하며 browser·transport·다른 handler를 import하지 않는다.
//
// 유지 조건
//   입력값은 길이·선택 라벨까지만 남기고, 서버 run_id·seq·t가 외부 event 값을 덮어야 한다.
//   증거는 발급 시점에 회차 폴더로 고정하며 accepted/completed 짝·순서·실패 기록을 보존한다.
//
// 영향 범위
//   server/index.js의 runSessionCmd·runBrowserCmdResilient·bulkfill 배선과 state-home coverage,
//   bin/iris-mcp.mjs browser_run/journal/report 흐름 및 bin/smoke.mjs QA 회차·증거 게이트 검사.

// 폴더는 호출 시점에 읽는다. import 시점에 고정하면 그 모듈을 먼저 로드한 쪽이 폴더를 정하게
// 되어, import 순서에 따라 검사가 사용자 폴더에 쓰는 일이 생긴다.

// 수행한 조작은 서버를 모두 거치므로, 버리지 않고 세션별로 모아 두면 보고서를 쓸 때 기억에
// 의존하지 않아도 된다. 값 자체는 담지 않는다(비밀이 섞일 수 있다).
const TRACE_MAX = 200;
const traceBySession = new Map();   // session → [{t, cmd, target, note, url}]
const TRACE_CMDS = new Set(["click", "dblclick", "fill", "select", "type", "key", "goto", "back", "forward", "reload", "scroll", "scrollto", "upload", "dialog", "login"]);
export function noteTrace(cmd, args, session, res) {
  if (!session || !TRACE_CMDS.has(cmd)) return;
  const a = args || {};
  const list = traceBySession.get(session) || [];
  const target = a.ref || a.sel || a.url || a.key || a.amount || (a.y != null ? "y=" + a.y : "") || "";
  // 입력값은 길이만 남긴다. 비밀번호·개인정보가 트레이스에 남으면 그 자체가 유출 경로가 된다.
  // 사람 경로를 건너뛴 이동은 그 사실이 여기 남는다. 보고서를 이 기록에서 파생하므로,
  // 눌러서 간 것과 주소로 건너뛴 것이 문서에서 구별된다.
  const note = a.reason ? `주소로 건너뜀 — ${String(a.reason).slice(0, 80)}`
    : a.text != null ? `${String(a.text).length}자 입력` : a.value != null ? `"${String(a.value).slice(0, 40)}" 선택` : "";
  list.push({ t: Date.now(), cmd, target: String(target).slice(0, 120), note, url: (res && res.data && res.data.url) || undefined, ok: !!(res && res.ok) });
  while (list.length > TRACE_MAX) list.shift();
  traceBySession.set(session, list);
}

// ── 회차 이벤트 원본 ─────────────────────────────────────────────────────────
// trace는 조회용 요약이라 상한(200)이 있고 clear로 지워진다. QA 회차의 기록은 지워지면 안 된다.
// 나중에 모델이 기억으로 서술한 것이 정본이 되면 그 서술이 환각의 출처가 되기 때문이다.
// 다만 이 파일은 회차 전체의 원본이 아니라 서버가 받은 브라우저 명령 기록이다. 앱은 idb를
// 직접 호출하고 API·코드·저장소 계측기도 서버 밖에 있어, 그쪽은 `journal` 명령으로 같은 파일에
// 기록한다. 줄마다 source가 붙는 이유다.
// 값은 여기서도 남기지 않는다(noteTrace와 같은 정책). 길이·선택 라벨까지만 기록한다.
const runs = new Map();           // runId → { runId, dir, seq, receipts, calls }
const runBySession = new Map();   // session → runId (요청에 회차가 안 실렸을 때만 쓰는 기본값)
const qaRunDir = (runId) => path.join(artifactDir("qa"), String(runId));
// 회차는 세션이 아니라 요청에 실린다. 세션은 QA 회차가 아니라 herdr pane이고, 한 pane의
// MCP·CLI·재생기가 같은 세션 값을 공유하므로 세션에 묶어두면 회차 둘이 겹칠 때 나중 것이 앞
// 것을 가로챈다. 요청에 실린 값이 항상 이기고, 세션 기본값은 편의일 뿐이다.
function runOf(session, runId) {
  const rid = runId || (session ? runBySession.get(String(session)) : null);
  return rid ? runs.get(String(rid)) || null : null;
}

function bindRun(session, runId) {
  const rid = String(runId || "run-" + Date.now());
  const dir = qaRunDir(rid);
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  // 이어 붙이는 회차면 지금까지의 순번·판정·호출 수를 이어받는다. 새로 1부터 매기면 한 회차
// 안에 같은 번호가 둘이 되고, 파생된 manifest에서 어느 줄이 어느 판정인지 구분되지 않는다.
  let seq = 0, receipts = 0, calls = 0;
  try {
    for (const line of fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.seq > seq) seq = e.seq;
        if (e.kind === "assertion") receipts++;
        if (e.kind === "accepted") calls++;
      } catch {}
    }
  } catch {}
  const st = runs.get(rid) || { runId: rid, dir, seq, receipts, calls };
  st.seq = Math.max(st.seq, seq); st.receipts = Math.max(st.receipts, receipts); st.calls = Math.max(st.calls, calls);
  runs.set(rid, st);
  if (session) runBySession.set(String(session), rid);
  return st;
}

// 계측기는 여럿이고 서로를 보증하지 않는다. 어느 계측기가 관측한 것인지 줄마다 남아 있어야
// 한쪽만 확인하고 양쪽을 확인했다고 기록되는 일이 없다.
// "moment"는 잠깐 표시되는 알림(토스트)이다. 생산자(bin/iris-mcp.mjs)가 이 이름으로 보내는데
// 허용값에 없으면 서버가 전부 거절하고 호출한 쪽은 null을 받고 넘어간다(확인 결과: 전 회차
// 기록에 moment 0건). 사라진 알림은 다시 촬영할 수 없어 그 화면은 상태 폴더의 60장 정리로
// 삭제됐다. 허용 목록이 생산자와 일치하지 않는 것을 아무도 확인하지 못했다.
const JOURNAL_SOURCES = new Set(["browser", "app", "api", "code", "store", "server", "moment"]);
const JOURNAL_KINDS = new Set(["run_begin", "run_end", "accepted", "completed", "assertion", "artifact", "observation", "macro_miss"]);
// 짝 없는 accepted = 보냈지만 완료를 확인하지 못한 호출. 회차를 닫을 때 이 수가 확인되지 않은 구간의 크기다.
function countCompleted(st) {
  let n = 0;
  try {
    for (const line of fs.readFileSync(path.join(st.dir, "journal.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { if (JSON.parse(line).kind === "completed") n++; } catch {}
    }
  } catch {}
  return n;
}

function appendEvent(st, ev) {
  if (!st) return null;                    // 회차에 안 묶인 호출은 지금까지와 똑같이 동작한다
  // 서버가 매기는 값을 뒤에 둔다. 앞에 두면 외부 생산자가 보낸 run_id·seq·t가 그것을 덮어
  // 서버가 매긴 단조 순번이라는 보장이 다중 생산자 경로에서 성립하지 않는다.
  const rec = { ...ev, run_id: st.runId, seq: st.seq + 1, t: Date.now() };
  try { fs.appendFileSync(path.join(st.dir, "journal.jsonl"), JSON.stringify(rec) + "\n"); }
  catch { return null; }                   // 기록하지 못하면 순번을 올리지 않는다. 빈 번호는 누락으로 읽힌다
  st.seq = rec.seq;
  return rec;
}

// 증거는 발급 시점에 회차 폴더로 고정한다. 촬영 위치(상태 폴더의 shots)는 60장·7일로
// 정리되므로, 보고서를 만들 때만 복사하면 보고서 없이 파생한 회차는 검사기가 요구하는
// evidence_root 안에 파일이 없어 검사를 통과하지 못한다.
function persistArtifact(st, src) {
  if (!st || !src) return src || null;
  try {
    const abs = path.resolve(String(src));
    if (abs.startsWith(path.resolve(st.dir) + path.sep)) return abs;   // 이미 회차 안
    const dest = path.join(st.dir, "shots", `${String(st.seq + 1).padStart(4, "0")}-${path.basename(abs)}`);
    fs.copyFileSync(abs, dest);
    return dest;
  } catch { return src; }
}

// 명령은 두 번 기록한다. 보내기 전(accepted)과 끝난 뒤(completed)다. 한 번만 기록하면
// 부수효과가 발생한 뒤 서버가 종료된 구간이 남지 않는다. 짝이 맞지 않는 accepted가 그 구간의
// 증거다. 단조 seq는 이것을 대신하지 못한다. 기록된 것에만 번호를 붙이므로 기록되지 않은
// 명령은 빈 번호를 만들지 않는다.
const RUN_EXTRA_CMDS = new Set(["expect", "screenshot", "observe", "snapshot", "diff", "shotsizes", "a11y"]);
// 조작이면 기록한다. 목록을 따로 두지 않는다. TRACE_CMDS만 확인하면 ACT_CMDS에는 있고 그
// 목록에는 없는 일곱(check·clear·hover·focus·nativeclick·nativekey·bulkfill)이 전후 프레임만
// 남기고 명령은 남기지 않아, 기록에 원인 없는 화면 변화가 생긴다. 두 목록을 수동으로 맞추면
// 언젠가 어긋난다.
const runLogged = (cmd) => TRACE_CMDS.has(cmd) || RUN_EXTRA_CMDS.has(cmd) || ACT_CMDS.has(cmd);
function runArgDigest(a) {
  const t = a.ref || a.sel || a.selector || a.url || a.key || a.amount || a.testid || a.name
    || (a.y != null ? "y=" + a.y : "") || "";
  return {
    target: String(t).slice(0, 120),
    note: a.text != null ? `${String(a.text).length}자 입력` : a.value != null ? `"${String(a.value).slice(0, 40)}" 선택` : "",
    tab: a.tab || undefined,
    skipped_human_path: a.reason ? String(a.reason).slice(0, 200) : undefined,
    step_id: a.step_id || undefined,
    scenario_id: a.scenario_id || undefined,
  };
}
export function noteRunAccepted(cmd, args, session, runId) {
  const st = runOf(session, runId);
  if (!st || !runLogged(cmd)) return null;
  const callId = "c" + (++st.calls);
  appendEvent(st, { kind: "accepted", call_id: callId, source: "browser", cmd, ...runArgDigest(args || {}) });
  return callId;
}
// 도구가 반환한 나머지 필드를 그대로 받는다. url·ok·error·경로만 옮기면 observe의
// 원인(reasons·alerts·candidates), diff의 변화량(changed·total·ratio), dialog의
// 문구(message·answered), upload의 파일 목록이 기록에 남지 않는다(확인 결과: observe 15건·
// upload 2건 전부 상세 0). 명령마다 옮길 필드를 지정하면 명령이 늘 때마다 같은 누락이
// 생기므로, 목록을 두지 않고 남는 필드를 모두 받는다.
//
// 버리는 것은 셋이다. 이미 기록한 것, 사람이 읽을 수 없는 큰 데이터(스냅샷 본문·이미지
// 바이트), 값 자체(비밀이 섞일 수 있다). 나머지는 잘라서 담는다.
const DETAIL_SKIP = new Set(["url", "ok", "error", "path", "shot", "shotError", "receipt",
  "snapshot", "text", "html", "value", "outerHTML", "data", "buffer"]);
const DETAIL_MAX = 1500;
function clip(v, depth = 0) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  if (Array.isArray(v)) return depth > 1 ? `[${v.length}개]` : v.slice(0, 6).map((x) => clip(x, depth + 1));
  if (typeof v === "object") {
    if (depth > 1) return "{…}";
    const o = {};
    for (const k of Object.keys(v).slice(0, 12)) { if (!DETAIL_SKIP.has(k)) o[k] = clip(v[k], depth + 1); }
    return o;
  }
  return undefined;
}
function detailOf(d) {
  const o = {};
  for (const k of Object.keys(d || {})) {
    if (DETAIL_SKIP.has(k)) continue;
    const v = clip(d[k]);
    if (v === undefined) continue;
    o[k] = v;
  }
  const keys = Object.keys(o);
  if (!keys.length) return undefined;
  // 기록이 너무 커지면 사용하기 어려워진다. 넘치면 뒤에서부터 제거하고 제거한 사실을 남긴다.
  let cut = 0;
  while (JSON.stringify(o).length > DETAIL_MAX && keys.length) { delete o[keys.pop()]; cut += 1; }
  if (cut) o.잘림 = `${cut}개 덜어냄`;
  return Object.keys(o).length ? o : undefined;
}
// 재시도는 한 줄로 합친다. 재시도는 전송 계층의 동작이지 사용자가 수행한 단계가 아니고,
// 상태를 바꾸는 명령은 재시도하지 않는다(READONLY_CMDS 제한).
export function noteRunEvent(callId, cmd, args, session, res, tries, runId) {
  const st = runOf(session, runId);
  if (!st || !runLogged(cmd)) return;
  const a = args || {};
  const d = (res && res.data) || {};
  appendEvent(st, {
    kind: "completed", call_id: callId || undefined, source: "browser", cmd,
    ...runArgDigest(a),
    url: d.url || undefined,
    ok: !!(res && res.ok),
    error: res && !res.ok ? String(res.error || "").slice(0, 200) : undefined,
    tries: tries > 1 ? tries : undefined,
    detail: res && res.ok ? detailOf(d) : undefined,
  });
  if (cmd === "expect" && res && res.ok) {
    const id = "r" + (++st.receipts);
    const shot = persistArtifact(st, d.shot);
    appendEvent(st, { kind: "assertion", id, call_id: callId || undefined, source: "browser",
      ...laneStamp(st),
      selector: String(a.sel || a.selector || ""),
      mode: a.mode || (a.text == null ? "exists" : "contains"),
      want: a.text == null ? null : String(a.text),
      label: a.label ? String(a.label).slice(0, 80) : undefined,
      // 판정한 요소를 사람이 읽는 이름(예: 버튼 '저장')으로. 이름표 없이 부른 확인도 대상이 지면에 선다.
      element: d.element ? String(d.element).slice(0, 80) : undefined,
      step_id: a.step_id || undefined, scenario_id: a.scenario_id || undefined,
      url: d.url || undefined,
      // 몇 곳이 일치했는가. 판정문 문자열 안의 "(3곳 중 1번째)"는 집계할 수 없어, 화면이 하나로
      // 좁혀지지 않은 판정 건수를 셀 수 없었다(확인 결과: 143건 전부 없음).
      matched: d.matched != null ? Number(d.matched) : undefined,
      expected: d.expected, got: d.got, pass: !!d.pass, found: !!d.found, shot });
    if (res.data) { res.data.receipt = id; if (shot) res.data.shot = shot; }
  }
  // 한 호출이 장면을 여럿 반환하는 경우가 있다(shotsizes: 폭마다 한 장). 고정 처리가
  // d.shot·d.path만 확인하면 그 배열은 회차 밖에 남아 상태 폴더의 60장·7일 정리로 삭제된다.
  // 배열도 같은 경로에서 받는다.
  if (Array.isArray(d.shots) && d.shots.length) {
    for (const one of d.shots) {
      if (!one || !one.path) continue;
      const keptOne = persistArtifact(st, one.path);
      appendEvent(st, { kind: "artifact", call_id: callId || undefined, source: "browser",
        ...laneStamp(st), path: keptOne, url: d.url || undefined,
        caption: [a.caption, one.size, one.width && one.height ? `${one.width}×${one.height}` : null]
          .filter(Boolean).join(" · ") || undefined });
      one.path = keptOne;
    }
  }
  const raw = d.shot || (cmd === "screenshot" || cmd === "diff" ? d.path : null);
  if (raw && cmd !== "expect") {
    const kept = persistArtifact(st, raw);
    // 직접 촬영한 장면에도 어느 줄의 것인지 기록한다. 이 값이 없으면 설명을 붙여 남긴 증거가
    // 화면에서 그 줄 밖으로 분리되어, 촬영했는데도 장면이 없다고 기록된다(확인 결과: 여덟 줄
    // 중 넷이 그렇게 비어 있었다).
    // 어디서 촬영한 장면인가. 자동 녹화분은 주소를 남기지만 직접 촬영한 것은 남기지 않았다
    // (확인 결과: 63장 전부 비어 있음). 도구가 이미 반환하는 값이므로 그대로 옮겨 적는다.
    appendEvent(st, { kind: "artifact", call_id: callId || undefined, source: "browser",
      ...laneStamp(st), path: kept, url: d.url || undefined, caption: a.caption || undefined });
    if (res && res.data && kept) { if (res.data.shot) res.data.shot = kept; if (res.data.path) res.data.path = kept; }
  }
}

// ── 녹화 줄기 ──────────────────────────────────────────────────
// 조작 자체는 화면을 남기지 않았다. 프레임이 전부 작성자가 직접 호출한 결과여서 기록의
// 밀도가 작성자에게 달려 있었다(확인 결과: 단계의 21%가 화면 없이 기록됐고, 직전 화면이 있는
// 9단계 중 6단계는 다른 단계의 직후 화면이었다). 규칙은 있었지만 사람이 지켜야 했다.
//
// 기록을 조작의 부산물로 만든다. 조작마다 직전·직후를 남기면 촬영 누락이 생기지 않는다.
//
// 직전 프레임은 대개 앞 조작의 직후와 같아 중복 판정에서 제거된다. 결과적으로 직후 프레임만
// 남고, 조작 사이에 화면이 저절로 바뀐 경우(늦게 표시된 토스트 등)에만 한 장이 더 남는다.
const ACT_CMDS = new Set(["click", "dblclick", "type", "key", "fill", "select", "check", "clear",
  "hover", "focus", "goto", "back", "forward", "reload", "upload", "scroll", "scrollto",
  "nativeclick", "nativekey", "dialog", "bulkfill"]);
export function isActCmd(cmd) { return ACT_CMDS.has(String(cmd)); }

// 녹화 프레임은 회차 폴더로 바로 저장한다. 상태 폴더에 쌓으면 60장·7일 정리가 증거를 삭제한다.
function recPath(st) {
  const dir = path.join(st.dir, "rec");
  fs.mkdirSync(dir, { recursive: true });
  // 번호는 메모리가 아니라 폴더에서 이어받는다. 앱이 재시작되면 이 프로세스의 카운터는 1로
  // 돌아가지만 폴더에는 앞 회차의 장면이 남아 있어, 0001부터 덮어쓰면 이미 기록된 증거가
  // 다른 이미지로 바뀐다(확인 결과: 한 회차에서 16장이 교체됐고, 기록은 그대로 그 파일
  // 이름을 가리키고 있었다).
  if (!st.recSeq) {
    let max = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = /^(\d{4})\.png$/.exec(f);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch {}
    st.recSeq = max;
  }
  st.recSeq += 1;
  return path.join(dir, String(st.recSeq).padStart(4, "0") + ".png");
}

// 어느 탭의 마지막 프레임인가. 중복 판정은 같은 탭 안에서만 유효하다. 전체화면과 뷰포트를,
// 서로 다른 탭을 비교하는 것은 의미가 없다.
function lastFrame(st, tab) { return (st.recLast || (st.recLast = new Map())).get(String(tab || "")) || null; }
function setLastFrame(st, tab, p) { (st.recLast || (st.recLast = new Map())).set(String(tab || ""), p); }

// 프레임 하나를 남긴다. 돌려주는 것은 저널에 적을 사실이다.
export async function recordFrame(st, tab, why, shoot) {
  if (!st) return null;
  const prev = lastFrame(st, tab);
  const out = path.join(st.dir, "rec", "tmp.png");
  const r = await shoot({ dpr: 1, settle: why === "before" ? 0 : undefined,
    path: prev ? out : recPath(st), sameAs: prev || undefined, tab });
  const d = (r && r.data) || {};
  if (!r || !r.ok || !d.path) return null;
  if (d.same) {
    // 파일을 만들지 않았다. 그 사실만 기록하며, 제외한 장수가 화면에 표시된다.
    // 제외한 장면에도 줄 번호를 남긴다. 남기지 않으면 그 줄에서 중복으로 제외된 장수를 셀 수
    // 없다(확인 결과: same 136건 전부 row 없음).
    appendEvent(st, { kind: "frame", source: "browser", why, tab: tab || undefined,
      same_as: prev, same: true, url: d.url || undefined, ...laneStamp(st) });
    return { path: prev, same: true };
  }
  // sameAs를 설정했으면 tmp로 받았으므로, 자기 번호를 붙여 옮긴다.
  let kept = d.path;
  if (kept === out) {
    kept = recPath(st);
    try { fs.renameSync(out, kept); } catch { kept = d.path; }
  }
  setLastFrame(st, tab, kept);
  appendEvent(st, { kind: "frame", source: "browser", why, tab: tab || undefined,
    path: kept, url: d.url || undefined, title: d.title || undefined,
    dpr: d.dpr || 1, shot: "viewport",
    ...laneStamp(st) });
  return { path: kept, same: false };
}

export function runFor(session, runId) { return runOf(session, runId); }

// ── 요구 원장 ──────────────────────────────────────────────────
// 회차의 단위는 단계가 아니라 요구 줄이다. 단계를 직접 작성하는 경로를 없애면 화면 없는 단계,
// 전/후 불일치, 과분할이 발생할 수 없다.
//
// 줄 하나는 요구 하나가 아니라 (요구 × 조건) 하나다. 화면에 값이 있다는 것은 그 값이 변할 수
// 있다는 뜻이고, 상태마다 동작이 다르며, 어떤 상태를 보려면 세계가 그 상태여야 한다. given은
// 서식용 칸이 아니라 열거를 강제하는 필드다. 조건을 적으려면 상태를 먼저 나열해야 한다.
const PATHS = new Set(["정상", "경계", "실패"]);
const BASIS = new Set(["spec", "plan", "user", "code", "assumed"]);
// 문서·기획·사용자 지정에서 온 기대. 이것을 못 지킨 것은 경중을 따질 대상이 아니다.
const HARD_BASIS = new Set(["spec", "plan", "user"]);
const COLORS = new Set(["red", "orange", "yellow", "green", "blue", "gray"]);

function rowsOf(st) { return st.rows || (st.rows = new Map()); }

// 증거 수는 호출하는 쪽이 적지 않는다. 그러면 자기 채점이 된다. 메모리에도 두지 않는다.
// 서버가 재시작되면 기록에는 사실이 남아 있는데 집계만 사라져, 실제로 수행한 줄이 증거
// 없음으로 거부된다. 기록 파일이 원본이므로 거기서 계산한다.
function tallyFor(st, id, path) {
  let lines = [];
  try { lines = fs.readFileSync(path_(st), "utf8").split("\n"); } catch { return { frames: 0, receipts: 0, failed: 0, shotted: 0 }; }
  let frames = 0, receipts = 0, failed = 0, shotted = 0;
  // 무효로 표시된 판정은 세지 않는다. 먼저 한 바퀴 돌아 모아야 순서와 무관해진다.
  const voided = new Set(), aside = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let v; try { v = JSON.parse(line); } catch { continue; }
    if (v.kind === "void" && v.receipt) voided.add(String(v.receipt));
    if (v.kind === "aside" && v.row === id && v.path_ === path) {
      for (const f of (v.frames || [])) aside.add(String(f));
    }
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const lanes = Array.isArray(e.lanes) ? e.lanes : [[e.row, e.path_]];
    if (!lanes.some((l) => Array.isArray(l) && l[0] === id && l[1] === path)) continue;
    // 설명을 붙여 직접 촬영한 장면도 그 줄의 장면이다. 자동 프레임만 집계하면 직접 남긴
    // 증거가 빠진 채 장면 없음으로 판정된다.
    if (e.kind === "frame" || e.kind === "artifact") { if (!aside.has(String(e.path))) frames += 1; }
    else if (e.kind === "assertion") {
      if (voided.has(String(e.id))) continue;
      receipts += 1;
      if (!e.pass) failed += 1;
      // 판정이 남긴 화면. 파일 이름이 적혀 있을 때만 센다.
      if (e.shot) shotted += 1;
    }
  }
  return { frames, receipts, failed, shotted };
}
const path_ = (st) => path.join(st.dir, "journal.jsonl");

// 줄을 연다. 시각을 여기서 기록하고, 이 줄의 증거는 그 시각 이후의 것만 집계한다. 이 규칙이
// 기대를 화면보다 먼저 적게 하고, 발견한 것을 재현하게 만든다.
function rowDeclare(st, r) {
  const id = String(r.id || "").trim();
  if (!id) return { ok: false, error: "줄에 id가 없습니다." };
  if (rowsOf(st).has(id)) return { ok: false, error: `이미 있는 줄입니다: ${id}` };
  const what = String(r.what || "").trim();
  if (!what) return { ok: false, error: `${id}: 무엇이 성립해야 하는지(what)가 없습니다.` };
  const given = String(r.given || "").trim();
  if (!given) return { ok: false, error:
    `${id}: given이 없습니다 — 이 줄이 성립하려면 세계가 어떠해야 하는지 적습니다.\n`
    + "조건 없이 밟은 것은 그 요구를 확인한 것이 아닙니다. 그리고 조건이 같은 줄들은 한 번의\n"
    + "준비로 함께 밟습니다 — 정확히 적을수록 준비가 줄어듭니다." };
  const basis = String(r.basis || "").trim();
  if (!BASIS.has(basis)) return { ok: false, error:
    `${id}: basis가 spec·plan·user·code·assumed 중 하나여야 합니다(받은 값: ${basis || "없음"}).\n`
    + "화면을 보고 기대를 만들면 구현이 곧 명세가 되어 그 확인은 언제나 통과합니다." };
  const paths = (Array.isArray(r.paths) ? r.paths : []).map((x) => String(x).trim()).filter(Boolean);
  if (!paths.length) return { ok: false, error:
    `${id}: 밟을 경로(paths)가 없습니다 — 정상·경계·실패 중 이 요구가 가지는 것을 적습니다.` };
  const bad = paths.filter((x) => !PATHS.has(x));
  if (bad.length) return { ok: false, error: `${id}: 모르는 경로: ${bad.join(", ")} (정상·경계·실패)` };
  // 근거는 이름만으로 부족하다. 보고서를 받은 사람이 명세를 따로 열어야 한다면 그 보고서만으로
  // 판단할 수 없다. 원문과 출처, 해당 화면까지 여기서 함께 받는다.
  // 위치만 적었으면 파일에서 읽어 온다. 직접 옮겨 적으면 인용이 달라진다.
  let q0 = r.quote ? String(r.quote) : "";
  if (!q0 && r.source) {
    const got = quoteFromSource(r.source);
    if (got && got.error) return { ok: false, error: `${id}: ${got.error}` };
    if (got && got.quote) q0 = got.quote;
  }
  const ev = { quote: q0 || undefined,
    source: r.source ? String(r.source) : undefined,
    sourceShot: r.sourceShot ? persistArtifact(st, String(r.sourceShot)) : undefined,
    covers: Array.isArray(r.covers) ? r.covers.map((x) => String(x)) : undefined };
  const row = { id, what, given, basis,
    basisNote: r.basisNote ? String(r.basisNote) : undefined,
    ...ev, paths, at: Date.now(), walked: {}, state: "declared" };
  rowsOf(st).set(id, row);
  // basisNote는 줄에만 담고 기록에 남기지 않으면 재시작·보고서에서 사라진다. 기록하지 않은
  // 값은 없는 값과 같다.
  appendEvent(st, { kind: "row", source: "server", row: id, act: "declare",
    what, given, basis, basisNote: row.basisNote, ...ev, paths });
  return { ok: true, row };
}

// 장부에서 줄을 복원한다.
//
// 회차 상태를 이 프로세스의 메모리에만 두면 앱이 재시작될 때 원장이 사라진다. 기록 파일에는
// declare·open·close가 모두 있는데도 그렇다(확인 결과: 회차 중간 재시작으로 여덟 줄이
// 사라져 이어서 열 수 없었다). 원본이 파일이므로 파일에서 다시 읽는다.
function rehydrateRows(st) {
  let lines = [];
  try { lines = fs.readFileSync(path_(st), "utf8").split("\n"); } catch { return 0; }
  const rows = rowsOf(st);
  let notes = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === "note") notes += 1;
    if (e.kind === "list" && e.name && Array.isArray(e.items)) {
      st.sets = (st.sets || []);
      if (!st.sets.some((x) => x.name === e.name)) {
        st.sets.push({ name: e.name, source: e.source, from: e.from, shot: e.shot, items: e.items });
        st.list = st.sets[0];
      }
    }
    if (e.kind !== "row") continue;
    if (e.act === "declare") {
      if (rows.has(e.row)) continue;
      rows.set(e.row, { id: e.row, what: e.what, given: e.given, basis: e.basis,
        basisNote: e.basisNote, paths: Array.isArray(e.paths) ? e.paths : [],
        // covers를 복원하지 않으면 재시작 한 번으로 목록 대조가 초기화되어, 모두 확인한
        // 회차가 아무것도 확인하지 않은 회차로 보인다.
        covers: Array.isArray(e.covers) ? e.covers.map((x) => String(x)) : undefined,
        state: "declared", walked: {}, at: e.t || Date.now() });
    } else if (e.act === "covers") {
      const row = rows.get(e.row); if (row) row.covers = Array.isArray(e.covers) ? e.covers : row.covers;
    } else if (e.act === "basis") {
      // 교정을 복원하지 않으면 재시작 한 번으로 고친 설명·근거가 원래 문장으로 돌아간다.
      const row = rows.get(e.row); if (!row) continue;
      if (e.basisNote) row.basisNote = e.basisNote;
      if (e.what) row.what = e.what;
    } else if (e.act === "close") {
      const row = rows.get(e.row); if (!row) continue;
      row.walked[e.path] = { color: e.color, at: e.t, note: e.note,
        frames: e.frames, receipts: e.receipts };
      row.state = row.paths.filter((x) => !row.walked[x]).length ? "open" : "closed";
    }
  }
  // 노트 번호도 이어받는다. 1로 돌아가면 같은 번호가 중복되어 화면에서 구분되지 않는다.
  if (notes && !(st.notes || []).length) st.notes = new Array(notes).fill(null).map((_, i) => ({ id: "n" + (i + 1), carried: true }));
  return rows.size;
}

// 같은 조건을 쓰는 줄들. 한 번의 준비로 함께 수행하며, 이 집계가 곧 수행 순서다.
function byGiven(st) {
  const m = new Map();
  for (const row of rowsOf(st).values()) {
    const k = row.given;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(row.id);
  }
  return [...m.entries()].map(([given, ids]) => ({ given, rows: ids }));
}

// 미충족일 때 색을 사람이 고를 수 있는가. 문서·기획·사용자 지정에서 온 기대는 아니다.
//
// 미충족 여부는 색에서 추론하지 않는다. 오렌지는 성립하지만 사용하기 어렵다는 뜻이지
// 미충족이 아닌데, 초록이 아니면 미충족으로 판정하면 그것까지 실패가 된다(확인 결과 그렇게
// 잘못 판정됐다). 미충족은 영수증에 이미 있는 사실이다. 도구가 값을 읽어 기대와 다르다고
// 기록한 것으로 판정한다.
function forcedColor(row, failedReceipts) {
  return (failedReceipts > 0 && HARD_BASIS.has(row.basis)) ? "red" : null;
}

// 실패한 판정과 어긋난 요구는 같은 것이 아니다.
//
// 경계 경로는 없어야 할 것이 없다는 형태로 증명되는 경우가 많고, 존재를 묻는 형태로 적으면
// 통과가 곧 결함이 된다(확인 결과: 승인된 매물에 승인 버튼이 없다는 사실을 contains로 물어
// pass:false가 남았고, 하드 근거 줄이라 화면이 요구대로인데도 red로 판정됐다).
// 그래서 판정을 무효로 표시하는 수단을 둔다. 삭제가 아니라 취소 표시이므로 원래 줄은 기록에
// 남고 집계에서 제외한 이유도 함께 남는다. 사유 없이는 받지 않는다.
function voidReceipt(st, id, why) {
  const rid = String(id || "").trim();
  if (!rid) return { ok: false, error: "어느 판정인지(id)가 없습니다." };
  const reason = String(why || "").trim();
  if (!reason) return { ok: false, error:
    "왜 안 세는지(why)가 없습니다 — 사유 없는 무효는 판정을 지우는 것과 같습니다." };
  let hit = null;
  try {
    for (const line of fs.readFileSync(path_(st), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.kind === "assertion" && e.id === rid) hit = e;
    }
  } catch {}
  if (!hit) return { ok: false, error: `이 회차에 없는 판정입니다: ${rid}` };
  appendEvent(st, { kind: "void", source: "server", receipt: rid, why: reason,
    row: hit.row || undefined, path_: hit.path_ || undefined });
  // 무엇을 죽였는지 말한다.
  //
  // 번호만 받고 그대로 제거하면, 호출하는 쪽이 기억에 의존해 잘못된 번호를 보낼 수 있다
  // (확인 결과: 다른 줄(R-39)의 관찰을 근거로 무관한 줄(R-36)의 통과 판정을 무효화했고 사유
  // 칸에도 R-39 내용이 적혔다). 그 줄만 보는 사람은 무효 사유를 알 수 없으므로, 도구가 그
  // 시점에 가진 정보를 함께 기록한다.
  const belongs = hit.row ? `${hit.row}${hit.path_ ? ` · ${hit.path_}` : ""}` : "줄에 안 붙은 판정";
  const named = [...rowsOf(st).keys()].filter((x) => x !== hit.row && reason.includes(x));
  // 통과를 지우는 것과 실패를 지우는 것은 뜻이 다르다.
  //
  // 실패 무효는 질문이 틀렸다는 뜻이라 증거가 늘어나는 방향이고 드러난다. 통과 무효는 통과로
  // 나온 판정을 취소하는 것이라 증거가 줄어드는 방향이고 눈에 띄지 않는다(확인 결과: 한
  // 회차의 무효 여섯 건 중 통과를 제거한 것은 하나였고 그 하나가 오류였다. 나머지 다섯은
  // 질문을 철회한 것이다). 빈도가 아니라 종류로 판정하므로 막지 않고 그 시점에 뜻을
  // 표시한다.
  return { ok: true, voided: rid, why: reason, 무효로만든것: belongs, 통과였나: !!hit.pass,
    note: `무효 처리함 — ${rid}는 ${belongs}의 판정입니다 (${hit.expected || "?"}${
      hit.pass ? " · 통과였음" : " · 어긋남이었음"}).`
      + (hit.pass
        ? "\n통과 판정을 무효화합니다 — 이 줄의 증거가 하나 줄어듭니다."
          + '\n실패 무효는 "내 질문이 틀렸다"이고 통과 무효는 "맞다고 나온 것을 취소한다"입니다.'
        : "")
      + (named.length
        ? `\n사유가 다른 줄을 가리킵니다: ${named.join(" · ")}. 지우려던 것이 그쪽이면 이 무효는 잘못 짚은 것입니다.`
        : "") };
}

// 현재 열려 있는 레인 전부. 한 조작·한 판정이 여러 줄의 증거가 될 수 있으므로 모두 기록한다.
// 마지막 하나만 기록하면 함께 연 줄이 증거 없이 남는다. row·path_는 기존 형식을 유지한다.
// 줄의 증거로 집계되는 종류. 이 셋에만 줄 번호를 남긴다. note·row·void 같은 기록에까지
// 남기면 tallyFor가 그것들을 장면·판정으로 집계한다.
const EVIDENCE_KINDS = new Set(["assertion", "artifact", "frame"]);

function laneStamp(st) {
  const lanes = st.openRows || [];
  if (!lanes.length) return {};
  const last = lanes[lanes.length - 1];
  const out = { row: last.id, path_: last.path };
  if (lanes.length > 1) out.lanes = lanes.map((l) => [l.id, l.path]);
  return out;
}

// 줄의 수행을 시작한다. 어느 경로를 수행할지 함께 정한다. 정상 경로만 수행하고 닫으면 확인이 부족하다.
function rowOpen(st, id, path) {
  const row = rowsOf(st).get(String(id || ""));
  if (!row) return { ok: false, error: `없는 줄입니다: ${id}` };
  const p = String(path || "").trim();
  if (!row.paths.includes(p)) return { ok: false, error:
    `${row.id}: 선언하지 않은 경로입니다: ${p || "없음"} (선언한 것: ${row.paths.join(", ")})` };
  // 열린 레인은 여럿일 수 있다. 같은 조건의 줄을 함께 수행하는데 슬롯이 하나면 마지막 줄만
  // 증거를 받고 나머지는 증거 없음으로 거부된다(확인 결과: R2·R3·R5를 함께 열자 R2가 장면
  // 0·판정 0으로 닫히지 않았다).
  const lanes = st.openRows || (st.openRows = []);
  if (!lanes.some((l) => l.id === row.id && l.path === p)) lanes.push({ id: row.id, path: p, at: Date.now() });
  st.openRow = lanes[lanes.length - 1];
  row.state = "open";
  appendEvent(st, { kind: "row", source: "server", row: row.id, act: "open", path: p });
  return { ok: true, row: rowShape(row), path: p };
}

// 근거 원문을 파일에서 그대로 읽어 온다.
//
// 직접 옮겨 적는 경로가 있으면 원문과 달라진다. 오타 하나여도 결과는 같다. 보고서를 읽는
// 사람이 근거로 삼는 문장이 원문이 아니게 된다.
//
// source가 "경로:시작-끝" 형식이면 그 파일의 해당 줄을 읽어 쓴다. 호출하는 쪽은 위치만
// 전달하고 내용은 파일에서 읽는다. 읽지 못하면 넘어가지 않고 거절한다. 읽지 못한 내용을
// 직접 적은 값으로 채우면 이 장치가 없는 것과 같다.
const SRC_RANGE = /^(.*?):(\d+)(?:-(\d+))?$/;
function quoteFromSource(src) {
  const m = SRC_RANGE.exec(String(src || "").trim());
  if (!m) return null;
  const file = m[1], a = Number(m[2]), b = m[3] ? Number(m[3]) : Number(m[2]);
  if (!file || !Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null;
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { error: `그 파일을 읽지 못했습니다: ${file}` }; }
  const lines = text.split("\n");
  if (b > lines.length) return { error: `${file}는 ${lines.length}행까지입니다(요청 ${a}-${b}).` };
  // 들여쓰기는 문장이 아니다. 왼쪽 공백만 공통으로 제거한다.
  const picked = lines.slice(a - 1, b);
  const pad = Math.min(...picked.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return { quote: picked.map((l) => l.slice(Number.isFinite(pad) ? pad : 0)).join("\n").trim() };
}

// 목록도 인용과 같이 파일에서 읽어 온다.
//
// 직접 옮겨 적은 목록은 작성자가 아는 것만 담는다. 시스템은 확인하기로 한 것에서 확인한 것을
// 뺀 값만 계산하므로, 한 차원이 빠진 목록도 100% 확인했다고 표시된다. 목록 자체의 완전성은
// 검사하지 않는다(확인 결과: 알림은 코드에 발생 지점이 여섯인데 회차는 승인 하나로 닫혔고
// 원장에는 누락이 없었다).
//
// 그래서 코드에 여섯이 있으면 목록도 여섯이다. pick이 찾은 것이 곧 항목이고, 그중 어느 줄도
// 확인하지 않은 항목이 있으면 회차가 닫히지 않는다.
function listFromSource(from) {
  const raw = String((from && from.source) || "").trim();
  const pick = String((from && from.pick) || "").trim();
  if (!raw || !pick) return { error:
    "from에는 source(파일)와 pick(찾을 규칙)이 둘 다 필요합니다.\n"
    + '  from: { source: "libs/…/notifier.service.ts", pick: "async (\\\\w+)\\\\(" }' };
  const file = raw.replace(/:\d+(-\d+)?$/, "");
  let re;
  try { re = new RegExp(pick, "g"); }
  catch (e) { return { error: `pick이 규칙이 아닙니다: ${pick} (${e.message})` }; }
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { error: `그 파일을 읽지 못했습니다: ${file}` }; }
  const items = [], seen = new Set();
  text.split("\n").forEach((line, i) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m[0] === "") { re.lastIndex += 1; continue; }   // 빈 매치는 위치가 진행되지 않는다
      const id = String(m[1] != null ? m[1] : m[0]).trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        items.push({ id, text: line.trim().slice(0, 200), at: `${file}:${i + 1}` });
      }
    }
  });
  // 항목이 0개인 목록은 규칙이 적용되지 않은 것이다. 남은 개수를 먼저 확인한다.
  if (!items.length) return { error:
    `그 규칙이 ${file}에서 아무것도 못 찾았습니다: ${pick}\n`
    + "0개짜리 목록은 완전한 목록과 구별되지 않습니다 — 규칙을 고치거나 items로 직접 적으세요." };
  const out = { items, from: { source: file, pick } };
  const usedIn = String((from && from.usedIn) || "").trim();
  if (usedIn) {
    const got = scanUsage(usedIn, items.map((x) => x.id), file);
    if (got.error) return got;
    const un = new Set(got.unused);
    for (const it of items) if (un.has(it.id)) it.unused = true;
    // 상한 때문에 일부만 검색했으면 그 사실을 기록한다. 알리지 않으면 전부 검색한 것으로 읽힌다.
    out.from.usedIn = usedIn;
    out.from.scanned = got.scanned;
    if (got.capped) out.from.capped = SCAN_CAP;
  }
  return out;
}

// 선언만 있고 호출되지 않는 항목은 목록에는 등록되지만 실제로는 실행되지 않는다.
//
// 목록을 한 파일에서 읽어 오면 그 파일이 정확하다는 전제가 생긴다. 발신기에 메서드가 여섯인데
// 호출부가 다섯이면 실제 발신은 다섯이고, 그 차이는 목록으로 드러나지 않는다. 그래서 호출
// 지점도 함께 확인한다. 코드가 있다는 것과 그것이 실행된다는 것은 다른 사실이다.
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".dart", ".py",
  ".go", ".java", ".kt", ".rb", ".php", ".vue", ".svelte", ".swift", ".cs"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next",
  ".working", "vendor", "__pycache__", ".dart_tool"]);
const SCAN_CAP = 5000;
function scanUsage(root, ids, exclude) {
  const left = new Set(ids);
  let seen = 0, capped = false;
  const walk = (d) => {
    if (capped || !left.size) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (capped || !left.size) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(full); continue; }
      if (!CODE_EXT.has(path.extname(e.name))) continue;
      if (full === exclude) continue;
      if (++seen > SCAN_CAP) { capped = true; return; }
      let text; try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      for (const id of [...left]) if (text.includes(id)) left.delete(id);
    }
  };
  const st0 = (() => { try { return fs.statSync(root); } catch { return null; } })();
  if (!st0) return { error: `부르는 자리를 찾을 폴더가 없습니다: ${root}` };
  walk(st0.isDirectory() ? root : path.dirname(root));
  return { unused: [...left], scanned: seen, capped };
}

// 이 회차가 든 목록들. 하나만 주면 하나, 여럿 주면 여럿이다.
function setsOf(st) { return Array.isArray(st.sets) ? st.sets : (st.list ? [st.list] : []); }

// 어느 줄이든 covers로 가리킨 항목 전부.
function coveredIds(st) {
  const out = new Set();
  for (const row of rowsOf(st).values())
    for (const c of (row.covers || [])) out.add(String(c));
  return out;
}

// 세트마다 몇 가지 중 몇 가지를 확인했고 무엇이 남았는지를 계산한다. 이 값은 declare 응답,
// begin 응답, end 거절문에 모두 실린다. 마지막에 한 번만 계산하면 그 사이 상태를 알 수 없다.
function setCoverage(st) {
  const covered = coveredIds(st);
  return setsOf(st).map((s) => {
    const miss = (s.items || []).filter((it) => !covered.has(it.id));
    return { name: s.name, total: (s.items || []).length, missing: miss.map((x) => x.id) };
  });
}
function coverageLines(st) {
  return setCoverage(st).filter((c) => c.missing.length).map((c) =>
    `${c.name} — ${c.total}가지 중 ${c.total - c.missing.length}가지를 봄 · 안 본 것: ${c.missing.join(" · ")}`);
}

// 이미 만든 줄에 근거 원문을 붙인다. 수행 중에 근거 위치를 확인하는 경우가 많고, 그때 붙일
// 방법이 없으면 보고서가 원문을 다시 찾게 만든다.
// 이미 만든 줄을 목록 항목에 잇는다.
//
// covers를 declare에서만 받으면 회차 중간에 목록이 들어올 때 이미 만든 줄이 연결되지 않는다.
// 목록이 도중에 들어오는 상황이 이 장치가 필요한 이유다. 연결할 방법이 없으면 같은 줄을 다른
// id로 다시 만들게 되고, 화면에 같은 확인이 두 번 표시된다.
//
// 덮지 않고 더한다. 한 줄이 목록 항목 둘을 볼 수 있다.
function rowCovers(st, id, items) {
  const row = rowsOf(st).get(String(id || ""));
  if (!row) return { ok: false, error: `없는 줄입니다: ${id}` };
  const add = (Array.isArray(items) ? items : [items]).map((x) => String(x || "").trim()).filter(Boolean);
  if (!add.length) return { ok: false, error:
    `${row.id}: 어느 항목을 보는지(covers)가 없습니다 — 목록 항목의 id를 넣습니다.` };
  // 없는 항목을 가리키면 아무것도 확인하지 않은 줄이 확인한 것으로 기록된다. 목록이 있으면 대조한다.
  const known = new Set();
  for (const set of setsOf(st)) for (const it of (set.items || [])) known.add(it.id);
  if (known.size) {
    const bad = add.filter((x) => !known.has(x));
    if (bad.length) return { ok: false, error:
      `${row.id}: 목록에 없는 항목입니다: ${bad.join(", ")}\n`
      + `있는 항목: ${[...known].join(" · ")}` };
  }
  const before = new Set(row.covers || []);
  row.covers = [...before, ...add.filter((x) => !before.has(x))];
  appendEvent(st, { kind: "row", source: "server", row: row.id, act: "covers", covers: row.covers });
  // toData가 한 겹을 씌우므로 여기서는 평평하게 돌려준다.
  return { ok: true, row: row.id, covers: row.covers, 목록: setCoverage(st) };
}

function rowBasis(st, id, b) {
  const row = rowsOf(st).get(String(id || ""));
  if (!row) return { ok: false, error: `없는 줄입니다: ${id}` };
  const shot = b && b.shot ? String(b.shot) : "";
  // 어디인지만 적었으면 무엇이라 적혀 있는지는 파일이 말한다.
  let quote = b && b.quote ? String(b.quote) : "";
  if (!quote && b && b.source) {
    const got = quoteFromSource(b.source);
    if (got && got.error) return { ok: false, error: got.error };
    if (got && got.quote) quote = got.quote;
  }
  // 근거를 가리키는 한 줄(basisNote)은 작성한 문장이지 측정값이 아니다. 잘못 쓴 것을 고칠 수
  // 없으면 화면이 틀린 채로 남으므로, 덮어쓰지 않고 교정 기록을 뒤에 붙여 원래 선언도 남긴다.
  const noteFix = b && b.note != null ? String(b.note).trim() : "";
  // 줄 설명(what)도 작성한 문장이라 같은 방식으로 교정한다. 원래 선언은 장부에 남는다.
  const whatFix = b && b.what != null ? String(b.what).trim() : "";
  if (!quote && !shot && !noteFix && !whatFix) return { ok: false, error:
    "원문(quote)·그 화면(shot)·근거 한 줄(basisNote)·줄 설명(what) 중 하나는 있어야 합니다 — 근거 이름만으로는 문서를 열어야 합니다.\n"
    + "source를 \"경로:12-14\" 모양으로 주면 그 줄들을 파일에서 그대로 떠 옵니다 — 옮겨 적지 않는 쪽이 안전합니다." };
  if (noteFix) {
    const fault = nominalFault(`${row.id} 근거`, noteFix);
    if (fault) return { ok: false, error: fault };
  }
  const kept = shot ? persistArtifact(st, shot) : undefined;
  // 덮지 않는다. 뒤에 붙인 근거가 앞의 것을 지우면 두 문서를 근거로 든 줄이 하나만 남는다.
  if (quote) row.quotes = [...(row.quotes || (row.quote ? [row.quote] : [])), quote];
  if (b && b.source) row.source = String(b.source);
  if (kept) row.sourceShot = kept;
  if (noteFix) row.basisNote = noteFix;
  if (whatFix) row.what = whatFix;
  appendEvent(st, { kind: "row", source: "server", row: row.id, act: "basis",
    quote: quote || undefined, source: b && b.source ? String(b.source) : undefined,
    sourceShot: kept, basisNote: noteFix || undefined, what: whatFix || undefined });
  return { ok: true, row: rowShape(row) };
}

// 잘못 연결된 장면을 분리한다. 로그인 벽에서 다시 들어가는 구간처럼 그 줄과 무관한 화면이
// 열린 레인에 기록될 수 있고, 그러면 다른 항목의 증거로 로그인 화면이 남는다. 삭제하지 않고
// 부가 항목으로 표시하며, 사유 없이는 받지 않는다.
function asideFrames(st, id, path, want, why) {
  const row = rowsOf(st).get(String(id || ""));
  if (!row) return { ok: false, error: `없는 줄입니다: ${id}` };
  const p = String(path || "").trim();
  if (!row.paths.includes(p)) return { ok: false, error: `${row.id}: 선언하지 않은 경로입니다: ${p}` };
  const reason = String(why || "").trim();
  if (!reason) return { ok: false, error:
    "왜 이 줄의 증거가 아닌지(why)가 없습니다 — 사유 없는 제외는 증거를 지우는 것과 같습니다." };
  const which = (Array.isArray(want) ? want : [want]).map((x) => String(x || "").trim()).filter(Boolean);
  if (!which.length) return { ok: false, error: "떼어낼 장면(frames)이 없습니다 — 파일 경로를 줍니다." };
  let seen = 0;
  try {
    for (const line of fs.readFileSync(path_(st), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.kind === "frame" && which.includes(String(e.path))) seen += 1;
    }
  } catch {}
  if (!seen) return { ok: false, error: "이 회차에 없는 장면입니다 — 장부에 적힌 경로를 그대로 줍니다." };
  appendEvent(st, { kind: "aside", source: "server", row: row.id, path_: p, frames: which, why: reason });
  return { ok: true, aside: which.length, why: reason };
}

// 이 경로를 모두 수행했다. 증거가 없으면 닫히지 않는다. 이 시점에는 화면이 남아 있어 다시
// 수행할 수 있고, 보고서 시점에 막는 것과 다른 점이 그것이다.
function rowClose(st, id, path, color, note, extra) {
  const row = rowsOf(st).get(String(id || ""));
  if (!row) return { ok: false, error: `없는 줄입니다: ${id}` };
  const p = String(path || "").trim();
  if (!row.paths.includes(p)) return { ok: false, error: `${row.id}: 선언하지 않은 경로입니다: ${p}` };
  const c = String(color || "").trim();
  if (!COLORS.has(c)) return { ok: false, error:
    `${row.id}: 색이 red·orange·yellow·green·blue·gray 중 하나여야 합니다(받은 값: ${c || "없음"}).` };
  // 색만으로는 발견이 아니다. 보고서를 읽는 사람이 보는 것은 무엇을 확인했는지 서술한 문장이고
  // 색은 그 문장의 긴급도를 나타낼 뿐이다. 문장 없이 닫히면 화면에 색만 남는다(확인 결과:
  // 호출하는 쪽이 said로 보냈는데 서버가 note만 받아 버려 아홉 줄이 그렇게 닫혔다).
  // 두 이름을 모두 받고, 없으면 닫지 않는다.
  const said = String(note == null ? "" : note).trim();
  if (!said) return { ok: false, error:
    `${row.id}·${p}: 무엇을 보았는지 한 문장이 필요합니다(note).\n`
    + "색은 급함이지 발견이 아닙니다. 보고서를 읽는 사람이 보는 것은 그 문장입니다." };
  // blue는 사용자가 정해야 한다는 뜻이다. 결정 항목이므로 note와 같은 조건을 요구한다.
  // 고를 선택지가 없으면 읽는 사람은 무엇을 정하라는 것인지 모른 채 판정문만 받는다.
  // 근거는 이 레인의 장면과 줄의 근거 원문이 이미 갖고 있어 따로 요구하지 않는다.
  const picksOf = (o) => (Array.isArray(o) ? o : []).map((x) => ({
    pick: String((x && x.pick) || "").trim(),
    then: String((x && x.then) || "").trim(),
    cost: x && x.cost ? String(x.cost).trim() : undefined,
  })).filter((x) => x.pick && x.then);
  const ex = extra || {};
  const picks = picksOf(ex.options);
  if (c === "blue" && !ex.simple && picks.length < 2) return { ok: false, error:
    `${row.id}·${p}: 정해야 할 것으로 닫으려면 고를 갈래가 둘 이상 필요합니다(지금 ${picks.length}개).\n`
    + "정하는 사람은 이 화면을 안 봤습니다 — 무엇을 고를 수 있고 고르면 어떻게 되는지를 함께 주세요.\n"
    + "options: [{pick:\"무엇을 한다\", then:\"고르면 이렇게 된다\", cost:\"대신 잃는 것\"}]\n"
    + "갈래를 세울 수 없는 자리면 simple:true — 지면에 그렇게 표시됩니다." };
  const closeFault = nominalFault(`${row.id}·${p}`, said)
    || picks.map((x, k) => nominalFault(`${row.id}·${p} 갈래 ${k + 1}`, `${x.pick}\n${x.then}\n${x.cost || ""}`))
         .find(Boolean)
    || (ex.lean ? nominalFault(`${row.id}·${p} 생각`, ex.lean) : null);
  if (closeFault) return { ok: false, error: closeFault };
  const { frames, receipts, failed, shotted } = tallyFor(st, row.id, p);
  const forced = forcedColor(row, failed);
  if (forced && c !== forced) return { ok: false, error:
    `${row.id}: 이 줄은 ${row.basis}에서 온 기대이고 이 경로의 판정 ${failed}건이 어긋났습니다`
    + ` — red입니다(넣은 값: ${c}).\n`
    + "문서·기획에 적힌 것과 사용자가 그렇게 하라고 한 것은 경중을 따질 자리가 아닙니다.\n"
    + "지켜졌다면 어긋난 판정이 없어야 합니다 — 그 자리를 다시 밟습니다.\n"
    + "요구가 아니었다면 줄의 basis를 고칩니다." };
  // 증거는 이 줄이 열린 뒤의 것만 집계한다. 탐색 중의 조작은 발견의 정황이지 증거가 아니고,
  // 화면을 보고 만든 기대는 구현을 명세로 삼은 것이다. 집계는 서버가 한다.
  // 장면은 조작이 남긴 것만이 아니라 판정도 그 순간의 화면을 함께 남긴다(expect의 shot).
  // 그것을 집계하지 않으면 조작 없이 확인되는 요구는 불필요한 조작을 하나 넣어야 닫힌다
  // (확인 결과: 상세 화면 확인 한 줄을 닫으려고 스크롤을 한 번 넣었다).
  // 집계 대상은 파일이다. 판정이 장면을 남기지 않았으면 그 판정은 여기서 집계되지 않는다.
  if (c !== "blue" && c !== "gray" && !(frames + shotted > 0 && receipts > 0)) return { ok: false, error:
    `${row.id}·${p}: 증거가 없습니다 (장면 ${frames + shotted} · 영수증 ${receipts}).\n`
    + "그 자리를 다시 밟습니다 — 지금은 화면이 아직 살아 있습니다.\n"
    + "됐다는 것도 실측입니다. 정상 동작이야말로 다음 회차의 기준선입니다." };
  row.walked[p] = { color: c, at: Date.now(), note: said, frames: frames + shotted, receipts, failed,
    ...(picks.length ? { options: picks } : {}), ...(ex.lean ? { lean: String(ex.lean) } : {}),
    ...(ex.simple ? { simple: true } : {}) };
  const left = row.paths.filter((x) => !row.walked[x]);
  row.state = left.length ? "open" : "closed";
  st.openRows = (st.openRows || []).filter((l) => !(l.id === row.id && l.path === p));
  st.openRow = st.openRows.length ? st.openRows[st.openRows.length - 1] : null;
  appendEvent(st, { kind: "row", source: "server", row: row.id, act: "close",
    path: p, color: c, frames: frames + shotted, receipts, note: note ? String(note) : undefined,
    ...(picks.length ? { options: picks } : {}), ...(ex.lean ? { lean: String(ex.lean) } : {}),
    ...(ex.simple ? { simple: true } : {}) });
  return { ok: true, row: rowShape(row), left };
}

// 회차가 닫힐 수 있는가. 완료를 작성자가 직접 선언하지 못하게 한다.
function ledgerGaps(st) {
  const gaps = [];
  for (const row of rowsOf(st).values()) {
    const left = row.paths.filter((x) => !row.walked[x]);
    if (left.length) gaps.push(`${row.id} — 안 밟은 경로: ${left.join(", ")} (${row.what.slice(0, 40)})`);
  }
  // 선언한 줄을 다 확인한 것과 확인하기로 한 것을 다 본 것은 다른 사실이다. 줄을 하나만
  // 등록하면 그 하나를 확인하는 것으로 원장이 닫히므로, 목록이 있으면 목록도 함께 센다.
  for (const c of setCoverage(st)) {
    if (!c.missing.length) continue;
    gaps.push(`${c.name} — 아무 줄도 안 본 항목 ${c.missing.length}가지: ${c.missing.join(", ")}`
      + " (그 항목을 covers로 가리키는 줄을 세우거나, 못 보는 사유와 함께 blue·gray로 닫습니다)");
  }
  return gaps;
}

// 보고서 문장은 명사형으로 끝낸다. 판정문·발견·결정·선택지가 대상이고 근거 원문 인용과
// 의문문은 제외한다. 인용은 그대로 실어야 하므로 어미를 바꾸면 원문이 아니게 되고, 묻는
// 문장은 명사형이 뜻을 흐린다.
//
// 규칙으로 적어 두는 것만으로는 지켜지지 않는다(확인 결과: 한 회차의 판정문 아홉이 전부
// 서술형이었다). 그래서 문장이 서술형으로 끝나면 받지 않는다.
//
// 문장 끝만 확인한다. 인용부호·마침표를 제거하고 남은 마지막 글자가 "다"나 "요"면 서술형이다.
// 물음표로 끝나면 통과시키고, 애매하면 통과시킨다. 이 검사는 어미만 보고 뜻은 보지 않는다.
const NARRATIVE_TAIL = /(다|요)$/;
function narrativeSentences(text) {
  const bad = [];
  String(text == null ? "" : text)
    .split(/\n+/)
    .flatMap((para) => para.split(/(?<=[^0-9]\.|[?!])\s+/))
    .map((x) => x.trim()).filter(Boolean)
    .forEach((one) => {
      if (/[?？]\s*["'\u201d\u2019)\]]*$/.test(one)) return;      // 묻는 문장은 그대로 둔다
      const tail = one.replace(/["'\u201c\u201d\u2018\u2019)\]\s.。!?？]+$/u, "");
      if (NARRATIVE_TAIL.test(tail)) bad.push(one);
    });
  return bad;
}
function nominalFault(label, text) {
  const bad = narrativeSentences(text);
  if (!bad.length) return null;
  return `${label}: 보고서는 라벨체입니다. 종결어미를 붙이지 않습니다.\n`
    + bad.slice(0, 3).map((x) => `  서술형: ${x}`).join("\n")
    + (bad.length > 3 ? `\n  … 외 ${bad.length - 3}문장` : "")
    + "\n예: \"버튼이 안 눌렸다\" → \"버튼 미반응\" · \"사유가 비어 있다\" → \"사유 없음\"\n"
    + "-임·-함·-음 같은 명사형 어미도 종결어미입니다. 여기서는 -다·-요만 막지만 그것도 걷어냅니다.\n"
    + "근거 원문(quote)과 묻는 문장은 이 검사에서 빠집니다.\n"
    // 여기서 막힌 사람이 가장 흔히 하는 일이 문장을 잘라 뜻을 지우는 것이다. 해결 방법이
    // 압축이 아니라 분해라는 것을 그 시점에 안내한다. 안내가 없으면 같은 줄에서 반복해서
    // 막힌다(확인 결과: 결정 선택지 하나를 닫는 데 세 번 걸렸고 뜻이 깎였다).
    + "뜻이 깎이면 문장으로 되돌리지 말고 줄을 더 쌓습니다 — 한 줄에 한 사실입니다.\n"
    + "  \"구매자는 앱을 열어 직접 봐야 한다\"\n"
    + "  → \"구매자 알림 없음\" / \"확인 경로: 앱에서 내 중고거래 직접 열기\"";
}

// 고칠 코드가 없는 발견. 결함 목록에 섞으면 개발자는 고칠 수 없는 항목을 받고, 정해야 할
// 사람은 그것이 자기 것인 줄 모른다. 따로 쌓아 보고서에 별도 문서로 붙인다.
function addNote(st, n) {
  const what = String((n && n.what) || "").trim();
  if (!what) return { ok: false, error: "무엇을 봤는지(what)가 없습니다." };
  const decide = String((n && n.decide) || "").trim();
  if (!decide) return { ok: false, error:
    "무엇을 정해야 하는지(decide)가 없습니다 — 그게 없으면 이것은 노트가 아니라 감상입니다." };
  // 정하는 사람은 이 화면을 안 봤고 코드도 안 읽는다. 글만 있으면 읽고 넘기는 것밖에 할 수
  // 없다. 무엇을 근거로 어떻게 해야 하는지 바로 이해할 수 있어야 하므로, 결정 항목은 근거와
  // 선택지를 함께 요구한다.
  //
  // 간단한 결정까지 이 형식에 넣으면 형식만 채운 선택지가 생긴다. simple:true로 빠질 수 있되,
  // 빠졌다는 사실이 화면에 "간단한 결정"으로 표시된다. 조용한 우회는 만들지 않는다.
  const simple = n && n.simple === true;
  const q0 = n && n.quote ? String(n.quote) : "";
  let quote = q0, srcErr = null;
  if (!quote && n && n.source) {
    const got = quoteFromSource(String(n.source));
    if (got && got.error) srcErr = got.error;
    else if (got && got.quote) quote = got.quote;
  }
  if (srcErr) return { ok: false, error: srcErr };
  const picks = Array.isArray(n && n.options)
    ? n.options.map((o) => ({
        pick: String((o && o.pick) || "").trim(),
        then: String((o && o.then) || "").trim(),
        cost: o && o.cost ? String(o.cost).trim() : undefined,
      })).filter((o) => o.pick && o.then)
    : [];
  if (!simple) {
    if (!n.shot && !quote && !n.source) return { ok: false, error:
      `${decide}\n\n근거가 없습니다. 정하는 사람은 이 화면을 안 봤습니다 — 무엇을 보고 정해야 하는지를 함께 주세요.\n`
      + "shot에 그 장면 경로, 또는 source에 \"파일:102-103\"처럼 어디인지를 적으면 원문은 파일에서 떠 옵니다.\n"
      + "정말 근거를 붙일 것이 없는 간단한 결정이면 simple:true — 지면에 그렇게 표시됩니다." };
    if (picks.length < 2) return { ok: false, error:
      `${decide}\n\n고를 수 있는 갈래가 ${picks.length}개입니다. 갈래가 없으면 읽는 사람은 무엇을 해야 할지 모릅니다.\n`
      + "options에 둘 이상 주세요: [{pick:\"무엇을 한다\", then:\"고르면 이렇게 된다\", cost:\"대신 잃는 것\"}]\n"
      + "갈래를 세울 수 없는 간단한 결정이면 simple:true — 지면에 그렇게 표시됩니다." };
  }
  const noteFault = nominalFault("무엇을 보았나(what)", what)
    || (n.why ? nominalFault("왜 정해야 하나(why)", n.why) : null)
    || nominalFault("정해야 할 것(decide)", decide)
    || picks.map((x, k) => nominalFault(`갈래 ${k + 1}`, `${x.pick}\n${x.then}\n${x.cost || ""}`)).find(Boolean)
    || (n.lean ? nominalFault("밟은 사람 생각(lean)", n.lean) : null);
  if (noteFault) return { ok: false, error: noteFault };
  const note = { id: "n" + ((st.notes || (st.notes = [])).length + 1),
    what, decide, why: n.why ? String(n.why) : undefined,
    row: n.row ? String(n.row) : undefined,
    ...(picks.length ? { options: picks } : {}),
    // 어느 쪽으로 기우는지는 적되 결정은 아니다. 없으면 없는 대로 둔다.
    lean: n.lean ? String(n.lean) : undefined,
    ...(simple ? { simple: true } : {}),
    // 노트도 근거를 갖는다. 기획서가 이렇게 적었는데 화면이 저렇더라는 말은, 그 문장이
    // 함께 실려야 읽는 사람이 문서를 안 열고 판단할 수 있다.
    quote: quote || undefined,
    source: n.source ? String(n.source) : undefined,
    shot: n.shot ? persistArtifact(st, String(n.shot)) : undefined,
    at: Date.now() };
  st.notes.push(note);
  appendEvent(st, { kind: "note", source: "server", ...note });
  return { ok: true, note };
}

const toData = (r) => (r.ok ? { ok: true, data: { ...r, ok: undefined } } : r);
// 근거는 조회에도 실린다. 안 실으면 "근거를 붙였는가"를 부르는 쪽이 확인할 길이 없다.
const rowShape = (r) => ({ id: r.id, what: r.what, given: r.given, basis: r.basis,
  basisNote: r.basisNote, quotes: r.quotes || (r.quote ? [r.quote] : undefined),
  source: r.source, sourceShot: r.sourceShot, covers: r.covers,
  paths: r.paths, state: r.state, walked: r.walked, at: r.at });

const shape = (st) => ({ runId: st.runId, dir: st.dir, journal: path.join(st.dir, "journal.jsonl"),
  seq: st.seq, receipts: st.receipts, calls: st.calls,
  ...(st.surfaces ? { surfaces: st.surfaces } : {}) });

export function handleQaSessionCmd(cmd, args, session, runId) {
  if (cmd === "run") {
    const act = String((args && args.action) || "status");
    if (act === "begin") {
      const st = bindRun(session, (args && args.runId) || runId);
      const resumed = st.seq > 0;
      const decl = Array.isArray(args && args.surfaces)
        ? args.surfaces.map((x) => String(x).trim()).filter(Boolean) : null;
      if (decl && decl.length) st.surfaces = decl;
      const kind = String((args && args.kind) || "review");
      st.kind = kind;
      // proof·regression은 확인을 시작하기 전에 원장이 확정된다. 그래야 기대가 화면보다 먼저다.
      // review는 빈 원장으로 시작하고, 탐색이 발견한 것이 줄을 만든다. 그 줄의 증거도 생성
      // 이후의 것만 세므로 재현 주행이 새로 있어야 닫힌다.
      // 이어 여는 회차면 장부의 줄부터 복원한다. 그래야 재시작이 원장을 지우지 않는다.
      if (resumed) rehydrateRows(st);
      const rows = Array.isArray(args && args.rows) ? args.rows : [];
      if (kind !== "review" && !rows.length && !rowsOf(st).size) return { ok: false, error:
        `${kind} 회차는 밟기 전에 원장이 있어야 합니다 — rows에 확인할 줄을 넣으세요.\n`
        + '  { id:"U5", what:"…", given:"…", basis:"spec", paths:["정상","실패"] }\n'
        + "무엇을 확인할지 먼저 적어야 화면을 보고 기대를 만드는 일이 없습니다.\n"
        + "뭐가 있는지 모르고 들어가는 회차라면 kind를 review로 엽니다." };
      const made = [];
      for (const r of rows) {
        const res = rowDeclare(st, r || {});
        if (!res.ok) return { ok: false, error: res.error };
        made.push(res.row.id);
      }
      // 회차가 따른 목록. 2차 QA처럼 앞 회차의 지적을 받아 도는 경우, 그 목록이 보고서 맨
      // 앞에 서야 "무엇을 고치기로 했고 어느 줄이 그것을 봤는가"가 문서 하나로 닫힌다.
      // 목록은 하나일 수도 여럿일 수도 있다. 한 회차가 앞 회차 지적과 알림 발생 지점을
      // 동시에 다룰 수 있어야 한다. from을 주면 항목을 파일에서 읽어 오고, items를 함께 주면
      // 코드가 못 보여주는 것(설정 기본값·껐을 때)을 사람이 더한다.
      const decls = Array.isArray(args && args.list) ? args.list
        : (args && args.list && typeof args.list === "object" ? [args.list] : []);
      const sets = [];
      for (const d of decls) {
        if (!d || typeof d !== "object") continue;
        let items = [], from;
        if (d.from && typeof d.from === "object") {
          const got = listFromSource(d.from);
          if (got.error) return { ok: false, error: got.error };
          items = got.items; from = got.from;
        }
        const seen = new Set(items.map((x) => x.id));
        for (const x of (Array.isArray(d.items) ? d.items : [])) {
          const id = String((x && x.id) || "").trim(), text = String((x && x.text) || "").trim();
          if (!id || !text || seen.has(id)) continue;
          seen.add(id);
          items.push({ id, text, was: x.was ? String(x.was) : undefined,
            shot: x.shot ? persistArtifact(st, String(x.shot)) : undefined });
        }
        if (!items.length) return { ok: false, error:
          "list에 항목이 없습니다 — id와 text를 가진 항목이 하나라도 있거나, from으로 파일에서 떠 와야 목록입니다." };
        const set = { name: String(d.name || "확인 목록"),
          source: d.source ? String(d.source) : (from ? from.source : undefined), from,
          shot: d.shot ? persistArtifact(st, String(d.shot)) : undefined, items };
        sets.push(set);
        appendEvent(st, { kind: "list", source: "server", ...set });
      }
      if (sets.length) { st.sets = (st.sets || []).concat(sets); st.list = st.sets[0]; }
      appendEvent(st, { kind: "run_begin", source: "server", resumed, runKind: kind,
        ...(st.surfaces ? { surfaces: st.surfaces } : {}) });
      const groups = byGiven(st);
      const cov = coverageLines(st);
      return { ok: true, data: { ...shape(st), resumed, kind, rows: made, plan: groups,
        목록: setCoverage(st),
        note: "이 runId를 이후 모든 호출에 실어라 — 세션 기본값은 회차 둘이 겹칠 때 무너진다."
          + (groups.length ? `\n조건이 ${groups.length}가지다 — 같은 조건을 쓰는 줄은 한 번의 준비로 함께 밟는다.` : "")
          + (cov.length ? "\n" + cov.join("\n") + "\n이 항목들을 덮는 줄이 없으면 회차가 안 닫힌다." : "") } };
    }
    if (act === "end") {
      const st = runOf(session, (args && args.runId) || runId);
      if (st) {
        // 완료를 작성자가 직접 선언하지 못하게 한다. 원장이 닫혀야 회차가 닫힌다.
        const gaps = ledgerGaps(st);
        if (gaps.length && !(args && args.force)) return { ok: false, error:
          `원장이 안 닫혔습니다 — ${gaps.length}줄.\n` + gaps.slice(0, 12).map((g) => "  " + g).join("\n")
          + (gaps.length > 12 ? `\n  … 외 ${gaps.length - 12}건` : "")
          + "\n\n밟거나, 못 밟는 사유와 함께 blue(사용자가 정해야 함)나 gray(분류 불가)로 닫습니다.\n"
          + "닫지 않고 넘기면 그 줄은 아무 데도 안 남습니다." };
        appendEvent(st, { kind: "run_end", source: "server" });
        const open = st.calls - countCompleted(st);
        runs.delete(st.runId);
        for (const [k, v] of runBySession) if (v === st.runId) runBySession.delete(k);
        return { ok: true, data: { ...shape(st), ended: true, openCalls: open > 0 ? open : 0 } };
      }
      return { ok: true, data: { runId: null, ended: false } };
    }
    const st = runOf(session, (args && args.runId) || runId);
    return { ok: true, data: st ? shape(st) : { runId: null } };
  }
  // 줄의 생애. 여는 시각이 곧 "이 줄의 증거는 여기서부터"의 기준이다.
  if (cmd === "row") {
    const st = runOf(session, (args && args.runId) || runId);
    if (!st) return { ok: false, error: "열린 회차가 없습니다 — browser_run begin 부터 하세요." };
    const act = String((args && args.action) || "");
    if (act === "declare") {
      const res = rowDeclare(st, (args && args.row) || {});
      if (!res.ok) return res;
      const same = byGiven(st).find((g) => g.given === res.row.given);
      const cov = coverageLines(st);
      const hints = [];
      if (same && same.rows.length === 1)
        hints.push("이 조건을 쓰는 줄이 하나뿐이다 — 이 값이 한 가지 상태만 가지는가?");
      // 목록이 있으면 줄을 등록할 때마다 남은 항목을 알린다. 한 항목을 채우면 전체를 처리했다고
      // 여기기 쉬우므로, 집계를 종점이 아니라 매 declare에서 수행한다.
      if (cov.length) hints.push(...cov);
      return { ok: true, data: { row: rowShape(res.row),
        같은조건: same ? same.rows : [res.row.id],
        ...(setsOf(st).length ? { 목록: setCoverage(st) } : {}),
        note: hints.length ? hints.join("\n") : undefined } };
    }
    if (act === "open") return toData(rowOpen(st, args && args.row, args && args.path));
    // 판정 문장의 이름은 둘 다 받는다. 이름 하나만 받고 다른 이름을 조용히 버리면 호출하는
    // 쪽은 기록됐다고 믿지만 화면에는 색만 남는다(확인 결과 아홉 줄).
    if (act === "close") return toData(rowClose(st, args && args.row, args && args.path,
      args && args.color, (args && (args.note != null ? args.note : args.said)),
      args && { options: args.options, lean: args.lean, simple: args.simple }));
    if (act === "note") { const r = addNote(st, (args && args.note) || {}); return toData(r); }
    if (act === "void") return toData(voidReceipt(st, args && args.receipt, args && args.why));
    if (act === "basis") return toData(rowBasis(st, args && args.row, args && args.basis));
    if (act === "covers") return toData(rowCovers(st, args && args.row, args && args.covers));
    if (act === "aside") return toData(asideFrames(st, args && args.row, args && args.path,
      args && args.frames, args && args.why));
    if (act === "list") return { ok: true, data: { kind: st.kind || "review",
      rows: [...rowsOf(st).values()].map(rowShape), plan: byGiven(st),
      notes: st.notes || [], gaps: ledgerGaps(st) } };
    return { ok: false, error: "action은 declare·basis·covers·open·close·aside·note·void·list 중 하나입니다." };
  }
  if (cmd === "journal") {
    const st = runOf(session, (args && args.runId) || runId);
    if (!st) return { ok: false, error: "열린 회차가 없습니다 — 먼저 run begin으로 회차를 여세요." };
    const ev = (args && args.event) || {};
    const kind = String(ev.kind || "");
    if (!JOURNAL_KINDS.has(kind)) {
      return { ok: false, error: `kind가 허용값이 아닙니다: ${kind || "(없음)"} — ${[...JOURNAL_KINDS].join("·")}` };
    }
    const source = String(ev.source || args.source || "");
    if (!JOURNAL_SOURCES.has(source)) {
      return { ok: false, error: `source가 허용값이 아닙니다: ${source || "(없음)"} — ${[...JOURNAL_SOURCES].join("·")}` };
    }
    // 앱 표면(app_*)과 순간 포착이 이 명령으로 장부에 기록된다. 표식을 브라우저 경로에만 붙이면
    // 앱으로만 확인한 줄은 증거 0으로 남아 green으로 닫히지 않는다. 실제로 세 줄이 그렇게 열린
    // 채로 멈췄다. 증거가 되는 종류에만 붙이고, 호출하는 쪽이 이미
    // 적었으면 그대로 둔다.
    const stamp = EVIDENCE_KINDS.has(kind) && !ev.row && !ev.lanes ? laneStamp(st) : {};
    const out = { ...stamp, ...ev, source };
    // 바깥 생산자가 보낸 상세도 서버가 자른다. 자르는 지점을 생산자마다 두면 하나가 빠질 때
    // 장부 전체가 무거워지고, 무거워진 장부는 화면에서 읽을 수 없다.
    if (out.detail != null) out.detail = detailOf(out.detail);
    if (out.shot) out.shot = persistArtifact(st, out.shot);
    if (out.path) out.path = persistArtifact(st, out.path);
    if (kind === "assertion" && !out.id) out.id = "r" + (++st.receipts);
    if (kind === "accepted" && !out.call_id) out.call_id = "c" + (++st.calls);
    const rec = appendEvent(st, out);
    return rec ? { ok: true, data: { seq: rec.seq, id: out.id, call_id: out.call_id, shot: out.shot, path: out.path } }
      : { ok: false, error: "장부에 쓰지 못했습니다" };
  }
  if (cmd === "trace") {
    const list = traceBySession.get(session) || [];
    const out = list.map((x) => ({ ...x, at: new Date(x.t).toISOString().slice(11, 19) }));
    if (args && args.clear) traceBySession.delete(session);
    return { ok: true, data: { steps: out, count: out.length } };
  }
  return null;
}

export function runSurfaces(session, runId) {
  const st = runOf(session, runId);
  return (st && st.surfaces) || [];
}
