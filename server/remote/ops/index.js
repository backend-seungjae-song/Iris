import { createPromptStore } from "../features/prompts.js";
import { REMOTE_REQUEST_TYPES } from "../contract/requests.js";
import { projectCaps } from "../projection.js";
import { createMessageOperation } from "./message.js";
import { handlePing } from "./ping.js";
import { createRequestAnswerOperation } from "./request-answer.js";
import { createStopOperation } from "./stop.js";
import { createUnregisterOperation } from "./unregister.js";
import { createTranscriptOperations } from "./transcript.js";
import { createWatchOperation } from "./watch.js";
import { createRemoteFeatures } from "../features/index.js";
import { installFeatureOperations } from "./features.js";
import { readMacName } from "../mac-name.js";

export function createRemoteOperations(options) {
  const features = options.features || createRemoteFeatures(options);
  const prompts = createPromptStore({ ...options, terminal: features.terminal });
  const questions = { list: () => {
    const parsed = prompts.list();
    const values = [...(options.terminalQuestions?.list() || []).filter(q => !parsed.some(p => p.agent === q.agent)), ...parsed].slice(0, 32);
    while (Buffer.byteLength(JSON.stringify(values)) > 32 * 1024) values.pop();
    return values;
  }, subscribe: fn => { const a = options.terminalQuestions?.subscribe(fn); const b = prompts.subscribe(fn); return () => { a?.(); b(); }; } };
  const watch = createWatchOperation({ ...options, terminalQuestions: questions });
  const transcript = createTranscriptOperations(options);
  const macName = options.macName || readMacName;
  const table = new Map();
  table.set("caps.get", async () => projectCaps([...table.keys()].filter((name) => name === "caps.get"
    || ["ping", "watch", "session.watch", "transcript.page", "transcript.watch", "agent.stop", "agent.message", "request.answer"].includes(name)
    || features.capabilities().includes(name)).concat(features.terminal.available() ? ["terminal.prompts", "terminal.prompt-fallback"] : []), await macName()));
  table.set("ping", handlePing);
  table.set("watch", watch.handle);
  table.set("session.watch", (entry, message) => { if (message.prompts === true) prompts.start(entry.connId); else prompts.stop(entry.connId); return watch.handle(entry, message); });
  table.set("transcript.page", transcript.page);
  table.set("transcript.watch", transcript.watch);
  table.set("agent.stop", createStopOperation(options));
  table.set("agent.message", createMessageOperation({ ...options, browserDrafts: features.browser }));
  table.set("request.answer", createRequestAnswerOperation(options));
  table.set("device.unregister", createUnregisterOperation(options));
  installFeatureOperations(table, features);
  if (JSON.stringify([...table.keys()]) !== JSON.stringify(REMOTE_REQUEST_TYPES)) {
    throw new Error("remote request table mismatch");
  }

  return {
    table,
    closeConnection(connId) {
      watch.closeConnection(connId);
      prompts.stop(connId);
      options.transcripts.closeConnection(connId);
      features.closeConnection(connId);
    },
    close() {
      watch.close();
      prompts.close();
      options.transcripts.close();
      features.close();
    },
  };
}
