"use strict";

function finite(value) { return typeof value === "number" && Number.isFinite(value); }

function normalizeBounds(bounds) {
  if (!bounds || !finite(bounds.x) || !finite(bounds.y) || !finite(bounds.width) || !finite(bounds.height)) return null;
  if (bounds.width < 200 || bounds.height < 150) return null;
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const instanceId = String(raw.instanceId || "").trim();
  const kind = raw.kind === "local" || raw.kind === "shared" ? raw.kind : null;
  if (!instanceId || !kind) return null;
  const record = {
    instanceId,
    kind,
    alwaysOnTop: !!raw.alwaysOnTop,
    maximized: !!raw.maximized,
    fullscreen: !!raw.fullscreen,
    viewMode: raw.viewMode === "preview" ? "preview" : "raw",
  };
  if (kind === "local") {
    record.spaceKey = String(raw.spaceKey || "").trim();
    record.noteId = String(raw.noteId || "").trim();
    if (!record.spaceKey || !record.noteId) return null;
    if (raw.spaceLabel) record.spaceLabel = String(raw.spaceLabel).slice(0, 120);
  }
  const bounds = normalizeBounds(raw.bounds);
  if (bounds) record.bounds = bounds;
  if (raw.display && typeof raw.display === "object") {
    const display = raw.display;
    if (display.id != null && finite(display.x) && finite(display.y)) record.display = { id: display.id, x: display.x, y: display.y };
  }
  return record;
}

function normalizeMemoWindowRecords(raw) {
  const out = [], index = new Map();
  for (const value of Array.isArray(raw) ? raw : []) {
    const record = normalizeRecord(value); if (!record) continue;
    if (index.has(record.instanceId)) out[index.get(record.instanceId)] = record;
    else { index.set(record.instanceId, out.length); out.push(record); }
  }
  return out;
}

function openMemoWindowRecord(records, raw) {
  const record = normalizeRecord(raw); if (!record) return normalizeMemoWindowRecords(records);
  const next = normalizeMemoWindowRecords(records);
  const at = next.findIndex((item) => item.instanceId === record.instanceId);
  if (at >= 0) next[at] = record; else next.push(record);
  return next;
}

function closeMemoWindowRecord(records, instanceId, { appQuitting = false } = {}) {
  const next = normalizeMemoWindowRecords(records);
  if (appQuitting) return next;
  return next.filter((record) => record.instanceId !== String(instanceId || ""));
}

function patchMemoWindowRecord(records, instanceId, patch) {
  const next = normalizeMemoWindowRecords(records);
  const at = next.findIndex((record) => record.instanceId === String(instanceId || ""));
  if (at < 0) return next;
  const merged = normalizeRecord({ ...next[at], ...(patch || {}), instanceId: next[at].instanceId, kind: next[at].kind });
  if (merged) next[at] = merged;
  return next;
}

function memoOpenCounts(records) {
  const out = {};
  for (const record of normalizeMemoWindowRecords(records)) {
    if (record.kind !== "local") continue;
    const key = `${record.spaceKey}\n${record.noteId}`;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = {
  closeMemoWindowRecord,
  memoOpenCounts,
  normalizeMemoWindowRecords,
  openMemoWindowRecord,
  patchMemoWindowRecord,
};
