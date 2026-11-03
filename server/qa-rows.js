import { quoteFromSource, listFromSource, nominalFault } from "./qa-row-contract.js";
import { validateQaRetest } from "./qa-fix.js";
export { validateQaDeclaration, unchangedExpectations, reviewQaList, validateQaPlanList } from "./qa-list-review.js";
import { validateQaDeclaration } from "./qa-list-review.js";

const text = (minLength = 1) => ({ type: "string", minLength });
const array = (items = text()) => ({ type: "array", items });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const choice = (...values) => ({ type: "string", enum: values });
const options = array(object({ pick: text(), then: text(), cost: text(0) }, ["pick", "then"]));
const from = object({ source: text(), pick: text(), usedIn: text() }, ["source", "pick"]);
const list = object({ name: text(), source: text(), from, items: array(object({ id: text(), text: text(), was: text(), shot: text() }, ["id", "text"])) });
const derivation = object({ source: text() }, ["source"]);
const instances = array(object({ input: text(), source_value: text(), observed: text(), evidence: text() }, ["input", "source_value", "observed", "evidence"]));
const invariant = object({sel:text(),role:text(),name:text(),text:text(),reason:text()});
const declaration = {
  risk:array(), oracle:text(), dataChanging:{type:"boolean"},
  rerun:object({mode:choice("setup","generated","human"),reason:text()},["mode","reason"]),
  mustNotChange:{anyOf:[{type:"array",minItems:1,items:invariant},object({notApplicable:{type:"boolean"},reason:text()},["notApplicable","reason"])]},
  consumers:array({anyOf:[text(),object({source:text(),attempts:array()},["source","attempts"])]}),
  id: text(), what: text(), given: text(), basis: choice("spec", "plan", "user", "code", "assumed"),
  basisNote: text(), paths: array(choice("정상", "경계", "실패")), quote: text(), source: text(), sourceShot: text(), covers: array(),
  derivation,
  retestOf: object({ run: text(), defect: { type: "integer", minimum: 1 } }, ["run", "defect"]),
  outOfCharter: { type: "boolean" },
};
export const QA_ROW_SCHEMA = object({
  action: choice("declare", "open", "close", "basis", "covers", "void", "aside", "note", "list", "begin", "end", "derivation"),
  ...declaration, row: text(), rowData: object(declaration), path: choice("정상", "경계", "실패"),
  sceneJudgment: text(), color: choice("red", "orange", "yellow", "green", "blue", "gray"), note: text(), name: text(),
  why: text(), receipt: text(), frames: array(), shot: text(), decide: text(), options, lean: text(), simple: { type: "boolean" },
  list, from, items: list.properties.items,
  instances, limitation: text(),
}, ["action"]);

const nonempty = (value) => typeof value === "string" ? value.trim() : "";
const requireText = (value, label) => {
  const result = nonempty(value);
  if (!result) throw new Error(`${label}: 값이 필요합니다.`);
  return result;
};
const checkFault = (label, value) => { const fault = nominalFault(label, value); if (fault) throw new Error(fault); };
const picksOf = (values) => (Array.isArray(values) ? values : []).map(v => ({
  pick: nonempty(v?.pick), then: nonempty(v?.then), ...(nonempty(v?.cost) ? { cost: nonempty(v.cost) } : {}),
})).filter(v => v.pick && v.then);
const quoteOf = (value) => {
  if (nonempty(value.quote)) return value.quote;
  if (!nonempty(value.source)) return undefined;
  const result = quoteFromSource(value.source);
  if (result?.error) throw new Error(result.error);
  return result?.quote;
};
const matches = (e, id, path) => e.rowId === id && e.path === path || (e.lanes || []).some(l =>
  Array.isArray(l) ? l[0] === id && l[1] === path : l.rowId === id && l.path === path);
const imagesOf = (e) => [e.shot, e.before, e.after, ...(e.shots || [])].filter(v => typeof v === "string" && v);
const receiptOf = (rec) => String(rec.seq);

// 실제 판정의 소속·사진 검증과 작성자가 적은 값의 구분
export function validateQaDerivation({ events, rowId, derivation }) {
  if (!derivation || typeof derivation !== "object") throw new Error("파생값 원천을 먼저 선언하세요.");
  const source = requireText(derivation.source, "derivation.source");
  if (!Array.isArray(derivation.instances) || derivation.instances.length < 2) throw new Error("파생값은 사례 2개 이상이 필요합니다.");
  const voided = new Set(events.filter(r => r.event.kind === "row" && r.event.action === "void").map(r => r.event.rowData?.receipt));
  const evidence = new Set();
  const checked = derivation.instances.map((value, index) => {
    const item = Object.fromEntries(["input", "source_value", "observed", "evidence"].map(key => [key, requireText(value?.[key], `instances[${index}].${key}`)]));
    item.observed = value.observed;
    if (!/^[1-9]\d*$/.test(item.evidence)) throw new Error("파생값 근거는 판정 영수증의 seq여야 합니다.");
    const receipt = events.find(rec => receiptOf(rec) === item.evidence && rec.event.kind === "assertion");
    if (!receipt || voided.has(item.evidence)) throw new Error("파생값 근거가 없거나 무효 처리되었습니다.");
    if (!receipt.event.shot) throw new Error("파생값 판정의 장면이 없습니다.");
    const e = receipt.event;
    if (typeof e.observed !== "string" || !nonempty(e.observed)) throw new Error("실제 관찰값이 기록된 판정 영수증이 필요합니다.");
    if (item.observed !== e.observed) throw new Error("기입한 observed가 판정 영수증의 실제 관찰값과 다릅니다.");
    if (e.rowId !== rowId && !(e.lanes || []).some(l => Array.isArray(l) ? l[0] === rowId : l.rowId === rowId))
      throw new Error("다른 확인 항목의 판정으로 파생값을 증명할 수 없습니다.");
    if (evidence.has(item.evidence)) throw new Error("서로 다른 사례에 같은 판정 영수증을 쓸 수 없습니다.");
    evidence.add(item.evidence);
    return item;
  });
  if (new Set(checked.map(item => item.input)).size < 2) throw new Error("서로 다른 input이 2개 이상 필요합니다.");
  const limitation = nonempty(derivation.limitation);
  if (new Set(checked.map(item => item.observed)).size < 2 && !limitation) throw new Error("관찰 결과가 한 종류면 limitation이 필요합니다.");
  return { source, instances: checked, ...(limitation ? { limitation } : {}),
    sourceValueOrigin: "user_claim", observedOrigin: "assertion" };
}

// 항목마다 같은 장부를 다시 훑지 않게 장부 하나에 한 번만 만드는 색인. 조작마다 장부 전체를 다시 찾아 항목 수 × 줄 수² 가 된 사례(설치본 120초 할당 185MB)
const indexes = new WeakMap();
function indexOf(events) {
  let index = indexes.get(events);
  // 같은 배열에 줄을 더한 뒤 다시 부르면 새로 만듦
  if (!index || index.length !== events.length) {
    index = { length: events.length, voided: new Set(), reacted: new Set() };
    for (const r of events) {
      if (r.event.kind === "row" && r.event.action === "void") index.voided.add(r.event.rowData.receipt);
      if (r.event.kind === "reaction") index.reacted.add(r.event.acceptedSeq);
    }
    indexes.set(events, index);
  }
  return index;
}

function evidence(events, id, path) {
  const { voided, reacted } = indexOf(events);
  const aside = new Set(events.filter(r => r.event.kind === "row" && r.event.action === "aside" && matches(r.event, id, path)).flatMap(r => r.event.rowData.frames || []));
  // 자동으로 닫힌 뒤 다시 연 것은 같은 걸음의 이어짐이라 그 앞의 open 부터 셈. 막힘 뒤 다시 열자 통과한 판정이 빠져 전부 다시 실행한 사례
  const lane = events.filter(r => r.event.kind === "row" && ["open", "close"].includes(r.event.action) && matches(r.event, id, path));
  let opened = null;
  for (let i = lane.length - 1; i >= 0; i--) {
    if (lane[i].event.action !== "open") continue;
    opened = lane[i];
    if (!(lane[i - 1]?.event.action === "close" && lane[i - 1].event.rowData?.automatic)) break;
  }
  let frames = 0, receipts = 0, failed = 0;
  for (const rec of events) {
    const e = rec.event;
    if (e.kind === "row" || !matches(e, id, path) || opened && rec.seq < opened.seq) continue;
    if (e.kind === "assertion" || e.kind === "reaction" && typeof e.pass === "boolean"
      || e.kind === "action" && e.expected && !reacted.has(e.acceptedSeq)) {
      if (voided.has(receiptOf(rec))) continue;
      receipts++;
      if (e.pass !== true) failed++;
    }
    frames += imagesOf(e).filter(p => !aside.has(p)).length;
  }
  return { frames, receipts, failed };
}

// 검증된 장부에서만 확인 항목과 열린 경로 집계
export function deriveQaRows(events) {
  const rows = new Map(), lists = [], notes = [], open = [];
  for (const rec of events) {
    const e = rec.event;
    if (e.kind !== "row") continue;
    const d = e.rowData || {}, id = e.rowId;
    if (e.action === "declare") rows.set(id, { ...d, outOfCharter: d.outOfCharter === true, id, walked: {}, state: "declared" });
    else if (e.action === "list" && d.items) lists.push(d);
    else if (e.action === "note") notes.push({ ...d, ...(e.shot ? { shot: e.shot } : {}) });
    else if (e.action === "open") {
      if (!open.some(l => l.id === id && l.path === e.path)) open.push({ id, path: e.path });
      if (rows.has(id)) rows.get(id).state = "open";
    } else if (e.action === "close") {
      const row = rows.get(id);
      if (row) { row.walked[e.path] = d; row.state = row.paths.every(p => row.walked[p]) ? "closed" : "open"; }
      const at = open.findIndex(l => l.id === id && l.path === e.path);
      if (at >= 0) open.splice(at, 1);
    } else if (e.action === "covers" && rows.has(id)) rows.get(id).covers = d.covers;
    else if (e.action === "derivation" && rows.has(id) && rows.get(id).derivation) {
      const row = rows.get(id);
      row.derivation = { ...d.derivation, source: row.derivation.source };
    }
    else if (e.action === "basis" && rows.has(id)) {
      const row = rows.get(id);
      if (d.quote) row.quotes = [...(row.quotes || (row.quote ? [row.quote] : [])), d.quote];
      for (const key of ["source", "basisNote", "what"]) if (d[key]) row[key] = d[key];
      if (e.shot) row.sourceShot = e.shot;
    }
    if (e.action === "declare" && e.shot && rows.has(id)) rows.get(id).sourceShot = e.shot;
  }
  const values = [...rows.values()];
  for (const row of values) for (const path of Object.keys(row.walked))
    row.walked[path] = { ...row.walked[path], ...evidence(events, row.id, path) };
  const covered = new Set(values.flatMap(r => r.covers || []));
  const coverage = lists.map(s => ({ name: s.name, total: s.items.length, missing: s.items.filter(it => !covered.has(it.id)).map(it => it.id) }));
  const gaps = values.flatMap(r => r.paths.filter(p => !r.walked[p]).map(path => ({ rowId: r.id, path })))
    .concat(coverage.filter(c => c.missing.length).map(c => ({ list: c.name, missing: c.missing })));
  return { rows: values, open, openLanes: open, lists, list: lists, notes, coverage, gaps,
    groups: [...new Set(values.map(r => r.given))].map(given => ({ given, rows: values.filter(r => r.given === given).map(r => r.id) })) };
}

export async function applyQaRow({ ledger, runId, args }) {
  const verified = await ledger.verify(runId), state = deriveQaRows(verified.events);
  const action = ({ begin: "open", end: "close" })[args.action] || args.action;
  if (action !== "declare" && Object.hasOwn(args, "derivation")) throw new Error("선언한 파생값 원천은 변경하거나 제거할 수 없습니다.");
  const id = nonempty(args.row || args.id || args.rowData?.id);
  const row = state.rows.find(r => r.id === id);
  const knownImages = new Set(verified.events.flatMap(r => imagesOf(r.event)));
  const requireImage = (value) => {
    if (!knownImages.has(value)) throw new Error("이번 회차의 장부에 없는 장면입니다.");
    return value;
  };
  let path = args.path, rowData, shot;
  const checkCovers = (items) => {
    const values = [...new Set((items || []).map(v => requireText(v, "covers")))];
    const known = new Set(state.lists.flatMap(s => s.items.map(it => it.id)));
    if (known.size && values.some(v => !known.has(v))) throw new Error("목록에 없는 covers 항목입니다.");
    return values;
  };
  if (action === "declare") {
    const d = args.rowData || args;
    const plan = verified.events.find(r=>r.event.kind === "run_begin")?.event.plan;
    const contract = plan?.risks ? validateQaDeclaration(d, {repo:plan.build?.repo, related:plan.build?.related}) : null;
    if(contract) for(const risk of contract.risk) {
      const declared=plan.risks.find(item=>item.id===risk);
      if(!declared || ["accept","delegate"].includes(declared.decision)) throw Error("row의 risk는 test·investigate 위험이어야 합니다");
    }
    // 판정이 생긴 뒤에는 선언을 고치면 증거와 어긋나므로 거부. 조작 전 거부·전달 실패처럼 판정 없는 시도만 있으면 고칠 수 있음
    // 조작 전 거부 한 번 뒤 mustNotChange 하나를 고치려고 새 항목을 만들어야 했던 사례(qa-295879da I1→I4)
    const voids = new Set(verified.events.filter(r => r.event.kind === "row" && r.event.action === "void").map(r => String(r.event.rowData?.receipt)));
    if (row && verified.events.some(r => r.event.rowId === id && !voids.has(String(r.seq))
      && (r.event.kind === "assertion" || r.event.kind === "reaction" && typeof r.event.pass === "boolean")))
      throw new Error(`이미 있는 줄입니다: ${id}. 판정 기록이 있는 항목은 선언을 고칠 수 없습니다`);
    requireText(id, "id");
    const paths = [...new Set((d.paths || []).map(v => requireText(v, "paths")))];
    if (!paths.length || paths.some(v => !["정상", "경계", "실패"].includes(v))) throw new Error("정상·경계·실패 중 경로를 선언하세요.");
    if (!["spec", "plan", "user", "code", "assumed"].includes(d.basis)) throw new Error("기대 출처 basis가 필요합니다.");
    const quote = quoteOf(d);
    if (Object.hasOwn(d, "outOfCharter") && typeof d.outOfCharter !== "boolean") throw new Error("outOfCharter: 불리언이 필요합니다.");
    rowData = { id, what: requireText(d.what, "what"), given: requireText(d.given, "given"), basis: d.basis, paths, outOfCharter: d.outOfCharter === true,
      ...(d.basisNote ? { basisNote: d.basisNote } : {}), ...(d.source ? { source: d.source } : {}),
      ...(quote ? { quote } : {}), ...(d.covers ? { covers: checkCovers(d.covers) } : {}) };
    if(contract) Object.assign(rowData,Object.fromEntries(["risk","oracle","mustNotChange","dataChanging","consumers","rerun"].filter(key=>contract[key]!==undefined).map(key=>[key,contract[key]])));
    if (Object.hasOwn(d, "derivation")) {
      if (!d.derivation || typeof d.derivation !== "object" || Array.isArray(d.derivation)) throw new Error("derivation.source를 선언하세요.");
      if (Object.keys(d.derivation).some(key => key !== "source")) throw new Error("선언할 때 파생값 원천만 고정하세요.");
      rowData.derivation = { source: requireText(d.derivation.source, "derivation.source") };
    }
    if (Object.hasOwn(d, "retestOf")) Object.assign(rowData, await validateQaRetest({ ledger, runId, retestOf: d.retestOf }));
    shot = d.sourceShot || d.shot;
  } else if (action === "list") {
    const d = args.list || (args.from || args.items ? args : null);
    if (!d) return state;
    const imported = d.from ? listFromSource(d.from) : { items: [] };
    if (imported.error) throw new Error(imported.error);
    const items = imported.items.slice(), seen = new Set(items.map(it => it.id));
    for (const it of d.items || []) {
      const itemId = requireText(it.id, "목록 id"), itemText = requireText(it.text, "목록 text");
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      items.push({ id: itemId, text: itemText, ...(it.was ? { was: it.was } : {}), ...(it.shot ? { shot: requireImage(it.shot) } : {}) });
    }
    if (!items.length) throw new Error("list에 항목이 없습니다.");
    rowData = { name: d.name || "확인 목록", source: d.source || imported.from?.source, ...(imported.from ? { from: imported.from } : {}), items };
  } else if (action === "void") {
    // void 는 판정 무효 처리. 항목을 빼려고 receipt 없이 부른 사례
    const verdict = r => r.event.kind === "assertion" || r.event.kind === "reaction" && typeof r.event.pass === "boolean";
    // 고를 수 있는 판정 번호를 거부 사유에 붙임. 번호를 잘못 넣어 거부된 사례 45건
    const choices = () => { const list = verified.events.filter(r => verdict(r) && (!id || r.event.rowId === id)).slice(-8)
      .map(r => `${r.seq}(${r.event.rowId || "항목 없음"} ${r.event.pass ? "통과" : "실패"})`); return list.length ? ` 판정 seq: ${list.join(", ")}` : " 무효로 할 판정이 없습니다."; };
    if (args.receipt == null) throw new Error("void는 잘못 기록된 판정 하나를 무효로 합니다. receipt에는 조작 결과의 receipt, 실패 장면 seq 또는 판정 seq를 넣습니다. 항목을 빼는 동작이 아니며, 진행할 수 없는 항목은 qa_review decisions에 {row,reason}으로 넘깁니다." + choices());
    const given = requireText(String(args.receipt), "receipt"), why = requireText(args.why, "why");
    // 조작 결과의 receipt 는 action seq, 실패 장면은 failure seq. 둘 다 같은 조작 번호의 반응 판정으로 바꿈
    const named = verified.events.find(r => receiptOf(r) === given);
    // 실패 기록·실패 장면 관찰은 detail.failureSeq 로 그 실패 판정을 가리킴
    const action = named?.event.detail?.failureSeq != null && named.event.kind !== "play_result" ? verified.events.find(r => String(r.seq) === String(named.event.detail.failureSeq)) : named;
    // qa_play 실패(play_failure)·실행 결과(play_result)는 같은 실행 안에서 남긴 마지막 실패 판정. 실행 범위를 넘으면 예전 조작의 판정이 무효가 됨
    const played = ["play_failure", "play_result"].includes(named?.event.kind);
    const playEnd = named?.event.kind === "play_result" ? named : played && verified.events.find(r => r.seq > named.seq && r.event.kind === "play_result" && r.event.rowId === named.event.rowId);
    const playStart = !played ? 0 : playEnd?.event.detail?.startSeq ?? verified.events.findLast(r => r.seq < named.seq && r.event.kind === "play_result")?.seq ?? 0;
    const playFailed = played ? verified.events.findLast(r => r.seq < named.seq && r.seq >= playStart && verdict(r) && r.event.pass === false && r.event.rowId === named.event.rowId && r.event.path === named.event.path) : null;
    if (played && !playFailed) throw new Error(named.event.kind === "play_result" ? `qa_play 실행 결과 ${given}에는 실패 판정이 없습니다.`
      : `qa_play 실패 ${given}은 입력 전에 멈춰(${named.event.reason || "판정 없음"}) 무효로 할 판정이 없습니다. 대상을 고쳐 다시 실행하면 됩니다.`);
    const hit = playFailed || (named && verdict(named) ? named : action && verdict(action) ? action
      : action?.event.kind === "action" ? verified.events.find(r => verdict(r) && r.event.kind === "reaction" && r.event.acceptedSeq === action.event.acceptedSeq) : null);
    if (!hit) throw new Error(`${named ? `seq ${given}(${named.event.kind})은 판정과 연결되지 않습니다` : "이 회차에 없는 판정입니다"}. receipt에는 조작 결과의 receipt(action seq), 실패 기록·실패 장면 seq, qa_play 실패(play_failure)·실행 결과(play_result) seq, 판정(reaction·assertion) seq 중 하나를 넣습니다.${choices()}`);
    const receipt = receiptOf(hit);
    // 넣은 seq 가 조작·실패 기록이면 그 판정 seq 로 바뀜. 두 번호를 함께 남겨 어떤 판정이 무효가 됐는지 알 수 있게 함
    rowData = { receipt, why, row: hit.event.rowId, path_: hit.event.path, expected: hit.event.expected, pass: hit.event.pass === true,
      ...(receipt !== given ? { requested: given, resolved: `seq ${given}(${named.event.kind})의 판정 ${receipt}(${hit.event.kind})을 무효 처리` } : {}) };
  } else if (action === "note") {
    const what = requireText(args.what, "what"), decide = requireText(args.decide, "decide");
    const picks = picksOf(args.options), quote = quoteOf(args);
    if (args.shot) requireImage(args.shot);
    if (!args.simple && (!args.shot && !quote && !args.source || picks.length < 2)) throw new Error("결정에는 근거와 선택지 2개가 필요합니다.");
    for (const [key, value] of Object.entries({ what, decide, why: args.why, lean: args.lean })) if (value) checkFault(key, value);
    for (const p of picks) checkFault("선택지", [p.pick, p.then, p.cost || ""].join("\n"));
    rowData = { id: `n${state.notes.length + 1}`, what, decide, ...(id ? { row: id } : {}),
      ...(args.why ? { why: args.why } : {}), ...(args.source ? { source: args.source } : {}), ...(quote ? { quote } : {}),
      ...(args.shot ? { shot: args.shot } : {}), ...(picks.length ? { options: picks } : {}),
      ...(args.lean ? { lean: args.lean } : {}), ...(args.simple ? { simple: true } : {}) };
  } else {
    if (!row) throw new Error(`없는 줄입니다: ${id}`);
    if (["open", "close", "aside"].includes(action)) {
      path ||= args.action === "begin" || args.action === "end" ? row.paths[0] : undefined;
      if (!row.paths.includes(path)) throw new Error("선언하지 않은 경로입니다.");
    }
    if (action === "derivation") {
      if (!row.derivation) throw new Error("파생값 원천을 먼저 선언하세요.");
      if (Object.hasOwn(args, "source") && args.source !== row.derivation.source) throw new Error("선언한 파생값 원천은 변경하거나 제거할 수 없습니다.");
      rowData = { derivation: validateQaDerivation({ events: verified.events, rowId: id, derivation: {
        source: row.derivation.source, instances: args.instances, limitation: args.limitation,
      } }) };
    } else if (action === "open") rowData = {};
    else if (action === "close") {
      const color = args.color, note = requireText(args.note, "note"), sceneJudgment = requireText(args.sceneJudgment, "sceneJudgment"), picks = picksOf(args.options);
      if (!["red", "orange", "yellow", "green", "blue", "gray"].includes(color)) throw new Error("허용되지 않은 판정 색입니다.");
      if (color === "blue" && !args.simple && picks.length < 2) throw new Error("blue에는 선택지 2개가 필요합니다.");
      checkFault("판정", note);
      for (const p of picks) checkFault("선택지", [p.pick, p.then, p.cost || ""].join("\n"));
      if (args.lean) checkFault("생각", args.lean);
      const counted = evidence(verified.events, id, path);
      if (["spec", "plan", "user"].includes(row.basis) && counted.failed && color !== "red") throw new Error("명세·기획·사용자 기대가 어긋난 판정은 red입니다.");
      if (!["blue", "gray"].includes(color) && (!counted.frames || !counted.receipts)) throw new Error("장면과 판정 영수증이 필요합니다.");
      // 회차 종료 검사(P1d)와 같은 조건. 닫은 뒤 기록한 결함은 경로가 없어 종료 때에야 막히던 사례(qa-e50dca98 Q24)
      const opened = verified.events.findLast(r => r.event.kind === "row" && r.event.action === "open" && r.event.rowId === id && r.event.path === path)?.seq ?? -1;
      if (color === "red" && !counted.failed && !verified.events.some(r => r.seq > opened && r.event.kind === "defect" && r.event.detail?.noFailure && matches(r.event, id, path)))
        throw new Error("red의 근거인 실패 판정이 없습니다. 화면 관찰로 찾은 결함이면 경로를 연 채 qa_defect에 noFailure:true로 기록한 뒤 닫습니다.");
      rowData = { color, note, sceneJudgment, ...counted, ...(picks.length ? { options: picks } : {}), ...(args.lean ? { lean: args.lean } : {}), ...(args.simple ? { simple: true } : {}) };
    } else if (action === "covers") {
      if (!args.covers?.length) throw new Error("covers 항목이 필요합니다.");
      rowData = { covers: [...new Set([...(row.covers || []), ...checkCovers(args.covers)])] };
    } else if (action === "basis") {
      const quote = quoteOf(args);
      shot = args.sourceShot || args.shot;
      if (!quote && !shot && !nonempty(args.basisNote) && !nonempty(args.what)) throw new Error("원문·사진·근거 설명·항목 설명 중 하나가 필요합니다.");
      if (args.basisNote) checkFault("근거", args.basisNote);
      rowData = Object.fromEntries(Object.entries({ quote, source: args.source, basisNote: args.basisNote, what: args.what }).filter(([, v]) => v));
    } else if (action === "aside") {
      const frames = args.frames || [];
      if (!frames.length) throw new Error("분리할 frames가 필요합니다.");
      for (const image of frames) requireImage(image);
      rowData = { frames, why: requireText(args.why, "why") };
    } else throw new Error("허용되지 않은 row action입니다.");
  }
  const appended = await ledger.append(runId, { kind: "row", mode: "agent_action", action, ...(id ? { rowId: id } : {}), ...(path ? { path } : {}), rowData, ...(shot ? { shot } : {}) });
  const result = deriveQaRows((await ledger.verify(runId)).events);
  return { ...result, event: appended, ...(id ? { row: result.rows.find(r => r.id === id) } : {}), ...(action === "void" ? {
    voided: rowData.receipt, original: rowData,
    note: `${rowData.row || "항목 미지정"} · ${rowData.path_ || "경로 미지정"} · ${rowData.pass ? "통과 판정 무효" : "실패 판정 무효"}`,
    ...(state.rows.some(r => r.id !== rowData.row && rowData.why.includes(r.id)) ? { warning: "사유가 다른 확인 항목을 가리킵니다." } : {}),
  } : {}) };
}

// 무효로 한 판정 때문에 qa_play 가 자동으로 닫은 경로를 다시 엶. 실수 한 번마다 open 을 다시 부른 사례(한 경로에서 5번)
// 그 뒤에 이미 열거나 닫은 기록이 있으면 사람이 정한 상태라 건드리지 않음
export async function reopenAfterVoid({ ledger, runId, voided }) {
  if (!voided?.row) return null;
  const { row, path_: lane, receipt } = voided;
  const { events } = await ledger.verify(runId);
  const sameLane = r => r.event.kind === "row" && r.event.rowId === row && r.event.path === lane;
  const autoClose = events.findLast(r => r.seq > Number(receipt) && sameLane(r) && r.event.action === "close" && r.event.rowData?.automatic);
  if (!autoClose || events.some(r => r.seq > autoClose.seq && sameLane(r) && ["open", "close"].includes(r.event.action))) return null;
  try { return { reopened: { row, path: lane }, result: await applyQaRow({ ledger, runId, args: { action: "open", row, path: lane } }) }; }
  catch (error) { return { reopened: { row, path: lane, error: error.message } }; }
}
