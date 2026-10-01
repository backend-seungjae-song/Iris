import { projectAgents, projectError, projectRequests } from "../projection.js";

const PUSH_INTERVAL_MS = 500;

export function createWatchOperation(options) {
  const agents = options.agents;
  const requests = options.requests;
  const send = options.send;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const connections = new Map();

  function schedule(record) {
    if (record.timer) return;
    const delay = Math.max(0, PUSH_INTERVAL_MS - (now() - record.lastSent));
    record.timer = setTimer(() => {
      record.timer = null;
      record.lastSent = now();
      if (record.agents) send(record.connId, projectAgents(agents.list()));
      if (record.requests) send(record.connId, projectRequests(requests.list()));
      record.agents = false;
      record.requests = false;
    }, delay);
    record.timer?.unref?.();
  }

  function changed(field) {
    for (const record of connections.values()) {
      record[field] = true;
      schedule(record);
    }
  }

  const unsubscribeAgents = agents.subscribe(() => changed("agents"));
  const unsubscribeRequests = requests.subscribe(() => changed("requests"));

  function handle(entry, message) {
    if (agents.refresh) return agents.refresh().then(() => initial(entry, message));
    return initial(entry, message);
  }

  function initial(entry, message) {
    if (connections.has(entry.connId)) return projectError("invalid-request", message.rid);
    connections.set(entry.connId, { connId: entry.connId, lastSent: now(), timer: null, agents: false, requests: false });
    return [projectAgents(agents.list()), projectRequests(requests.list())];
  }

  function closeConnection(connId) {
    const record = connections.get(connId);
    if (!record) return false;
    if (record.timer) clearTimer(record.timer);
    connections.delete(connId);
    return true;
  }

  function close() {
    for (const connId of [...connections.keys()]) closeConnection(connId);
    unsubscribeAgents();
    unsubscribeRequests();
  }

  return { handle, closeConnection, close };
}
