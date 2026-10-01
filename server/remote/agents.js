import { randomBytes as nodeRandomBytes } from "node:crypto";

import { projectAgent } from "./projection.js";

const STATUSES = new Set(["working", "idle", "done", "blocked", "unknown"]);

function kindOf(value) {
  const name = String(value || "").toLowerCase();
  if (name === "claude" || name.startsWith("claude")) return "claude";
  if (name === "codex" || name.startsWith("codex")) return "codex";
  return name ? "other" : "terminal";
}

export function createAgentStore(options = {}) {
  const getSnapshot = options.getSnapshot || (() => ({ state: [], workspaces: [] }));
  const subscribeSnapshot = options.subscribeSnapshot || (() => () => {});
  const subscribeSpaceOrder = options.subscribeSpaceOrder || (() => () => {});
  const orderWorkspaces = options.orderWorkspaces || ((workspaces) => workspaces);
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const canMessage = options.canMessage || ((agent) => agent.kind === "codex" && !!agent.source.sessionUuid);
  const refsBySession = new Map();
  const sessionsByRef = new Map();
  const refsBySpace = new Map();
  const spacesByRef = new Map();
  const subscribers = new Set();
  let signature = "";
  let terminalSources = [];
  let refreshing = null;

  async function refresh() {
    if (!options.getHerdr) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const panes = await options.getHerdr()?.paneList();
        terminalSources = (panes || []).filter((pane) => !pane.agent).map((pane) => ({
          paneId: pane.pane_id, terminalId: pane.terminal_id, workspaceId: pane.workspace_id,
          tabId: pane.tab_id, agent: null, sessionUuid: null,
        }));
      } catch { terminalSources = []; }
      notifyIfChanged();
    })();
    try { await refreshing; } finally { refreshing = null; }
  }

  function sessionIdentity(source) {
    if (typeof source?.paneId !== "string" || !source.paneId) return null;
    const sessionUuid = typeof source.sessionUuid === "string" && source.sessionUuid ? source.sessionUuid : null;
    return JSON.stringify([source.paneId, sessionUuid, source.agent ? null : source.terminalId || null]);
  }

  function refForSource(source) {
    const identity = sessionIdentity(source);
    if (!identity) return null;
    let ref = refsBySession.get(identity);
    for (let attempt = 0; !ref && attempt < 64; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (sessionsByRef.has(candidate)) continue;
      ref = candidate;
      refsBySession.set(identity, ref);
      sessionsByRef.set(ref, identity);
    }
    if (!ref) throw new Error("agent-ref-unavailable");
    return ref;
  }

  function refForPane(paneId) {
    if (typeof paneId !== "string" || !paneId) return null;
    const source = [...(getSnapshot()?.state || []), ...terminalSources].find((item) => item?.paneId === paneId);
    return refForSource(source);
  }

  function refForSpace(spaceId) {
    if (typeof spaceId !== "string" || !spaceId) return null;
    let ref = refsBySpace.get(spaceId);
    for (let attempt = 0; !ref && attempt < 64; attempt++) {
      const candidate = randomBytes(16).toString("hex");
      if (spacesByRef.has(candidate)) continue;
      ref = candidate;
      refsBySpace.set(spaceId, ref);
      spacesByRef.set(ref, spaceId);
    }
    if (!ref) throw new Error("space-ref-unavailable");
    return ref;
  }

  function records() {
    const value = getSnapshot() || {};
    const workspaces = orderWorkspaces(value.workspaces || []);
    const spaces = new Map(workspaces.map((space) => [space.id, String(space.label || space.id || "스페이스")]));
    const spaceOrder = new Map(workspaces.map((space, index) => [space.id, index]));
    const tabOrder = new Map(Object.entries(value.tabs || {}).map(([spaceId, tabs]) => [spaceId,
      new Map((Array.isArray(tabs) ? tabs : []).map((tab, index) => [tab.tabId, index]))]));
    const liveState = (value.state || []).filter((item) => item.agent || !options.getHerdr);
    const existing = new Set(liveState.map((item) => item.paneId));
    const sources = [...liveState, ...terminalSources.filter((item) => !existing.has(item.paneId))].filter((source) => typeof source?.paneId === "string" && source.paneId);
    const sourceByPane = new Map(sources.map((source) => [source.paneId, source]));
    const ordered = sources.map((source, index) => ({ source, index })).sort((left, right) => {
      const a = left.source, b = right.source;
      const aSpace = spaceOrder.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      const bSpace = spaceOrder.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER;
      const aTab = tabOrder.get(a.workspaceId)?.get(a.tabId) ?? Number.MAX_SAFE_INTEGER;
      const bTab = tabOrder.get(b.workspaceId)?.get(b.tabId) ?? Number.MAX_SAFE_INTEGER;
      return aSpace - bSpace || aTab - bTab || String(a.tabId || "").localeCompare(String(b.tabId || ""))
        || left.index - right.index;
    });
    const sessionOrder = new Map();
    return ordered.flatMap(({ source }) => {
      const ref = refForSource(source);
      if (!ref) return [];
      const kind = kindOf(source.agent);
      const status = kind !== "terminal" && STATUSES.has(source.status) ? source.status : "unknown";
      const spaceId = String(source.workspaceId || "unknown");
      const parentSource = sourceByPane.get(source.parentPaneId);
      const order = sessionOrder.get(spaceId) || 0;
      sessionOrder.set(spaceId, order + 1);
      const agent = {
        ref,
        name: String(source.tabLabel || (value.tabs?.[source.workspaceId] || []).find((tab) => tab.tabId === source.tabId)?.label || source.agent || "터미널") || "에이전트",
        kind,
        status,
        question: kind !== "terminal" && !!source.question,
        space: spaces.get(source.workspaceId) || String(source.workspaceId || "스페이스") || "스페이스",
        spaceRef: refForSpace(spaceId),
        spaceOrder: spaceOrder.get(source.workspaceId) ?? Number.MAX_SAFE_INTEGER,
        sessionOrder: order,
        parent: parentSource && parentSource.workspaceId === source.workspaceId
          ? refForSource(parentSource) : null,
        lastActivityAt: Number.isSafeInteger(source.lastActivityAt) && source.lastActivityAt >= 0
          ? source.lastActivityAt : null,
        can: { stop: kind === "claude" || kind === "codex", message: false },
        source,
      };
      agent.can.message = kind !== "terminal" && !!canMessage(agent);
      return [agent];
    });
  }

  function list() {
    return records().map(projectAgent);
  }

  function resolve(ref) {
    if (!sessionsByRef.has(ref)) return null;
    return records().find((agent) => agent.ref === ref) || null;
  }

  function resolvePane(paneId) {
    if (typeof paneId !== "string" || !paneId) return null;
    return records().find((agent) => agent.source.paneId === paneId) || null;
  }

  function notifyIfChanged() {
    let next;
    try { next = JSON.stringify(list()); } catch { return; }
    if (next === signature) return;
    signature = next;
    for (const subscriber of [...subscribers]) {
      try { subscriber(); } catch {}
    }
  }

  signature = JSON.stringify(list());
  const unsubscribeSnapshot = subscribeSnapshot(() => { notifyIfChanged(); void refresh(); });
  const unsubscribeSpaceOrder = subscribeSpaceOrder(notifyIfChanged);

  return {
    list,
    refresh: options.getHerdr ? refresh : undefined,
    refForSpace,
    resolve,
    resolvePane,
    refForPane,
    subscribe(subscriber) {
      if (typeof subscriber !== "function") throw new TypeError("subscriber must be a function");
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    changed: notifyIfChanged,
    close() { unsubscribeSnapshot(); unsubscribeSpaceOrder(); subscribers.clear(); },
  };
}
