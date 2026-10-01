import { fitsRemoteIpc, isHostMessage, REMOTE_RPC_VERSION } from "../contract/ipc.js";
import { createGateway } from "./server.js";

const serverInstance = process.argv[2] || "";
let configured = false;
let exiting = false;

function exitNow(code = 1) {
  if (exiting) return;
  exiting = true;
  gateway.stop();
  process.exit(code);
}

const gateway = createGateway({
  sendIpc(message, callback) {
    if (!process.connected || typeof process.send !== "function") {
      callback?.(new Error("IPC disconnected"));
      return false;
    }
    return process.send(message, callback);
  },
  onFatal: () => exitNow(1),
});

process.on("message", (message) => {
  if (!fitsRemoteIpc(message) || !isHostMessage(message)) return exitNow(1);
  if (!configured) {
    if (message.type !== "configure" || message.serverInstance !== serverInstance) return exitNow(1);
    configured = true;
    void gateway.start(message).catch(() => exitNow(1));
    return;
  }
  gateway.receive(message);
});
process.on("disconnect", () => exitNow(0));
process.on("SIGTERM", () => exitNow(0));

if (!process.connected || typeof process.send !== "function") exitNow(1);
else process.send({ type: "hello", v: REMOTE_RPC_VERSION, serverInstance }, (error) => {
  if (error) exitNow(1);
});
