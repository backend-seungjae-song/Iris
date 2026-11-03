import { AsyncLocalStorage } from "node:async_hooks";

export function createHostApiClient({ ipc, activity }) {
  const context = new AsyncLocalStorage();
  const current = () => context.getStore() || {};
  return {
    withCommand(command, fn) { return context.run(structuredClone(command), fn); },
    current,
    onRelayEvent(listener) { return ipc.onRelayEvent(listener); },
    async call(operation, input = {}, options = {}) {
      const command = current();
      command.callSeq = (command.callSeq || 0) + 1;
      const callId = options.callId ?? command.callSeq;
      const kind = options.activityKind || (operation === "qa.anchorUpdate" ? "journalWrites" : operation === "browser.executeWithDialog" ? "relayCommands" : null);
      const invoke = () => ipc.request(operation, {
        identity: options.identity || command.identity,
        commandId: options.commandId || command.commandId,
        callId,
        input,
      });
      if (!kind || !activity) return invoke();
      const id = `${command.commandId || "host"}:${operation}:${callId}`;
      return activity.run(kind, id, invoke, { allowDuringDrain: options.allowDuringDrain === true, detail: { operation } });
    },
  };
}
