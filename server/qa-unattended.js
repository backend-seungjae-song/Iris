const belongs = (event, lane) => event.rowId === lane.id
  || event.lanes?.some(item => (Array.isArray(item) ? item[0] : item.rowId) === lane.id);

export function qaUnattendedPolicy(events) {
  const charter = events.find(record => record.event.kind === "run_begin")?.event.charter;
  return { unattended: charter?.unattended === true, approvals: charter?.approvals || { logins: [], bulkFill: false },
    investigationLimitMin: charter?.investigationLimitMin ?? 10 };
}

// 장부 시각으로 복구하는 항목별 미해결 실패
export function assertQaInvestigationTime(events, lanes, now = Date.now()) {
  const policy = qaUnattendedPolicy(events);
  if (!policy.unattended) return;
  for (const lane of lanes) {
    const unresolved = new Map();
    for (const record of events) {
      const event = record.event;
      if (!belongs(event, lane)) continue;
      if (["assertion", "action"].includes(event.kind) && event.pass === false) unresolved.set(record.seq, event.at);
      if (event.kind === "defect") {
        for (const seq of [...(event.detail?.failureSeqs || []), event.detail?.failureSeq]) unresolved.delete(seq);
      }
      if (event.kind === "blocked") unresolved.clear();
    }
    const first = Math.min(...[...unresolved.values()].filter(Number.isFinite));
    if (now - first >= policy.investigationLimitMin * 60000)
      throw new Error(`항목 ${lane.id}의 조사 상한 ${policy.investigationLimitMin}분을 넘었습니다. qa_defect에 재현 여부 그대로 기록하거나 qa_blocked("중단·미해결")로 기록한 뒤 다음 항목으로 넘어가세요.`);
  }
}

export async function recordQaHumanRequired({ ledger, runId, lanes, reason }) {
  const message = "사람 필요: " + reason;
  const row = lanes.at(-1);
  const receipt = await ledger.append(runId, row
    ? { kind: "blocked", mode: "agent_action", rowId: row.id, path: row.path, lanes: lanes.map(lane => [lane.id, lane.path]), reason: message }
    : { kind: "session_note", mode: "preparation", detail: { kind: "막힘", text: message } });
  return { humanRequired: true, blocked: true, recorded: true, receipt,
    next: row ? "막힘을 기록했습니다. 열린 항목을 qa_row close로 정리하고 다음 항목으로 넘어가세요." : "막힘을 기록했습니다. 다음 항목으로 넘어가세요." };
}
