import { assertQaReactionsJudged } from "./qa-reaction.js";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { renderQaActionReport, renderQaCaptureInfo, isQaCalibration } from "./qa-action-report.js";
import { buildReportIsolated } from "./qa-report-worker.js";
import { QA_COMMAND_SCHEMAS } from "./qa-protocol.js";
import { deriveQaRows, validateQaDerivation } from "./qa-rows.js";
import { validateQaCharter, validateQaStoredSession } from "./qa-session-contract.js";
import { deriveQaSessionAnalysis } from "./qa-session-analysis.js";

// 사유를 모을 때는 던지지 않고 쌓음. 회차를 끝내기 전에 고칠 목록을 한 번에 돌려주기 위함
let collected = null;
const reject = (code, message) => {
  const text = `[${code}] ${message}`;
  if (!collected) throw new Error(text);
  if (!collected.includes(text)) collected.push(text);
};
const belongs = (e, id, lane) => e.rowId === id && e.path === lane
  || e.lanes?.some(x => Array.isArray(x) ? x[0] === id && x[1] === lane : x.rowId === id && x.path === lane);
// 항목을 열기 전 준비 단계 조작의 반응은 항목 판정이 아님(화면 준비용)
const preparation = e => e.mode === "preparation" && !e.rowId && !e.lanes?.length;
const isVerdict = e => e.kind === "assertion" || e.kind === "reaction" && typeof e.pass === "boolean" && !preparation(e);
const reactionScene = (events, e) => events.findLast(r => r.event.kind === "frame" && r.event.acceptedSeq === e.acceptedSeq
  && r.event.claim?.kind === (e.pass ? "S2" : "S3") && r.event.shot)?.event;
const failureOf = (events, seq) => events.find(record => record.event.kind === "failure" && String(record.event.detail?.failureSeq) === String(seq))?.event;
const withFailureEvidence = (events, record) => {
  const reaction = record.event.kind === "reaction";
  // 반응 판정의 실패 기록은 같은 조작 번호의 action 을 가리킴
  const action = reaction ? events.find(r => r.event.kind === "action" && r.event.acceptedSeq === record.event.acceptedSeq) : undefined;
  const failure = failureOf(events, record.seq) || (action && failureOf(events, action.seq));
  const scene = reaction ? reactionScene(events, record.event) : undefined;
  return { ...record.event, shot: record.event.shot || scene?.shot || failure?.shot, url: record.event.url || scene?.url || failure?.url, surface: record.event.surface || scene?.surface || failure?.surface };
};

// 보고서 거부 사유 전체. 앞선 사유 때문에 검사를 이어 갈 수 없으면 그 오류로 끝냄
const collectQaReport = events => {
  collected = [];
  let result;
  try { result = inspectQaReport(events); }
  catch (error) { if (!collected.includes(error.message)) collected.push(error.message); }
  const problems = collected;
  collected = null;
  return { result, problems };
};
export const qaReportProblems = events => collectQaReport(events).problems;

// 검증된 장부의 보고 가능 여부. 첫 사유만 보여 주면 나머지를 장부에서 직접 세야 했던 사례라 사유를 모두 담음
export function checkQaReport(events) {
  const { result, problems } = collectQaReport(events);
  if (problems.length) throw new Error(problems.length === 1 ? problems[0] : `${problems.join(" / ")} (사유 ${problems.length}건)`);
  return result;
}

function inspectQaReport(events) {
  const begin = events.find(r => r.event.kind === "run_begin")?.event;
  const end = events.findLast(r => r.event.kind === "run_end")?.event;
  if (!begin || !end) return reject("session", "charter와 종료 기록이 필요합니다.");
  if(begin.plan?.risks)assertQaReactionsJudged(events);
  validateQaCharter(begin.charter); validateQaStoredSession(end.sessionRecord);
  const state = deriveQaRows(events);
  const rows = state.rows instanceof Map ? [...state.rows.values()] : state.rows;
  if (!rows.length) reject("LR0", "선언한 확인 항목이 없습니다.");
  if (state.open?.length || state.gaps?.length) reject("LR1", "닫지 않은 경로 또는 확인 목록이 있습니다.");
  const voids = new Set();
  for (const { event: e } of events) if (e.kind === "row" && e.action === "void") {
    const d = e.rowData;
    // void 가 받는 판정과 같은 기준. 준비 단계 판정은 판정으로 세지 않지만 그 무효 기록이 원본 없는 무효는 아님(qa-2ab6e345 seq 163)
    const named = r => r.event.kind === "assertion" || r.event.kind === "reaction" && typeof r.event.pass === "boolean";
    if (!d?.why?.trim() || !events.some(r => String(r.seq) === String(d.receipt) && named(r))) reject("D1", "무효 판정의 원본과 사유가 필요합니다.");
    voids.add(String(d.receipt));
  }
  // 판정(reaction)을 무효 처리한 조작은 그 조작도 판정 대상에서 뺌
  const voidedAction = r => events.some(v => voids.has(String(v.seq)) && v.event.kind === "reaction" && v.event.acceptedSeq === r.event.acceptedSeq);
  const looked = new Set();
  for (let i = 0; i < events.length; i++) {
    const { seq } = events[i], e = withFailureEvidence(events, events[i]);
    const surface = e.surface || "browser";
    if (e.kind === "entry" || e.cmd === "app_target") looked.delete(surface);
    if (e.kind === "observation" && e.pass && ["snapshot", "observe", "app_snapshot", "app_observe"].includes(e.cmd)) looked.add(surface);
    // 확인 창이 떠 있는 동안은 페이지가 멈춰 화면을 볼 수 없음. 창의 종류·문구 기록이 조작 전 관찰
    if (e.kind === "observation" && e.pass && e.cmd === "dialog_open") looked.add(surface);
    // 모바일 조작은 반응 관찰이 접근성 트리를 읽고 결과 장면을 찍음. 채널도 app_* 조작 전 관찰을 요구하지 않음
    const mobileReaction = r => r.event.kind === "reaction" && String(r.event.cmd || "").startsWith("app_");
    if (mobileReaction(events[i])) looked.add(surface);
    if (e.kind === "action") {
      const captureFailed = events.some(r=>r.event.cmd === "capture_failed" && r.event.acceptedSeq === e.acceptedSeq);
      const gray = rows.filter(row=>(row.paths||[]).some(lane=>belongs(e,row.id,lane))).every(row=>row.paths.filter(lane=>belongs(e,row.id,lane)).every(lane=>row.walked[lane]?.color === "gray"));
      if((captureFailed || e.pass !== true) && gray && (e.rowId || e.lanes?.length)) continue;
      // 모바일 조작은 시작할 때 접근성 트리를 읽고 S1 장면을 찍으므로 그 장면이 조작 전 관찰
      const mobileBefore = String(e.cmd || "").startsWith("app_") && events.some(r => r.event.kind === "frame" && r.event.shot && r.event.acceptedSeq === e.acceptedSeq && r.event.claim?.kind === "S1");
      if (!looked.has(surface) && !mobileBefore) reject("S0", `조작 ${seq} 전에 화면 관찰이 없습니다.`);
      const accepted = events.find(r => r.seq === e.acceptedSeq)?.event;
      // 사진은 주장 시점에만 찍으므로 기대 선언이 필수인 조작만 기대 장면(S1)과 결과 장면(S2·S3) 필요. 장면은 조작 번호로 연결
      // 멈춘 페이지에서 답한 확인 창은 사진·반응 관찰이 불가능. 결과는 뒤따르는 관찰(L)로 확인
      // dialog_open 은 페이지가 멈춘 경로에서만 기록됨. dialogBlocked 표시 전 빌드가 쓴 기록도 이것으로 판별
      const dialogAnswered = e.dialogBlocked || e.cmd === "dialog" && events.some(r => r.event.kind === "observation" && r.event.cmd === "dialog_open" && r.event.acceptedSeq === e.acceptedSeq);
      // 무효 처리한 판정의 조작은 어떤 결과의 근거도 아니라 장면을 요구하지 않음. 촬영이 시간 초과된 실패가 끝난 회차의 보고서를 막던 사례
      if (QA_COMMAND_SCHEMAS[e.cmd]?.required?.includes("expect") && !dialogAnswered && !voidedAction(events[i])) {
        if (!accepted?.expected) reject("P3", `조작 ${seq}의 기대 선언이 없습니다.`);
        const scene = kinds => events.some(r => r.event.kind === "frame" && r.event.shot && r.event.acceptedSeq === e.acceptedSeq && kinds.includes(r.event.claim?.kind));
        // 반응 관찰이 결과 장면 전에 실패한 조작: 실패 기록(failure)이 그 순간 화면을 결과 장면으로 보존
        const failureScene = e.pass !== true && !!failureOf(events, seq)?.shot;
        if (!scene(["S1"]) || !(scene(["S2", "S3"]) || failureScene)) reject("P3", `조작 ${seq}의 기대·결과 장면이 없습니다.`);
        if (!events.some(r => r.event.kind === "reaction" && r.event.acceptedSeq === e.acceptedSeq)) reject("reaction", `조작 ${seq}의 반응 관찰이 없습니다.`);
      }
      // 웹 탭과 기기를 번갈아 조작하는 회차: 그 화면의 다음 조작 전까지 그 화면 관찰이 있으면 됨
      const next = events.slice(i + 1).findIndex(r => r.event.kind === "action" && (r.event.surface || "browser") === surface);
      const interval = events.slice(i + 1, next < 0 ? undefined : i + 1 + next);
      const following = next < 0 ? undefined : events[i + 1 + next].event;
      // 이어지는 준비 입력(로그인 칸 채우기)과 qa_login 의 전체 선택 키 뒤 같은 칸 입력은 마지막 입력 뒤 관찰로 확인
      const chainedInput = e.mode === "preparation" && following?.mode === "preparation"
        || ["Meta+a", "Control+a"].includes(e.input?.key) && following?.cmd === "type" && JSON.stringify(following.target) === JSON.stringify(e.target);
      // 조작으로 뜬 확인 창의 기록도 조작 뒤 관찰(조작 전 관찰과 같은 기준)
      if (!chainedInput && !interval.some(r => r.event.kind === "observation" && (r.event.surface || "browser") === surface && r.event.pass && ["snapshot", "observe", "app_snapshot", "app_observe", "dialog_open"].includes(r.event.cmd)
        || mobileReaction(r) && r.event.acceptedSeq === e.acceptedSeq)) reject("L", `조작 ${seq} 뒤 관찰이 없습니다.`);
    }
    // 도구 오류로 결과 기록 전에 끊기고 뒤 실행이 이어진 경우는 판정이 없을 뿐이라 통과. 마지막 실행이 끊긴 회차만 거부
    if (e.kind === "accepted" && !events.some(r=>r.event.acceptedSeq===seq && ["action","observation","assertion"].includes(r.event.kind))
      && !events.slice(i + 1).some(r => r.event.kind === "accepted")) reject("execution","완료되지 않은 실행이 있습니다.");
    if (isVerdict(e) && !voids.has(String(seq))) {
      const failure = failureOf(events, seq);
      const grayFailure = e.pass === false && failure?.detail?.captureError && rows.some(row => row.paths.some(lane => belongs(e,row.id,lane)))
        && rows.filter(row => row.paths.some(lane => belongs(e,row.id,lane))).every(row => row.paths.filter(lane => belongs(e,row.id,lane)).every(lane => row.walked[lane]?.color === "gray"));
      if (!e.shot && !grayFailure) reject("S1", `판정 ${seq}의 장면이 없습니다.`);
      // 웹 진입 주소가 있는 회차는 surfaces 에 http 주소만 받으므로, app_target 으로 연결한 기기 화면도 확인 화면
      const devices = events.filter(r => r.event.kind === "observation" && r.event.cmd === "app_target" && r.event.pass && String(r.event.url || "").startsWith("app://")).map(r => r.event.url);
      const surfaces = [...(begin.plan?.surfaces || begin.plan?.entries || []), ...devices];
      if ((!e.url && !grayFailure) || e.url && !surfaces.some(prefix=>e.url.startsWith(prefix))) reject("S2","선언한 확인 화면 밖의 판정입니다.");
      if (!e.rowId && !e.lanes?.length) reject("S2", `판정 ${seq}이 확인 항목 밖에 있습니다.`);
      if (!rows.some(row => (row.paths || []).some(lane => belongs(e, row.id, lane)))) reject("P2", `판정 ${seq}을 담을 항목이 없습니다.`);
    }
  }
  for (const row of rows) {
    if(row.derivation) {
      try { validateQaDerivation({events,rowId:row.id,derivation:row.derivation}); }
      catch(error) { reject("manifest D",error.message); }
      if(row.derivation.limitation && !Object.values(end.sessionRecord.unverified).some(v=>v.includes(row.derivation.limitation))) reject("manifest D","파생값 한계가 미확인 기록에 없습니다.");
    }
    if (!row.basis || !row.basisNote?.trim()) reject("basis", `${row.id} 기대 근거가 없습니다.`);
    for (const lane of row.paths || []) {
      const close = events.findLast(r => r.event.kind === "row" && r.event.action === "close" && r.event.rowId === row.id && r.event.path === lane)?.event.rowData;
      if (!close) { reject("LR1", `${row.id} ${lane} 종료가 없습니다.`); continue; }
      if (!close.sceneJudgment?.trim()) reject("sceneJudgment", `${row.id} ${lane} 장면 전체 판단이 없습니다.`);
      // 수정 뒤 retestOf 재실행 구간이면 그 구간만 판정 대상, 고치기 전 실패는 장부·결함 기록에 유지
      const lastOpen = events.findLast(r => r.event.kind === "row" && r.event.action === "open" && r.event.rowId === row.id && r.event.path === lane)?.seq ?? -1;
      const retestSpan = events.some(r => r.seq > lastOpen && r.event.kind === "play_result" && r.event.rowId === row.id && r.event.path === lane && r.event.detail?.retestOf);
      const inSpan = r => !retestSpan || r.seq > lastOpen;
      const receipts = events.filter(r => isVerdict(r.event) && belongs(r.event, row.id, lane) && !voids.has(String(r.seq)) && inSpan(r));
      if (!["gray", "blue"].includes(close.color) && !receipts.length) reject("P1", `${row.id} 유효 판정이 없습니다.`);
      if (!["gray","blue"].includes(close.color) && !(row.walked[lane].frames > 0)) reject("LR2","유효 장면이 없습니다.");
      const actions = events.filter(r=>r.event.kind === "action" && belongs(r.event,row.id,lane) && inSpan(r) && !voidedAction(r));
      // pass 없는 조작은 반응이 없어 다시 누른 첫 클릭. 다시 누른 판정이 그 조작의 결과
      if(close.color === "green" && actions.some(r=>r.event.pass === false)) reject("execution",`실패한 조작이 있는 항목은 통과가 아닙니다: ${row.id} ${lane} 조작 ${actions.filter(r=>r.event.pass === false).map(r=>r.seq).join(", ")}`);
      if(close.color === "green" && actions.length && !receipts.some(r=>r.seq>actions.at(-1).seq)) reject("A2","조작 이후 결과 판정이 없습니다.");
      if (close.color === "green" && receipts.some(r => !r.event.pass)) reject("P1c", `${row.id} ${lane} 실패 판정이 있습니다: ${receipts.filter(r => !r.event.pass).map(r => r.seq).join(", ")}`);
      // 화면 관찰로 찾아 실패 판정 없이 이 경로에 기록한 결함(qa_defect noFailure)도 red 의 근거
      const observedDefect = events.some(r => r.seq > lastOpen && r.event.kind === "defect" && r.event.detail?.noFailure && belongs(r.event, row.id, lane));
      if (close.color === "red" && !receipts.some(r => !r.event.pass) && !observedDefect) reject("P1d", `${row.id} 실패한 판정이 없습니다.`);
    }
  }
  return { state, begin, end };
}

// 기록 순서보다 1초 이상 앞서 찍힌 사진의 실제 촬영 시점
export function lateCaptureNote(e) {
  const lateBy = Number.isFinite(e.capturedAt) && e.at - e.capturedAt >= 1000 ? Math.round((e.at - e.capturedAt) / 100) / 10 : 0;
  return lateBy ? `촬영 시점: #${e.acceptedSeq ?? "?"} 조작 중 · 이 기록보다 ${lateBy}초 앞` : undefined;
}

// 반응 판정의 기대 효과를 대상·방식으로 옮기고 같은 조작의 효과 장면을 붙임. 없으면 사람용 보고서가 대상 없는 "화면에 있음"과 시작·끝 화면만 그리던 사례
const REACTION_MODE = { appear: "exists", disappear: "absent", absent: "absent", change: "equals", unchanged: "exists" };
function reactionCheck(events, e) {
  if (e.kind !== "reaction") return {};
  const effects = e.expected?.effects || [], first = effects[0] || {};
  const label = effects.map(effect => effect.type === "none" ? "변화 없음" : effect.text || effect.name || effect.sel || effect.url || effect.type).filter(Boolean).join(" · ").replace(/\s*\n\s*/g, " ");
  const scene = kind => events.find(item => String(item.event.acceptedSeq) === String(e.acceptedSeq) && item.event.shot && item.event.claim?.kind === kind);
  return { label, mode: REACTION_MODE[first.type], want: first.type === "change" ? first.to : undefined, sceneShot: (scene("S2") || scene("S3"))?.event.shot };
}
// 화면 조건 판정(qa_expect·qa_app_expect)의 대상·기대값. expected 칸은 QA_COMMAND_SCHEMAS expect·app_expect
// 이 값 없이 옮겨 사람용 보고서가 대상 없는 "화면에 있음"을 그리던 사례
// observed: 브라우저 실행기는 찾은 요소의 글이나 null(요소 없음), 앱 실행기는 맞는 요소들의 글을 줄바꿈으로 이은 문자열
function expectCheck(e) {
  const x = e.expected && typeof e.expected === "object" ? e.expected : {}, o = e.observed;
  const text = typeof x.text === "string" && x.text !== "" ? x.text : undefined;
  const valued = x.mode === "equals" || x.mode === "contains";
  const seen = o && typeof o === "object" ? o.text ?? o.value : typeof o === "string" ? o : undefined;
  const found = o && typeof o === "object" ? (typeof o.found === "boolean" ? o.found : undefined) : o === null ? false : undefined;
  return { label: x.label || (valued ? undefined : text), mode: x.mode, want: valued ? text : undefined,
    got: e.pass || seen == null ? undefined : String(seen), found };
}
// 사람용 확인 줄 "조작 → 효과"의 재료. 대상 이름·키·전달 여부·이동량과 효과별 관찰 결과만 넘김
// 입력 원문은 회차 기록에도 없어 글자 수만, 좌표·선택자는 사람용 보고서에 쓰지 않음
function reactionStory(e, act) {
  if (e.kind !== "reaction") return {};
  const a = e.detail?.action || {}, t = a.target || {}, input = act?.input || {};
  const seen = new Map((e.detail?.effects || []).map(x => [x.id, x.observed]));
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const dx = input.x1 != null && input.x2 != null ? num(input.x2 - input.x1) : num(input.deltaX);
  const dy = input.y1 != null && input.y2 != null ? num(input.y2 - input.y1) : num(input.deltaY);
  return {
    act: a.kind ? { kind: a.kind, name: t.name || t.text || undefined, key: input.key || undefined,
      delivered: typeof input.delivered === "boolean" ? input.delivered : undefined, retried: e.detail?.retryOf ? true : undefined, dx, dy,
      length: Number.isInteger(input.length) ? input.length : undefined } : undefined,
    effects: (e.expected?.effects || []).map(f => ({ type: f.type, name: f.text || f.name || undefined,
      to: f.type === "change" ? f.to : undefined, observed: typeof seen.get(f.id) === "boolean" ? seen.get(f.id) : undefined })),
  };
}

export function legacyQaEvents(events, folder) {
  const absolute = value => value ? path.resolve(folder, value) : undefined;
  const actionOf = new Map(events.filter(r => r.event.kind === "action" && r.event.acceptedSeq != null).map(r => [String(r.event.acceptedSeq), r.event]));
  return events.flatMap(record => {
    const {seq} = record, e = withFailureEvidence(events, record);
    if (isQaCalibration(e)) return [];
    const original = e.sameSceneSeq && events.find(item => item.seq === e.sameSceneSeq)?.event;
    if (original?.shot) e.shot = original.shot;
    const captureNote = [e.stability?.stable === false && !e.stability.remaining?.includes?.("not-requested")
      ? `안정 전 촬영 · 남은 항목: ${JSON.stringify(e.stability.remaining)}` : undefined,
      lateCaptureNote(e)].filter(Boolean).join(" · ") || undefined;
    const common = { row: e.rowId, path_: e.path, lanes: e.lanes, seq, shotSeq: e.shotSeq || seq, t: e.at, url: e.url, captureNote };
    if (e.kind === "row") {
      const d = { ...e.rowData };
      if (e.action === "declare" && e.shot) d.sourceShot = absolute(e.shot);
      if (["void", "aside", "note", "list"].includes(e.action)) return [{ ...common, kind:e.action, ...d, ...(e.action === "aside" ? {frames:d.frames.map(absolute)} : {}), ...(e.action === "note" && d.shot ? {shot:absolute(d.shot)} : {}) }];
      return [{...common, kind:"row", act:e.action, path:e.path, ...d}];
    }
    if (isVerdict(e)) { const check = e.kind === "reaction" ? reactionCheck(events, e) : expectCheck(e); return [{...common, kind:"assertion", id:String(seq), pass:e.pass, expected:JSON.stringify(e.expected), label:check.label, mode:check.mode, want:check.want, got:check.got, found:check.found, ...reactionStory(e, actionOf.get(String(e.acceptedSeq))), shot:absolute(e.shot || check.sceneShot)}]; }
    if (e.shot && e.kind !== "diff") return [{...common, kind:"frame", claimKind:e.claim?.kind, path:absolute(e.shot), why:["screenshot","app_screenshot"].includes(e.cmd) || e.claim?.kind === "S5" ? "찍음" : e.phase || e.cmd || "장면", same:e.same,caption:[e.caption,e.moment,e.claim?.kind === "S5" && e.claim.description,captureNote].filter(Boolean).join(" · "),marks:Array.isArray(e.marks) ? e.marks : e.marks?.marks,moment:e.moment,detail:e.detail}];
    return [];
  });
}

// overview.cases 의 id("회차ID:항목ID" 또는 항목ID)를 보고서의 항목 ID 로 맞춤. 없는 항목·중복은 거부
export function normalizeOverviewCases(cases, rowIds, renamed = new Map()) {
  const out = [], seen = new Set();
  for (const item of cases || []) {
    const raw = String(item.id).split(":").at(-1), id = renamed.get(raw) || raw;
    if (!rowIds.has(id)) throw new Error(`overview.cases의 케이스가 보고서에 없습니다: ${item.id}`);
    if (seen.has(id)) throw new Error(`overview.cases에 같은 케이스가 두 번 있습니다: ${item.id}`);
    seen.add(id);
    out.push({ ...item, id, kind: [...new Set(item.kind || [])], ...parseCaseEdits(item, id) });
  }
  return out;
}

// overview.cases[].scenes·text: 끝난 회차의 사람용 사진·글을 확인자가 고치는 칸. 스키마 검사기가 pattern·const 를 보지 않아 여기서 검사
const EDIT_MAX = 300;
function parseCaseEdits(item, id) {
  const out = {};
  if (item.scenes != null) {
    if (!Array.isArray(item.scenes) || item.scenes.length > EDIT_MAX) throw new Error(`overview.cases ${id} scenes는 ${EDIT_MAX}개 이하 배열이어야 합니다.`);
    const seen = new Set();
    out.scenes = item.scenes.map((x) => {
      const sha = String(x?.sha256 ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`overview.cases ${id} scenes의 sha256은 64자 16진이어야 합니다: ${x?.sha256}`);
      if (seen.has(sha)) throw new Error(`overview.cases ${id} scenes에 같은 sha256이 두 번 있습니다: ${sha}`);
      seen.add(sha);
      if (x.hide != null && x.hide !== true) throw new Error(`overview.cases ${id} scenes의 hide는 true만 받습니다: ${sha}`);
      if (x.caption != null && typeof x.caption !== "string") throw new Error(`overview.cases ${id} scenes의 caption은 글이어야 합니다: ${sha}`);
      const hide = x.hide === true, caption = x.caption != null ? x.caption.trim() : undefined;
      if (hide === (caption !== undefined)) throw new Error(`overview.cases ${id} scenes 항목은 caption과 hide 중 하나만 씁니다: ${sha}`);
      if (caption === "") throw new Error(`overview.cases ${id} scenes의 caption이 비었습니다: ${sha}`);
      return hide ? { sha256: sha, hide } : { sha256: sha, caption };
    });
  }
  if (item.text != null) out.text = parseTextEdits(item.text, `overview.cases ${id} text`);
  return out;
}
function parseTextEdits(list, where) {
  if (!Array.isArray(list) || list.length > EDIT_MAX) throw new Error(`${where}는 ${EDIT_MAX}개 이하 배열이어야 합니다.`);
  const seen = new Set();
  return list.map((x) => {
    const from = typeof x?.from === "string" ? x.from : "";
    if (!from.trim()) throw new Error(`${where}의 from이 비었습니다.`);
    if (typeof x.to !== "string") throw new Error(`${where}의 to는 글이어야 합니다(지우려면 빈 글): ${from}`);
    if (seen.has(from)) throw new Error(`${where}에 같은 from이 두 번 있습니다: ${from}`);
    seen.add(from);
    return { from, to: x.to };
  });
}
// overview.text: 보고서 전체 확인자 글 고치기(케이스 밖 결함·메모·Charter 포함). overview.notes: 끝난 회차의 결정 카드 빼기(개발자용 결정 카드 번호)
export function parseReportEdits(overview) {
  const out = {};
  if (overview?.text != null) out.text = parseTextEdits(overview.text, "overview.text");
  if (overview?.notes != null) {
    if (!Array.isArray(overview.notes) || overview.notes.length > EDIT_MAX) throw new Error(`overview.notes는 ${EDIT_MAX}개 이하 배열이어야 합니다.`);
    const seen = new Set();
    out.notes = overview.notes.map((x) => {
      const id = String(x?.id ?? "").trim();
      if (!id) throw new Error("overview.notes의 id가 비었습니다.");
      if (x.hide !== true) throw new Error(`overview.notes의 hide는 true만 받습니다: ${id}`);
      if (seen.has(id)) throw new Error(`overview.notes에 같은 id가 두 번 있습니다: ${id}`);
      seen.add(id);
      return { id, hide: true };
    });
  }
  return out;
}

// overview.cases[].checks 증거 사진: 절대 경로의 그림 파일만 받고 내용 해시를 붙임. 보고서가 그 파일을 실었다는 기록
const EVIDENCE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;
// 증거 사진은 상한 없이 모두 보고서에 넣으므로 합계를 입력 때 제한. 케이스당 1,000장까지 받던 스키마로는 보고서가 열리지 않을 수 있음
const EVIDENCE_TOTAL_MAX = 200;
// 보고서는 사진을 base64 로 HTML 한 문자열에 넣고 줄이기에 실패하면 원본을 씀. 장수만 세면 큰 파일 몇 장으로 문자열 한도(약 512MB)를 넘음
const EVIDENCE_TOTAL_BYTES = 100 * 1024 * 1024;
export function readCaseEvidence(cases) {
  const total = (cases || []).reduce((n, item) => n + (item.checks || []).reduce((m, c) => m + (c.evidence || []).length, 0), 0);
  if (total > EVIDENCE_TOTAL_MAX) throw new Error(`overview.cases 증거 사진은 보고서 하나에 ${EVIDENCE_TOTAL_MAX}장까지 받습니다: ${total}장`);
  const sizes = new Map();
  const out = (cases || []).map((item) => !item.checks?.length ? item : { ...item, checks: item.checks.map((check) => ({ ...check,
    evidence: (check.evidence || []).map((ev) => {
      const file = String(ev.file);
      if (!path.isAbsolute(file)) throw new Error(`overview.cases ${item.id} 증거 사진은 절대 경로여야 합니다: ${file}`);
      if (!EVIDENCE_EXT.has(path.extname(file).toLowerCase())) throw new Error(`overview.cases ${item.id} 증거 사진은 png·jpg·webp만 받습니다: ${file}`);
      let stat;
      try { stat = fs.statSync(file); } catch { throw new Error(`overview.cases ${item.id} 증거 사진이 없습니다: ${file}`); }
      if (!stat.isFile() || stat.size > EVIDENCE_MAX_BYTES) throw new Error(`overview.cases ${item.id} 증거 사진은 15MB 이하 파일이어야 합니다: ${file}`);
      sizes.set(file, stat.size);
      return { ...ev, file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    }) })) });
  const bytes = [...sizes.values()].reduce((n, x) => n + x, 0);
  if (bytes > EVIDENCE_TOTAL_BYTES) throw new Error(`overview.cases 증거 사진 파일은 합쳐 100MB까지 받습니다: ${(bytes / 1048576).toFixed(1)}MB`);
  return out;
}

export async function createQaReport(ledger, runId, { handoff = false, steps: procedures, overview, resume, session, activity } = {}) {
  const verified = await ledger.verify(runId, { full: true });
  const { folder } = ledger.paths(runId);
  const checked = handoff ? {begin:verified.events.find(r=>r.event.kind === "run_begin")?.event,end:verified.events.findLast(r=>r.event.kind === "run_end")?.event} : checkQaReport(verified.events);
  if(overview) {
    overview = {...overview,scope:typeof overview.scope === "string" ? [overview.scope] : overview.scope || []};
    const rowIds = new Set((checked.state?.rows || []).map(row=>row.id));
    for(const feature of overview.features || []) {
      if(feature.cases.some(id=>!rowIds.has(id))) throw new Error("overview의 케이스가 현재 장부에 없습니다.");
      if(!feature.cases.length && !feature.why?.trim()) throw new Error("케이스가 없는 기능에는 이유가 필요합니다.");
    }
    if(overview.cases) overview.cases = readCaseEvidence(normalizeOverviewCases(overview.cases, rowIds));
    overview = {...overview,...parseReportEdits(overview)};
  }
  let previousReport;
  if(resume) {
    if(resume.from === runId) throw new Error("현재 회차는 이전 보고서가 아닙니다.");
    const prior = await ledger.verify(resume.from);
    const previous = checkQaReport(prior.events);
    if(previous.begin.session !== session) throw new Error("이전 보고서의 세션이 다릅니다.");
    previousReport = await createQaReport(ledger,resume.from,{activity});
    // 기존 manifest는 판정 근거로 재사용하지 않음
    overview = {...overview,scope:[...(overview?.scope || []),`이전 회차: ${resume.from} · 검증된 항목 ${previous.state.rows.length}`]};
  }
  const notices = verified.events.filter(r=>r.event.cmd === "moment").map(r=>`순간 알림: ${r.event.moment || "문구 없음"}${r.event.shot ? "" : " (사진 없음)"}${lateCaptureNote(r.event) ? ` (${lateCaptureNote(r.event)})` : ""}`);
  if(notices.length) overview = {...overview,scope:[...(overview?.scope || []),...notices]};
  const serverEvents = legacyQaEvents(verified.events, folder);
  const steps = handoff ? procedures.map(step => {
    const shot = verified.events.find(r=>r.seq===step.shotSeq)?.event.shot;
    if (!shot) throw new Error("이 회차에서 촬영한 기준 이미지가 필요합니다.");
    return {name:step.name,action:step.action,expected:step.expected,after:path.resolve(folder,shot)};
  }) : [];
  const sessionAnalysis = deriveQaSessionAnalysis(verified.events, checked.state?.rows || deriveQaRows(verified.events).rows);
  for (const defect of sessionAnalysis.defects) {
    defect.frames = (defect.frames || []).map(frame => ({...frame,shot:path.resolve(folder,frame.shot)}));
    defect.failures = defect.failures.map(failure => ({...failure,...(failure.shot ? {shot:path.resolve(folder,failure.shot)} : {})}));
  }
  // 확인자 글의 회차 번호를 지울 때 대조할 이 회차 기록 전체의 번호(화면 구조 읽기 등 사진 없는 기록 포함)
  const result = await buildReportIsolated({runId, kind:handoff ? "handoff" : "review", steps, serverEvents, runSeqs:verified.events.map(r => r.seq),
    overview, charter:checked.begin.charter, sessionRecord:checked.end?.sessionRecord, sessionAnalysis,
    build: { begin: checked.begin.build, end: checked.end?.build },
    actionHtml: handoff ? undefined : renderQaActionReport(verified.events, folder),
    captureInfoHtml: renderQaCaptureInfo(verified.events.filter(r => r.event.shot && !isQaCalibration(r.event)).map(r => ({ seq: r.seq, ...r.event }))),
    captures: verified.events.filter(r => r.event.shot).map(r => ({ seq: r.seq, shotSeq: r.event.shotSeq || r.seq,
      stability: r.event.stability, captureTarget: r.event.captureTarget, viewport: r.event.viewport, url: r.event.url })) }, activity);
  if (!result.ok) throw new Error(result.error || "HTML 보고서 생성 실패");
  return {...result,...(previousReport ? {previousReport:{run:resume.from,path:previousReport.path,scenes:previousReport.scenes}}:{}), sessionAnalysis, head:verified.head, scenes:new Set(verified.events.filter(r => r.event.shot && !isQaCalibration(r.event)).map(r => r.event.sameSceneSeq || r.event.shotSeq || r.seq)).size};
}
