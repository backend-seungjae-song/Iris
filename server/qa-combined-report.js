// 여러 회차를 사람용 보고서 한 장으로. 같은 항목을 뒤 회차가 다시 확인했으면 마지막 판정만 케이스로 보이고 앞 판정은 이력 줄로 남김
import path from "node:path";
import crypto from "node:crypto";
import { buildReport } from "../bin/mcp/report.mjs";
import { runQaReportTask } from "./qa-report-worker.js";
import { checkQaReport, legacyQaEvents, normalizeOverviewCases, parseReportEdits, readCaseEvidence } from "./qa-report.js";
import { deriveQaRows } from "./qa-rows.js";
import { deriveQaSessionAnalysis } from "./qa-session-analysis.js";
import { deriveQaRemediation } from "./qa-remediation.js";

// 회차마다 seq 가 1부터라 합치면 판정 번호·무효 대상이 겹침. 회차 순번만큼 띄움
const SEQ_GAP = 10_000_000;

const runLabel = (at) => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "시각 미기록 회차";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} 회차`;
};

// 한 항목의 경로 색 묶음 → 대표 색. 실패가 하나라도 있으면 실패
export function rowColor(row) {
  const colors = row.paths.map((lane) => row.walked[lane]?.color).filter(Boolean);
  if (!colors.length) return null;
  for (const color of ["red", "orange", "yellow", "blue", "gray"]) if (colors.includes(color)) return color;
  return "green";
}

// 항목마다 최종 판정 회차 선택. 보고서 검사를 통과한 회차 중 그 항목을 닫은 마지막 회차, 없으면 닫은 마지막 회차
export function pickFinalRuns(runs) {
  const byRow = new Map();
  runs.forEach((run, index) => {
    for (const row of run.rows) {
      const color = rowColor(row);
      if (!color) continue;
      const list = byRow.get(row.id) || [];
      list.push({ index, color, reportable: run.reportable });
      byRow.set(row.id, list);
    }
  });
  const final = new Map();
  for (const [id, history] of byRow) {
    const pick = history.findLast((item) => item.reportable) || history.at(-1);
    final.set(id, { ...pick, history });
  }
  return final;
}

// 다른 ID로 다시 선언한 항목: 앞 항목을 케이스에서 빼고 그 판정을 새 항목의 이력 앞에 붙임
export function applyReplaces(final, replaces = []) {
  const out = new Map(final);
  for (const { from, to } of replaces) {
    const old = out.get(from), next = out.get(to);
    if (!old || !next) throw new Error(`replaces: 합친 회차에 없는 항목입니다: ${!old ? from : to}`);
    if (from === to) throw new Error(`replaces: 같은 항목입니다: ${from}`);
    out.delete(from);
    out.set(to, { ...next, history: [...old.history.map((item) => ({ ...item, from: item.from || from })), ...next.history] });
  }
  return out;
}

function shiftEvent(event, offset) {
  // origSeq: 판정 글이 가리키는 회차 안 번호. 보고서가 그 번호의 사진을 먼저 고름
  const out = { ...event, seq: event.seq + offset, shotSeq: (event.shotSeq || event.seq) + offset, origSeq: event.seq };
  if (event.kind === "assertion") out.id = String(Number(event.id) + offset);
  if (event.kind === "void" && /^\d+$/.test(String(event.receipt ?? ""))) out.receipt = String(Number(event.receipt) + offset);
  return out;
}

export async function createQaCombinedReport(ledger, runIds, { title, overview, session, replaces = [], activity } = {}) {
  if (!Array.isArray(runIds) || runIds.length < 2 || runIds.length > 100 || runIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) || new Set(runIds).size !== runIds.length)
    throw new Error("report.runIds: 서로 다른 회차 ID가 두 개 이상 필요합니다.");
  if (typeof title !== "string" || !title.trim()) throw new Error("report.title: 보고서 제목이 필요합니다.");
  const runs = [], rejected = [];
  for (const runId of runIds) {
    let verified;
    try { verified = await ledger.verify(runId, { full: true, retain: false }); }
    catch (error) { rejected.push(`${runId} · 기록 검증 실패: ${String(error?.message || error).slice(0, 200)}`); continue; }
    const begin = verified.events.find((r) => r.event.kind === "run_begin")?.event;
    if (!begin || (session && begin.session !== session)) { rejected.push(`${runId} · 세션 소유권 확인 실패`); continue; }
    runs.push({ runId, folder: ledger.paths(runId).folder, events: verified.events });
  }
  // 한 회차라도 빠지면 그 회차 항목의 최종 판정이 다른 회차 것으로 바뀌므로 만들지 않음. 빠진 회차 사유 없이 "케이스가 없다"만 나온 사례
  if (rejected.length) throw new Error(`검증하지 못한 회차가 있어 합친 보고서를 만들지 않았습니다: ${rejected.join(" / ")}`);
  return runQaReportTask(import.meta.url, "assembleQaCombinedReport", [runs, { title, overview, replaces }], activity);
}

// 검증을 마친 회차 기록으로 보고서 조립(보고서 스레드에서 실행)
export function assembleQaCombinedReport(verified, { title, overview, replaces = [] } = {}) {
  const runs = [];
  for (const { runId, folder, events } of verified) {
    const begin = events.find((r) => r.event.kind === "run_begin")?.event;
    let checked = null, reportError = "";
    try { checked = checkQaReport(events); } catch (error) { reportError = error.message; }
    const rows = checked?.state?.rows || deriveQaRows(events).rows;
    runs.push({ runId, folder, events, begin, end: events.findLast((r) => r.event.kind === "run_end")?.event,
      at: events[0]?.event.at ?? begin.at, rows, reportable: !!checked, reportError });
  }
  runs.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const label = (index) => runLabel(runs[index].at);
  const final = applyReplaces(pickFinalRuns(runs), replaces);
  const names = new Map(runs.flatMap((run) => run.rows.map((row) => [row.id, row.what || row.id])));
  // 판정 이력은 문장 대신 칸으로 넘김. 케이스 설명 전체가 이력마다 반복돼 확인 범위 한 줄이 4,685자가 된 사례
  const historyOf = (item) => item.history.map((h) => ({ run: label(h.index), color: h.color, reportable: h.reportable,
    ...(h.from ? { replaced: names.get(h.from) || h.from } : {}) }));

  // 최종 회차의 항목 기록만 합침. 앞 회차 판정은 그 항목 종료 기록의 history 로
  const serverEvents = [];
  runs.forEach((run, index) => {
    const offset = (index + 1) * SEQ_GAP;
    for (const event of legacyQaEvents(run.events, run.folder)) {
      if (!event.row || final.get(event.row)?.index !== index) continue;
      const shifted = shiftEvent(event, offset);
      // 결정 카드 번호(n1·n2)는 회차마다 다시 매김. 합친 보고서에서는 회차 순번을 붙여(2-n1) overview.notes 가 한 카드만 가리킴
      if (shifted.kind === "note" && shifted.id != null) shifted.id = `${index + 1}-${shifted.id}`;
      const history = final.get(event.row).history;
      if (shifted.kind === "row" && shifted.act === "close" && history.length > 1) shifted.history = historyOf(final.get(event.row));
      serverEvents.push(shifted);
    }
  });

  const finalIds = new Set(final.keys());
  const scope = typeof overview?.scope === "string" ? [overview.scope] : [...(overview?.scope || [])];
  const features = (overview?.features || []).map((feature) => {
    // "회차ID:항목ID" 도 받음. 합친 보고서에서는 항목마다 최종 케이스 하나라 항목 ID 로 맞춤
    const renamed = new Map(replaces.map((r) => [r.from, r.to]));
    const cases = [...new Set((feature.cases || []).map((id) => String(id).split(":").at(-1)).map((id) => renamed.get(id) || id))];
    const missing = cases.filter((id) => !finalIds.has(id));
    if (missing.length) throw new Error(`overview의 케이스가 합친 회차에 없습니다: ${missing.join(", ")}`);
    if (!cases.length && !feature.why?.trim()) throw new Error("케이스가 없는 기능에는 이유가 필요합니다.");
    return { ...feature, cases };
  });
  const cases = readCaseEvidence(normalizeOverviewCases(overview?.cases, finalIds, new Map(replaces.map((r) => [r.from, r.to]))));
  const edits = parseReportEdits(overview);
  const replaced = [...final].filter(([, item]) => item.history.some((h) => (h.index !== item.index || h.from) && h.color !== item.color));
  // 회차·판정 변경·대체는 보고서가 표로 그림
  const combined = {
    runs: runs.map((run, index) => ({ label: label(index), reportable: run.reportable,
      cases: [...final].filter(([, item]) => item.index === index).map(([id]) => id) })),
    changes: replaced.map(([id, item]) => ({ id, history: historyOf(item) })),
    replaced: replaces.map(({ from, to, why }) => ({ from: names.get(from) || from, to, why })),
    // Charter·세션 기록은 마지막 회차 것. 보고서 검사를 통과한 회차가 없어 미통과 회차 판정을 쓴 케이스
    lastRun: label(runs.length - 1),
    unchecked: [...final].filter(([, item]) => !item.reportable).map(([id]) => id),
  };


  // 세션 기록: Charter·세션 기록은 마지막 회차, 결함·메모·시간·범위 밖 항목은 회차 전체
  const analyses = runs.map((run) => {
    const analysis = deriveQaSessionAnalysis(run.events, run.rows);
    // 결함마다 수정 여부와 재확인 결과
    const remedies = new Map(deriveQaRemediation(run.events).defects.map((d) => [d.seq, d]));
    for (const defect of analysis.defects) {
      defect.problem = `${runLabel(run.at)} · ${defect.problem}`;
      const d = remedies.get(defect.seq);
      if (d) defect.remedy = [d.status, d.reason && `사람 확인 이유: ${d.reason}`, d.waiting?.length && `남은 확인: ${d.waiting.join(", ")}`].filter(Boolean).join("\n");
      defect.frames = (defect.frames || []).map((frame) => ({ ...frame, ...(frame.shot ? { shot: path.resolve(run.folder, frame.shot) } : {}) }));
      defect.failures = (defect.failures || []).map((failure) => ({ ...failure, ...(failure.shot ? { shot: path.resolve(run.folder, failure.shot) } : {}) }));
    }
    return analysis;
  });
  const sum = (key) => analyses.reduce((total, a) => total + (a.time?.[key] || 0), 0);
  const sessionAnalysis = { ...analyses.at(-1),
    charterChanges: analyses.flatMap((a) => a.charterChanges || []), defects: analyses.flatMap((a) => a.defects || []),
    notes: analyses.flatMap((a) => a.notes || []), outsideRows: analyses.flatMap((a) => a.outsideRows || []),
    rowCounts: { inside: analyses.reduce((n, a) => n + (a.rowCounts?.inside || 0), 0), outside: analyses.reduce((n, a) => n + (a.rowCounts?.outside || 0), 0) },
    time: { ...analyses.at(-1).time, ...Object.fromEntries(["totalMs", "setupMs", "investigationMs", "testMs", "insideMs", "outsideMs", "unassignedMs", "invalidIntervals"].map((key) => [key, sum(key)])) } };

  const last = runs.at(-1);
  const digest = crypto.createHash("sha256").update(JSON.stringify([runs.map((r) => r.runId), title])).digest("hex").slice(0, 16);
  // 회차 폴더에 쓰면 그 회차의 manifest.json(이어받기가 읽음)을 덮어씀. 합친 보고서 전용 폴더
  // 확인자 글의 회차 번호를 지울 때 대조할 합친 회차들 기록 전체의 번호
  const result = buildReport({ runId: `combined-${digest}`, kind: "review", sceneLimit: 5, title: title.trim(), serverEvents,
    runSeqs: [...new Set(runs.flatMap((run) => run.events.map((r) => r.seq)))],
    overview: { ...overview, ...edits, features, scope, cases, combined },
    charter: last.begin.charter, sessionRecord: last.end?.sessionRecord, sessionAnalysis,
    build: { begin: runs[0].begin.build, end: last.end?.build } });
  if (!result.ok) throw new Error(result.error || "HTML 보고서 생성 실패");
  return { ...result, runs: runs.map((run) => ({ runId: run.runId, label: runLabel(run.at), reportable: run.reportable })),
    cases: final.size, replaced: replaced.length };
}
