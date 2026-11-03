import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { QA_ORACLES } from "./qa-session-contract.js";

export const RISK_SIZES = Object.freeze(["high", "mid", "low"]);
export const RISK_KNOWLEDGE = Object.freeze(["lots", "some", "little", "none"]);
export const RISK_DECISIONS = Object.freeze(["test", "investigate", "accept", "delegate"]);

const text = (value, label) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: 값이 필요합니다.`);
  return value.trim();
};

export function validateQaPlanList(plan) {
  if (!plan || typeof plan !== "object") throw new Error("plan: 객체가 필요합니다.");
  if (!Array.isArray(plan.risks) || !plan.risks.length) throw new Error("plan.risks: 위험 목록이 필요합니다.");
  text(plan.listRationale, "plan.listRationale");
  const ids = new Set();
  const risks = plan.risks.map((risk, i) => {
    const id = text(risk?.id, `plan.risks[${i}].id`);
    if (ids.has(id)) throw new Error(`plan.risks: 중복 id ${id}`);
    ids.add(id);
    const size = text(risk?.size, `plan.risks[${i}].size`);
    const knowledge = text(risk?.knowledge, `plan.risks[${i}].knowledge`);
    const decision = text(risk?.decision, `plan.risks[${i}].decision`);
    if (!RISK_SIZES.includes(size) || !RISK_KNOWLEDGE.includes(knowledge) || !RISK_DECISIONS.includes(decision))
      throw new Error(`plan.risks[${i}]: size·knowledge·decision 값이 잘못되었습니다.`);
    const out = { id, risk: text(risk?.risk, `plan.risks[${i}].risk`), size, knowledge, decision };
    if (decision === "accept" || decision === "delegate") out.reason = text(risk?.reason, `plan.risks[${i}].reason`);
    else if (risk?.reason) out.reason = text(risk.reason, `plan.risks[${i}].reason`);
    return out;
  });
  return { ...plan, risks, listRationale: plan.listRationale.trim() };
}

function sourcePath(repo, value, related = []) {
  const match = typeof value === "string" && value.match(/^(.*?):(\d+)$/);
  if (!match) return { ok: false, source: "미확인", tried: [String(value || "")] };
  const root=fs.realpathSync(repo || ".");
  // 회차 저장소나 계획의 관련 저장소(build.related) 안의 경로만 허용. 상대 경로는 회차 저장소 기준
  const roots=[root,...(Array.isArray(related)?related:[]).flatMap(dir=>{try{return [fs.realpathSync(dir)];}catch{return [];}})];
  const inside=p=>roots.some(r=>p===r||p.startsWith(r+path.sep));
  const file = path.resolve(root, match[1]);
  if(!inside(file))return {ok:false,tried:[file]};
  const line = Number(match[2]);
  if (!fs.existsSync(file)) return { ok: false, source: "미확인", tried: [file] };
  const real=fs.realpathSync(file);
  if(!inside(real))return {ok:false,tried:[real]};
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  if (line < 1 || line > lines.length) return { ok: false, source: "미확인", tried: [`${file}:${line}`] };
  return { ok: true, file, line, hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}

export function validateQaDeclaration(input, options = {}) {
  const d = input?.rowData || input || {};
  for (const key of ["risk", "oracle", "mustNotChange"]) if (!Object.hasOwn(d, key)) throw new Error(`declare.${key}: 필수 항목`);
  if (!Array.isArray(d.risk) || !d.risk.length || d.risk.some(v => typeof v !== "string" || !v.trim())) throw new Error("declare.risk: 위험 id가 필요합니다.");
  // 보고서 검사 basis 와 같은 기준을 선언 때 적용
  if (typeof d.basisNote !== "string" || !d.basisNote.trim()) throw new Error("declare.basisNote: 기대의 출처를 설명하는 근거가 필요합니다.");
  const oracle = text(d.oracle, "declare.oracle");
  if (QA_ORACLES.includes(oracle)) throw new Error(`declare.oracle: 판정 근거 설명이 필요합니다. "${oracle}: <이 항목에 적용한 근거>" 형식으로 기준 이름 뒤에 설명을 붙입니다.`);
  if (typeof d.dataChanging !== "boolean") throw new Error("declare.dataChanging: boolean 값이 필요합니다.");
  if (!Array.isArray(d.mustNotChange) && !(d.mustNotChange && typeof d.mustNotChange === "object")) throw new Error("declare.mustNotChange: 구조화 목록이 필요합니다.");
  const na = d.mustNotChange?.notApplicable === true;
  if (!na && (!Array.isArray(d.mustNotChange) || !d.mustNotChange.length)) throw new Error("declare.mustNotChange: 항목이 필요합니다.");
  if (na && (typeof d.mustNotChange.reason !== "string" || !d.mustNotChange.reason.trim())) throw new Error("declare.mustNotChange.reason: 사유가 필요합니다.");
  // 스키마와 unchangedExpectations 가 받는 대상(sel, role+name, text)과 같게. text 만 적은 선언 48건이 거부된 사례
  if(Array.isArray(d.mustNotChange))for(const item of d.mustNotChange)if(!item.sel && !(item.role && item.name) && !item.text)
    throw Error(`mustNotChange 대상이 필요합니다: ${JSON.stringify(item)}. 화면에서 찾을 sel, role+name, text 중 하나를 적습니다`);
  if (d.dataChanging && (!Array.isArray(d.consumers) || !d.consumers.length)) throw new Error("declare.consumers: 소비자 경로가 필요합니다.");
  if (Array.isArray(d.consumers)) for (const [i, consumer] of d.consumers.entries()) {
    if (consumer?.source === "미확인") { if (!Array.isArray(consumer.attempts) || !consumer.attempts.length || consumer.attempts.some(value=>typeof value!=="string" || !value.trim())) throw new Error(`declare.consumers[${i}]: 시도한 검색이 필요합니다.`); continue; }
    const check = sourcePath(options.repo, typeof consumer === "string" ? consumer : consumer?.source, options.related);
    if (!check.ok) throw new Error(`declare.consumers[${i}]: 경로를 찾을 수 없습니다 (${check.tried.join(", ")})`);
  }
  // 첫 실행이 바꾼 데이터 때문에 수정 뒤 재실행이 거짓으로 실패하지 않도록 재실행 방식을 선언
  if (d.rerun !== undefined && (!["setup", "generated", "human"].includes(d.rerun?.mode) || typeof d.rerun.reason !== "string" || !d.rerun.reason.trim()))
    throw new Error("declare.rerun: mode(setup·generated·human)와 reason이 필요합니다.");
  if (d.dataChanging && !d.rerun) throw new Error("declare.rerun: 데이터를 바꾸는 항목은 수정 뒤 다시 실행할 방식을 정합니다. setup: 앞 단계(setup:true)에서 시작 상태를 만들고 재실행 때 그 단계부터 다시 실행. 시작 상태를 만들 수 없으면 generated: 확인 대상이 아닌 입력값에 {{unique}}를 넣어 실행마다 새 값 사용. 둘 다 안 되면 human: 사람 확인. reason에 고른 이유를 적습니다.");
  return { ...d, risk: [...new Set(d.risk)], oracle, mustNotChange: d.mustNotChange, dataChanging: d.dataChanging, ...(d.dataChanging ? { consumers: d.consumers } : {}), ...(d.rerun ? { rerun: d.rerun } : {}) };
}

export function unchangedExpectations(row) {
  if (!Array.isArray(row?.mustNotChange)) return [];
  return row.mustNotChange.map((item, i) => ({ id: `unchanged-${row.id || "row"}-${i + 1}`, type: "unchanged",
    ...(item.sel ? { sel: item.sel } : {}), ...(item.role ? { role: item.role, name: item.name } : {}),
    ...(item.text ? { text: item.text } : {}), reason: item.reason || "변경되면 안 되는 항목", oracle: QA_ORACLES.find(name=>row.oracle?.startsWith(name)) || "기능의 용도" }));
}

export function reviewQaList({ plan, rows = [], repo, review } = {}) {
  const normalized = validateQaPlanList(plan);
  const risks = new Map(normalized.risks.map(r => [r.id, r]));
  const seen = new Map(), duplicates = [];
  for (const row of rows) {
    const d = row.rowData || row;
    validateQaDeclaration(d, { repo, related: plan?.build?.related });
    for (const id of d.risk) if (!risks.has(id)) throw new Error(`row ${d.id}: 없는 risk ${id}`);
    for (const [key, previous] of seen) if (key.startsWith(`${d.given}\u0000`) && d.risk.some(id => previous.risk.includes(id))) duplicates.push({ rows: [previous.id, d.id], given: d.given, risk: d.risk.filter(id => previous.risk.includes(id)) });
    seen.set(`${d.given}\u0000${d.id}`, { id: d.id, risk: d.risk });
  }
  const covered = new Set(rows.flatMap(row => (row.rowData || row).risk || []));
  for (const risk of normalized.risks) {

    if (["accept", "delegate"].includes(risk.decision) && covered.has(risk.id)) throw new Error(`risk ${risk.id}: ${risk.decision} 위험에 row가 있습니다.`);
  }
  const unresolved = duplicates.filter(candidate => !review?.duplicates?.some(d => d.rows?.length === candidate.rows.length && candidate.rows.every(id => d.rows.includes(id)) && d.reason));
  if (review) {
    if (!review.distribution || !review.missingRisks) throw new Error("목록 검토의 분포·빠진 위험 판단이 필요합니다.");
    const answered = new Set((review.information || []).map(v => v.row || v.id));
    for (const row of rows) if (!answered.has((row.rowData || row).id)) throw new Error(`row ${(row.rowData || row).id}: information 판단이 없습니다.`);
  }
  const rowFingerprints = Object.fromEntries(rows.map(row => { const d = row.rowData || row; return [d.id, crypto.createHash("sha256").update(JSON.stringify(d)).digest("hex")]; }));
  return { plan: normalized, rows, duplicates, unresolved, consumersUnknown: rows.filter(row => (row.rowData || row).consumers?.some(c=>c.source === "미확인")),
    riskGroups:normalized.risks.map(risk=>({risk,rows:rows.filter(row=>row.risk.includes(risk.id)).map(row=>row.id)})),
    distribution:{paths:rows.flatMap(row=>row.paths || []),basis:rows.map(row=>row.basis)},
    dataChangingWithoutInvariants:rows.filter(row=>row.dataChanging && row.mustNotChange?.notApplicable), rowFingerprints, fingerprint: crypto.createHash("sha256").update(JSON.stringify({ risks: normalized.risks, rows })).digest("hex") };
}

export function assertReviewed(inventory, review) {
  if (!review || !Array.isArray(review.information) || !Array.isArray(review.duplicates) || typeof review.distribution !== "string" || typeof review.missingRisks !== "string") throw new Error("목록 검토 답이 불완전합니다.");
  if(!review.distribution.trim() || !review.missingRisks.trim())throw Error("분포·빠진 위험 검토 문장이 필요합니다");
  const ids = new Set(inventory.rows.map(row => (row.rowData || row).id));
  if (review.fingerprint && review.fingerprint !== inventory.fingerprint) throw new Error("목록이 바뀌어 재검토가 필요합니다.");
  if (review.rowFingerprints) for (const [id, fingerprint] of Object.entries(review.rowFingerprints)) if (inventory.rowFingerprints[id] !== fingerprint) throw new Error(`row ${id}: 변경되어 재검토가 필요합니다.`);
  for (const item of review.information) if (!ids.has(item.row || item.id) || !item.text) throw new Error("목록 검토 information이 빠졌습니다.");
  if (review.information.length !== ids.size || new Set(review.information.map(item => item.row || item.id)).size !== ids.size) throw new Error("목록 검토 information이 빠졌습니다.");
  for(const item of review.duplicates) {
    if(!Array.isArray(item.rows) || item.rows.length!==2 || new Set(item.rows).size!==2 || item.rows.some(id=>!ids.has(id)))throw Error("중복 판단의 항목이 목록에 없습니다");
    if(!inventory.duplicates.some(candidate=>candidate.rows.every(id=>item.rows.includes(id))))throw Error("목록에 없는 중복 후보입니다");
  }
  for(const item of review.information) if(item.sameAs && (!ids.has(item.sameAs) || item.sameAs===item.row || !["merge","split"].includes(item.decision) || !item.reason?.trim()))throw Error("다른 항목에서 함께 확인할 정보는 병합·분리 사유가 필요합니다");
  for (const candidate of inventory.duplicates) if (!review.duplicates.some(d => candidate.rows.every(id => d.rows?.includes(id)) && d.reason && ["merge", "split"].includes(d.decision))) throw new Error("중복 후보 판단이 빠졌습니다.");
  return { ok: true, fingerprint: inventory.fingerprint };
}


export function qaRiskResults(events, rows) {
  const plan=events.find(record=>record.event.kind==='run_begin')?.event.plan;
  const review=events.findLast(record=>record.event.kind==='list_review')?.event.detail?.review;
  const merged=new Map((review?.duplicates || []).filter(item=>item.decision==='merge').flatMap(item=>item.rows.slice(1).map(id=>[id,item.rows[0]])));
  for(const item of review?.information || [])if(item.sameAs && item.decision==='merge')merged.set(item.row,item.sameAs);
  return (plan?.risks || []).map(risk=>{
    const related=rows.filter(row=>row.risk?.includes(risk.id)&&!merged.has(row.id));
    const walks=related.flatMap(row=>row.paths.map(lane=>row.walked[lane]));
    const voided=new Set(events.filter(r=>r.event.kind==='row' && r.event.action==='void').map(r=>String(r.event.rowData?.receipt)));
    const evidence=related.every(row=>row.paths.every(lane=>events.some(r=>!voided.has(String(r.seq)) && r.event.rowId===row.id && r.event.path===lane && ['assertion','reaction'].includes(r.event.kind) && r.event.pass===true)));
    const result=risk.decision==='accept'?'수용':risk.decision==='delegate'?'위임':walks.some(w=>w?.color==='red')?'실패':!walks.length||walks.some(w=>!w || w.color!=='green')||!evidence?'막힘':'확인됨';
    return {id:risk.id,risk:risk.risk,decision:risk.decision,result,reason:risk.reason,rows:related.map(row=>row.id)};
  });
}
