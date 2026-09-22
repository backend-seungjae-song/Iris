(function exposeMemoSnapshotState(root) {
  function objectCopy(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  }

  function storageKey(space, spaceKeys) {
    return (space && spaceKeys && spaceKeys[space]) || space || "";
  }

  function mergeSnapshot(snapshot, { current, unavailable, activeSpace, draft, dirty } = {}) {
    if (unavailable) return objectCopy(current);
    const next = objectCopy(snapshot);
    if (dirty && activeSpace) next[activeSpace] = String(draft ?? "");
    return next;
  }

  function mergeUpdate(current, update, { activeSpace, draft, dirty, spaceKeys } = {}) {
    const next = objectCopy(current);
    const changedSpace = String(update?.space || "");
    if (!changedSpace) return next;
    const changedKey = storageKey(changedSpace, spaceKeys);
    const text = String(update?.text || "");
    for (const space of new Set([...Object.keys(next), changedSpace, activeSpace].filter(Boolean))) {
      if (storageKey(space, spaceKeys) === changedKey) next[space] = text;
    }
    if (dirty && activeSpace && storageKey(activeSpace, spaceKeys) === changedKey) {
      next[activeSpace] = String(draft ?? "");
    }
    return next;
  }

  function advanceEditRevision(current) {
    return Number.isInteger(current) && current >= 0 ? current + 1 : 1;
  }

  function isCurrentRevision(saved, current) {
    return Number.isInteger(saved) && saved === current;
  }

  function mergeConcurrentText(serverText, draftText) {
    serverText = String(serverText ?? "");
    draftText = String(draftText ?? "");
    if (serverText === draftText || serverText.includes(draftText)) return serverText;
    if (draftText.includes(serverText)) return draftText;
    if (!serverText.trim()) return draftText;
    if (!draftText.trim()) return serverText;
    return `${serverText.replace(/\s+$/, "")}\n\n---\n\n<!-- Iris: 동시 편집 초안 보존 -->\n${draftText}`;
  }

  function recoverDraft(serverDoc, rawDraft) {
    const server = {
      text: String(serverDoc?.text ?? ""),
      version: String(serverDoc?.version || ""),
    };
    if (!rawDraft || typeof rawDraft.text !== "string" || typeof rawDraft.baseVersion !== "string") {
      return { action: "accept", text: server.text, draft: null };
    }
    const draft = {
      text: rawDraft.text,
      baseVersion: rawDraft.baseVersion,
      updatedAt: Number.isFinite(rawDraft.updatedAt) ? rawDraft.updatedAt : 0,
    };
    if (draft.text === server.text) return { action: "clear", text: server.text, draft: null };
    if (draft.baseVersion === server.version) return { action: "retry", text: draft.text, draft };
    const text = mergeConcurrentText(server.text, draft.text);
    return { action: "merge", text, draft: { text, baseVersion: server.version, updatedAt: draft.updatedAt } };
  }

  function isSavedDraft(draft, savedText) {
    return !!draft && typeof draft.text === "string" && draft.text === String(savedText ?? "");
  }

  root.IrisMemoSnapshotState = {
    mergeSnapshot, mergeUpdate, advanceEditRevision, isCurrentRevision,
    mergeConcurrentText, recoverDraft, isSavedDraft,
  };
})(globalThis);
