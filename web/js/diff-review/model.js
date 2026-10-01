// 소유 범위: 비교 identity별 줄 의견과 초안 본문.
// 제공 API: reviewKey, createReviewStore, reviewDraft.
// 의존 대상: 없음. 저장과 화면은 boot가 소유한다.
// 유지 조건: patch가 바뀐 의견은 자동 이동하거나 해결하지 않는다.
// 영향 범위: Diff 의견의 복원·수정·전달.
export const reviewKey = (tab, spaceId) => JSON.stringify([spaceId, tab.root || "", tab.path,
  !!tab.staged, tab.mode || "", tab.base || ""]);

export function createReviewStore(saved = []) {
  const docs = Array.isArray(saved) ? saved.filter((d) => d && typeof d.key === "string" && typeof d.patch === "string"
    && Array.isArray(d.notes)).slice(-20).map((d) => ({ ...d, notes: d.notes.filter((n) => n && typeof n.id === "string"
      && typeof n.text === "string" && n.text.length <= 4000 && Number.isInteger(n.line) && n.line > 0
      && ["old", "new"].includes(n.side)).slice(-50) })) : [];
  return {
    documents: () => docs,
    current: (key, patch) => docs.filter((d) => d.key === key && d.patch === patch).flatMap((d) => d.notes),
    stale: (key, patch) => docs.filter((d) => d.key === key && d.patch !== patch).flatMap((d) => d.notes).filter((n) => !n.resolved),
    add(tab, spaceId, row, text, id) {
      const trimmed = String(text).trim();
      if (!trimmed || trimmed.length > 4000 || !(row.o || row.n)) throw new Error("의견을 4,000자 이내로 입력하세요");
      if (typeof tab.patch !== "string" || tab.patch.length > 250000) throw new Error("diff가 너무 커서 의견을 저장할 수 없습니다");
      const key = reviewKey(tab, spaceId);
      let doc = docs.find((d) => d.key === key && d.patch === tab.patch);
      if (!doc) {
        if (docs.length >= 20) throw new Error("의견은 diff 20개까지 저장할 수 있습니다. 이전 의견을 삭제하세요");
        doc = { key, patch: tab.patch, path: tab.rel || tab.path, root: tab.root || "", spaceId, notes: [] }; docs.push(doc);
      }
      if (doc.notes.length >= 50) throw new Error("한 diff에는 의견을 50개까지 저장할 수 있습니다");
      const note = { id, text: trimmed, side: row.cls === "del" ? "old" : "new", line: Number(row.cls === "del" ? row.o : row.n),
        excerpt: row.text, resolved: false, sent: false };
      doc.notes.push(note); return note;
    },
    remove(key, id) {
      for (const doc of docs.filter((d) => d.key === key)) doc.notes = doc.notes.filter((n) => n.id !== id);
      for (let i = docs.length - 1; i >= 0; i--) if (!docs[i].notes.length) docs.splice(i, 1);
    },
  };
}

export function reviewDraft(tab, notes) {
  return `다음 diff 의견을 검토해 주세요.\n저장소: ${tab.root || ""}\n파일: ${tab.rel || tab.path}\n비교: ${tab.mode || (tab.staged ? "staged" : "worktree")} ${tab.base || ""}\n\n`
    + notes.filter((n) => !n.resolved).map((n, i) => `${i + 1}. ${n.side === "old" ? "변경 전" : "변경 후"} ${n.line}행\n${n.excerpt}\n의견: ${n.text}`).join("\n\n");
}
