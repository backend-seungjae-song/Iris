const params = new URLSearchParams(globalThis.location?.search);
const key = params.get("managed");
const agentId = params.get("agentId");
const serverId = params.get("serverId");
const workspaceId = params.get("workspaceId");

export const managedChat = key && agentId && serverId && workspaceId
  ? { key, agentId, serverId, workspaceId, host: "iris-managed.invalid:80" }
  : null;

const clientNamespace = managedChat ? crypto.randomUUID() : null;

export const managedPrompt = {
  expand: (text: string) => ({ text, contextIds: [] as string[] }),
  accepted: (_ids: string[]) => {},
};

export class ManagedSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  private readonly socketId = crypto.randomUUID();
  private readonly sentContexts = new Map<string, string[]>();

  constructor(readonly url: string, private readonly key: string) {
    super();
    window.addEventListener("message", this.receive);
    this.post("connect");
  }

  private post(event: string, data?: string, binary?: boolean) {
    window.parent.postMessage({ type: "iris-chat.managed-relay", key: this.key, socketId: this.socketId, clientNamespace, event, data, binary }, location.origin);
  }

  private readonly receive = (message: MessageEvent) => {
    if (message.origin !== location.origin || message.source !== window.parent) return;
    const frame = message.data;
    if (frame?.type !== "iris-chat.managed-relay" || frame.key !== this.key || (frame.socketId !== this.socketId && frame.event !== "reset")) return;
    if (frame.event === "open" && this.readyState === 0) {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    } else if (frame.event === "message" && this.readyState === 1 && typeof frame.data === "string") {
      const data = frame.binary ? Uint8Array.from(atob(frame.data), (value) => value.charCodeAt(0)).buffer : frame.data;
      if (typeof data === "string" && this.sentContexts.size) {
        const message = JSON.parse(data).message;
        const requestId = message?.payload?.requestId;
        if (this.sentContexts.has(requestId) && (message.type === "send_agent_message_response" || message.type === "rpc_error")) {
          if (message.payload.accepted === true) managedPrompt.accepted(this.sentContexts.get(requestId)!);
          this.sentContexts.delete(requestId);
        }
      }
      this.dispatchEvent(new MessageEvent("message", { data }));
    } else if (frame.event === "close" || frame.event === "reset") {
      this.finish(frame.code || 1006);
    }
  };

  send(data: string | Uint8Array | ArrayBuffer) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      const message = frame?.message;
      if (message?.type === "send_agent_message_request" && typeof message.text === "string") {
        const expanded = managedPrompt.expand(message.text);
        if (expanded.contextIds.length) {
          this.sentContexts.set(message.requestId, expanded.contextIds);
          message.text = expanded.text;
          data = JSON.stringify(frame);
        }
      }
      this.post("message", data);
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    this.post("message", btoa(text), true);
  }

  close() {
    this.post("close");
    this.finish(1000);
  }

  private finish(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    window.removeEventListener("message", this.receive);
    queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code, wasClean: code === 1000 })));
  }
}
