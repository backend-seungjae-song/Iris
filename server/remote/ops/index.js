import { REMOTE_REQUEST_TYPES } from "../contract/requests.js";
import { projectCaps } from "../projection.js";
import { createMessageOperation } from "./message.js";
import { handlePing } from "./ping.js";
import { createRequestAnswerOperation } from "./request-answer.js";
import { createStopOperation } from "./stop.js";
import { createTranscriptOperations } from "./transcript.js";
import { createWatchOperation } from "./watch.js";
import { createRemoteFeatures } from "../features/index.js";
import { installFeatureOperations } from "./features.js";
import { readMacName } from "../mac-name.js";

export function createRemoteOperations(options) {
  const watch = createWatchOperation(options);
  const transcript = createTranscriptOperations(options);
  const macName = options.macName || readMacName;
  const table = new Map();
  const features = options.features || createRemoteFeatures(options);
  table.set("caps.get", async () => projectCaps([...table.keys()].filter((name) => name === "caps.get"
    || ["ping", "watch", "transcript.page", "transcript.watch", "agent.stop", "agent.message", "request.answer"].includes(name)
    || features.capabilities().includes(name)), await macName()));
  table.set("ping", handlePing);
  table.set("watch", watch.handle);
  table.set("transcript.page", transcript.page);
  table.set("transcript.watch", transcript.watch);
  table.set("agent.stop", createStopOperation(options));
  table.set("agent.message", createMessageOperation({ ...options, browserDrafts: features.browser }));
  table.set("request.answer", createRequestAnswerOperation(options));
  installFeatureOperations(table, features);
  if (JSON.stringify([...table.keys()]) !== JSON.stringify(REMOTE_REQUEST_TYPES)) {
    throw new Error("remote request table mismatch");
  }

  return {
    table,
    closeConnection(connId) {
      watch.closeConnection(connId);
      options.transcripts.closeConnection(connId);
      features.closeConnection(connId);
    },
    close() {
      watch.close();
      options.transcripts.close();
      features.close();
    },
  };
}
