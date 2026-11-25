import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { liveManagedPane } from "../paseo-ui/managed-pane.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOKUP_TIMEOUT_MS = 3_000;

export function hasManagedAgentIdentity(source) {
  return [source?.managedProvider, source?.paneId, source?.terminalId].every((id) => typeof id === "string" && id.length > 0) &&
    typeof source.sessionUuid === "string" && UUID.test(source.sessionUuid);
}

async function withDeadline(pending) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Paseo request timed out")), LOOKUP_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

async function openClient(record) {
  const { releasedRuntime } = await import("../paseo-ui/index.js");
  const release = releasedRuntime(record.build);
  if (!release) throw new Error("Paseo runtime unavailable");
  const require = createRequire(join(release.dir, "package.json"));
  const WebSocket = require("ws");
  const { DaemonClient } = await import(pathToFileURL(require.resolve("@getpaseo/client/internal/daemon-client")));
  return new DaemonClient({ url: "ws://localhost/ws", clientType: "cli", clientId: `iris-remote-${randomUUID()}`,
    reconnect: { enabled: false }, connectTimeoutMs: LOOKUP_TIMEOUT_MS,
    webSocketFactory: () => new WebSocket(`ws+unix://${record.socketPath}:/ws`) });
}

export function createManagedAgentOperations({ getHerdr, readPane = liveManagedPane, openClient: makeClient = openClient }) {
  async function resolvePane(source) {
    const herdr = getHerdr();
    if (typeof herdr?.paneGet !== "function") throw new Error("Herdr unavailable");
    const pane = await herdr.paneGet(source.paneId);
    if (pane?.pane_id !== source.paneId || pane.terminal_id !== source.terminalId || pane.agent !== "iris-paseo") return null;
    const record = readPane(pane);
    return record?.agentId === source.sessionUuid && record.provider === source.managedProvider &&
      record.serverId && record.workspaceId ? record : null;
  }

  async function run(agent, resolveCurrent, operation) {
    const source = agent.source;
    const matchesCurrent = () => {
      const current = resolveCurrent()?.source;
      return current?.managedProvider === source.managedProvider && current.paneId === source.paneId &&
        current.terminalId === source.terminalId && current.sessionUuid === source.sessionUuid;
    };
    if (!hasManagedAgentIdentity(source) || !matchesCurrent()) return "forbidden";
    let client;
    try {
      const record = await resolvePane(source);
      if (!record) return "forbidden";
      client = await makeClient(record);
      await client.connect();
      if (client.getLastServerInfoMessage()?.serverId !== record.serverId) return "forbidden";
      const { agent: upstream } = await client.fetchAgent({ agentId: record.agentId, timeout: LOOKUP_TIMEOUT_MS }) ?? {};
      if (upstream?.id !== record.agentId || upstream.provider !== record.provider || upstream.workspaceId !== record.workspaceId) return "forbidden";
      const current = await resolvePane(source);
      if (!matchesCurrent() || current?.serverId !== record.serverId || current.workspaceId !== record.workspaceId ||
        current.socketPath !== record.socketPath || current.build !== record.build) return "forbidden";
      return await operation(client, upstream);
    } catch {
      return "failed";
    } finally {
      if (client) await withDeadline(client.close()).catch(() => {});
    }
  }

  return {
    send(agent, text, resolveCurrent) {
      return run(agent, resolveCurrent, async (client, upstream) => {
        await withDeadline(client.sendAgentMessage(upstream.id, text));
        return "sent";
      });
    },
    stop(agent, resolveCurrent) {
      return run(agent, resolveCurrent, async (client, upstream) => {
        if (upstream.status !== "running") return "not-working";
        await withDeadline(client.cancelAgent(upstream.id));
        return "sent";
      });
    },
  };
}
