import { mkdir, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyProviderConfig } from "./provider-config.mjs";
import { createEmbeddedTimeline } from "./embedded-timeline.mjs";
import { clearRuntimeHandoff, readRuntimeHandoff, reserveRuntimeHandoff } from "./embedded-handoff.mjs";
import { geminiCliPin, readGeminiHistory } from "./gemini-history.mjs";

const validAgentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const launchContextKeys = new Set([
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "HERDR_SESSION",
  "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "IRIS_PORT", "IRIS_STATE_DIR", "IRIS_HERDR_SESSION",
]);

function paneLaunchEnv(env) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => launchContextKeys.has(key)).map(([key, value]) => {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error(`Paseo 실행 환경을 확인할 수 없습니다 (${key})`);
    return [key, value];
  }));
}

async function loadRelease(runtime, stateDir) {
  const require = createRequire(join(runtime, "package.json"));
  const dir = dirname(require.resolve("@getpaseo/server"));
  const load = (name) => import(pathToFileURL(join(dir, `${name}.js`)));
  const [
    { AgentManager }, { ProviderSnapshotManager }, { AgentStorage },
    { attachAgentStoragePersistence, buildConfigOverrides, extractAttention, extractTimestamps, toAgentPersistenceHandle },
    { toAgentPayload, buildStoredAgentPayload }, { ensureUnarchivedAgentLoaded }, { sendPreparedPromptToAgent, waitForAgentRunStartWithTimeout },
    { prepareAgentMessage, projectAgentMessages }, { projectTimelineRows }, { writeJsonFileAtomic }, { OpenCodeBridge },
    { createRootLogger }, { InMemoryAgentTimelineStore }, { plugins }, providerOverrides,
  ] = await Promise.all([
    ...["agent/agent-manager", "agent/provider-snapshot-manager", "agent/agent-storage", "persistence-hooks",
      "agent/agent-projections", "agent/agent-loading", "agent/agent-prompt", "agent/agent-messages/index", "agent/timeline-projection",
      "atomic-file", "agent/providers/opencode/bridge", "logger", "agent/agent-timeline-store"].map(load),
    import(pathToFileURL(join(runtime, "embedded-providers.mjs"))),
    readFile(join(runtime, "provider-overrides.json"), "utf8").then(JSON.parse),
  ]);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logger = createRootLogger({ level: "warn" }, { paseoHome: stateDir, file: false });
  const registrations = [];
  const disposePlugins = [];
  const bridge = new OpenCodeBridge({ paseoHome: stateDir, logger });
  let snapshots;
  let detach;
  let bridgeStart;
  try {
    for (const [, contribute] of plugins) {
      const dispose = await contribute({ registerProvider: (value) => registrations.push(value), registerUsageSource() {} });
      if (dispose) disposePlugins.push(dispose);
    }
    snapshots = new ProviderSnapshotManager({ logger, providerOverrides, openCodeBridge: bridge });
    const providerState = snapshots.replacePluginProviders(registrations);
    snapshots.settlePluginProviders();
    const storage = new AgentStorage(join(stateDir, "agents"), logger);
    await storage.initialize();
    const timeline = createEmbeddedTimeline(join(stateDir, "timeline"), writeJsonFileAtomic);
    const memoryTimeline = new InMemoryAgentTimelineStore();
    const manager = new AgentManager({ ...providerState, registry: storage, timelineStore: memoryTimeline,
      durableTimelineStore: timeline, logger, paseoToolsEnabled: false });
    detach = attachAgentStoragePersistence(logger, manager, storage);
    const agentDeps = { agentManager: manager, agentStorage: storage, logger };
    return {
      manager, storage, timeline, memoryTimeline, logger, projectTimelineRows, projectAgentMessages, writeJsonFileAtomic,
      projectAgent(live, stored) {
        return live ? toAgentPayload(live) : buildStoredAgentPayload(stored, manager.getRegisteredProviderIds(),
          (provider, options) => manager.effectiveOptionsFor(provider, options));
      },
      providerIds: Object.keys(providerState.clients),
      geminiPin: geminiCliPin(providerOverrides.gemini?.command),
      models: (provider, cwd) => snapshots.listModels({ provider, cwd, wait: true }),
      async prepareProvider(provider) {
        if (provider !== "opencode" && providerState.providerDefinitions[provider]?.derivedFromProviderId !== "opencode") return;
        bridgeStart ??= bridge.start().catch((error) => { bridgeStart = undefined; throw error; });
        await bridgeStart;
      },
      async applyConfig(agentId, value) {
        const [{ AgentConfigSession }, { AgentConfigApplySchema }, { setAgentModeCommand }] = await Promise.all([
          load("session/agent-config/agent-config-session"),
          import(pathToFileURL(require.resolve("@getpaseo/protocol/messages"))),
          load("agent/lifecycle-command"),
        ]);
        return applyProviderConfig({ AgentConfigSession, AgentConfigApplySchema, logger, agentId, config: value,
          operations: {
            ensureLoaded: id => ensureUnarchivedAgentLoaded(id, agentDeps),
            setMode: async (id, modeId) => (await setAgentModeCommand({ agentManager: manager }, { agentId: id, modeId })).notice,
            setModel: (id, model) => manager.setAgentModel(id, model),
            setThinking: (id, thinking) => manager.setAgentThinkingOption(id, thinking),
            setOptions: (id, patch) => manager.setAgentOptions(id, patch),
          },
        });
      },
      restore: (id) => ensureUnarchivedAgentLoaded(id, agentDeps),
      resumeForHistory(record) {
        const handle = toAgentPersistenceHandle(manager.getRegisteredProviderIds(), record.persistence);
        if (!handle) throw new Error("제공자 세션을 다시 열 수 없습니다");
        return manager.resumeAgentFromPersistence(handle, buildConfigOverrides(record), record.id, {
          ...extractTimestamps(record), attention: extractAttention(record), workspaceId: record.workspaceId,
        });
      },
      async send(agentId, text, options) {
        const message = prepareAgentMessage(text, null, options.clientMessageId);
        const dispatched = await sendPreparedPromptToAgent({ ...agentDeps, agentId, prompt: message.prompt,
          unarchive: false, activeTurnBehavior: options.activeTurnBehavior,
          runOptions: { clientMessageId: message.messageId } });
        if (dispatched.disposition === "turn_started") await waitForAgentRunStartWithTimeout(manager, agentId, dispatched.started);
        return dispatched.disposition;
      },
      async close() {
        manager.prepareForShutdown();
        try {
          const closed = await Promise.allSettled(manager.listAgents({ includeInternal: true }).map(({ id }) => manager.closeAgent(id)));
          await manager.flushForShutdown();
          await storage.flush();
          const failure = closed.find(({ status }) => status === "rejected");
          if (failure) throw failure.reason;
        } finally { await disposeRelease(); }
      },
    };
  } catch (error) {
    await disposeRelease();
    throw error;
  }

  async function disposeRelease() {
    detach?.();
    try { await snapshots?.shutdown(); }
    finally {
      await bridge.close();
      await Promise.all(disposePlugins.map((dispose) => dispose()));
    }
  }
}

export function createEmbeddedRuntime({ runtime, stateDir }) {
  if (!isAbsolute(runtime) || !isAbsolute(stateDir)) throw new Error("Paseo 실행 및 저장 폴더에 절대 경로가 필요합니다");
  let opening;
  let closing;
  const lanes = new Map();
  const listeners = new Map();
  const releaseRequested = new Set();
  const transcriptHistory = new Map();

  function open() {
    if (closing) throw new Error("Paseo 런타임이 종료 중입니다");
    opening ??= loadRelease(runtime, stateDir).then((release) => {
      const detach = release.manager.subscribe((event) => {
        const id = event.agentId ?? event.agent?.id ?? event.event?.parentAgentId;
        for (const listener of listeners.get(id) ?? []) {
          try { listener(event); } catch (error) { release.logger.warn({ err: error }, "Paseo session observer failed"); }
        }
        if (releaseRequested.has(id) && event.type === "agent_state" && event.agent.lifecycle === "idle") {
          queueMicrotask(() => {
            if (!closing) void evict(id).catch((error) => release.logger.warn({ err: error, agentId: id }, "Paseo runtime release failed"));
          });
        }
      }, { replayState: false });
      return { ...release, detach };
    }).catch((error) => { opening = undefined; throw error; });
    return opening;
  }

  function queue(id, action) {
    if (!validAgentId.test(id ?? "")) throw new Error("Paseo 세션 ID가 잘못되었습니다");
    if (closing) throw new Error("Paseo 런타임이 종료 중입니다");
    const result = (lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    lanes.set(id, result);
    const done = () => { if (lanes.get(id) === result) lanes.delete(id); };
    void result.then(done, done);
    return result;
  }

  function operate(id, action, requireChatOwnership = false) {
    return queue(id, async () => {
      if (requireChatOwnership) await assertChatOwns(id);
      return action(await open());
    });
  }

  async function getReadyAgent(release, id) {
    const live = release.manager.getAgent(id);
    if (live) return live;
    const stored = await release.storage.get(id);
    if (!stored) throw new Error("저장된 Paseo 세션을 찾을 수 없습니다");
    await release.prepareProvider(stored.provider);
    return release.restore(id);
  }

  async function assertChatOwns(id) {
    if (await readRuntimeHandoff(stateDir, id)) throw new Error("터미널 대화를 종료한 뒤 다시 여세요");
  }

  function evict(id) {
    if (!opening || closing) return Promise.resolve(false);
    return operate(id, async ({ manager, storage, memoryTimeline }) => {
      const unobserved = () => releaseRequested.has(id) && !listeners.get(id)?.size;
      if (!unobserved()) return false;
      const agent = manager.getAgent(id);
      if (!agent) { releaseRequested.delete(id); return false; }
      const nativeACP = agent.session.agentCapabilities;
      if (nativeACP && !nativeACP.loadSession && !nativeACP.sessionCapabilities?.resume) return false;
      const candidate = manager.getRuntimeCleanupCandidates().find(({ agentId }) => agentId === id);
      if (!candidate?.sessionId || !candidate.isEligible()) return false;
      if (candidate.canStopRuntime && await candidate.canStopRuntime() !== true) return false;
      const closed = await candidate.closeIfEligible(unobserved);
      if (closed) {
        releaseRequested.delete(id);
        transcriptHistory.delete(id);
        await storage.flush();
        memoryTimeline.delete(id);
      }
      return closed;
    });
  }

  function ensureAgent({ agentId, provider, cwd, workspaceId, env }) {
    releaseRequested.delete(agentId);
    return operate(agentId, async (release) => {
      const resolvedCwd = await realpath(cwd);
      const launchEnv = paneLaunchEnv(env);
      const live = release.manager.getAgent(agentId);
      const existing = live ?? await release.storage.get(agentId);
      if (existing) {
        if (existing.provider !== provider || existing.cwd !== resolvedCwd || existing.workspaceId !== workspaceId) {
          throw new Error("저장된 Paseo 세션이 요청한 제공자 또는 작업 폴더와 일치하지 않습니다");
        }
        if (Object.entries(launchEnv).some(([key, value]) => value !== existing.launchEnv?.[key])) {
          if (live) throw new Error("대화를 다시 열기 전에 기존 Paseo 연결을 닫으세요");
          await release.storage.upsert({ ...existing, launchEnv: { ...existing.launchEnv, ...launchEnv } });
        }
        await getReadyAgent(release, agentId);
      } else {
        if (!release.providerIds.includes(provider)) throw new Error(`지원하지 않는 Paseo 제공자입니다 (${provider})`);
        await release.prepareProvider(provider);
        await release.manager.createAgent({ provider, cwd: resolvedCwd }, agentId,
          { workspaceId, persistSession: true, env: launchEnv });
        await release.storage.flush();
      }
      return agentId;
    }, true);
  }

  async function snapshot(id) {
    if (!validAgentId.test(id ?? "")) throw new Error("Paseo 세션 ID가 잘못되었습니다");
    const { manager, storage, timeline, projectTimelineRows, projectAgent } = await open();
    const agent = manager.getAgent(id);
    const live = agent && manager.fetchTimeline(id, { limit: 0 });
    const stored = agent ?? await storage.get(id);
    if (!stored) return null;
    const boundary = live?.rows[0]?.seqStart ?? live?.window.nextSeq;
    let history = [];
    if (!live) {
      history = projectTimelineRows({ rows: await timeline.getCommittedRows(id), mode: "projected" });
    } else if (boundary > 1) {
      const cached = transcriptHistory.get(id);
      if (cached?.epoch === live.epoch && cached.boundary === boundary) {
        history = await cached.rows;
      } else {
        const rows = timeline.getCommittedRows(id).then((committed) =>
          projectTimelineRows({ rows: committed.filter(({ seq }) => seq < boundary), mode: "projected" }));
        transcriptHistory.set(id, { epoch: live.epoch, boundary, rows });
        history = await rows;
      }
    }
    const timelineRows = live ? [...history, ...live.rows] : history;
    const { controls, features, options, lastUsage } = projectAgent(agent, stored);
    return { controls, features, options, lastUsage, thinkingOptionId: agent?.runtimeInfo?.thinkingOptionId ?? stored.config?.thinkingOptionId ?? null,
      timeline: timelineRows.map(({ item }) => item), timelineRows,
      status: agent?.lifecycle ?? "closed", permissions: [...(agent?.pendingPermissions.values() ?? [])],
      provider: stored.provider, availableModes: agent?.availableModes ?? [],
      modeId: agent?.currentModeId ?? stored.lastModeId ?? null, model: agent?.runtimeInfo?.model ?? stored.config?.model ?? null };
  }

  function describeHandle(id) {
    return operate(id, async ({ manager, storage, timeline }) => {
      const agent = manager.getAgent(id);
      const stored = agent ?? await storage.get(id);
      if (!stored) return null;
      const empty = !manager.getLoadedTimelineHead(id)?.seq && !(await timeline.getLatestCommittedSeq(id));
      return {
        provider: stored.provider, sessionId: handoffSessionId(stored, id, empty), persistenceId: stored.persistence?.sessionId ?? null,
        empty,
      };
    }, true);
  }

  function releaseForTerminal(id, owner) {
    return operate(id, async ({ manager, storage, timeline, memoryTimeline }) => {
      const agent = manager.getAgent(id);
      const stored = agent ?? await storage.get(id);
      const empty = !manager.getLoadedTimelineHead(id)?.seq && !(await timeline.getLatestCommittedSeq(id));
      if (!stored || typeof owner.sessionId !== "string" || (stored.persistence?.sessionId ?? null) !== owner.persistenceId ||
          handoffSessionId(stored, id, empty) !== owner.sessionId || empty !== owner.empty) {
        throw new Error("터미널로 열려는 대화가 변경되었습니다");
      }
      const candidate = agent && manager.getRuntimeCleanupCandidates().find(({ agentId }) => agentId === id);
      if (agent && (!candidate?.isEligible() || (candidate.canStopRuntime && !await candidate.canStopRuntime()))) {
        throw new Error("응답 또는 질문이 끝난 뒤 터미널로 전환하세요");
      }
      const ownership = await reserveRuntimeHandoff(stateDir, id, owner);
      try {
        if (candidate) {
          if (!candidate.sessionId && empty && candidate.isEligible()) {
            await manager.closeAgent(id);
          } else if (!await candidate.closeIfEligible(() => true)) {
            throw new Error("대화의 실행 상태가 변경되었습니다");
          }
        }
        await storage.flush();
        memoryTimeline.delete(id);
        transcriptHistory.delete(id);
        return ownership;
      } catch (error) {
        await clearRuntimeHandoff(stateDir, id, ownership.token, "reserved");
        throw error;
      }
    }, true);
  }

  async function prepareNativeFirst(identity, binding) {
    const { agentId, provider, cwd, workspaceId, env } = identity;
    if (!supportsNativeSeed(provider)) throw new Error("이 제공자의 터미널 대화를 연결할 수 없습니다");
    return queue(agentId, async () => {
      const resolvedCwd = await realpath(cwd);
      const launchEnv = paneLaunchEnv(env);
      const records = join(stateDir, "agents");
      const dirs = await readdir(records, { withFileTypes: true }).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const file = agentId + ".json";
      const stored = await hasStoredAgent(records, file, dirs);
      if (stored || (opening && await (await opening).storage.get(agentId))) throw new Error("이미 시작한 Paseo 세션입니다");
      return reserveRuntimeHandoff(stateDir, agentId, { ...binding, nativeFirst: true, sessionId: agentId,
        persistenceId: null, empty: true, identity: { provider, cwd: resolvedCwd, workspaceId, launchEnv } });
    });
  }

  function returnFromTerminal(id, owner, verifyExited) {
    return operate(id, async (release) => {
      const { manager, storage, timeline, memoryTimeline, writeJsonFileAtomic } = release;
      const current = await readRuntimeHandoff(stateDir, id);
      if (current?.token !== owner.token || current.phase !== "exited") throw new Error("터미널 대화의 종료를 확인할 수 없습니다");
      await verifyExited();
      let stored = await storage.get(id);
      if (current.nativeFirst) {
        const { provider, cwd, workspaceId, launchEnv } = current.identity;
        if (!supportsNativeSeed(provider) || !release.providerIds.includes(provider) || !isAbsolute(cwd)) {
          throw new Error("터미널에 저장된 제공자를 다시 열 수 없습니다");
        }
        if (!stored) {
          const timestamp = new Date().toISOString();
          stored = { id, provider, cwd, workspaceId, launchEnv, createdAt: timestamp, updatedAt: timestamp, lastStatus: "closed" };
          await storage.upsert(stored);
        } else if (stored.provider !== provider || stored.cwd !== cwd || stored.workspaceId !== workspaceId) {
          throw new Error("저장된 터미널 대화와 연결 정보가 일치하지 않습니다");
        }
      }
      const seeded = current.persistenceId === null && current.empty && current.sessionId === id &&
        supportsNativeSeed(stored?.provider) && (!stored.persistence || nativeSessionId(stored) === id);
      if (!stored || manager.getAgent(id) || (!seeded &&
          (stored.persistence?.sessionId !== current.persistenceId || nativeSessionId(stored) !== current.sessionId))) {
        throw new Error("저장된 터미널 대화와 연결 정보가 일치하지 않습니다");
      }
      const recoveryFile = join(stateDir, "handoffs", `${id}.replay.json`);
      const recovery = await readFile(recoveryFile, "utf8").then(JSON.parse).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      let rows = recovery?.token === owner.token ? recovery.rows : null;
      if (!rows) {
        const previous = await timeline.getCommittedRows(id);
        // Gemini의 ACP 세션 열기 응답이 기록 스트림보다 먼저 끝나는 경우
        if (stored.provider === "gemini" && release.geminiPin) {
          const events = await readGeminiHistory(release.geminiPin, stored.cwd, current.sessionId);
          rows = await nativeTimelineSuffix(previous, events, release.projectAgentMessages, stored.provider);
        } else {
          await release.prepareProvider(stored.provider);
          const agent = await release.resumeForHistory(seeded && !stored.persistence ? {
            ...stored, persistence: { provider: stored.provider, sessionId: id, nativeHandle: id },
          } : stored);
          try { rows = await nativeTimelineSuffix(previous, agent.session.streamHistory(), release.projectAgentMessages, stored.provider); }
          finally { await manager.closeAgent(id); }
        }
        await writeJsonFileAtomic(recoveryFile, { token: owner.token, rows });
      }
      await verifyExited();
      await timeline.bulkInsert(id, rows);
      if (seeded) {
        const persistence = rows.length ? storage.get(id).then((record) => record?.persistence ??
          { provider: stored.provider, sessionId: id, nativeHandle: id }) : null;
        await storage.upsert({ ...stored, persistence: await persistence });
        await storage.flush();
      }
      // 다음 열기에서 터미널에 추가된 기록을 읽도록 메모리 사본 제거
      memoryTimeline.delete(id);
      await clearRuntimeHandoff(stateDir, id, owner.token, "exited");
      await unlink(recoveryFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
      transcriptHistory.delete(id);
    });
  }

  return {
    async open() { await open(); },
    async providers() { return [...(await open()).providerIds]; },
    async canDispose() {
      if (closing || lanes.size || listeners.size) return false;
      const pending = opening;
      if (!pending) return true;
      const release = await pending.catch(() => null);
      if (closing || lanes.size || listeners.size || (opening && pending !== opening)) return false;
      return !release?.manager.listAgents({ includeInternal: true }).length;
    },
    ensureAgent,
    snapshot,
    async models(id) {
      const release = await open();
      const agent = release.manager.getAgent(id);
      return agent ? release.models(agent.provider, agent.cwd) : [];
    },
    describeHandle,
    releaseForTerminal,
    prepareNativeFirst,
    abortTerminalRelease(id, token) { return clearRuntimeHandoff(stateDir, id, token, "reserved"); },
    returnFromTerminal,
    async getTimeline(id) { return (await snapshot(id))?.timeline ?? []; },
    sendMessage(id, text, options = {}) {
      return operate(id, async (release) => {
        await getReadyAgent(release, id);
        return release.send(id, text, options);
      }, true);
    },
    listCommands(id) {
      return operate(id, async release => {
        const { session } = await getReadyAgent(release, id);
        if (!session.listCommands) throw new Error("이 제공자는 명령 목록을 지원하지 않습니다");
        return session.listCommands();
      }, true);
    },
    setSetting(id, setting, value) {
      return operate(id, async release => {
        await assertChatOwns(id);
        const agent = await getReadyAgent(release, id);
        if (setting === "config") return release.applyConfig(id, value);
        if (setting === "mode" && value) return release.manager.setAgentMode(id, value);
        if (setting === "model" && agent.session.setModel) return release.manager.setAgentModel(id, value);
        if (setting === "thinking" && agent.session.setThinkingOption) return release.manager.setAgentThinkingOption(id, value);
        throw new Error("이 제공자에서 지원하지 않는 설정입니다");
      });
    },
    respondToPermission(id, requestId, response) {
      return operate(id, ({ manager }) => manager.respondToPermission(id, requestId, response), true);
    },
    cancel(id) {
      return operate(id, ({ manager }) => manager.cancelAgentRun(id), true);
    },
    subscribe(id, listener) {
      if (!validAgentId.test(id ?? "") || typeof listener !== "function") throw new Error("Paseo 구독 대상이 잘못되었습니다");
      const current = listeners.get(id) ?? new Set();
      current.add(listener);
      listeners.set(id, current);
      releaseRequested.delete(id);
      return () => { current.delete(listener); if (!current.size) listeners.delete(id); };
    },
    release(id) {
      if (!opening || closing || listeners.get(id)?.size) return Promise.resolve(false);
      releaseRequested.add(id);
      return evict(id);
    },
    close() {
      closing ??= (async () => {
        await Promise.allSettled(lanes.values());
        if (!opening) return;
        const release = await opening;
        release.detach();
        await release.close();
        listeners.clear();
        releaseRequested.clear();
        transcriptHistory.clear();
      })();
      return closing;
    },
  };
}

async function hasStoredAgent(directory, filename, entries) {
  for (const entry of entries) {
    if (entry.isFile() && entry.name === filename) return true;
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    if (await hasStoredAgent(child, filename, await readdir(child, { withFileTypes: true }))) return true;
  }
  return false;
}

async function nativeTimelineSuffix(previous, events, projectAgentMessages, provider) {
  const replayed = [];
  let sawUser = false;
  for await (const event of events) {
    if (event.type === "timeline") {
      for (let item of projectAgentMessages(event.item)) {
        const firstUser = item.type === "user_message" && !sawUser;
        if (firstUser) sawUser = true;
        // Gemini가 첫 사용자 메시지 앞에 자체 작업환경 정보를 기록
        if (firstUser && provider === "gemini") {
          const text = stripGeminiSessionContext(item.text);
          if (!text) continue;
          item = { ...item, text };
        }
        replayed.push({ item, timestamp: event.timestamp, turnId: event.turnId });
      }
    }
  }
  const previousPrompts = previous.filter(({ item }) => item.type === "user_message");
  let promptIndex = 0;
  for (let index = 0; index < replayed.length; index++) {
    const { item } = replayed[index];
    if (item.type !== "user_message") continue;
    if (promptIndex === previousPrompts.length) {
      const previousSeq = previous.at(-1)?.seq ?? 0;
      return replayed.slice(index).map((row, offset) => ({ ...row, timestamp: row.timestamp ?? new Date().toISOString(), seq: previousSeq + offset + 1 }));
    }
    if (item.text.trim() !== previousPrompts[promptIndex].item.text.trim()) break;
    promptIndex++;
  }
  if (promptIndex === previousPrompts.length && replayed.filter(({ item }) => item.type === "user_message").length === promptIndex) return [];
  throw new Error("터미널 기록에서 전환 전 대화를 확인하지 못했습니다. 기존 대화 기록을 보존했습니다");
}

function stripGeminiSessionContext(text) {
  const start = "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n";
  const end = "\n</session_context>";
  if (!text.startsWith(start)) return text;
  const index = text.indexOf(end, start.length);
  return index < 0 ? text : text.slice(index + end.length);
}

function nativeSessionId(stored) {
  const handle = stored?.persistence;
  if (!handle) return null;
  if (stored.provider === "antigravity") {
    const native = handle.metadata?.pluginProviderPersistence;
    return native?.version === 1 && validAgentId.test(native.data?.sessionId ?? "") ? native.data.sessionId : null;
  }
  return handle.sessionId.startsWith("plugin:") ? null : handle.sessionId;
}

function supportsNativeSeed(provider) {
  return provider === "claude" || provider === "gemini";
}

function handoffSessionId(stored, id, empty) {
  return nativeSessionId(stored) ?? (empty && !stored?.persistence && supportsNativeSeed(stored?.provider) ? id : null);
}
