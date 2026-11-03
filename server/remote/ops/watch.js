import { projectAgents, projectRequests, projectTerminalQuestions } from "../projection.js";

const PUSH_INTERVAL_MS = 500;

export function createWatchOperation(options) {
  const agents = options.agents;
  const requests = options.requests;
  const terminalQuestions = options.terminalQuestions;
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
      if (record.terminal && record.terminalChanged) send(record.connId, projectTerminalQuestions((terminalQuestions?.list() || []).filter(q => q.kind !== "terminal-prompt" || record.prompts && (q.body.screen !== null || record.promptFallback))));
      record.terminalChanged = false;
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

  const unsubscribeTerminal = terminalQuestions?.subscribe(() => changed("terminalChanged"));

  function handle(entry, message) {
    if (agents.refresh) return agents.refresh().then(() => initial(entry, message));
    return initial(entry, message);
  }

  function initial(entry, message) {
    const previous = connections.get(entry.connId);
    if (previous?.timer) clearTimer(previous.timer);
    const terminal = message.type === "session.watch";
    connections.set(entry.connId, { connId: entry.connId, lastSent: now(), timer: null, agents: false, requests: false, terminal, prompts: message.prompts === true, promptFallback: message.promptFallback === true });
    return [projectAgents(agents.list()), projectRequests(requests.list()),
      ...(terminal ? [projectTerminalQuestions((terminalQuestions?.list() || []).filter(q => q.kind !== "terminal-prompt" || message.prompts === true && (q.body.screen !== null || message.promptFallback === true)))] : [])];
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
    unsubscribeTerminal?.();
  }

  return { handle, closeConnection, close };
}
