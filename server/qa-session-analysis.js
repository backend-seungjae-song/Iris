const rowsOf = event => [...new Set([event.rowId, ...(event.lanes || []).map(lane => Array.isArray(lane) ? lane[0] : lane.rowId)].filter(Boolean))];
const failureIds = record => record.event.detail?.failureSeqs?.length ? record.event.detail.failureSeqs
  : [record.event.detail?.failureSeq].filter(value => value != null);
const execution = new Set(["accepted", "action", "assertion", "observation", "frame"]);
const timestamp = value => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;

// 이벤트 시각과 열린 경로를 기준으로 한 시간 추정
export function deriveQaSessionAnalysis(events, rows = []) {
  const begin = events.findIndex(record => record.event.kind === "run_begin");
  const last = events.findLastIndex(record => record.event.kind === "run_end");
  const records = events.slice(Math.max(0, begin), last < 0 ? undefined : last + 1);
  const outside = new Map(rows.map(row => [row.id, row.outOfCharter === true]));
  for (const { event } of records) if (event.kind === "row" && event.action === "declare")
    outside.set(event.rowId || event.rowData?.id, event.rowData?.outOfCharter === true);
  const active = new Map(), investigating = new Map();
  const time = { totalMs: 0, setupMs: 0, investigationMs: 0, testMs: 0, insideMs: 0, outsideMs: 0, unassignedMs: 0, invalidIntervals: 0 };
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index], event = record.event;
    if (event.kind === "row" && event.action === "open") active.set(`${event.rowId}\0${event.path}`, event.rowId);
    if (event.kind === "row" && event.action === "close") active.delete(`${event.rowId}\0${event.path}`);
    if (event.kind === "failure") {
      const id = event.detail?.failureSeq ?? record.seq;
      const original = records.find(value => String(value.seq) === String(id));
      investigating.set(String(id), rowsOf(original?.event || event));
    } else if (["action", "assertion", "observation"].includes(event.kind) && event.pass === false) {
      investigating.set(String(record.seq), rowsOf(event));
    }
    if (event.kind === "defect") for (const id of failureIds(record)) investigating.delete(String(id));
    const start = timestamp(event.at), end = timestamp(records[index + 1].event.at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { time.invalidIntervals++; continue; }
    const ms = end - start;
    const setup = ["preparation", "route_replay"].includes(event.mode);
    const eventRows = rowsOf(event);
    const investigationRows = new Set([...investigating.values()].flat());
    const testing = event.mode === "agent_action" && execution.has(event.kind) && eventRows.length > 0
      && (!investigating.size || eventRows.some(id => !investigationRows.has(id)));
    const category = testing || setup && investigating.size ? "testMs"
      : investigating.size ? "investigationMs" : setup ? "setupMs" : "testMs";
    time.totalMs += ms; time[category] += ms;
    const scope = active.size ? [...active.values()].every(id => outside.get(id) === true) ? "outsideMs" : "insideMs" : "unassignedMs";
    time[scope] += ms;
  }
  const failures = records.filter(record => record.event.kind === "failure");
  // 예전 결함 기록의 재현 단계에는 기대 효과가 없어 같은 seq 의 조작 기록에서 가져옴. 사람용 재현 절차의 결과 칸
  const actionBySeq = new Map(records.filter(record => record.event.kind === "action").map(record => [record.seq, record.event]));
  const withExpected = steps => (steps || []).map(step => step.expected || !actionBySeq.get(step.seq)?.expected ? step : { ...step, expected: actionBySeq.get(step.seq).expected });
  const defects = records.filter(record => record.event.kind === "defect").map(record => ({
    seq: record.seq, at: record.event.at, ...record.event.detail, steps: withExpected(record.event.detail?.steps),
    failures: failures.filter(failure => failureIds(record).some(id => String(id) === String(failure.event.detail?.failureSeq ?? failure.seq)))
      .map(failure => ({ seq: failure.seq, ...failure.event })),
  }));
  return {
    time, defects,
    charterChanges: records.filter(record => record.event.kind === "charter_change").map(record => ({ seq: record.seq, at: record.event.at, ...record.event.detail })),
    notes: records.filter(record => record.event.kind === "session_note").map(record => ({ seq: record.seq, at: record.event.at, ...record.event.detail })),
    outsideRows: rows.filter(row => row.outOfCharter === true).map(row => ({ id: row.id, what: row.what, given: row.given })),
    rowCounts: { inside: rows.filter(row => row.outOfCharter !== true).length, outside: rows.filter(row => row.outOfCharter === true).length },
  };
}
