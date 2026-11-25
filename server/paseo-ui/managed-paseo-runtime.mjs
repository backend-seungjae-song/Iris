import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

export async function loadManagedChatPermissions(runtime) {
  const require = createRequire(join(runtime, "package.json"));
  const dir = dirname(require.resolve("@getpaseo/server"));
  return import(pathToFileURL(join(dir, "authorization/operation-permissions.js")));
}

export async function loadManagedPaseo(runtime) {
  const require = createRequire(join(runtime, "package.json"));
  const entry = require.resolve("@getpaseo/server");
  const dir = dirname(entry);
  const load = (file) => import(pathToFileURL(join(dir, `${file}.js`)));
  const loadPackage = (id) => import(pathToFileURL(require.resolve(id, { paths: [dir, runtime] })));
  const [
    { version }, { DaemonClient }, { default: WebSocket }, { VoiceAssistantWebSocketServer },
    { AgentStorage }, { AgentManager }, { ProviderSnapshotManager }, { createAgentProviderRuntime },
    { ensureUnarchivedAgentLoaded }, { attachAgentStoragePersistence },
    { FileBackedProjectRegistry, FileBackedWorkspaceRegistry }, { bootstrapWorkspaceRegistries },
    { WorkspaceGitServiceImpl }, { createWorkspaceRuntimeStore }, { CheckoutDiffManager },
    { ScheduleService }, { DownloadTokenStore }, { DaemonConfigStore }, { getOrCreateServerId },
    { createRootLogger }, { loadConfig }, { createWorkspaceLabelService },
    { PluginService }, { BuiltinPluginLoader, builtinPlugins, resolveBuiltinPluginsRoot }, { OWNER_PERMISSIONS },
    { AGENT_PROVIDER_DEFINITIONS, DEV_AGENT_PROVIDER_DEFINITIONS }, { ProviderOverridesSchema }, { MAX_WEBSOCKET_MESSAGE_BYTES },
  ] = await Promise.all([
    readFile(resolve(dir, "../../../package.json"), "utf8").then(JSON.parse),
    loadPackage("@getpaseo/client/internal/daemon-client"), loadPackage("ws"),
    ...["websocket-server", "agent/agent-storage", "agent/agent-manager", "agent/provider-snapshot-manager",
      "agent/provider-runtime", "agent/agent-loading", "persistence-hooks", "workspace-registry",
      "workspace-registry-bootstrap", "workspace-git-service", "workspace-runtime-store/index",
      "checkout-diff-manager", "schedule/service", "file-download/token-store", "daemon-config-store",
      "server-id", "logger", "config", "workspace-labels/index",
      "plugins/index", "plugins/builtin/index", "authorization/index"].map(load),
    loadPackage("@getpaseo/protocol/provider-manifest"),
    loadPackage("@getpaseo/protocol/provider-config"),
    loadPackage("@getpaseo/protocol/websocket-message-limit"),
  ]);
  const clientEntry = require.resolve("@getpaseo/client/internal/daemon-client");
  const clientManifest = await readJSON(resolve(dirname(clientEntry), "../package.json"));
  if (clientManifest?.version !== version) throw new Error("Paseo server and client releases do not match");
  const runtimeOverrides = ProviderOverridesSchema.parse(await readJSON(join(runtime, "provider-overrides.json")) ?? {});
  const providerPlugins = await readJSON(join(runtime, "provider-plugins.json"));

  async function open({ http, stateDir, socket, provider }) {
    const logger = createRootLogger({ log: { file: { level: "warn" } } }, { paseoHome: stateDir });
    const config = loadConfig(stateDir);
    const serverId = getOrCreateServerId(stateDir, { logger, env: {} });
    const configured = { ...runtimeOverrides, ...config.providerOverrides };
    const builtins = config.isDev ? [...AGENT_PROVIDER_DEFINITIONS, ...DEV_AGENT_PROVIDER_DEFINITIONS] : AGENT_PROVIDER_DEFINITIONS;
    const providers = Object.fromEntries(builtins.map(({ id }) => [id, { enabled: id === provider }]));
    providers[provider] = { ...configured[provider], enabled: true };
    const selectedPlugin = providerPlugins?.[provider] ?? `${provider}-provider`;
    const daemonConfig = new DaemonConfigStore(stateDir, {
      relay: { enabled: false }, mcp: { enabled: false, injectIntoAgents: false },
      agentProfiles: config.agentProfiles, providers,
    }, logger, { relayEnabledMutable: false });
    const pluginRuntime = new PluginService(logger, daemonConfig, version, {
      builtinPlugins: new BuiltinPluginLoader(undefined, builtinPlugins.includes(selectedPlugin) ? [selectedPlugin] : []),
    });
    const store = new AgentStorage(config.agentStoragePath, logger);
    const projects = new FileBackedProjectRegistry(join(stateDir, "projects", "projects.json"), logger);
    const workspaces = new FileBackedWorkspaceRegistry(join(stateDir, "projects", "workspaces.json"), logger);
    const labels = createWorkspaceLabelService({ paseoHome: stateDir, workspaceRegistry: workspaces });
    const git = new WorkspaceGitServiceImpl({ logger, paseoHome: stateDir, worktreesRoot: config.worktreesRoot });
    const runtimes = createWorkspaceRuntimeStore();
    git.onSnapshotUpdated((snapshot) => runtimes.set(snapshot));
    const snapshotOptions = {
      logger, workspaceGitService: git, runtimeSettings: config.agentProviderSettings,
      providerOverrides: providers, refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs, isDev: config.isDev,
    };
    const providerRuntime = providerBase(provider, providers) === "opencode"
      ? await createAgentProviderRuntime({ paseoHome: stateDir, logger, snapshotManager: snapshotOptions })
      : localProviderRuntime(new ProviderSnapshotManager(snapshotOptions));
    const snapshots = providerRuntime.snapshotManager;
    const agent = new AgentManager({ ...snapshots.getAgentManagerProviderState(), registry: store, logger,
      pluginLifecycle: pluginRuntime, pluginAgentTools: pluginRuntime,
      appendSystemPrompt: config.appendSystemPrompt, paseoToolsEnabled: false,
      onWorkspaceStateMayHaveChanged: ({ cwd }) => git.onWorkspaceStateMayHaveChanged(cwd) });
    const detachPersistence = attachAgentStoragePersistence(logger, agent, store);
    let sessionServer;
    let client;
    let detachProviders;
    let stopIngress;
    async function close() {
      detachProviders?.();
      sessionServer?.prepareForShutdown();
      await client?.close();
      await sessionServer?.agentMessages.close();
      agent.prepareForShutdown();
      await Promise.allSettled(agent.listAgents({ includeInternal: true }).map(({ id }) => agent.closeAgent(id)));
      await agent.flushForShutdown();
      detachPersistence();
      await store.flush();
      if (sessionServer) await sessionServer.close();
      else await git.dispose();
      await stopIngress?.();
      await providerRuntime.shutdown();
      await pluginRuntime.stopAllPlugins();
    }
    try {
      await store.initialize();
      await bootstrapWorkspaceRegistries({ serverId, paseoHome: stateDir, agentStorage: store,
        projectRegistry: projects, workspaceRegistry: workspaces, workspaceGitService: git, logger });
      await labels.initialize();
      const schedule = new ScheduleService({ paseoHome: stateDir, logger, agentManager: agent, agentStorage: store });
      const diffs = new CheckoutDiffManager({ logger, paseoHome: stateDir, workspaceGitService: git, workspaceRuntimeStore: runtimes });
      const downloads = new DownloadTokenStore({ ttlMs: 60_000 });
      sessionServer = new VoiceAssistantWebSocketServer(createServer(), logger, serverId, agent, store, downloads,
        stateDir, daemonConfig, undefined, { daemonStatusRpc: false, relayConfig: false }, undefined, runtimes,
        undefined, undefined, undefined, undefined, version, undefined, projects, workspaces, schedule, diffs,
        undefined, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined,
        snapshots, { desktopManaged: true, worktreesRoot: config.worktreesRoot }, undefined, undefined,
        undefined, undefined, pluginRuntime, undefined, labels);
      pluginRuntime.bindPaseoSessionHost(sessionServer);
      detachProviders = pluginRuntime.subscribeProviderRegistrations(() => {
        agent.updateProviderRegistry(snapshots.replacePluginProviders(pluginRuntime.getProviderRegistrations()));
      });
      await pluginRuntime.start();
      snapshots.settlePluginProviders();
      if (!Object.hasOwn(snapshots.getAgentManagerProviderState().clients, provider)) {
        throw new Error(`Paseo provider '${provider}' is unavailable in this release`);
      }
      if (socket) stopIngress = socketIngress(http, sessionServer, WebSocket.Server, MAX_WEBSOCKET_MESSAGE_BYTES, OWNER_PERMISSIONS);
      client = new DaemonClient({ url: "ws://localhost/ws", clientId: `${serverId}-terminal`, clientType: "cli",
        appVersion: version, reconnect: { enabled: false }, connectTimeoutMs: 5_000, logger,
        ...(socket
          ? { webSocketFactory: () => new WebSocket(`ws+unix://${socket}:/ws/owner`) }
          : { transportFactory: () => memoryTransport(sessionServer, OWNER_PERMISSIONS) }) });
      await client.connect();
      return { serverId, agent, client, store, close,
        loadAgent: (id) => ensureUnarchivedAgentLoaded(id, { agentManager: agent, agentStorage: store, logger }) };
    } catch (error) {
      await close().catch((failure) => logger.error({ err: failure }, "Managed host shutdown failed"));
      throw error;
    }
  }
  async function checkBuiltinPlugins() {
    if (!providerPlugins) return;
    const { compileDirectoryPlugin } = await load("plugins/compiler");
    const root = resolveBuiltinPluginsRoot();
    for (const id of new Set(Object.values(providerPlugins))) {
      if (!builtinPlugins.includes(id)) throw new Error(`Paseo provider references an unknown bundled plugin '${id}'`);
      const { serverBundle } = await compileDirectoryPlugin(join(root, id), version, id);
      if (!serverBundle) throw new Error(`Paseo provider plugin '${id}' has no server entry`);
    }
  }
  return { open, checkBuiltinPlugins };
}

function socketIngress(http, sessions, WebSocketServer, maxPayload, ownerPermissions) {
  const ws = new WebSocketServer({ noServer: true, maxPayload });
  const browser = { principalId: "iris-chat", permissions: ["workspace.read", "workspace.write", "daemon.read"] };
  const owner = { principalId: "owner", permissions: ownerPermissions };
  function upgrade(request, connection, head) {
    const admission = request.url === "/ws" ? browser : request.url === "/ws/owner" ? owner : null;
    if (!admission) { connection.destroy(); return; }
    ws.handleUpgrade(request, connection, head, (socket) => {
      void sessions.attachExternalSocket(socket, undefined, admission).catch(() => socket.close(1011, "Session unavailable"));
    });
  }
  http.on("upgrade", upgrade);
  return () => {
    http.off("upgrade", upgrade);
    return new Promise((resolve) => ws.close(resolve));
  };
}

async function readJSON(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}

function memoryTransport(server, permissions) {
  const client = new EventEmitter();
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send(frame, callback) {
      queueMicrotask(() => client.emit("message", frame, typeof frame !== "string"));
      callback?.();
    },
    close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", code, reason);
      client.emit("close", { code, reason });
    },
  });
  const on = (name, callback) => {
    client.on(name, callback);
    return () => client.off(name, callback);
  };
  void server.attachExternalSocket(socket, undefined, { principalId: "owner", permissions })
    .then(() => client.emit("open"), (error) => client.emit("error", error));
  return {
    supportsDrain: true,
    send: (frame) => { queueMicrotask(() => socket.emit("message", frame)); },
    close: (code, reason) => socket.close(code, reason),
    onMessage: (callback) => on("message", callback),
    onOpen: (callback) => on("open", callback),
    onClose: (callback) => on("close", callback),
    onError: (callback) => on("error", callback),
  };
}

function localProviderRuntime(snapshotManager) {
  return { snapshotManager, shutdown: () => snapshotManager.shutdown() };
}

function providerBase(provider, providers) {
  const visited = new Set();
  while (providers[provider]?.extends && !visited.has(provider)) {
    visited.add(provider);
    provider = providers[provider].extends;
  }
  return provider;
}
