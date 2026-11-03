import { qaRiskResults } from "./qa-list-review.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { deriveQaRows } from "./qa-rows.js";
import { checkQaReport } from "./qa-report.js";
import { deriveQaRemediation, qaRowReplay } from "./qa-remediation.js";

const esc = value => String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const prose = value => value == null ? "" : typeof value !== "object" ? String(value) : Array.isArray(value) ? value.map(prose).join(" · ") : Object.entries(value).map(([key, item]) => `${key}: ${prose(item)}`).join(" · ");
const present = value => typeof value === "string" && value.trim() && !["없음", "해당 없음"].includes(value.trim());
const allGreen = row => row.paths.length && row.paths.every(lane => row.walked[lane]?.color === "green");
const unstable = value => value?.stable === false && !value.remaining?.includes?.("not-requested");

// 검증한 회차만 모은 사람 확인용 요약
export async function createQaSummary(ledger, runIds, { out, session, runJson } = {}) {
  // 실행기 보고서는 세션이 고른 회차가 아닌, 그 실행의 수정 worktree 로 연 회차 전부
  if (runJson !== undefined && Array.isArray(runIds) && typeof ledger.runIds === "function") {
    let unattended = null;
    try { unattended = JSON.parse(fs.readFileSync(path.resolve(String(runJson)), "utf8")); } catch {}
    const since = Date.parse(unattended?.startedAt || "");
    if (unattended?.fixTree && Number.isFinite(since))
      runIds = [...new Set([...runIds, ...ledger.runIds({ session, repo: unattended.fixTree, since })])];
  }
  if (!Array.isArray(runIds) || !runIds.length || runIds.length > 100 || runIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) || new Set(runIds).size !== runIds.length)
    throw new Error("summary.runIds: 서로 다른 회차 ID가 필요합니다.");
  const runs = [], rejectedRuns = [];
  for (const runId of runIds) {
    let verified;
    // 다른 회차 읽기: 서버 캐시에 줄을 남기지 않음(여섯 회차 줄을 서버가 끝날 때까지 보관한 사례)
    try { verified = await ledger.verify(runId, { retain: false }); }
    // 원래 사유를 함께 적음. 사유 없이 "장부 검증 실패"만 남아 qa_report 는 통과한 회차가 왜 빠졌는지 알 수 없던 사례
    catch (error) { rejectedRuns.push({ runId, reason: `장부 검증 실패: ${String(error?.message || error).slice(0, 200)}` }); continue; }
    const begin = verified.events.find(record => record.event.kind === "run_begin")?.event;
    if (!begin || session && begin.session !== session) { rejectedRuns.push({ runId, reason: "세션 소유권 확인 실패" }); continue; }
    const end = verified.events.findLast(record => record.event.kind === "run_end")?.event;
    let reportable = true, reportError = "";
    try { checkQaReport(verified.events); } catch (error) { reportable = false; reportError = error.message; }
    runs.push({ runId, ...verified, begin, end, rows: deriveQaRows(verified.events).rows, reportable, reportError });
  }
  // 실행기 결과의 소유 경로 확인: 다른 실행의 verify 혼입 방지
  let unattendedVerify = null;
  if (runJson !== undefined) {
    if (typeof runJson !== "string" || !runJson.trim()) throw new Error("summary.runJson: 파일 경로가 필요합니다.");
    const runFile = path.resolve(runJson);
    const verifyFile = path.join(path.dirname(runFile), "verify.json");
    let unattendedRun;
    try { unattendedRun = JSON.parse(fs.readFileSync(runFile, "utf8")); }
    catch (error) { throw new Error(`summary.runJson: run.json을 읽지 못했습니다: ${error.message}`); }
    // 실행기는 세션이 끝난 뒤 대조하므로 세션 안에서는 verify.json 이 아직 없음
    try { unattendedVerify = JSON.parse(fs.readFileSync(verifyFile, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error(`summary.runJson: verify.json을 읽지 못했습니다: ${error.message}`);
      unattendedVerify = { pending: true, file: verifyFile };
    }
    if (!unattendedRun || typeof unattendedRun !== "object" || !unattendedRun.repo || !unattendedRun.fixBranch || !unattendedRun.fixTree)
      throw new Error("summary.runJson: run.json 형식이 올바르지 않습니다.");
    const fixTrees = new Set([unattendedRun.fixTree].filter(Boolean).map(value => path.resolve(value)));
    const buildRepos = new Set(runs.map(run => run.begin.build?.repo).filter(Boolean).map(value => path.resolve(value)));
    if (fixTrees.size && buildRepos.size && ![...buildRepos].some(repo => fixTrees.has(repo))) throw new Error("summary.runJson: 실행기 fixTree와 QA build.repo가 다릅니다.");
    if (!unattendedVerify?.pending && (!unattendedVerify || typeof unattendedVerify !== "object" || typeof unattendedVerify.runDir !== "string" || path.resolve(unattendedVerify.runDir) !== path.dirname(runFile) || !Array.isArray(unattendedVerify.changed) || unattendedVerify.changed.some(v=>typeof v!=="string")))
      throw new Error("summary.runJson: verify.json 형식이 올바르지 않습니다.");
  }
  const summary = { passed: [], failed: [], fixed: [], unable: [], obstacles: [], unverified: [], builds: [], riskResults: [], catalogUpdates: [], listReviews: [], humanTasks: [], unattendedVerify };
  const named = (run, row) => `${run.runId} · ${row.what || row.id}`;
  // 첫 칸 제외: 세션 기록의 미확인 범위·사람 확인으로 이미 표시한 항목
  const scopeNotes = new Set(), shownRows = new Set(), shownDefects = new Set();
  for (const run of runs) {
    summary.builds.push({ runId: run.runId, begin: run.begin.build, end: run.end?.build });
    summary.riskResults.push(...qaRiskResults(run.events,run.rows).map(result=>({...result,runId:run.runId})));
    for (const row of run.rows) {
      const label = named(run, row);
      if (run.reportable && allGreen(row)) summary.passed.push(label);
      else if (row.paths.some(lane => row.walked[lane]?.color === "red")) summary.failed.push(label);
      else summary.unable.push(`${label} · ${row.paths.map(lane => row.walked[lane]?.note || `${lane} 미확인`).join(" / ")}`);
    }
    for (const record of run.events) {
      const e = record.event;
      if (e.kind === "catalog_update") summary.catalogUpdates.push({ runId: run.runId, item: e.detail?.removed ? "삭제" : e.detail?.item, previous: e.detail?.previous });
      // 세션이 사람 승인 없이 바꾼 목록은 사람이 보고 되돌릴 수 있게 할 일로
      if (e.kind === "catalog_update" && e.detail?.by === "세션 판단") {
        const describe = item => [item?.class, item?.condition && JSON.stringify(item.condition)].filter(Boolean).join(" ");
        summary.humanTasks.push(`반응 목록 변경 확인: ${describe(e.detail.previous)} → ${e.detail.removed ? "삭제" : describe(e.detail.item)} · 이유: ${e.detail.cause || "기록 없음"} · 틀렸으면 세션에 되돌려 달라고 요청(승인 창에서 승인)`);
      }
      if (e.kind === "list_review") summary.listReviews.push({ runId: run.runId, review: e.detail?.review, inventory: e.detail?.inventory });
      if ((e.kind === "blocked" || e.cmd === "ask_user") && (!e.rowId || !qaRowReplay(run.events,e.rowId,record.seq).pass)) summary.unable.push(`${run.runId} · ${e.reason || "사람 확인 필요"}`);
      if (e.kind === "session_note" && ["막힘", "질문"].includes(e.detail?.kind)) summary.unable.push(`${run.runId} · ${e.detail.kind}: ${e.detail.text}`);
      if (e.kind === "failure" && e.detail?.captureError) summary.obstacles.push(`${run.runId} · 화면 기록 실패: ${e.detail.captureError}`);
      if (unstable(e.stability)) summary.obstacles.push(`${run.runId} #${record.seq} · 안정 전 촬영 · 남은 항목: ${(e.stability.remaining || []).map(item => item === "not-measured" ? "안정 여부 측정 안 됨" : item).join(", ")}`);
      if (e.kind !== "fix") continue;
      const defect = run.events.find(item => item.event.kind === "defect" && String(item.seq) === String(e.detail?.defect));
      if (!defect || !e.detail?.commit || !e.detail?.branch) continue;
      const retestResults = runs.flatMap(retest => retest.rows.filter(row => row.retestOf?.run === run.runId && String(row.retestOf?.defect) === String(defect.seq)
        && row.retestFix?.seq === record.seq && row.retestFix?.commit === e.detail.commit).map(row => ({
        run: retest.runId, row: row.id, name: named(retest, row),
        status: retest.reportable && allGreen(row) ? "통과" : row.paths.some(lane => row.walked[lane]?.color === "red") ? "실패" : "미확인",
      })));
      const retests = retestResults.map(result => `${result.name} · ${result.status}`);
      const diff = String(e.detail.diff || "");
      const diffStat = { files: e.detail.diffFiles || [], additions: (diff.match(/^\+(?!\+\+)/gm) || []).length, deletions: (diff.match(/^-(?!-\-)/gm) || []).length };
      const reasons = [e.detail.testReason, e.detail.cleanupReason].filter(Boolean);
      const affectedRows = e.detail.affectedRows || [];
      summary.fixed.push({ run: run.runId, defect: defect.seq, problem: defect.event.detail?.problem,
        commit: e.detail.commit, branch: e.detail.branch, summary: e.detail.summary, retests, retestResults, status: "사람 확인 전", diffStat, reasons, affectedRows, diagnosis:e.detail.diagnosis });
      summary.fixed.at(-1).evidence = `수정 전 실패 seq ${defect.event.detail?.failureSeq ?? "미기록"} · 재확인(수정 후) ${retests.join(", ") || "미확인"} · 영향 row ${affectedRows.join(", ") || "없음"}`;
      for (const reason of reasons) summary.humanTasks.push(`${run.runId} 결함 #${defect.seq} · 사람 확인 이유: ${reason}`);
      if (!retestResults.length || retestResults.some(result => result.status !== "통과")) summary.unable.push(`${run.runId} 결함 #${defect.seq} · 수정 후 재확인 ${retestResults.some(result => result.status === "실패") ? "실패" : "미확인"}`);
    }
    const record = run.end?.sessionRecord;
    if (!run.end) summary.unable.push(`${run.runId} · 회차 미종료`);
    if (!run.reportable) summary.unverified.push(`${run.runId} · 보고 조건 미충족: ${run.reportError}`);
    if (present(record?.remainingQuestions)) summary.unable.push(`${run.runId} · 중단 후 미해결: ${record.remainingQuestions}`);
    if (present(record?.unverified?.items)) { const text = `${run.runId} · ${record.unverified.items}: ${record.unverified.reason}`; summary.unable.push(text); scopeNotes.add(text); }
    for (const key of ["blockers", "risks"]) if (present(record?.[key])) summary.obstacles.push(`${run.runId} · ${record[key]}`);
    if (present(record?.unverified?.items)) summary.unverified.push(`${run.runId} · ${record.unverified.items}`);
    if (present(run.begin.charter?.exclusions)) summary.unverified.push(`${run.runId} · 제외 범위: ${run.begin.charter.exclusions}`);
  }
  for (const run of runs) {
    const remediation=deriveQaRemediation(run.events);
    for (const d of remediation.defects) {
      if (['사람 확인','고치지 못함'].includes(d.status)) shownDefects.add(`${run.runId} 결함 #${d.seq} ·`);
      if (['사람 확인','고치지 못함'].includes(d.status)) summary.humanTasks.push(`${run.runId} 결함 #${d.seq} · ${d.status} · ${d.reason || '마지막 수정 시도 확인 필요'}`);
    }
    for(const h of run.events.filter(r=>r.event.kind==='human_review' && r.event.detail.row)) {
      const label=named(run,run.rows.find(row=>row.id===h.event.detail.row) || {id:h.event.detail.row});
      shownRows.add(label+' ·');
      summary.humanTasks.push(`${label} · 사람 확인 · ${h.event.detail.reason}`);
    }
    for(const row of remediation.pendingRows)summary.humanTasks.push(`${run.runId} 항목 ${row.row} · 재실행 필요`);
    for(const item of summary.fixed.filter(f=>f.run===run.runId)) {
      const fix=run.events.find(r=>r.event.kind==='fix' && r.event.detail.commit===item.commit && r.event.detail.defect===item.defect);
      const state=remediation.defects.find(d=>d.seq===item.defect);
      const retests=runs.flatMap(other=>other.events.filter(r=>r.event.kind==='play_result' && r.event.detail.retestOf?.run===run.runId && r.event.detail.retestOf?.defect===item.defect && r.event.detail.retestFix?.seq===fix.seq && r.event.detail.retestFix?.commit===item.commit && (other.runId!==run.runId || r.seq>fix.seq)).map(r=>({run:other,record:r})));
      const last=retests.at(-1);
      item.status=state?.fixSeq===fix.seq ? state.status : '이전 수정';
      if(last?.record.event.detail.pass===true && item.affectedRows.length===0 && state?.fixSeq===fix.seq && state?.status==='수정 미확인' && qaRowReplay(last.run.events,last.record.event.rowId,last.run.runId===run.runId?fix.seq:0).pass)item.status='수정 확인';
      item.impactResults=item.affectedRows.map(row=>({row,pass:qaRowReplay(run.events,row,fix.seq).pass}));
      item.retestResults=retests.map(({run:other,record})=>({run:other.runId,row:record.event.rowId,name:named(other,{id:record.event.rowId}),status:record.event.detail.pass?'통과':'실패'}));
      item.retests=item.retestResults.map(r=>`${r.name} · ${r.status}`);
      const defect=run.events.find(r=>r.seq===item.defect);
      item.before={run:run.runId,seq:defect.event.detail?.failureSeq};
      item.after=last && {run:last.run.runId,seq:last.record.event.detail.shotSeq};
      item.evidence=`수정 전 실패 seq ${item.before.seq ?? '미기록'} · 재확인(수정 후) ${item.retests.join(', ') || '미확인'} · 영향 row ${item.impactResults.map(r=>`${r.row}: ${r.pass?'통과':'미확인'}`).join(', ') || '없음'}`;
      summary.humanTasks.push(`병합 여부: branch ${item.branch} · commit ${item.commit} · diff ${item.diffStat.files.length} files +${item.diffStat.additions} -${item.diffStat.deletions}`);
    }
  }
  summary.unable=summary.unable.filter(text=>!summary.fixed.some(f=>f.status==='수정 확인' && text.startsWith(`${f.run} 결함 #${f.defect} · 수정 후 재확인`)));
  for (const item of summary.unable) if (!scopeNotes.has(item) && ![...shownRows,...shownDefects].some(prefix => item.startsWith(prefix))) summary.humanTasks.push(item);
  if (unattendedVerify?.pending) summary.humanTasks.push(`실행기 verify 결과: 세션이 끝난 뒤 실행기가 worktree 밖 상태를 대조해 ${unattendedVerify.file} 에 기록하고 이 보고서를 다시 만듭니다`);
  else if (unattendedVerify) summary.humanTasks.push(`실행기 verify 결과: ${unattendedVerify.changed.length ? "worktree 밖 상태 변화 있음" : "worktree 밖 상태 변화 없음"} · ${unattendedVerify.changed.join(", ") || "변경 항목 없음"} · ${unattendedVerify.note || "실행기의 검사 대상 기준"}`);
  const list = values => values.length ? `<ul>${values.map(value => `<li>${esc(value)}</li>`).join("")}</ul>` : "<p>기록 없음</p>";
  const build = value => value ? `${esc(value.repo)} · HEAD ${esc(value.head)} · branch ${esc(value.branch ?? "(detached HEAD)")} · dirty ${value.dirty ? "true" : "false"}` : "미기록";
  // 회차별 사진·조작 기록은 그 회차 보고서로 연결만 함. 여섯 회차 사진 원본을 모두 넣어 195MB 가 되고, 연 탭 하나가 1.8GB·CPU 89% 를 쓴 사례
  const scenes = `<section><h2>회차별 보고서</h2><ul>${runs.map(run => {
    const folder = ledger.paths(run.runId).folder;
    const links = ["report.html", "report-dev.html"].filter(name => fs.existsSync(path.join(folder, name)))
      .map(name => `<a href="${esc(pathToFileURL(path.join(folder, name)).href)}">${name === "report.html" ? "보고서" : "개발자용 상세 기록"}</a>`);
    return `<li>${esc(run.runId)} · ${links.length ? links.join(" · ") : "qa_report 로 보고서를 만든 뒤 볼 수 있음"}</li>`;
  }).join("")}</ul></section>`;
  const shotLink=(point,label)=>{
    const run=point && runs.find(r=>r.runId===point.run);
    const record=run?.events.find(r=>r.seq===point.seq);
    // 결함 failureSeq는 반응 기록, 실패 사진 기록의 failureSeq는 그 직전 조작 기록
    const action=record?.event.kind==='reaction' ? run.events.findLast(r=>r.seq<point.seq && r.event.kind==='action')?.seq : undefined;
    const shot=record?.event.shot || run?.events.find(r=>r.event.kind==='failure' && [point.seq,action].includes(r.event.detail?.failureSeq))?.event.shot;
    return shot ? `<a href="${esc(pathToFileURL(path.resolve(ledger.paths(point.run).folder,shot)).href)}">${label} #${point.seq}</a>` : `${label} 장면 미기록`;
  };
  const humanDiffs=runs.flatMap(run=>run.events.filter(r=>r.event.kind==='fix' && (r.event.detail.testReason || r.event.detail.cleanupReason)).map(r=>`<details><summary>${esc(run.runId)} 결함 #${r.event.detail.defect} · ${esc([r.event.detail.testReason,r.event.detail.cleanupReason].filter(Boolean).join(' · '))}</summary><pre>${esc(r.event.detail.diff)}</pre></details>`)).join('');
  const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA 요약</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;color:#17212b;background:#fff}section{margin:32px 0}img{max-width:100%;max-height:700px}li{margin:8px 0}dt{font-weight:600}dd{margin-bottom:16px;overflow-wrap:anywhere}</style><body><h1>QA 요약</h1><p>판정과 고침: 사람 확인 전</p>
    <section><h2>사람이 할 일</h2>${list(summary.humanTasks)}${humanDiffs}</section>
    <section><h2>빌드</h2><dl>${summary.builds.map(item => `<dt>${esc(item.runId)} 시작</dt><dd>${build(item.begin)}</dd><dt>종료</dt><dd>${build(item.end)}</dd>`).join("")}</dl></section>
    <section><h2>위험별 완료 근거</h2>${summary.riskResults.length ? `<ul>${summary.riskResults.map(item => `<li>${esc([item.runId, item.id, item.risk, item.decision, item.result, item.reason, `관련 항목 ${item.rows.join(", ") || "없음"}`].filter(Boolean).join(" · "))}</li>`).join("")}</ul>` : "<p>기록 없음</p>"}</section>
    <section><h2>목록 검토</h2>${summary.listReviews.length ? `<ul>${summary.listReviews.map(item => `<li>${esc(item.runId)} · ${esc(prose(item.review || item.inventory))}</li>`).join("")}</ul>` : "<p>기록 없음</p>"}</section>
    <section><h2>반응 목록 변경</h2>${summary.catalogUpdates.length ? `<ul>${summary.catalogUpdates.map(item => `<li>${esc(item.runId)} · ${esc(prose(item.item))} · 이전 ${esc(prose(item.previous))}</li>`).join("")}</ul>` : "<p>기록 없음</p>"}</section>
    <section><h2>통과</h2>${list(summary.passed)}</section><section><h2>실패</h2>${list(summary.failed)}</section>
    <section><h2>고침</h2>${summary.fixed.length ? `<ul>${summary.fixed.map(item => `<li>${esc(item.run)} 결함 #${item.defect} · ${esc(item.problem)}<br>${esc(item.summary)}<br>commit ${esc(item.commit || "없음")} · branch ${esc(item.branch || "없음")} · diff ${item.diffStat.files.length} files +${item.diffStat.additions} -${item.diffStat.deletions}<br>원인: ${esc(item.diagnosis?.source)} · ${esc(item.diagnosis?.reason)}<br>사람 확인 이유: ${esc(item.reasons.join(" · ") || "없음")}<br>${shotLink(item.before,"수정 전")} · ${shotLink(item.after,"수정 후")} · 수정 전·후·영향: ${esc(item.evidence)} · ${esc(item.status)}</li>`).join("")}</ul>` : "<p>기록 없음</p>"}</section>
    <section><h2>못 함</h2>${list(summary.unable)}</section><section><h2>확인 방해 문제</h2>${list(summary.obstacles)}</section><section><h2>미확인 영역</h2>${list(summary.unverified)}</section>
    <section><h2>장부 확인 실패</h2>${list(rejectedRuns.map(item => `${item.runId} · ${item.reason}`))}</section>${scenes}</body></html>`;
  const dir = ledger.paths(runIds[0]).folder;
  const digest = crypto.createHash("sha256").update(JSON.stringify(runIds)).digest("hex").slice(0, 16);
  const file = out || path.join(dir, `summary-${digest}.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return { ok: true, path: file, runIds, verifiedRuns: runs.map(run => run.runId), rejectedRuns, summary };
}
