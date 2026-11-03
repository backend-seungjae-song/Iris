import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { qaCandidateFailure } from "./qa-remediation.js";

const exec = promisify(execFile);
const text = { type: "string", minLength: 1 };
export const QA_FIX_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { defect: { type: "integer", minimum: 1 }, commit: text, summary: text,
    failureSeq: { type: "integer", minimum: 1 }, diagnosis: { type: "object", additionalProperties: false,
      properties: { source: text, reason: text }, required: ["source", "reason"] },
    testReason: text, cleanupReason: text },
  required: ["defect", "commit", "summary", "diagnosis"],
};
// 결함별 자동 수정 상한: 같은 실패의 무한 반복 방지
export const QA_FIX_MAX_ATTEMPTS = 2;
const requiredText = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: 값이 필요합니다.`);
  return value.trim();
};
const git = async (repo, args) => (await exec("git", ["-C", repo, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
const diagnosisText = (diagnosis) => {
  if (!diagnosis || typeof diagnosis !== "object") throw new Error("diagnosis: source·reason이 필요합니다.");
  const source = requiredText(diagnosis.source, "diagnosis.source");
  const reason = requiredText(diagnosis.reason, "diagnosis.reason");
  const match = /^(.*):(\d+)$/.exec(source);
  if (!match || Number(match[2]) < 1) throw new Error("diagnosis.source: file:line이 필요합니다.");
  return { source: `${match[1]}:${Number(match[2])}`, reason };
};
const diffFiles = async (repo, commit) => (await git(repo, ["diff", "--name-only", `${commit}^`, commit])).split(/\r?\n/).filter(Boolean);
const sourceFile = source => source.slice(0, source.lastIndexOf(":"));
const sourceLine = source => Number(source.slice(source.lastIndexOf(":") + 1));
const diffText = async (repo, commit) => git(repo, ["diff", "--unified=0", `${commit}^`, commit]);
export function calculateAffectedRows(events, changedFiles = [], repo = '', seedRow) {
  const normalize=value=>typeof value==='string' ? (path.isAbsolute(value.replace(/:\d+$/, '')) ? path.relative(repo,value.replace(/:\d+$/, '')) : value.replace(/:\d+$/, '').replace(/^\.\//,'')) : '';
  const files=new Set(changedFiles.map(normalize));
  const overlaps=value=>files.has(normalize(value));
  const direct=new Set(seedRow?[seedRow]:[]), catalog=new Set();
  for(const {event:e} of events) {
    const items=e.kind==='catalog_begin' ? e.detail?.catalog?.items || [] : e.kind==='catalog_update'?[e.detail?.item]:[];
    for(const item of items)if(item && overlaps(item.source))catalog.add(item.key);
  }
  for(const {event:e} of events) {
    const d=e.rowData || e.detail || {};
    const sources=[d.source,...(d.consumers || []).map(c=>typeof c==='string'?c:c.source)];
    const effects=[...(d.effects || []),...(e.expected?.effects || [])];
    if(e.rowId && (sources.some(overlaps) || effects.some(x=>catalog.has(x.catalogKey))))direct.add(e.rowId);
  }
  const surfaces=new Set(events.filter(r=>direct.has(r.event.rowId)).map(r=>r.event.surface).filter(Boolean));
  for(const {event:e} of events)if(e.rowId && surfaces.has(e.surface))direct.add(e.rowId);
  return [...direct];
}

function inspectDiff(diff) {
  const parts=[];let part;
  for(const line of diff.split(/\r?\n/)) {
    const header=/^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if(header) { part={file:header[2],added:[],removed:[]};parts.push(part); }
    else if(line.startsWith('+++ b/') && part)part.file=line.slice(6);
    else if(line.startsWith('+') && part)part.added.push(line.slice(1));
    else if(line.startsWith('-') && !line.startsWith('---') && part)part.removed.push(line.slice(1));
  }
  return parts;
}
const isTestFile=file=>/(^|\/)(?:tests?|__tests__)(?:\/|\.)|[.-](?:test|spec)\.[^/]+$/.test(file);

export async function applyQaFix({ ledger, runId, args }) {
  if (!Number.isSafeInteger(args.defect) || args.defect < 1) throw new Error("defect: 결함 기록의 정수 seq가 필요합니다.");
  const requestedCommit = requiredText(args.commit, "commit"), summary = requiredText(args.summary, "summary");
  const diagnosis = diagnosisText(args.diagnosis);
  if (args.failureSeq !== undefined && (!Number.isSafeInteger(args.failureSeq) || args.failureSeq < 1)) throw new Error("failureSeq: 실패 판정의 정수 seq가 필요합니다.");
  const verified = await ledger.verify(runId);
  const defect = verified.events.find(rec => rec.seq === args.defect && rec.event.kind === "defect");
  if (!defect) {
    const known = verified.events.filter(rec => rec.event.kind === "defect").map(rec => rec.seq);
    throw new Error(`이번 회차에 없는 결함입니다. defect에는 qa_defect 결과의 seq를 넣습니다. 이 회차의 결함 seq: ${known.join(", ") || "없음"}`);
  }
  // 반응 후보에서 나온 결함은 실패 판정이 없음: 후보가 기록된 반응 seq 가 실패 근거
  const candidate = defect.event.detail?.failureSeq == null ? qaCandidateFailure(verified.events, args.defect) : null;
  // 관찰·비교로 찾아 실패 판정 없이 기록한 결함(noFailure): failureSeq 없이 기록하고 재확인은 qa_play 통과로 판단
  const unbound = defect.event.detail?.failureSeq == null && !candidate;
  if (unbound && args.failureSeq !== undefined) throw new Error("실패 판정 없이 기록한 결함입니다. failureSeq 없이 qa_fix를 부릅니다.");
  // 실패 근거는 결함 기록으로 정해짐. 빼면 도구가 채우고, 다른 값을 넣으면 맞는 값을 알려 줌(불일치 거부 9건)
  const bound = candidate ? candidate.seq : Number(defect.event.detail?.failureSeq);
  if (!unbound && args.failureSeq === undefined) args = { ...args, failureSeq: bound };
  if (!unbound) {
    if (bound !== args.failureSeq)
      throw new Error(`결함 ${args.defect}의 실패 근거는 seq ${bound}입니다${candidate ? "(반응 후보가 기록된 반응)" : ""}. failureSeq를 빼거나 ${bound}를 넣습니다.`);
    if (args.failureSeq >= args.defect) throw new Error("failureSeq는 결함보다 앞선 실패 판정이어야 합니다.");
    const failure = candidate ? candidate.record : verified.events.find(rec => rec.seq === args.failureSeq && ((rec.event.kind === "assertion" && rec.event.pass === false) || (rec.event.kind === "reaction" && rec.event.pass === false)));
    if (verified.events.some(r=>r.event.kind==="row" && r.event.action==="void" && String(r.event.rowData?.receipt)===String(args.failureSeq))) throw Error("무효 처리한 실패 판정입니다.");
    if (!failure) throw new Error("실패 판정(K1 reaction 또는 qa_expect)이 없는 결함입니다.");
  }
  const prior = verified.events.filter(rec => rec.event.kind === "fix" && rec.event.detail?.defect === args.defect);
  if (prior.length >= QA_FIX_MAX_ATTEMPTS) {
    return ledger.append(runId, { kind: "fix", mode: "preparation", detail: { defect: args.defect, status: "고치지 못함", lastAttempt: prior.at(-1).event.detail } });
  }
  const build = verified.events.find(rec => rec.event.kind === "run_begin")?.event.build;
  // 시작 때 detached HEAD 이면 branch 가 null. 그때는 이름 있는 작업 브랜치면 모두 시작 브랜치와 다름
  if (!build?.repo) throw new Error("시작 회차의 저장소 기록이 필요합니다.");
  // 수정 커밋이 있는 저장소: 회차 저장소 또는 시작 때 기록한 관련 저장소(build.related)
  let repo = null, startBranch = null;
  for (const candidate of [{ repo: build.repo, branch: build.branch }, ...(Array.isArray(build.related) ? build.related : [])]) {
    if (!candidate?.repo) continue;
    try { await git(candidate.repo, ["rev-parse", "--verify", "--end-of-options", `${requestedCommit}^{commit}`]); }
    catch { continue; }
    repo = candidate.repo; startBranch = candidate.branch ?? null; break;
  }
  if (!repo) throw new Error(build.related?.length ? "시작 회차의 저장소와 관련 저장소에 없는 커밋입니다." : "시작 회차의 저장소에 없는 커밋입니다. 다른 저장소에서 고쳤으면 다음 회차의 plan.build.related에 그 저장소를 넣으세요.");
  let branch, commit;
  try { branch = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]); }
  catch { throw new Error("수정 커밋은 작업 브랜치에서 기록하세요."); }
  if (branch === startBranch && !branch.startsWith("qa-fix/")) throw new Error("시작 회차와 다른 작업 브랜치에서 수정하세요.");
  commit = await git(repo, ["rev-parse", "--verify", "--end-of-options", `${requestedCommit}^{commit}`]);
  try { await git(repo, ["merge-base", "--is-ancestor", commit, "HEAD"]); }
  catch { throw new Error("현재 작업 브랜치에 포함되지 않은 커밋입니다."); }
  const files = await diffFiles(repo, commit);
  const rawSource=sourceFile(diagnosis.source), line = sourceLine(diagnosis.source);
  const source=path.relative(repo,path.resolve(repo,rawSource));
  diagnosis.source=`${source}:${line}`;
  if (!files.includes(source)) throw new Error("diagnosis.source 파일이 수정 커밋에 포함되어야 합니다.");
  const actual=fs.realpathSync(path.resolve(repo,source));
  if(!actual.startsWith(fs.realpathSync(repo)+path.sep))throw Error("진단 파일은 저장소 안에 있어야 합니다");
  const bytes = fs.readFileSync(actual,"utf8");
  if (line > bytes.split(/\r?\n/).length) throw new Error("diagnosis.source 줄이 없습니다.");
  const diff = await diffText(repo, commit);
  const parts=inspectDiff(diff);
  if(files.some(file=>!parts.some(p=>p.file===file)))throw Error("수정 diff 파일을 해석하지 못했습니다. 사람 확인이 필요합니다");
  const productFiles=files.filter(file=>!isTestFile(file));
  // 환경 검사는 대소문자 무시, 표식 이름은 상수·플래그 모양만: qa-name 같은 제품 이름 제외
  const envMarker=/NODE_ENV|TEST_ENV|webdriver|(?:process\.env|import\.meta\.env).*test/i;
  const flagMarker=/\b(?:QA_[A-Z0-9_]+|__QA\w*|__TEST\w*|isTest|isTesting|testMode)\b/;
  if(parts.some(p=>productFiles.includes(p.file) && p.added.some(line=>envMarker.test(line) || flagMarker.test(line)))) throw new Error("제품 코드에 테스트 실행 여부 분기를 추가할 수 없습니다.");
  const testChanged=files.filter(isTestFile);
  const removedAssertion=parts.some(p=>isTestFile(p.file) && p.removed.some(line=>line.trim() && !/^\s*(?:\/\/|\*|[{}]);?\s*$/.test(line)));
  if (removedAssertion && !requiredText(args.testReason, "testReason")) throw new Error("단언 변경에는 testReason이 필요합니다.");
  const cleanup = files.filter(file => file !== source && !testChanged.includes(file));
  if (cleanup.length && !requiredText(args.cleanupReason, "cleanupReason")) throw new Error("수정과 무관한 파일에는 cleanupReason이 필요합니다.");
  const affectedRows = calculateAffectedRows(verified.events, files, repo, defect.event.rowId || defect.event.detail?.rowId);
  return ledger.append(runId, { kind: "fix", mode: "preparation", detail: { defect: args.defect, ...(unbound ? {} : { failureSeq: args.failureSeq }), commit, branch, ...(repo !== build.repo ? { repo } : {}), summary, diagnosis, diffFiles: files, otherFiles:files.filter(file=>file!==source), diff, ...(args.testReason ? { testReason: args.testReason } : {}), ...(args.cleanupReason ? { cleanupReason: args.cleanupReason } : {}), affectedRows } });
}

export async function validateQaRetest({ ledger, runId, retestOf }) {
  if (!retestOf || typeof retestOf !== "object" || Array.isArray(retestOf) || Object.keys(retestOf).some(key => !["run", "defect"].includes(key)))
    throw new Error("retestOf: run·defect를 지정하세요.");
  const run = requiredText(retestOf.run, "retestOf.run"), defect = retestOf.defect;
  if (!Number.isSafeInteger(defect) || defect < 1) throw new Error("retestOf.defect: 결함 기록의 정수 seq가 필요합니다.");
  const verified = await ledger.verify(run), current = await ledger.verify(runId);
  const session = verified.events.find(rec => rec.event.kind === "run_begin")?.event.session;
  const currentSession = current.events.find(rec => rec.event.kind === "run_begin")?.event.session;
  if (!session || session !== currentSession) throw new Error("재검증 대상 회차의 세션 소유권이 다릅니다.");
  if (!verified.events.some(rec => rec.seq === defect && rec.event.kind === "defect")) throw new Error("재검증 대상 회차에 없는 결함입니다.");
  const fix = verified.events.findLast(rec => rec.seq > defect && rec.event.kind === "fix" && rec.event.detail?.defect === defect);
  if (!fix || !fix.event.detail.commit) throw new Error("재검증 대상 결함의 수정 기록이 필요합니다.");
  return { retestOf: { run, defect }, retestFix: { seq: fix.seq, commit: fix.event.detail.commit } };
}
