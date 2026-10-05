// 공개 Windows API는 데스크톱의 순서 조회와 다른 앱의 데스크톱 이동을 제공하지 않는다.
const native = require('../../../server/win-native.cjs');
function createWin({ request = native.request, screen = null } = {}) {
  const rect = ([x, y, width, height]) => ({ x, y, width, height });
  const bounds = ({ x, y, width, height }) => [x, y, width, height];
  const toDip = (r) => screen ? screen.screenToDipRect(null, r) : r;
  const toPhysical = (r) => screen ? screen.dipToScreenRect(null, r) : r;
  async function listWindows() {
    const r = await request({ op: 'windows' });
    if (!r.ok) return { ...r, reason: r.error };
    const current = r.windows.find((w) => w.onCurrent && w.desktopId)?.desktopId || null;
    return { ok: true, locked: !current, desktops: [], windows: r.windows.filter((w) => w.exe && w.desktopId && w.bounds[2] >= 200 && w.bounds[3] >= 150).map((w) => ({
      bundle: w.exe, appName: w.matchApp, pid: w.pid, pidStart: w.pidStart, cgId: w.id,
      title: w.matchTitle, rect: toDip(rect(w.bounds)), desktop: null, desktopId: w.desktopId, space: w.desktopId, onCurrent: w.onCurrent,
    })) };
  }
  async function applyWindows(items) {
    const live = await request({ op: 'windows' });
    if (!live.ok) return { ...live, reason: live.error };
    const results = [];
    for (const it of items) {
      const w = live.windows.find((w) => w.id === it.cgId && w.pid === it.pid);
      if (!w) { results.push({ ok: false, reason: 'window-not-found' }); continue; }
      if (!it.pidStart || !w.pidStart || it.pidStart !== w.pidStart) { results.push({ ok: false, reason: 'process-identity-changed' }); continue; }
      if (!w.onCurrent) { results.push({ ok: false, reason: 'desktop-switch-failed' }); continue; }
      const to = bounds(toPhysical(it.to));
      const r = await request({ op: 'move', hwnd: w.id, pid: w.pid, start: it.pidStart, bounds: to });
      const landed = r.ok && r.bounds.every((n, i) => Math.abs(n - to[i]) <= 2);
      results.push({ ok: !!landed, reason: landed ? null : r.error || 'frame-did-not-land', applied: r.bounds ? toDip(rect(r.bounds)) : null });
    }
    return { ok: true, results };
  }
  async function restoreAcrossDesktops(plan) {
    const live = await listWindows(); if (!live.ok) return live;
    const results = {};
    for (const visit of plan.visits || []) for (const it of visit.items || []) {
      results[it.key] = { ok: false, reason: 'desktop-switch-failed' };
    }
    return { ok: true, results };
  }
  async function runningBundleIds() {
    const r = await request({ op: 'windows' }); if (!r.ok) return r;
    const bundles = [...new Set(r.windows.map((w) => w.exe).filter(Boolean))];
    return { ok: true, bundles, regular: bundles };
  }
  return { listWindows, applyWindows, restoreAcrossDesktops, runningBundleIds };
}
module.exports = { createWin };
