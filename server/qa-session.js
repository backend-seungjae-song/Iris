import { deriveQaRows } from "./qa-rows.js";
import { validateQaDefect, validateQaNote, validateQaCharterChange } from "./qa-session-contract.js";

const belongs = (event, rowId, lane) => !rowId || (event.rowId === rowId && (!lane || event.path === lane))
  || (event.lanes || []).some(l => Array.isArray(l) ? l[0] === rowId && (!lane || l[1] === lane) : l.rowId === rowId && (!lane || l.path === lane));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]));
const expectedKey = e => JSON.stringify([e.cmd || "expect", e.expectedDigest
  || [e.expected?.mode, e.expected?.sel, e.expected?.text, e.expected?.label, e.expected?.type]]);

// 현재 경로와 같은 화면의 결함 증거
export function deriveQaDefect(events, args, { rowId, surface } = {}) {
  const input = validateQaDefect(args);
  const voided = new Set(events.filter(r => r.event.kind === "row" && r.event.action === "void").map(r => String(r.event.rowData?.receipt)));
  // 고른 실패가 앞선 항목의 것이면 그 시점까지의 기록으로 재현 절차를 만듦. 나중 항목의 진입·장면이 붙던 사례(qa-6face637 결함 1224)
  const picked = input.failureSeq != null && events.find(r => r.seq === input.failureSeq && ["assertion", "reaction"].includes(r.event.kind));
  if (picked) {
    const until = Math.max(picked.seq, ...events.filter(r => r.event.kind === "failure" && r.event.detail?.failureSeq === picked.seq).map(r => r.seq));
    events = events.filter(r => r.seq <= until);
    rowId = picked.event.rowId || rowId;
    surface = picked.event.surface || surface;
  }
  const failureSurfaces = new Map(events.filter(r=>r.event.kind === "failure" && r.event.surface).map(r=>[r.event.detail?.failureSeq,r.event.surface]));
  events = events.map(r=>r.event.surface || !failureSurfaces.has(r.seq) ? r : {...r,event:{...r.event,surface:failureSurfaces.get(r.seq)}});
  const state = deriveQaRows(events);
  const lane = state.open.findLast(l => !rowId || l.id === rowId);
  // 열린 항목이 없으면 qa_play 실패로 닫힌 항목만 이어받음. 그 뒤 다른 조작·항목 열기가 있었으면 관계없는 실패
  const playFailure = events.findLast(r=>r.event.kind==="play_failure" && (!surface || r.event.surface===surface));
  const laterWork = playFailure && events.some(r=>r.seq>playFailure.seq && (["entry","action","assertion","play_step"].includes(r.event.kind)
    || r.event.kind==="reaction" && !r.event.detail?.idle || r.event.kind==="row" && r.event.action!=="close"));
  rowId ||= lane?.id || (laterWork ? undefined : playFailure?.event.rowId);
  const row = state.rows.find(r => r.id === rowId);
  const opened = lane && events.findLast(r => r.event.kind === "row" && r.event.action === "open" && r.event.rowId === rowId && r.event.path === lane.path);
  let entry = events.findLast(r => r.event.kind === "entry" && (!surface || r.event.surface === surface || r.event.tab === surface));
  const startSeq = opened?.seq || entry?.seq || events[0]?.seq || 0;
  let scoped = events.filter(r => r.seq >= startSeq && belongs(r.event, rowId, lane?.path));
  surface ||= scoped.findLast(r => r.event.cmd === "defect_context" && r.event.surface)?.event.surface
    || scoped.findLast(r => ["assertion", "action", "failure"].includes(r.event.kind) && r.event.pass !== true && r.event.surface)?.event.surface
    || entry?.event.surface || entry?.event.tab;
  if (surface) entry = events.findLast(r => r.event.kind === "entry" && (r.event.surface === surface || r.event.tab === surface));
  scoped = scoped.filter(r => !surface || !r.event.surface || r.event.surface === surface);
  const declared = rowId && events.findLast(r => r.event.kind === "row" && r.event.action === "declare" && r.event.rowId === rowId);
  const history = events.filter(r => r.seq >= (declared?.seq || startSeq) && belongs(r.event, rowId, lane?.path)
    && (!surface || !r.event.surface || r.event.surface === surface));
  const assertions = history.filter(r => ["assertion", "reaction"].includes(r.event.kind) && !voided.has(String(r.seq)) && r.event.mode === "agent_action"
    && r.event.expected && (!surface || r.event.surface === surface));
  // 항목이 정해지지 않은 결함에는 다른 항목의 실패를 붙이지 않음. 항목 밖의 경로 도착 실패만 연결
  const ownFailure = r => r.event.pass === false && (rowId || !r.event.rowId);
  // 세션이 고른 실패 판정, 실패 판정 없음(noFailure), 기본은 같은 항목의 마지막 실패
  if (input.failureSeq != null && input.noFailure) throw new Error("failureSeq와 noFailure는 함께 넣지 않습니다.");
  const chosen = input.failureSeq != null ? events.find(r => r.seq === input.failureSeq && ["assertion", "reaction"].includes(r.event.kind) && r.event.pass === false && !voided.has(String(r.seq))) : null;
  if (input.failureSeq != null && !chosen) throw new Error(`failureSeq ${input.failureSeq}는 이 회차의 무효 처리하지 않은 실패 판정(assertion·reaction)이 아닙니다.`);
  const failed = input.noFailure ? undefined : chosen || [assertions.findLast(ownFailure), scoped.findLast(r => (r.event.kind === "action" || r.event.kind === "observation" && r.event.cmd === "route_arrival") && ownFailure(r))]
    .filter(Boolean).sort((a, b) => a.seq - b.seq).at(-1);
  const sameFailures = ["assertion", "reaction"].includes(failed?.event.kind)
    ? assertions.filter(r => r.event.pass === false && expectedKey(r.event) === expectedKey(failed.event)) : [];
  if (input.reproducible === "재현됨" && sameFailures.length < 2)
    throw new Error(`재현됨은 현재 항목과 화면에서 같은 기대값이 두 번 이상 실패한 판정이 필요합니다(지금 ${sameFailures.length}번). reproducible을 빼면 기록에서 계산합니다.`);
  // 재현 여부를 기록에서 계산: 실패만 2번 이상이면 재현됨, 실패와 통과가 섞이면 가끔 재현됨, 그 밖은 재현 안 됨
  const samePasses = ["assertion", "reaction"].includes(failed?.event.kind)
    ? assertions.filter(r => r.event.pass === true && expectedKey(r.event) === expectedKey(failed.event)) : [];
  const reproducible = input.reproducible
    || (sameFailures.length >= 2 && !samePasses.length ? "재현됨" : sameFailures.length && samePasses.length ? "가끔 재현됨" : "재현 안 됨");
  const failureSeqs = sameFailures.length ? sameFailures.map(r => r.seq) : failed ? [failed.seq] : [];
  const failures = history.filter(r => r.event.kind === "failure" && failureSeqs.includes(r.event.detail?.failureSeq));
  const acceptedSeqs = new Set(failureSeqs.map(seq => events.find(r => r.seq === seq)?.event.acceptedSeq).filter(Boolean));
  const frameRecords = history.filter(r => r.event.shot && (failureSeqs.includes(r.seq) || failures.includes(r)
    || r.event.kind === "frame" && acceptedSeqs.has(r.event.acceptedSeq)));
  if (!frameRecords.length) {
    const latest = scoped.findLast(r => r.event.shot);
    if (latest) frameRecords.push(latest);
  }
  const frames = frameRecords
    .map(r => ({ seq: r.seq, ...pick(r.event, ["shot", "shotHash", "phase"]) }));
  const observations = history.filter(r => r.event.kind === "failure" && failures.includes(r)
    || scoped.includes(r) && r.event.kind === "observation" && ["observe", "app_observe", "defect_context"].includes(r.event.cmd))
    .map(r => ({ seq: r.seq, ...pick(r.event, ["cmd", "detail", "observed"]) }));
  const urlEvent = scoped.findLast(r => r.event.url) || entry;
  const viewport = scoped.findLast(r => r.event.viewport)?.event.viewport;
  const device = scoped.findLast(r => r.event.device)?.event.device;
  const environment = { ...(urlEvent?.event.url ? { url: urlEvent.event.url } : {}),
    ...(viewport ? { viewport: structuredClone(viewport) } : {}), ...(device ? { device: structuredClone(device) } : {}),
    ...structuredClone(scoped.findLast(r => r.event.kind === "observation" && r.event.detail?.environment)?.event.detail.environment || {}),
    ...structuredClone(failures.at(-1)?.event.detail?.environment || {}) };
  return { ...input, reproducible, reproduction: { failed: sameFailures.length, passed: samePasses.length, ...(input.reproducible ? {} : { derived: true }) },
    ...(rowId ? { rowId } : {}), ...(lane ? { path: lane.path } : {}), ...(surface ? { surface } : {}),
    outOfCharter: row?.outOfCharter === true, startSeq, endSeq: events.at(-1)?.seq || 0,
    ...(failed ? { failureSeq: failed.seq } : {}), failureSeqs,
    ...(failed?.event.expected ? { expected: structuredClone(failed.event.expected) } : {}),
    ...(failed?.event.observed !== undefined ? { actual: failed.event.observed } : {}),
    // 재현 절차는 항목 구분 없이 진입부터 실패까지 같은 화면의 모든 조작
    steps: [entry, ...events.filter(r => r.event.kind === "action" && r.seq > (entry?.seq || 0)
      && r.seq <= (failed?.seq || events.at(-1)?.seq || 0) && (!surface || !r.event.surface || r.event.surface === surface))].filter(Boolean)
      .filter((r, i, all) => all.findIndex(item => item.seq === r.seq) === i)
      .map(r => ({ seq: r.seq, cmd: r.event.kind === "entry" ? "open_entry" : r.event.cmd,
        ...pick(r.event, ["url", "target", "input", "pass", "expected"]) })),
    frames, observations, environment };
}

export async function recordQaSession({ ledger, runId, cmd, args, rowId, surface }) {
  const verified = await ledger.verify(runId);
  if (verified.events.some(r => r.event.kind === "run_end")) throw new Error("종료한 세션에는 기록을 추가할 수 없습니다.");
  let event;
  if (cmd === "defect") {
    const detail = deriveQaDefect(verified.events, args, { rowId, surface });
    event = { kind: "defect", mode: "agent_action", detail,
      ...pick(detail, ["rowId", "path", "surface"]) };
  } else if (cmd === "note") {
    event = { kind: "session_note", mode: "agent_action", detail: validateQaNote(args),
      ...(rowId ? { rowId } : {}), ...(surface ? { surface } : {}) };
  } else if (cmd === "charter") {
    const { charter, reason } = validateQaCharterChange(args);
    const current = verified.events.findLast(r => r.event.kind === "charter_change" || r.event.kind === "run_begin");
    const oldCharter = current?.event.kind === "charter_change" ? current.event.detail.newCharter : current?.event.charter;
    if (!oldCharter) throw new Error("변경할 charter가 없습니다.");
    const initial = verified.events.find(r => r.event.kind === "run_begin")?.event.charter;
    for (const key of ["unattended", "approvals", "investigationLimitMin"])
      if (JSON.stringify(charter[key]) !== JSON.stringify(initial?.[key])) throw new Error("시작 때 승인한 무인 설정은 새 회차에서 변경하세요.");
    event = { kind: "charter_change", mode: "agent_action", detail: { oldCharter, newCharter: charter, reason } };
  } else throw new Error("허용되지 않은 세션 기록 명령입니다.");
  return ledger.append(runId, event);
}
