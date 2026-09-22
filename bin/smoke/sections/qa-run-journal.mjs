// 소유 범위: 회차 journal. 줄마다 run_id·source, 명령 전후 기록, 증거의 회차 폴더 저장.
// 제공 API: 러너가 한 번 부르는 비동기 기본 run.
// 의존 대상: core 의 공유 검사·파일 도구, sources 의 공유 소스, Node 파일·경로·모듈 API.
// 유지 조건: 검사 이름과 본문. 40-qa-evidence.mjs 를 기능별로 분리한 것이고,
//   분리하면서 본문을 바꾸지 않았고, 원본 대비 바이트 대조로 이를 강제한다.
// 영향 범위: 러너가 동적 import 로 이 run 을 부르며 sources 의 공유 상수 계약도 함께 본다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs bin/smoke/sections/qa-run-journal.mjs
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  b4Function, check, checkAsync, read, readAll, require_, ROOT, sourceFiles,
} from "../core.mjs";
import {
  aiState, aiTabs, allServer, archive, archiveHandlers, browserCommands, browserRuntime,
  browserTabs, cdpCaptureToolsSource, cdpCmdCaptureSource, cdpCmdInputSource,
  cdpCmdInspectSource, cdpHiddenViewportSource, cdpObservationSource, cdpSessionSource,
  cdpTransportSource, centerTabs, contextMenu, css, herdrAgents, herdrHandlers, herdrState,
  httpHandler, main, mainJs, mcp, mcpApp, mcpReport, memoPanel, rail, xtermWiring, tabClose, terminalPanel,
  textEditor, web, webviewFactory, webviewThrottleSource, wsCore,
} from "../sources.mjs";
import { sliceBetween, sliceFrom } from "../../slice-anchor.mjs";
// 회차 폴더 이름을 여기서 다시 적지 않는다. 생산자와 값이 갈리면 이 검사가 엉뚱한 위치를 본다.
import { artifactDir } from "../../../server/artifacts-home.cjs";

export default async function run() {
console.log("[11] QA 회차 journal — 브라우저 생산자");
const qaJournal = read("server/qa-journal.js"), qaJournalEntry = read("server/browser-commands.js");
// 이 파일은 회차 전체의 원본이 아니라 "서버가 받은 브라우저 명령 장부"다. 앱은 idb를 직접
// 부르고 API·코드·저장소 계측기도 서버 밖이라, 여기 없는 source가 회차에는 더 있다.
check("회차 로그는 journal이고 줄마다 run_id·source가 붙는다", () =>
  /const runBySession = new Map\(\)/.test(qaJournal)
  && /fs\.appendFileSync\(path\.join\(st\.dir, "journal\.jsonl"\)/.test(qaJournal)
  // 서버 값이 뒤에 온다. 앞에 두면 외부 생산자가 보낸 run_id·seq·t가 서버 값을 덮는다.
  && /const rec = \{ \.\.\.ev, run_id: st\.runId, seq: st\.seq \+ 1, t: Date\.now\(\) \}/.test(qaJournal)
  && /source: "browser"/.test(qaJournal));
// 단조 seq는 기록되지 않은 명령을 드러내지 못한다. 기록된 것에만 번호를 붙이므로 빈 번호가
// 생기지 않는다. 실제 보증은 accepted/completed 짝이며, 짝 없는 accepted가 확인 불가 구간이다.
check("명령은 보내기 전에 먼저 남는다", () =>
  /const callId = noteRunAccepted\(cmd, args, session, runId\);/.test(qaJournalEntry)
  // 조작 직전 프레임은 명령 전송 전에 찍힌다. 그 사이에 accepted 가 남아 있어야 전송 후
  // 응답이 없는 구간과 촬영 중 중단된 구간을 구별할 수 있다.
  && qaJournalEntry.indexOf("noteRunAccepted(cmd, args, session, runId)")
     < qaJournalEntry.indexOf('recordFrame(recRun, args && args.tab, "before"')
  && /let last = null/.test(qaJournalEntry)
  && /kind: "accepted", call_id: callId/.test(qaJournal));
check("끝난 뒤 같은 call_id로 닫는다", () =>
  /kind: "completed", call_id: callId \|\| undefined/.test(qaJournal)
  && /noteRunEvent\(callId, cmd, args, session, out, tries, runId\)/.test(qaJournalEntry)
  && /noteRunEvent\(callId, cmd, args, session, last, tries, runId\)/.test(qaJournalEntry));
// 회차는 세션이 아니라 요청에 포함된다. 세션에만 묶으면 회차 둘이 겹칠 때 나중 회차가 앞 회차를
// 가로채고, 이 계약이 깨지면 동시 회차가 경고 없이 섞인다.
check("회차는 요청마다 실리고 세션은 기본값일 뿐이다", () =>
  /function runOf\(session, runId\) \{[\s\S]{0,180}?runId \|\| \(session \? runBySession\.get/.test(qaJournal)
  && /j\.run \? String\(j\.run\) : null/.test(httpHandler)
  && /\.\.\.\(CURRENT_RUN \? \{ run: CURRENT_RUN \} : \{\}\)/.test(mcp));
// 서버를 안 지나는 계측기(앱 idb·API·코드·저장소)가 같은 장부에 합류하지 못하면 그 단계는
// 파생에서 빠지고 다시 모델 서술로 되돌아간다.
check("서버 밖 계측기도 같은 장부에 합류한다", () =>
  /if \(cmd === "journal"\)/.test(qaJournal)
  && /JOURNAL_SOURCES = new Set\(/.test(qaJournal)
  && /kind: "assertion", source: "app"/.test(mcpApp));
// 허용 목록을 리터럴로 적어 두면 목록이 생산자와 갈린 것을 이 검사가 보지 못한다. 실제로
// bin/iris-mcp.mjs 가 source "moment" 로 내보내는데 허용값에 없어 서버가 전부 거절했고,
// 부르는 쪽은 null 을 받고 넘어갔다(확인 결과: 전 회차 장부에 moment 0건).
// 잠깐 뜬 알림은 다시 찍을 수 없어 그 증거는 복구되지 않는다. 목록이 아니라 대조로 검사한다.
check("장부가 받는 source 목록이 실제 생산자를 다 담는다", () => {
  const m = /JOURNAL_SOURCES = new Set\(\[([^\]]*)\]\)/.exec(qaJournal);
  if (!m) return false;
  const allowed = new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  if (!allowed.size) return false;
  const emitted = new Set();
  for (const src of [mcp, mcpApp]) {
    for (const x of String(src).matchAll(/source:\s*"([a-z_]+)"/g)) emitted.add(x[1]);
  }
  if (!emitted.size) return false;             // 못 세면 통과시키지 않는다: 0건은 계측기 고장
  return [...emitted].every((s2) => allowed.has(s2));
});
// 증거가 회차 폴더 밖에 있으면 파생한 회차는 검사기의 evidence_root 요구를 못 넘는다.
check("증거는 발급과 같은 자리에서 회차 폴더로 굳는다", () =>
  /function persistArtifact\(st, src\)/.test(qaJournal)
  && /fs\.copyFileSync\(abs, dest\)/.test(qaJournal)
  && /const shot = persistArtifact\(st, d\.shot\);/.test(qaJournal));
// 짝 없는 accepted = 보냈는데 끝을 못 본 호출. 회차를 닫을 때 그 수가 모르는 구간의 크기다.
check("회차를 닫을 때 열린 호출을 센다", () =>
  /function countCompleted\(st\)/.test(qaJournal)
  && /const open = st\.calls - countCompleted\(st\);/.test(qaJournal)
  && /openCalls: open > 0 \? open : 0/.test(qaJournal));
check("못 남기면 순번을 올리지 않는다", () =>
  /catch \{ return null; \}/.test(qaJournal) && /st\.seq = rec\.seq;/.test(qaJournal));
check("이어 붙이는 회차는 순번·판정·호출 수를 이어받는다", () =>
  /if \(e\.seq > seq\) seq = e\.seq;/.test(qaJournal)
  && /if \(e\.kind === "assertion"\) receipts\+\+;/.test(qaJournal)
  && /if \(e\.kind === "accepted"\) calls\+\+;/.test(qaJournal));
check("실패한 명령도 남는다", () =>
  /error: res && !res\.ok \? String\(res\.error \|\| ""\)/.test(qaJournal));
check("판정과 증거는 명령과 다른 줄로 남는다", () =>
  /kind: "assertion", id, call_id/.test(qaJournal)
  && /kind: "artifact", call_id/.test(qaJournal)
  && /res\.data\.receipt = id;/.test(qaJournal));
check("입력값은 journal에도 안 남는다", () =>
  /note: a\.text != null \? `\$\{String\(a\.text\)\.length\}자 입력`/.test(qaJournal));
check("회차에 안 묶이면 지금까지대로 동작한다", () =>
  /if \(!st\) return null;\s*\/\/ 회차에 안 묶인/.test(qaJournal)
  && /if \(!st \|\| !runLogged\(cmd\)\) return null;/.test(qaJournal));
check("영수증 번호는 회차가 있으면 서버 것을 쓴다", () =>
  /function addReceipt\(d, serverId, runId\)/.test(mcpReport)
  && /id: serverId \|\| "r" \+ \(receipts\.length \+ 1\)/.test(mcpReport)
  && /shot: r\.data\.shot \|\| null \}, r\.data\.receipt, CURRENT_RUN\);/.test(mcp));
// ── 요구 원장: 소스 모양이 아니라 실제로 실행해 확인한다 ──────────────────
// 게이트를 소스로만 검사하면 `false &&` 한 줄에 우회된다(변이 검사에서 확인).
await (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ac-ledger-"));
  process.env.IRIS_STATE_DIR = dir;
  const { handleQaSessionCmd } = await import(path.join(ROOT, "server/qa-journal.js"));
  const S = "smoke-ledger";
  const call = (cmd, a) => handleQaSessionCmd(cmd, a, S, a && a.runId);
  const R = { runId: "smoke-L" };
  const ROW = { id: "U1", what: "유효기간 비면 완료 비활성", given: "유효기간 미입력",
    basis: "spec", paths: ["정상", "실패"] };

  // 확인 전에 원장이 있어야 기대가 화면보다 먼저 정해진다. 탐색 회차는 빈 원장으로 연다.
  check("proof 회차는 원장 없이 열리지 않는다", () =>
    !call("run", { action: "begin", runId: "smoke-P", kind: "proof" }).ok
    && call("run", { action: "begin", runId: "smoke-Rv", kind: "review" }).ok);

  call("run", { action: "begin", ...R, kind: "review" });
  // given은 서식 칸이 아니라 열거를 강제하는 항목이다. 조건을 적으려면 상태를 먼저 열거해야 한다.
  check("줄은 조건·출처·경로 없이 만들어지지 않는다", () => {
    const no = (patch) => !call("row", { action: "declare", ...R, row: { ...ROW, ...patch } }).ok;
    return no({ given: undefined }) && no({ basis: undefined }) && no({ paths: [] })
      && no({ basis: "그냥" }) && no({ paths: ["아무거나"] });
  });
  check("줄을 만들면 같은 조건이 몇 줄인지 그 자리에서 돌아온다", () => {
    const r = call("row", { action: "declare", ...R, row: ROW });
    // 조건을 쓰는 줄이 하나뿐이면 그 값이 한 가지 상태만 가진다고 선언한 셈이라, 그 시점에 묻는다.
    return r.ok && r.data.같은조건.length === 1 && /한 가지 상태만/.test(r.data.note || "");
  });
  check("선언하지 않은 경로는 열리지 않는다", () =>
    !call("row", { action: "open", ...R, row: "U1", path: "경계" }).ok
    && call("row", { action: "open", ...R, row: "U1", path: "실패" }).ok);
  // 증거 수는 서버가 계산한다. 부르는 쪽이 정하면 자기 채점이 된다.
  check("증거 없이는 닫히지 않는다", () =>
    !call("row", { action: "close", ...R, row: "U1", path: "실패", color: "green" }).ok
    && !call("row", { action: "close", ...R, row: "U1", path: "실패", color: "red" }).ok);
  // 표시를 피하는 값이 하나라도 있으면 전부 그 값으로 몰린다(pass에만 "사진 없음"을 붙였던 사례).
  // 미충족은 색에서 추론하지 않는다. 오렌지는 "성립하지만 쓰기 어렵다"이므로 미충족이 아니다.
  // 영수증이 이미 그 사실을 갖고 있으므로 그것으로 판정한다.
  check("문서에서 온 기대는 판정이 어긋나면 red 말고 안 받는다", () => {
    const J = path.join(artifactDir("qa", dir), "smoke-L", "journal.jsonl");
    const put = (kind, extra) => appendFileSync(J, JSON.stringify(
      { kind, source: "browser", row: "U1", path_: "실패", run_id: "smoke-L", ...extra }) + "\n");
    put("frame", { path: "/tmp/x.png" });
    put("assertion", { id: "rX", expected: "비활성", got: "활성", pass: false });
    const no = (c) => !call("row", { action: "close", ...R, row: "U1", path: "실패", color: c, note: "봄" }).ok;
    const yes = call("row", { action: "close", ...R, row: "U1", path: "실패", color: "red", note: "완료가 눌림" }).ok;
    return ["yellow", "orange", "gray", "blue", "green"].every(no) && yes;
  });
  // 일치하지 않는 판정이 없으면 색은 사람이 고른다. 성립했지만 쓰기 어려운 것은 미충족이 아니다.
  check("판정이 다 맞으면 오렌지로 닫을 수 있다", () => {
    const J = path.join(artifactDir("qa", dir), "smoke-L", "journal.jsonl");
    call("row", { action: "declare", ...R, row: { ...ROW, id: "U2", given: "다른 조건" } });
    call("row", { action: "open", ...R, row: "U2", path: "정상" });
    const put = (kind, extra) => appendFileSync(J, JSON.stringify(
      { kind, source: "browser", row: "U2", path_: "정상", run_id: "smoke-L", ...extra }) + "\n");
    put("frame", { path: "/tmp/x.png" });
    put("assertion", { id: "rY", expected: "보임", got: "보임", pass: true });
    return call("row", { action: "close", ...R, row: "U2", path: "정상", color: "orange",
      note: "되긴 되는데 한 박자 늦음" }).ok;
  });
  check("완료는 작성자가 선언하지 않는다 — 원장이 닫혀야 회차가 닫힌다", () =>
    !call("run", { action: "end", ...R }).ok
    && /안 밟은 경로/.test(String(call("run", { action: "end", ...R }).error)));
  // 앱이 재시작되면 이 프로세스의 프레임 번호는 1로 돌아가는데 회차 폴더에는 앞서 찍은 장면이
  // 그대로 있다. 번호를 메모리에서만 이어가면 0001부터 덮어써서 장부가 가리키는 파일이 다른
  // 장면으로 바뀌고, 보고서는 그 장면을 그 줄의 증거로 싣는다.
  // 확인 결과: 한 회차에서 16장이 그렇게 바뀌었다.
  await checkAsync("회차 장면 번호는 기억이 아니라 폴더에서 이어받는다", async () => {
    const { recordFrame } = await import(path.join(ROOT, "server/qa-journal.js"));
    const rdir = mkdtempSync(path.join(tmpdir(), "ac-recseq-"));
    try {
      const shoot = async (a) => {
        writeFileSync(a.path, Buffer.from([1]));
        return { ok: true, data: { path: a.path, url: "about:blank", title: "t", dpr: 1 } };
      };
      const first = { runId: "rec", dir: rdir, seq: 0, receipts: 0, calls: 0 };
      for (let i = 0; i < 3; i++) await recordFrame(first, "tab", "after", shoot);
      if (readdirSync(path.join(rdir, "rec")).length !== 3) throw new Error("첫 구간에서 세 장이 남지 않았다");
      // 재시작: 같은 폴더, 초기화된 메모리
      const resumed = { runId: "rec", dir: rdir, seq: 99, receipts: 0, calls: 0 };
      for (let i = 0; i < 2; i++) await recordFrame(resumed, "tab", "after", shoot);
      const after = readdirSync(path.join(rdir, "rec")).sort();
      if (after.length !== 5 || after[4] !== "0005.png") throw new Error("재시작 뒤 번호가 이어지지 않았다");
      if (after.slice(0, 3).join() !== "0001.png,0002.png,0003.png") throw new Error("앞 장면이 덮였다");
      return true;
    } finally {
      rmSync(rdir, { recursive: true, force: true });
    }
  });
  // 고칠 코드가 없는 발견은 결함 목록에 섞지 않는다. 정할 것이 없으면 노트가 아니라 감상이다.
  check("설계 노트는 무엇을 정해야 하는지 없이는 안 남는다", () =>
    !call("row", { action: "note", ...R, note: { what: "명세가 모순" } }).ok
    && call("row", { action: "note", ...R, note: { what: "명세가 모순", decide: "어느 쪽이 맞는지",
      simple: true } }).ok);

  // 결정하는 사람은 이 화면을 보지 않았고 코드도 읽지 않는다. 글만 있는 결정 항목으로는
  // 판단할 수 없으므로, 근거와 선택지를 구조로 요구한다.
  check("결정 항목은 근거와 갈래 없이는 안 남는다", () => {
    const base = { what: "OCR 결과가 화면에 없음", decide: "OCR을 언제 붙일 것인가" };
    const bare = call("row", { action: "note", ...R, note: base });
    if (bare.ok) return false;                                  // 근거부터 막는다
    if (!/shot|source/.test(String(bare.error))) return false;  // 무엇을 하라는지 말한다
    const noPick = call("row", { action: "note", ...R,
      note: { ...base, source: "docs/two-flows.md:1" } });
    if (noPick.ok) return false;                                // 근거만으론 안 선다
    if (!/options/.test(String(noPick.error))) return false;
    const onePick = call("row", { action: "note", ...R,
      note: { ...base, source: "docs/two-flows.md:1",
        options: [{ pick: "그냥 붙임", then: "됨" }] } });
    if (onePick.ok) return false;                               // 갈래 하나는 갈래가 아니다
    const full = call("row", { action: "note", ...R,
      note: { ...base, source: "docs/two-flows.md:1", lean: "나를 권함",
        options: [{ pick: "지금 붙임", then: "이번 회차에서 검수가 확인됨", cost: "일정이 밀림" },
                  { pick: "다음으로 미룸", then: "일정이 삶", cost: "검수는 다음까지 미확인" }] } });
    if (!full.ok) return false;
    const n = full.data && full.data.note;
    return n && n.options && n.options.length === 2 && n.options[0].cost && n.lean
      && n.quote && /iris|Iris|#/.test(String(n.quote));        // source로 준 원문이 떠 왔다
  });

  // 앱 표면은 서버 명령을 거치지 않고 journal 에 직접 적는다. 표식을 브라우저 경로에만 두면
  // 앱으로만 확인한 줄은 증거 0 으로 남아 green 으로 닫히지 않는다. 실제로 세 줄이 그 상태로
  // 멈췄고, 당시 회귀 검사는 브라우저 경로만 덮고 있었다.
  check("앱으로만 밟은 줄도 green으로 닫힌다", () => {
    const RA = { runId: "ra-" + Date.now() };
    if (!call("run", { action: "begin", ...RA, kind: "proof", surfaces: ["app"],
      rows: [{ id: "A1", what: "온보딩 건너뛰기가 보임", given: "앱 첫 실행", basis: "spec",
        basisNote: "정본 12행", paths: ["정상"] }] }).ok) return false;
    if (!call("row", { action: "open", ...RA, row: "A1", path: "정상" }).ok) return false;
    const shotFile = path.join(dir, "appshot.png");
    writeFileSync(shotFile, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"));
    const art = call("journal", { ...RA,
      event: { kind: "artifact", source: "app", shot: shotFile, caption: "온보딩" } });
    const asr = call("journal", { ...RA,
      event: { kind: "assertion", source: "app", expected: "건너뛰기 있음", got: "건너뛰기",
        pass: true, shot: shotFile } });
    if (!art.ok || !asr.ok) return false;
    // 장부에 어느 줄의 것인지 기록되는지 확인한다. 이 값이 없으면 tallyFor 가 계산하지 못한다.
    const lines = readFileSync(path.join(artifactDir("qa", dir), RA.runId, "journal.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const stamped = lines.filter((e) => e.source === "app" && e.row === "A1");
    if (stamped.length !== 2) return false;
    const done = call("row", { action: "close", ...RA, row: "A1", path: "정상", color: "green",
      note: "앱 첫 화면에 건너뛰기가 섬." });
    return done.ok;
  });

  // 규칙으로 적어 두면 다음 회차의 글은 또 서술형으로 온다. 문장 끝을 서버가 본다.
  check("보고서 문장은 명사형으로만 들어간다", () => {
    const src = read("server/qa-journal.js");
    const a0 = src.indexOf("const NARRATIVE_TAIL");
    if (a0 < 0) return false;
    const a2 = src.indexOf("\nfunction nominalFault", a0);
    const f = new Function(src.slice(a0, a2) + "\n return narrativeSentences;")();
    const cases = [
      ["버튼이 안 눌렸다.", true],                         // 서술형은 잡는다
      ["사유가 비어 있음.", false],                        // 명사형은 통과
      ["이 상태로 확인했다고 볼 것인가?", false],           // 묻는 문장은 뺀다
      ["이 화면이 맞나요?", false],                        // 요로 끝나는 물음도 뺀다
      ["이 화면이 맞나요", true],                          // 물음표가 없으면 서술형이다
      ['화면 문구는 "저장되었습니다."', true],              // 인용부호 뒤도 본다
      ["버전 1.0.24 기준임.", false],                      // 숫자 마침표는 문장 끝이 아니다
      ["첫 줄은 됨\n둘째 줄은 안 된다.", true],            // 여러 줄도 다 본다
      ["", false],
    ];
    return cases.every(([t, want]) => (f(t).length > 0) === want);
  });

  check("서술형 판정문은 줄을 닫지 못한다", () => {
    const RN = { runId: "rn-" + Date.now() };
    if (!call("run", { action: "begin", ...RN, kind: "proof", surfaces: ["web:t"],
      rows: [{ id: "N1", what: "무엇", given: "어디", basis: "code", basisNote: "여기",
        paths: ["정상"] }] }).ok) return false;
    if (!call("row", { action: "open", ...RN, row: "N1", path: "정상" }).ok) return false;
    const bad = call("row", { action: "close", ...RN, row: "N1", path: "정상", color: "blue",
      note: "만료된 초안이 데이터에 없어서 이 경로를 확인하지 못했다.",
      options: [{ pick: "심는다", then: "닫힌다" }, { pick: "미룬다", then: "남는다" }] });
    if (bad.ok) return false;
    if (!/명사형/.test(String(bad.error))) return false;      // 무엇을 하라는지 말한다
    const badPick = call("row", { action: "close", ...RN, row: "N1", path: "정상", color: "blue",
      note: "만료된 초안이 데이터에 없어 이 경로를 확인 못 함.",
      options: [{ pick: "하나 심음", then: "이 요구가 닫힌다." },   // 갈래도 본다
                { pick: "미룸", then: "다음으로 남음." }] });
    if (badPick.ok) return false;
    const done = call("row", { action: "close", ...RN, row: "N1", path: "정상", color: "blue",
      note: "만료된 초안이 데이터에 없어 이 경로를 확인 못 함.",
      options: [{ pick: "하나 심음", then: "이 요구가 이번 회차에 닫힘." },
                { pick: "미룸", then: "다음 회차로 남음." }] });
    return done.ok;
  });

  // blue는 "사용자가 정해야 함"이고 노트와 같은 결정 항목이므로 같은 요구를 받는다.
  // 판정문만 실으면 읽는 사람은 무엇을 정해야 하는지 알 수 없다.
  check("정해야 할 것으로 닫는 줄도 갈래가 있어야 한다", () => {
    const RB = { runId: "rb-" + Date.now() };
    const begun = call("run", { action: "begin", ...RB, kind: "proof", surfaces: ["web:t"],
      rows: [{ id: "B1", what: "만료된 초안이 없음", given: "매물 목록", basis: "plan",
        basisNote: "기획서 3장", paths: ["정상"] }] });
    if (!begun.ok) return false;
    if (!call("row", { action: "open", ...RB, row: "B1", path: "정상" }).ok) return false;
    const bare = call("row", { action: "close", ...RB, row: "B1", path: "정상", color: "blue",
      note: "만료된 초안이 데이터에 없어 이 경로를 확인 못 함." });
    if (bare.ok) return false;                                   // 갈래 없이는 안 닫힌다
    if (!/options/.test(String(bare.error))) return false;       // 무엇을 주면 되는지 말한다
    const green = call("row", { action: "close", ...RB, row: "B1", path: "정상", color: "green",
      note: "초록은 결정이 아니므로 갈래를 안 물어야 함." });
    if (green.ok) return false;                                  // 증거가 없어 막히는 것이 정상
    if (/options/.test(String(green.error))) return false;       // 다만 갈래 때문은 아니다
    const done = call("row", { action: "close", ...RB, row: "B1", path: "정상", color: "blue",
      lean: "가를 권함",
      options: [{ pick: "만료된 초안을 하나 심음", then: "이 경로가 확인됨", cost: "시드 손봐야 함" },
                { pick: "이 요구를 뺌", then: "회차가 짧아짐", cost: "실제 동작은 계속 미확인" }],
      note: "만료된 초안이 데이터에 없어 이 경로를 확인 못 함." });
    if (!done.ok) return false;
    const w = done.data && done.data.row && done.data.row.walked && done.data.row.walked["정상"];
    return w && w.options && w.options.length === 2 && w.lean;
  });

  // 간단한 결정까지 선택지를 요구하면 형식만 채운 선택지가 생긴다. 생략하되 생략한 사실은 남긴다.
  check("간단한 결정은 빠지되 그 사실이 남는다", () => {
    const r = call("row", { action: "note", ...R,
      note: { what: "라벨 글자가 기획서와 다름", decide: "어느 글자로 갈 것인가", simple: true } });
    return r.ok && r.data && r.data.note && r.data.note.simple === true;
  });

  // ── 아래 넷은 실제 회차에서 발견된 항목이다. 장부를 직접 쓰지 않고 서버가
  //    기록하는 경로(noteRunAccepted → noteRunEvent)로 남긴다. 직접 쓰면 표시가
  //    실제로 붙는지를 이 검사가 확인하지 못한다.
  const mod = await import(path.join(ROOT, "server/qa-journal.js"));
  const shotFile = path.join(dir, "ev.png");
  writeFileSync(shotFile, "x");
  const judge = (rid, pass) => {
    const cid = mod.noteRunAccepted("expect", { sel: "#a" }, S, rid);
    mod.noteRunEvent(cid, "expect", { sel: "#a" }, S,
      { ok: true, data: { expected: "e", got: "g", pass, found: true, shot: shotFile } }, 1, rid);
  };

  // 계획은 같은 조건의 줄을 함께 확인하도록 한다. 열린 슬롯이 하나뿐이면 마지막에 연 줄만
  // 증거를 받고 나머지는 증거 없음으로 거부된다. 확인 결과 세 줄을 함께 열었을 때 그랬다.
  check("조건이 같은 줄을 함께 열면 한 판정이 둘의 증거가 된다", () => {
    const M = { runId: "smoke-lane" };
    const two = [{ id: "A", what: "가", given: "같은 조건", basis: "spec", paths: ["정상"] },
      { id: "B", what: "나", given: "같은 조건", basis: "code", paths: ["정상"] }];
    if (!call("run", { action: "begin", ...M, kind: "proof", rows: two }).ok) return false;
    call("row", { action: "open", ...M, row: "A", path: "정상" });
    call("row", { action: "open", ...M, row: "B", path: "정상" });
    judge("smoke-lane", true);
    return call("row", { action: "close", ...M, row: "A", path: "정상", color: "green", note: "됨" }).ok
      && call("row", { action: "close", ...M, row: "B", path: "정상", color: "green", note: "됨" }).ok;
  });

  // 판정도 그 순간의 화면을 찍는다. 이를 집계하지 않으면 조작 없이 확인되는 요구는 불필요한
  // 조작을 하나 끼워야 닫힌다. 확인 결과 상세 화면 한 줄을 닫으려고 스크롤을 넣은 사례가 있다.
  check("판정이 남긴 화면도 증거로 센다", () => {
    const M = { runId: "smoke-shotonly" };
    if (!call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "C", what: "무엇", given: "조건", basis: "spec", paths: ["경계"] }] }).ok) return false;
    call("row", { action: "open", ...M, row: "C", path: "경계" });
    judge("smoke-shotonly", true);
    return call("row", { action: "close", ...M, row: "C", path: "경계", color: "green", note: "됨" }).ok;
  });

  // 인용을 직접 옮겨 적는 경로가 있으면 언젠가 원문과 일치하지 않는다. 실제로 "안 뜬다"가
  // "안 뜼다"로 바뀌고 다음 줄이 뒤섞인 채 장부에 기록됐다. 위치만 지정하면 원문은
  // 파일에서 읽어 온다.
  check("어디인지만 적으면 원문은 파일에서 떠 온다", () => {
    const f = path.join(dir, "quote-src.txt");
    writeFileSync(f, ["첫 줄", "    검수 중에는 반려, 판매 중에는 중지다.", "    셀러 화면에는 반려 사유가 안 뜬다.", "끝 줄"].join("\n"));
    const M = { runId: "smoke-quote" };
    if (!call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "Q", what: "사", given: "조건", basis: "code", paths: ["정상"],
        source: `${f}:2-3` }] }).ok) return false;
    const ev = readFileSync(path.join(artifactDir("qa", dir), "smoke-quote", "journal.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .find((e) => e.kind === "row" && e.act === "declare");
    // 들여쓰기만 걷고 글자는 그대로. 옮겨 적었으면 여기서 갈린다.
    if (!ev || ev.quote !== "검수 중에는 반려, 판매 중에는 중지다.\n셀러 화면에는 반려 사유가 안 뜬다.") return false;
    // 읽지 못하면 넘어가지 않고 실패한다. 직접 채우면 이 장치가 없는 것과 같다.
    const gone = call("row", { action: "declare", ...M,
      row: { id: "Q2", what: "오", given: "조건", basis: "code", paths: ["정상"],
        source: `${f}:900-901` } });
    return !gone.ok && /900-901|행까지/.test(String(gone.error));
  });

  // 대부분의 회차는 MCP로만 도구를 부르므로, 서버에 동작을 더하고 MCP 표면에 올리지 않으면
  // 없는 기능과 같다. 실제로 basis·void·aside가 서버에만 있어 그것을 쓰려던 회차가
  // "action은 … 중 하나입니다"로 거부당했다. 서버가 받는 동작과 MCP가 내주는 동작을
  // 대조한다.
  check("서버가 받는 원장 동작은 MCP 표면에도 다 있다", () => {
    const server = read("server/qa-journal.js");
    const m = /action은 ([^"]+?) 중 하나입니다/.exec(server);
    if (!m) return false;
    const wanted = m[1].split("·").map((x) => x.trim()).filter(Boolean);
    const enumLine = /enum: \[([^\]]*)\][^}]*?description: "declare=/.exec(mcp);
    if (!enumLine) return false;
    const have = enumLine[1].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    return wanted.every((w) => have.includes(w)) && wanted.length === have.length;
  });
  // 줄에 근거 원문을 실을 수 있어도 MCP가 그 칸을 안 내주면 보고서는 영영 원문 없이 나간다.
  check("근거 원문과 따라 도는 목록도 MCP가 내준다", () =>
    /quote: \{ type: "string"/.test(mcp) && /sourceShot: \{ type: "string"/.test(mcp)
    && /covers: \{ type: "array"/.test(mcp)
    // 목록은 여럿이다. 앞 회차의 지적과 코드에서 찾은 발생 위치를 한 회차가 함께 든다.
    && /list: \{ type: "array"/.test(mcp) && /from: \{ type: "object"/.test(mcp)
    && /pick: \{ type: "string"/.test(mcp)
    && /receipt: \{ type: "string", description: "void:/.test(mcp)
    && /frames: \{ type: "array", items: \{ type: "string" \}, description: "aside:/.test(mcp)
    // 스키마만 있고 전달자가 없으면 값이 서버까지 안 간다.
    && /action: "basis", runId/.test(mcp) && /action: "void", runId/.test(mcp)
    && /action: "aside", runId/.test(mcp) && /\{ list: a\.list \}/.test(mcp)
    // 목록이 도중에 들어오면 이미 세운 줄에 나중에 이어야 한다.
    && /"covers", "open"/.test(mcp) && /action: "covers", runId/.test(mcp)
    && /row: a\.row, covers: a\.covers/.test(mcp));

  // 색만 남은 판정은 발견이 아니다. 보고서를 읽는 사람이 보는 것은 "무엇을 보았는가" 한
  // 문장이고, 그 문장이 빠지면 화면에 색만 남는다. 실제로 아홉 줄이 그렇게 닫혔다.
  // 부르는 쪽이 said로 보냈지만 서버가 note만 받아 버린 것이 원인이므로 두 이름을 모두 받는다.
  check("무엇을 보았는지 없이는 줄이 안 닫히고, 이름은 둘 다 받는다", () => {
    const M = { runId: "smoke-said" };
    if (!call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "F", what: "바", given: "조건", basis: "spec", paths: ["정상", "경계"] }] }).ok) return false;
    call("row", { action: "open", ...M, row: "F", path: "정상" });
    judge("smoke-said", true);
    const bare = call("row", { action: "close", ...M, row: "F", path: "정상", color: "green" });
    const withSaid = call("row", { action: "close", ...M, row: "F", path: "정상", color: "green", said: "됨" });
    call("row", { action: "open", ...M, row: "F", path: "경계" });
    const blueBare = call("row", { action: "close", ...M, row: "F", path: "경계", color: "blue" });
    // 증거가 면제되는 색도 문장은 면제되지 않는다. 확인하지 못한 이유가 그 문장이다.
    return !bare.ok && /한 문장/.test(String(bare.error)) && withSaid.ok && !blueBare.ok;
  });

  // 설명을 달아 직접 찍은 장면이 그 줄의 가장 좋은 증거인데, 표식이 붙지 않아 보고서에서 줄
  // 밖으로 빠졌다. 확인 결과 찍은 장면이 있는데도 "장면이 없다"로 기록됐다.
  check("설명을 달아 찍은 장면도 그 줄의 것으로 남는다", () => {
    const M = { runId: "smoke-artifact" };
    if (!call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "E", what: "마", given: "조건", basis: "spec", paths: ["정상"] }] }).ok) return false;
    call("row", { action: "open", ...M, row: "E", path: "정상" });
    const cid = mod.noteRunAccepted("screenshot", { caption: "여기가 비어 있다" }, S, "smoke-artifact");
    mod.noteRunEvent(cid, "screenshot", { caption: "여기가 비어 있다" }, S,
      { ok: true, data: { path: shotFile } }, 1, "smoke-artifact");
    const art = readFileSync(path.join(artifactDir("qa", dir), "smoke-artifact", "journal.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.kind === "artifact").pop();
    if (!art || art.row !== "E" || art.path_ !== "정상") return false;
    // 판정 없이 장면만으로는 줄을 닫지 못하지만, 장면은 증거로 집계된다.
    judge("smoke-artifact", true);
    return call("row", { action: "close", ...M, row: "E", path: "정상", color: "green", note: "됨" }).ok;
  });

  // 실패한 판정과 잘못 적은 요구는 다르다. 없어야 할 것을 있는지 묻는 형태로 적으면
  // 통과가 곧 결함이 되고, 하드 근거 줄은 그 한 건으로 red에 고정된다. 지우지 않고
  // 무효 표시만 하되, 사유가 없으면 받지 않는다.
  check("잘못 물은 판정은 사유를 적어야 무효가 된다", () => {
    const M = { runId: "smoke-void" };
    if (!call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "D", what: "라", given: "조건", basis: "spec", paths: ["경계"] }] }).ok) return false;
    call("row", { action: "open", ...M, row: "D", path: "경계" });
    judge("smoke-void", false);
    judge("smoke-void", true);
    const forced = call("row", { action: "close", ...M, row: "D", path: "경계", color: "green", note: "됨" });
    const noWhy = call("row", { action: "void", ...M, receipt: "r1" });
    const absent = call("row", { action: "void", ...M, receipt: "없음", why: "x" });
    const voided = call("row", { action: "void", ...M, receipt: "r1", why: "없어야 할 것을 있는지 물었다" });
    return !forced.ok && /red/.test(String(forced.error))
      && !noWhy.ok && !absent.ok && voided.ok
      && call("row", { action: "close", ...M, row: "D", path: "경계", color: "green", note: "됨" }).ok;
  });

  // 회차 상태가 메모리에만 있으면 장부에 기록이 남아 있어도 앱 재시작 한 번에 원장이 사라진다.
  // 확인 결과 여덟 줄이 그렇게 사라져 이어 열 수 없었다.
  check("되살릴 회차를 하나 남긴다", () => {
    const M = { runId: "smoke-rehydrate" };
    call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "E", what: "마", given: "조건", basis: "spec", paths: ["정상", "실패"] }] });
    call("row", { action: "open", ...M, row: "E", path: "정상" });
    judge("smoke-rehydrate", true);
    call("row", { action: "close", ...M, row: "E", path: "정상", color: "green", note: "됨" });
    return true;
  });
  // 위 검사는 같은 프로세스라 메모리가 남아 있다. 재시작을 재현하려면 모듈을 새로 로드해야 한다.
  // 그러지 않으면 복원 기능을 전부 지워도 검사가 통과한다(확인 결과).
  await checkAsync("재시작해도 장부에서 줄이 되살아난다", async () => {
    const fresh = await import(path.join(ROOT, "server/qa-journal.js") + "?restart=" + process.pid);
    const M = { runId: "smoke-rehydrate" };
    const again = fresh.handleQaSessionCmd("run", { action: "begin", ...M, kind: "proof" }, "새세션", M.runId);
    const listed = fresh.handleQaSessionCmd("row", { action: "list", ...M }, "새세션", M.runId);
    const row = ((listed.data || {}).rows || []).find((x) => x.id === "E");
    if (!again.ok) throw new Error("rows 없이 이어 열리지 않았다: " + again.error);
    if (!row) throw new Error("장부의 줄이 되살아나지 않았다");
    if (!(row.walked || {})["정상"] || row.walked["정상"].color !== "green") throw new Error("닫힌 경로가 안 살아났다");
    return true;
  });


  // ── 목록의 완전성 ───────────────────────────────────────────────
  // 원장은 "확인하기로 한 것 − 확인한 것"만 계산한다. 그래서 한 차원이 통째로 빠진 목록도
  // 빈 항목 없이 닫힌다. 알림은 코드에 발생 위치가 여섯인데 회차가 승인 하나로 닫혔고
  // 원장은 이를 알리지 않았다.
  check("목록 항목은 손으로 적지 않고 파일에서 떠 온다", () => {
    const src = path.join(dir, "notifier.ts");
    writeFileSync(src, ["class N {",
      "  async listingApproved(x) {}",
      "  async listingRejected(x) {}",
      "  async tradeEscrowed(x) {}",
      "  async tradeCancelled(x) {}",
      "  async disputeOpened(x) {}",
      "  async tradeSettled(x) {}",
      "}"].join("\n"));
    const M = { runId: "smoke-set-from" };
    const r = call("run", { action: "begin", ...M, kind: "review",
      list: [{ name: "알림 발생 자리", from: { source: src, pick: "async (\\w+)\\(" } }] });
    const set = (r.data || {}).목록 || [];
    return r.ok && set.length === 1 && set[0].total === 6
      && set[0].missing.join(",") === "listingApproved,listingRejected,tradeEscrowed,tradeCancelled,disputeOpened,tradeSettled";
  });
  // 0개짜리 목록은 완전한 목록과 구별되지 않는다. 필터가 전부 걸러내고도 통과가 되는
  // 경우라 남은 수를 먼저 계산한다.
  check("아무것도 못 찾은 규칙은 목록을 못 만든다", () => {
    const src = path.join(dir, "notifier.ts");
    const r = call("run", { action: "begin", runId: "smoke-set-empty", kind: "review",
      list: [{ name: "빈 목록", from: { source: src, pick: "이런건없다(\\w+)" } }] });
    const r2 = call("run", { action: "begin", runId: "smoke-set-nofile", kind: "review",
      list: [{ name: "없는 파일", from: { source: path.join(dir, "없음.ts"), pick: "(\\w+)" } }] });
    return !r.ok && /아무것도 못 찾았습니다/.test(r.error) && !r2.ok && /읽지 못했습니다/.test(r2.error);
  });
  // 한 곳을 덮으면 다 덮었다고 판단해 나머지를 보지 않는다. 그래서 집계 시점을 종료 시점이
  // 아니라 줄을 만드는 매 시점에 둔다.
  check("줄을 세울 때마다 안 본 자리가 돌아온다", () => {
    const M = { runId: "smoke-set-from" };
    const r = call("row", { action: "declare", ...M, row: { id: "N-2",
      what: "승인하면 알림 1건", given: "판매검수중 매물", basis: "spec",
      paths: ["정상"], covers: ["listingApproved"] } });
    return r.ok && /알림 발생 자리 — 6가지 중 1가지를 봄/.test(r.data.note || "")
      && /안 본 것: listingRejected · tradeEscrowed/.test(r.data.note || "");
  });
  // 이 수정의 핵심이다. 한 곳만 확인하고 그 동작 전체를 확인했다고 적을 수 없다.
  check("목록에 안 본 항목이 남으면 회차가 안 닫힌다", () => {
    const M = { runId: "smoke-set-from" };
    call("row", { action: "open", ...M, row: "N-2", path: "정상" });
    judge("smoke-set-from", true);
    call("row", { action: "close", ...M, row: "N-2", path: "정상", color: "green", note: "알림 1건 쌓임" });
    const gaps = ((call("row", { action: "list", ...M }).data) || {}).gaps || [];
    const end = call("run", { action: "end", ...M });
    return !end.ok && /안 본 항목 5가지/.test(end.error)
      && gaps.some((g) => /알림 발생 자리/.test(g) && /listingRejected/.test(g));
  });
  // 생성하는 코드가 있는 것과 그 코드가 실행되는 것은 다른 사실이다. 목록을 한 파일에서만
  // 뜨면 그 파일이 정확하다는 전제가 생기고, 호출되지 않는 코드는 목록에 등록돼도 실행되지
  // 않는다. 그 줄이 무엇을 확인하는 화면인지는 판정이 정한다.
  //
  // 레인 표식은 시간 기준이라 줄이 열린 동안의 기록이 전부 그 줄에 귀속된다. 확인 도중 세션이
  // 끊기면 재로그인 화면이 무관한 줄에 기록된다. 확인 결과 증거 300장 중 67장이
  // 로그인이었고, 대시보드 숫자를 보는 줄은 32장 중 16장이 로그인이었다.
  //
  // 범위 밖 항목을 목록으로 받으면 위치마다 새 문자열이 필요해 받지 않는다.
  // 판정을 내린 위치가 그 줄의 화면이고, 이미 기록된 사실이다.
  check("판정에는 그것을 내린 자리가 함께 적힌다", () => {
    const inspect = read("native/electron/cdp-cmd-inspect.cjs");
    return /url: wc\.getURL\(\)/.test(inspect) && /url: d\.url \|\| undefined,/.test(qaJournal);
  });
  // 무효 처리는 번호만 받고 확인 없이 지웠다. 부르는 쪽은 번호를 기억에 의존해 지정하므로
  // 대상이 일치하지 않을 수 있다. 확인 결과 다른 줄의 관찰을 근거로 무관한 줄의 통과 판정을
  // 무효화했고 사유 칸에도 그 다른 줄 내용이 적혔다. 도구는 그때 올바른 값을 갖고 있었다.
  await checkAsync("무효는 무엇을 죽였는지 말하고, 사유가 다른 줄을 가리키면 짚는다", async () => {
    const mod = await import(path.join(ROOT, "server/qa-journal.js"));
    const M = { runId: "smoke-void-say" };
    call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "R-36", what: "승인하면 판매 중", given: "검수중", basis: "spec", paths: ["정상"] },
        { id: "R-39", what: "중지하면 정지", given: "판매 중", basis: "spec", paths: ["정상"] }] });
    const st = mod.runFor("smoke-ledger", M.runId);
    call("row", { action: "open", ...M, row: "R-36", path: "정상" });
    const J = path.join(artifactDir("qa", dir), M.runId, "journal.jsonl");
    appendFileSync(J, JSON.stringify({ kind: "assertion", source: "browser", id: "r30",
      row: "R-36", path_: "정상", expected: "판매 중", got: "판매 중", pass: true,
      run_id: M.runId, seq: 900, t: Date.now() }) + "\n");
    void st;
    const r = call("row", { action: "void", ...M, receipt: "r30",
      why: "R-39 반려 사유 라디오 5종을 못 본 채 판정했다" });
    if (!r.ok) throw new Error("무효가 안 됐다: " + r.error);
    const d = r.data || {};
    if (d.무효로만든것 !== "R-36 · 정상") throw new Error("무엇을 죽였는지 안 말했다: " + JSON.stringify(d));
    if (!/r30는 R-36 · 정상의 판정입니다/.test(d.note || "")) throw new Error("줄 이름을 안 실었다: " + d.note);
    if (!/통과였음/.test(d.note || "")) throw new Error("통과였다는 사실을 안 실었다");
    if (!/사유가 다른 줄을 가리킵니다: R-39/.test(d.note || ""))
      throw new Error("사유가 다른 줄을 가리키는 것을 안 짚었다: " + d.note);
    // 통과를 지우는 것과 실패를 지우는 것은 의미가 다르다. 통과 무효는 증거와 방향이 같아
    // 대상을 잘못 지정해도 드러나지 않는다(확인 결과: 무효 여섯 건 중 통과를 지운 하나가 오류였다).
    if (!/이 줄의 증거가 하나 줄어듭니다/.test(d.note || ""))
      throw new Error("통과를 지우는 뜻을 안 말했다: " + d.note);
    // 사유가 그 줄의 내용이면 경고를 붙이지 않는다. 판단이 분명한 경우만 지적한다.
    appendFileSync(J, JSON.stringify({ kind: "assertion", source: "browser", id: "r31",
      row: "R-36", path_: "정상", expected: "판매 중", got: "판매 중", pass: true,
      run_id: M.runId, seq: 901, t: Date.now() }) + "\n");
    const r2 = call("row", { action: "void", ...M, receipt: "r31", why: "선택자가 두 곳에 걸렸다" });
    if (/다른 줄을 가리킵니다/.test((r2.data || {}).note || "")) throw new Error("멀쩡한 사유를 짚었다");
    // 실패를 지우는 경우에는 경고를 붙이지 않는다. 모든 무효에 붙이면 구분이 사라진다.
    appendFileSync(J, JSON.stringify({ kind: "assertion", source: "browser", id: "r32",
      row: "R-39", path_: "정상", expected: "정지", got: "판매 중", pass: false,
      run_id: M.runId, seq: 902, t: Date.now() }) + "\n");
    const r3 = call("row", { action: "void", ...M, receipt: "r32", why: "갱신 전에 물었다" });
    if (/증거가 하나 줄어듭니다/.test((r3.data || {}).note || ""))
      throw new Error("실패 무효에도 통과 문구를 붙였다");
    if ((r3.data || {}).통과였나 !== false) throw new Error("통과 여부를 안 돌려줬다");
    return true;
  });

  // 설명을 달아 직접 찍은 장면이 가장 좋은 증거인데 그것만 출처가 비어 있었다.
  // 자동 녹화분은 주소를 적고 직접 찍은 것은 적지 않았다(확인 결과: 63장 전부).
  check("일부러 찍은 장면에도 어디서 찍었는지가 남는다", () =>
    /kind: "artifact", call_id: callId \|\| undefined, source: "browser",\s*\n\s*\.\.\.laneStamp\(st\), path: kept, url: d\.url \|\| undefined/.test(qaJournal)
    // 도구는 이미 값을 돌려주고 있었고 기록만 누락됐다.
    && /return \{ ok: true, path: p, url: wc\.getURL\(\)/.test(read("native/electron/cdp-cmd-capture.cjs")));

  check("범위 밖 자리를 손으로 나열하는 손잡이가 없다", () =>
    !/detours/.test(mcp) && !/detour/.test(qaJournal)
    && !/keeps/.test(mcp) && !/keeps/.test(qaJournal));

  // 대조는 한 방향이다. 목록 항목은 덮여야 하지만 줄이 목록에 속할 필요는 없다.
  // 회차가 목록보다 넓어지는 것은 정상이고(발신기 밖에서 나온 발견), 양방향으로 막으면
  // 발견할 때마다 목록을 고쳐야 해서 탐색이 멈춘다.
  check("목록에 없는 줄은 회차를 안 막는다", () => {
    const src = path.join(dir, "notifier.ts");
    const M = { runId: "smoke-set-oneway" };
    call("run", { action: "begin", ...M, kind: "review",
      list: [{ name: "발신 자리", from: { source: src, pick: "async (listingApproved)\\(" } }] });
    call("row", { action: "declare", ...M, row: { id: "A1", what: "승인 알림", given: "검수중",
      basis: "spec", paths: ["정상"], covers: ["listingApproved"] } });
    // 목록에 없는 발견은 covers 없이 만들고 닫는다.
    call("row", { action: "declare", ...M, row: { id: "A2", what: "알림함 자동 갱신 안 됨",
      given: "알림 도착 직후", basis: "assumed", basisNote: "밟다가 발견", paths: ["정상"] } });
    for (const id of ["A1", "A2"]) {
      call("row", { action: "open", ...M, row: id, path: "정상" });
      judge(M.runId, true);
      call("row", { action: "close", ...M, row: id, path: "정상", color: "green", note: "확인" });
    }
    const end = call("run", { action: "end", ...M });
    return end.ok;
  });
  // 무엇을 고쳐야 할지 알 수 없는 거부는 강제가 아니라 중단이다. 여기서 막힌 사람은 흔히
  // 문장을 잘라 뜻을 지우므로, 해결 방법이 축약이 아니라 분해임을 거절문에서 알린다
  // (확인 결과: 결정 선택지 하나를 닫는 데 세 번 걸렸고 그 과정에서 뜻이 손실됐다).
  check("어투 거절문이 나가는 길을 그 자리에서 말한다", () => {
    const M = { runId: "smoke-tone-exit" };
    call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "T1", what: "가", given: "나", basis: "spec", paths: ["정상"] }] });
    const r = call("row", { action: "close", ...M, row: "T1", path: "정상", color: "gray",
      note: "구매자는 앱을 열어 직접 봐야 한다" });
    return !r.ok && /라벨체/.test(r.error)
      && /문장으로 되돌리지 말고 줄을 더 쌓습니다/.test(r.error)
      && /한 줄에 한 사실/.test(r.error);
  });
  check("부르는 자리가 없는 항목이 표시된다", () => {
    const proj = path.join(dir, "proj");
    mkdirSync(path.join(proj, "src"), { recursive: true });
    mkdirSync(path.join(proj, "node_modules"), { recursive: true });
    const src = path.join(proj, "src", "notifier.ts");
    writeFileSync(src, ["class N {",
      "  async listingApproved(x) {}",
      "  async listingRejected(x) {}",
      "  async tradeSettled(x) {}",
      "}"].join("\n"));
    writeFileSync(path.join(proj, "src", "caller.ts"), "n.listingApproved(1); n.tradeSettled(2);");
    // 검색하지 않는 폴더에만 있는 호출은 확인되지 않는다. 건너뛸 폴더가 실제로 제외되는지 본다.
    writeFileSync(path.join(proj, "node_modules", "x.ts"), "n.listingRejected(3);");
    const M = { runId: "smoke-set-used" };
    const r = call("run", { action: "begin", ...M, kind: "review",
      list: [{ name: "알림 발생 자리",
        from: { source: src, pick: "async (\\w+)\\(", usedIn: proj } }] });
    if (!r.ok) return false;
    // 장부가 원본이며 보고서도 이 값을 읽는다.
    const J = path.join(artifactDir("qa", dir), M.runId, "journal.jsonl");
    const ev = readFileSync(J, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x))
      .find((x) => x.kind === "list");
    const un = ev.items.filter((x) => x.unused).map((x) => x.id);
    return un.join(",") === "listingRejected"          // 불리는 것에는 안 붙는다
      // 검색한 파일은 caller.ts 하나다. 목록 원본을 제외하고 node_modules를 건너뛴 결과다.
      && ev.from.usedIn === proj && ev.from.scanned === 1;
  });
  // 목록이 회차 중간에 들어오기 때문에 이 장치가 필요하다. covers를 declare에서만 받으면
  // 그 전에 만든 줄은 목록에 연결되지 않고, 사람은 같은 줄을 다른 id로 다시 만들어
  // 보고서에 같은 확인이 두 번 등록된다.
  check("이미 만든 줄도 나중에 목록 항목에 이어진다", () => {
    const M = { runId: "smoke-set-from" };
    const before = call("row", { action: "declare", ...M, row: { id: "N-6",
      what: "반려하면 알림 1건", given: "판매검수중 매물", basis: "spec", paths: ["정상"] } });
    if (!before.ok) return false;
    const link = call("row", { action: "covers", ...M, row: "N-6", covers: ["listingRejected"] });
    // 덮어쓰지 않고 추가한다. 한 줄이 항목 둘을 확인할 수 있다.
    const more = call("row", { action: "covers", ...M, row: "N-6", covers: ["tradeSettled"] });
    // 목록에 없는 id를 가리키면 그 줄은 아무것도 안 덮은 채 덮었다고 적힌다.
    const bad = call("row", { action: "covers", ...M, row: "N-6", covers: ["없는것"] });
    const none = call("row", { action: "covers", ...M, row: "없는줄", covers: ["listingRejected"] });
    return link.ok && link.data.covers.join(",") === "listingRejected"
      && more.ok && more.data.covers.join(",") === "listingRejected,tradeSettled"
      && !bad.ok && /목록에 없는 항목/.test(bad.error) && !none.ok;
  });
  // 재시작 한 번으로 이어 놓은 것이 통째로 풀리면 다 본 회차가 아무것도 안 본 회차가 된다.
  await checkAsync("나중에 이은 것도 장부에서 되살아난다", async () => {
    const fresh = await import(path.join(ROOT, "server/qa-journal.js") + "?cov=" + process.pid);
    const M = { runId: "smoke-set-from" };
    fresh.handleQaSessionCmd("run", { action: "begin", ...M, kind: "review" }, "새세션2", M.runId);
    const listed = fresh.handleQaSessionCmd("row", { action: "list", ...M }, "새세션2", M.runId);
    const row = ((listed.data || {}).rows || []).find((x) => x.id === "N-6");
    if (!row) throw new Error("줄이 안 살아났다");
    if ((row.covers || []).join(",") !== "listingRejected,tradeSettled")
      throw new Error("나중에 이은 covers가 안 살아났다: " + JSON.stringify(row.covers));
    return true;
  });
  // from이 못 보여주는 것(설정 기본값·껐을 때)은 사람이 더한다. 더한 것도 같은 무게로 센다.
  check("코드에서 뜬 항목과 손으로 더한 항목이 한 목록에 선다", () => {
    const src = path.join(dir, "notifier.ts");
    const r = call("run", { action: "begin", runId: "smoke-set-mix", kind: "review",
      list: [{ name: "알림", from: { source: src, pick: "async (\\w+)\\(" },
        items: [{ id: "off", text: "알림을 끈 계정에는 안 쌓인다" }] }] });
    const set = ((r.data || {}).목록 || [])[0];
    return r.ok && set.total === 7 && set.missing.includes("off");
  });

  // 보고서를 받은 사람이 명세를 찾아 열어야 한다면 그 보고서는 혼자 서지 못한다.
  // 근거 이름만이 아니라 적힌 문장과 그 화면까지 회차가 들고 있어야 한다.
  check("근거는 이름만이 아니라 원문과 그 화면까지 받는다", () => {
    const M = { runId: "smoke-basis" };
    const png = path.join(dir, "spec.png");
    writeFileSync(png, "x");
    const begun = call("run", { action: "begin", ...M, kind: "proof", rows: [{
      id: "F", what: "만료일을 다시 검사한다", given: "승인 직전", basis: "spec",
      basisNote: "기획서 10.1", source: "design.md:339", quote: "승인 시 만료일을 서버에서 다시 검사한다.",
      sourceShot: png, covers: ["L1"], paths: ["정상"] }] });
    if (!begun.ok) return false;
    // 이름만 주면 받지 않는다. 이름만으로는 문서를 따로 열어야 한다.
    const bare = call("row", { action: "basis", ...M, row: "F", basis: { source: "x" } });
    const more = call("row", { action: "basis", ...M, row: "F",
      basis: { quote: "다른 문서에도 같은 말이 있다", source: "plan.md:12" } });
    const listed = call("row", { action: "list", ...M });
    const row = ((listed.data || {}).rows || []).find((x) => x.id === "F");
    // 뒤에 붙인 근거가 앞의 것을 지우면 두 문서를 근거로 든 줄이 하나만 남는다.
    // 메모리가 아니라 장부에서 복원되어야 한다. basisNote가 기록에서 빠져 재시작 후
    // 보고서에서 사라진 적이 있다. 기록되지 않은 값은 없는 값과 같다.
    const fromJournal = readFileSync(path.join(artifactDir("qa", dir), "smoke-basis", "journal.jsonl"), "utf8");
    return !bare.ok && more.ok && !!row
      && (row.quotes || []).length === 2 && row.basisNote === "기획서 10.1"
      && /"basisNote":"기획서 10\.1"/.test(fromJournal)
      && /"quote":"승인 시 만료일을 서버에서 다시 검사한다\."/.test(fromJournal);
  });

  // 2차 QA처럼 앞 회차의 지적을 받아 도는 회차는 그 목록이 맨 앞에 서야 문서 하나로 닫힌다.
  check("회차가 따른 목록을 들고 돈다", () => {
    const M = { runId: "smoke-list" };
    const empty = call("run", { action: "begin", ...M, kind: "proof",
      list: { name: "빈 목록", items: [] },
      rows: [{ id: "G", what: "가", given: "조건", basis: "spec", paths: ["정상"] }] });
    const good = call("run", { action: "begin", runId: "smoke-list2", kind: "proof",
      list: { name: "2차 수정 목록", source: "qa/지적.md",
        items: [{ id: "L1", text: "완료가 활성이다", was: "사유 안내가 없었다" }] },
      rows: [{ id: "H", what: "나", given: "조건", basis: "spec", covers: ["L1"], paths: ["정상"] }] });
    return !empty.ok && good.ok;
  });

  // 로그인 벽에 걸려 다시 들어간 구간이 열린 레인에 실려 "매물 관리"라면서 로그인 화면이
  // 증거로 선 적이 있다. 지우지 않고 곁가지로 떼어내되 사유를 받는다.
  check("그 줄의 화면이 아닌 장면은 사유와 함께 떼어낸다", () => {
    const M = { runId: "smoke-aside" };
    if (!call("run", { action: "begin", ...M, kind: "proof",
      rows: [{ id: "I", what: "다", given: "조건", basis: "code", paths: ["정상"] }] }).ok) return false;
    call("row", { action: "open", ...M, row: "I", path: "정상" });
    judge("smoke-aside", true);
    const J2 = path.join(artifactDir("qa", dir), "smoke-aside", "journal.jsonl");
    const stray = path.join(dir, "stray.png");
    writeFileSync(stray, "x");
    appendFileSync(J2, JSON.stringify({ run_id: "smoke-aside", kind: "frame", source: "browser",
      why: "after", path: stray, url: "http://x/login", row: "I", path_: "정상" }) + "\n");
    const noWhy = call("row", { action: "aside", ...M, row: "I", path: "정상", frames: [stray] });
    const absent = call("row", { action: "aside", ...M, row: "I", path: "정상",
      frames: [path.join(dir, "없는것.png")], why: "x" });
    const done = call("row", { action: "aside", ...M, row: "I", path: "정상", frames: [stray],
      why: "세션이 끊겨 다시 들어간 구간이다" });
    return !noWhy.ok && !absent.ok && done.ok;
  });

  rmSync(dir, { recursive: true, force: true });
})();

// 기록은 확인 과정의 부산물이어야 한다. 프레임을 사람이 직접 호출하면 기록 밀도가 사람에 따라
// 달라진다. 확인 결과 단계의 21%가 사진 없음이었고, 직전 프레임 9개 중 6개는 다른 조작의 직후 장면이었다.
check("조작은 스스로 직전·직후를 남긴다", () => {
  const cmds = sliceBetween(qaJournal, "const ACT_CMDS = new Set(", "export function isActCmd", "조작 명령 집합");
  return ["click", "fill", "key", "select", "goto", "bulkfill"].every((c) => cmds.includes(`"${c}"`))
    // 회차가 열려 있을 때만 찍는다. 회차 밖 단발 조작까지 찍으면 쓰지 않는 파일이 쌓인다.
    && /const recRun = isActCmd\(cmd\) \? runFor\(session, runId\) : null/.test(qaJournalEntry)
    && /recordFrame\(recRun, args && args\.tab, "before", shoot\)/.test(qaJournalEntry)
    && /recordFrame\(recRun, args && args\.tab, "after", shoot\)/.test(qaJournalEntry)
    // 촬영이 실패해도 조작 결과는 그대로 반환한다. 기록 실패가 이미 수행된 조작을 무효로 만들지 않는다.
    && /try \{ await recordFrame\(recRun, args && args\.tab, "after", shoot\); \} catch \{\}/.test(qaJournalEntry);
});
// 중복은 만든 뒤 제거하지 않고 찍는 시점에 판별한다. 디스크 사용량과 정리 부담이
// 그대로면 증거가 밀려난다.
check("직전과 같은 프레임은 파일을 안 만든다", () => {
  const cap = read("native/electron/cdp-cmd-capture.cjs");
  const tools = read("native/electron/cdp-capture-tools.cjs");
  return /if \(args\.sameAs && samePng\(String\(args\.sameAs\), png\)\)/.test(cap)
    && /return \{ ok: true, path: String\(args\.sameAs\), same: true/.test(cap)
    // 색 허용치는 diffPng와 같다. 퍼센트 임계값을 두지 않는다. 확인 결과 중복은 변경 픽셀 0,
    // 실제 변화의 최솟값은 34,693이었다.
    && /if \(d > 24\) return false;/.test(tools)
    && /if \(sa\.width !== sb\.width \|\| sa\.height !== sb\.height\) return false;/.test(tools)
    // 제외한 프레임도 기록에 남긴다. 보고서가 장수를 적는다.
    && /same_as: prev, same: true/.test(qaJournal);
});
// 녹화 프레임이 상태 폴더에 쌓이면 60장·7일 정리가 증거를 밀어낸다.
check("녹화 프레임은 회차 폴더로 간다", () =>
  /path\.join\(st\.dir, "rec"\)/.test(qaJournal)
  && /if \(!args\.path\) pruneShots\(dir\);/.test(read("native/electron/cdp-cmd-capture.cjs")));
// 중복 판정은 같은 탭 안에서만 유효하다. 서로 다른 탭의 프레임을 비교하는 것은 의미가 없다.
check("중복은 같은 탭의 직전 프레임과만 견준다", () =>
  /function lastFrame\(st, tab\)/.test(qaJournal)
  && qaJournal.includes('.get(String(tab || ""))'));
check("회차 여닫기가 도구로 노출된다", () =>
  /name: "browser_run"/.test(mcp)
  && /enum: \["begin", "end", "status"\]/.test(mcp)
  && /C\("run", \{ action: act, runId: a\.runId \|\| CURRENT_RUN \|\| undefined,/.test(mcp)
  && /surfaces: \{ type: "array"/.test(mcp)
  && /CURRENT_RUN = act === "end" \? null :/.test(mcp));



// ── 증거 사슬 누수 (전수 점검) ────────────────────────────────
// 아래는 모두 같은 유형이다. 도구는 값을 갖고 있는데 기록이 그 값을 옮기지 않았다. 기록되지 않은
// 값은 "그 사실이 없다"와 구별되지 않고, 나중에 그 필드로 집계하면 항상 0이 나온다.

// 조작인데 기록 목록에 없으면 전후 프레임만 남고 원인 명령이 남지 않아, 장부에 원인 없는
// 화면 변화가 생긴다. 목록 둘을 사람이 맞추는 구조였고 그런 구조는 언젠가 일치하지 않는다.
check("조작이면 기록된다 — 목록이 아니라 구조로", () =>
  /const runLogged = \(cmd\) =>[^;]*ACT_CMDS\.has\(cmd\)/.test(qaJournal));

// observe 의 원인, diff 의 변화량, dialog 의 문구, upload 의 파일 목록이 전부 버려지고 있었다.
check("도구가 돌려준 나머지를 장부가 받는다", () =>
  /function detailOf\(d\)/.test(qaJournal)
  && /detail: res && res\.ok \? detailOf\(d\) : undefined/.test(qaJournal)
  && /if \(out\.detail != null\) out\.detail = detailOf\(out\.detail\);/.test(qaJournal));

// 상세가 통째로 커지면 장부가 지나치게 무거워진다. 자르는 지점이 있어야 받는 것이 안전해진다.
check("받은 상세는 잘라서 담는다", () =>
  /const DETAIL_MAX = \d+;/.test(qaJournal)
  && /DETAIL_SKIP = new Set\(/.test(qaJournal)
  && /while \(JSON\.stringify\(o\)\.length > DETAIL_MAX/.test(qaJournal));

// 몇 곳이 맞았는지가 판정문 문자열 안에만 있으면 회차 전체에서 셀 수 없다.
check("판정이 몇 곳을 봤는지 수로 남는다", () =>
  /matched: d\.matched != null \? Number\(d\.matched\) : undefined/.test(qaJournal)
  && /matched: f\.hits\.length/.test(mcpApp));

// 한 호출이 장면을 여럿 돌려주는 shotsizes 는 저장 로직이 하나만 처리해 나머지가 누락됐다.
check("한 호출이 여럿 돌려준 장면도 회차로 굳는다", () =>
  /Array\.isArray\(d\.shots\) && d\.shots\.length/.test(qaJournal)
  && /const keptOne = persistArtifact\(st, one\.path\);/.test(qaJournal));

// 제거한 프레임에 줄이 안 박히면 "이 줄에서 몇 장이 안 변했나"를 셀 수 없다.
check("같아서 안 남긴 프레임에도 줄이 박힌다", () =>
  /same_as: prev, same: true, url: d\.url \|\| undefined, \.\.\.laneStamp\(st\)/.test(qaJournal));

// 앱 조작은 idb 를 직접 부르므로 서버의 자동 기록 경로를 지나지 않는다. 도구 넷이 장부에 0건이었다.
check("앱 조작도 장부에 남는다", () =>
  /const APP_ACT = new Set\(\["app_tap", "app_text", "app_key", "app_swipe"\]\)/.test(mcpApp)
  && /if \(!APP_ACT\.has\(t\.name\)\) continue;/.test(mcpApp)
  && /kind: "accepted", source: "app", cmd: t\.name\.slice\(4\)/.test(mcpApp)
  && /kind: "completed", source: "app", cmd: t\.name\.slice\(4\)/.test(mcpApp));

// 브라우저 증거에는 url 이 붙는데 앱 증거에는 아무것도 안 붙어, 그 줄의 주제를 정할 수 없었다.
check("앱 증거에도 어느 화면인지 붙는다", () =>
  /function appIdent\(udid, app\)/.test(mcpApp)
  && (String(mcpApp).match(/url: appIdent\(u, app\)/g) || []).length >= 3);

// 장부가 거절해도 그 사실이 기록되지 않았다. 드물게 발생하는 거절이 조용하면 발견되지 않는다.
check("장부가 거절하면 그 사실이 들린다", () =>
  /console\.error\(`\[iris\] 장부가 거절했다/.test(mcp));

// 잠깐 뜬 알림은 다시 찍을 수 없다. 문구뿐 아니라 측정값도 그때 함께 남긴다.
check("잠깐 뜬 알림의 실측값이 남는다", () =>
  /source: "moment", shot,/.test(mcp)
  && /떠있던초: m\.lived != null/.test(mcp)
  && /장부에 안 실렸다/.test(mcp));



  // 소스 모양 검사는 실제 효과를 확인하지 못한다. 위 검사가 모두 통과해도 장부에 무엇이
  // 적히는지는 확인되지 않는다. 실제로 회차를 열고 도구 반환을 흘려 장부에 남는 줄을 읽는다.
  await checkAsync("도구가 돌려준 것이 실제로 장부에 적힌다", async () => {
    const fdir = mkdtempSync(path.join(tmpdir(), "ac-leak-"));
    const prev = process.env.IRIS_STATE_DIR;
    process.env.IRIS_STATE_DIR = fdir;
    try {
      const q = await import(path.join(ROOT, "server/qa-journal.js") + "?leak=" + Date.now());
      const S2 = "누수확인", RID = "leak-run";
      const c2 = (cmd, a) => q.handleQaSessionCmd(cmd, a, S2, RID);
      c2("run", { action: "begin", runId: RID, kind: "review" });
      const st2 = q.runFor(S2, RID);
      const J2 = path.join(st2.dir, "journal.jsonl");
      const rd = () => readFileSync(J2, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const fire = (cmd, args, data) =>
        q.noteRunEvent(q.noteRunAccepted(cmd, args, S2, RID), cmd, args, S2, { ok: true, data }, 1, RID);

      // observe 의 원인: 실패 원인을 보려고 만든 도구인데 원인이 기록되지 않았다
      fire("observe", { sel: "#x" }, { url: "http://a/b", count: 3, reasons: ["3개가 맞는다"],
        snapshot: "긴 본문".repeat(500) });
      const ob = rd().filter((x) => x.cmd === "observe").pop();
      if (!ob || !ob.detail || ob.detail.count !== 3 || !ob.detail.reasons) return false;
      if (ob.detail.snapshot !== undefined) return false;      // 덩어리는 안 담는다

      // dialog 의 문구: 무엇을 승인했는지
      fire("dialog", {}, { answered: "ok", kind: "confirm", message: "정말 삭제할까요?" });
      if (rd().filter((x) => x.cmd === "dialog").pop().detail.message !== "정말 삭제할까요?") return false;

      // upload 의 파일 목록
      fire("upload", {}, { files: ["/tmp/a.png"], via: "direct" });
      if (!Array.isArray(rd().filter((x) => x.cmd === "upload").pop().detail.files)) return false;

      // 판정이 몇 곳을 봤는가
      fire("expect", { sel: ".btn" }, { pass: true, expected: ".btn 있음 (3곳 중 1번째)",
        got: "확인", found: true, matched: 3, url: "http://a/b" });
      if (rd().filter((x) => x.kind === "assertion").pop().matched !== 3) return false;

      // 한 호출이 여럿 돌려준 장면
      const s1 = path.join(st2.dir, "s1.png"), s2 = path.join(st2.dir, "s2.png");
      writeFileSync(s1, "1"); writeFileSync(s2, "2");
      fire("shotsizes", { caption: "반응형" }, { shots: [
        { size: "모바일", width: 390, height: 844, path: s1 },
        { size: "데스크톱", width: 1440, height: 900, path: s2 }] });
      const arts = rd().filter((x) => x.kind === "artifact");
      if (arts.length < 2 || !arts.some((a) => /모바일/.test(a.caption || ""))) return false;

      // 조작인데 기록 목록에 없던 것
      fire("bulkfill", { sel: "#f" }, { typed: 3, total: 3 });
      if (rd().filter((x) => x.cmd === "bulkfill").length !== 2) return false;

      // 잠깐 뜬 알림: 허용값에서 빠져 전 회차 0건이던 항목
      if (!c2("journal", { runId: RID, event: { kind: "artifact", source: "moment", shot: s1,
        caption: "잠깐 뜬 알림: 저장했습니다" } }).ok) return false;
      // 알 수 없는 이름은 그대로 거절한다. 오타를 잡는 장치는 유지한다
      if (c2("journal", { runId: RID, event: { kind: "artifact", source: "없는것", shot: s1 } }).ok) return false;

      // 외부가 보낸 상세도 서버가 자른다. 자르는 지점이 생산자마다 있으면 하나가 빠질 때 장부가 무거워진다
      const big = {};
      for (let i = 0; i < 60; i++) big["k" + i] = "값".repeat(120);
      c2("journal", { runId: RID, event: { kind: "artifact", source: "app", shot: s2, detail: big } });
      const ext = rd().filter((x) => x.source === "app").pop();
      return !!ext && !!ext.detail && JSON.stringify(ext.detail).length <= 1700;
    } finally {
      if (prev) process.env.IRIS_STATE_DIR = prev; else delete process.env.IRIS_STATE_DIR;
      rmSync(fdir, { recursive: true, force: true });
    }
  });

}
