import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { resolveCodexSession } from "../codex-session.js";
import { stateHome } from "../state-home.cjs";
import { codexTerminalTitleIdentity, codexTerminalTitleMatches, loadedCodexThreads, matchSharedCodexTitle, sharedCodexForPane } from "./codex-shared-daemon.mjs";
import { applyCodexQuestionItem, displayCodexQuestionAnswer, nativeQuestionAnswer, pendingCodexQuestions } from "./codex-shared-questions.mjs";
import { createCodexAppServerProcess } from "./codex-shared-transport.mjs";
import { applyProviderConfig } from "./provider-config.mjs";

const actionsByThread = new Map();
const nativeSettingsStateBySession = new WeakMap();
const observedEvents = new Set(["item/completed", "turn/started", "turn/completed", "thread/status/changed", "thread/tokenUsage/updated", "thread/settings/updated"]);

function nativeSettingsState(session) {
  let state = nativeSettingsStateBySession.get(session);
  if (!state) {
    state = { failure: null };
    nativeSettingsStateBySession.set(session, state);
  }
  return state;
}

function assertNativeSettingsUsable(state) {
  if (state.failure) throw new Error("Codex native 설정 동기화가 실패했습니다. 대화를 다시 열어 주세요", { cause: state.failure });
}

function serialize(threadId, action) {
  const previous = actionsByThread.get(threadId) ?? Promise.resolve();
  const work = previous.then(action);
  const wait = work.catch(() => {});
  actionsByThread.set(threadId, wait);
  void wait.then(() => {
    if (actionsByThread.get(threadId) === wait) actionsByThread.delete(threadId);
  });
  return work;
}

async function assertPane(agent, herdr) {
  const pane = await herdr.paneGet(agent.paneId);
  if (pane.terminal_id !== agent.terminalId || pane.agent !== "codex") throw new Error("Codex 터미널이 변경되었습니다");
  if (codexTerminalTitleIdentity(pane.terminal_title)) {
    if (!codexTerminalTitleMatches(pane.terminal_title, agent.sessionUuid)) throw new Error("터미널에서 다른 Codex 대화를 열었습니다");
    return pane;
  }
  const current = await resolveCodexSession(herdr, agent.paneId, pane);
  if (current?.uuid && current.uuid !== agent.sessionUuid) throw new Error("터미널에서 다른 Codex 대화를 열었습니다");
  return { ...pane, confirmed: (pane.agent_session?.kind === "id" || pane.agent_session?.kind === "path") && current?.uuid === agent.sessionUuid };
}

async function assertSingleNativeThread(request, threadId) {
  const loaded = await loadedCodexThreads(request);
  if (!loaded.includes(threadId)) throw new Error("Codex 터미널에서 이 대화를 열어 주세요");
  for (const id of loaded) {
    if (id === threadId) continue;
    const { thread } = await request("thread/read", { threadId: id });
    if (!thread.source?.subAgent) throw new Error("현재 터미널의 Codex 대화를 확인할 수 없습니다. 터미널에서 응답해 주세요");
  }
}

async function loadCodexProvider(dir) {
  const require = createRequire(join(dir, "package.json"));
  const root = dirname(require.resolve("@getpaseo/server"));
  const load = (name) => import(pathToFileURL(join(root, name + ".js")));
  const [{ CodexAppServerAgentClient, threadItemToTimeline, toAgentUsage }, { AgentConfigSession }, { createRootLogger }, { projectAgentMessages }, { AgentConfigApplySchema }] = await Promise.all([
    load("agent/providers/codex-app-server-agent"), load("session/agent-config/agent-config-session"), load("logger"), load("agent/agent-messages/index"),
    import(pathToFileURL(require.resolve("@getpaseo/protocol/messages", { paths: [root, dir] }))),
  ]);
  const logger = createRootLogger({ level: "warn" }, { paseoHome: stateHome(), file: false });
  return { AgentConfigApplySchema, AgentConfigSession, CodexAppServerAgentClient, logger, projectAgentMessages, threadItemToTimeline, toAgentUsage };
}

function nativeThreadSettings(params) {
  const { threadId: _threadId, input: _input, config: _config, developerInstructions: _developerInstructions, outputSchema: _outputSchema, ...settings } = params;
  return settings;
}

function nativeSettingsDelta(before, after) {
  const changed = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    changed[key] = Object.hasOwn(after, key) ? after[key] : null;
  }
  return changed;
}

async function generatedNativeSettings(session) {
  const turn = await session.buildTurnStartParams("", {});
  return nativeThreadSettings(turn.params);
}

function providerOptions(session) {
  if (typeof session.getEffectiveOptions === "function") return session.getEffectiveOptions();
  if (session.providerOptions && typeof session.providerOptions === "object") return { ...session.providerOptions };
  return {};
}

export async function applySharedCodexConfig({ AgentConfigApplySchema, AgentConfigSession, logger, session, request, threadId, config }) {
  const nativeState = nativeSettingsState(session);
  assertNativeSettingsUsable(nativeState);
  const before = await generatedNativeSettings(session);
  const notice = await applyProviderConfig({
    AgentConfigApplySchema,
    AgentConfigSession,
    logger,
    agentId: threadId,
    config,
    operations: {
      ensureLoaded: async () => {},
      setMode: (_id, modeId) => session.setMode(modeId),
      setModel: (_id, modelId) => session.setModel(modelId),
      setOptions: (_id, patch) => session.applyOptions(patch),
      setThinking: (_id, thinkingOptionId) => session.setThinkingOption(thinkingOptionId),
    },
  });
  const after = await generatedNativeSettings(session);
  const changed = nativeSettingsDelta(before, after);
  if (Object.keys(changed).length > 0) {
    try {
      await request("thread/settings/update", { threadId, ...changed });
    } catch (error) {
      nativeState.failure = error;
      throw new Error("Codex native 설정 동기화에 실패했습니다. 대화를 다시 열어 주세요", { cause: error });
    }
  }
  return notice;
}

export async function readSharedCodexThread(request, threadId, metadata) {
  const threadInfo = metadata ?? (await request("thread/read", { threadId })).thread;
  if (threadInfo?.id !== threadId) throw new Error("Codex 대화 ID가 변경되었습니다");
  if (threadInfo.historyMode === "paginated") {
    const turns = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await request("thread/turns/list", { threadId, cursor, limit: 16, sortDirection: "asc", itemsView: "full" });
      turns.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Codex 대화 기록의 페이지가 반복되었습니다");
      cursors.add(cursor);
    } while (cursor);
    return { ...threadInfo, turns };
  }
  const { thread } = await request("thread/read", { threadId, includeTurns: true });
  if (thread.id !== threadId || !Array.isArray(thread.turns)) throw new Error("Codex 대화 기록을 확인할 수 없습니다");
  return thread;
}

function activeTurn(thread) { return thread.turns.findLast(turn => turn.status === "inProgress"); }

function presentation(turn) {
  if (!turn) return null;
  return { turnId: turn.id, startedAt: new Date(Number.isFinite(turn.startedAt) ? turn.startedAt * 1000 : Date.now()).toISOString() };
}

function submit(request, threadId, thread, text) {
  const input = [{ type: "text", text }];
  const active = activeTurn(thread);
  if (active) return request("turn/steer", { threadId, input, expectedTurnId: active.id });
  if (thread.status?.type === "active") throw new Error("Codex가 현재 요청을 시작하고 있습니다");
  return request("turn/start", { threadId, input });
}

export async function watchSharedCodex({ agent, herdr, release, onFrame, onError, readUsage }) {
  if (!release?.dir) throw new Error("Paseo의 Codex 대화 화면을 먼저 준비하세요");
  const pane = await assertPane(agent, herdr);
  const binding = await sharedCodexForPane(agent.terminalId, agent.sessionUuid, pane.terminal_title);
  if (!binding) throw new Error("Codex 터미널이 공유 서버에 연결되어 있지 않습니다");

  const { threadId, socketPath } = binding;
  const { AgentConfigApplySchema, AgentConfigSession, CodexAppServerAgentClient, logger, projectAgentMessages, threadItemToTimeline, toAgentUsage } = await loadCodexProvider(release.dir);
  const initialEvents = [];
  let state;
  let session;
  let info;
  let availableModes;
  let models;
  let unsubscribe;
  let timer;
  let closed = false;
  let events = Promise.resolve();
  const timeline = [];
  const seen = new Set();
  const dismissed = new Set();
  const appServerProcess = createCodexAppServerProcess({ socketPath, onMessage(event) {
    if (event.params?.threadId !== threadId || !observedEvents.has(event.method)) return;
    if (!state) initialEvents.push(event);
    else queue(event);
  } });
  const request = appServerProcess.request;
  const client = new CodexAppServerAgentClient(logger, undefined, { appServerProcess });

  function render() {
    timer = null;
    if (closed) return;
    const original = session.getPendingPermissions().filter(permission => permission.name !== "request_user_input_async");
    const prompts = [...state.prompts.values()].map(prompt => prompt.permission).filter(permission => !dismissed.has(permission.id));
    const permissions = [...original, ...prompts];
    onFrame({ timeline, lastUsage: state.lastUsage, permissions, status: state.running ? "running" : "idle", activeTurn: state.activeTurn,
      provider: "codex", controls: session.controls, options: providerOptions(session), availableModes, models, modeId: info.modeId, model: info.model, thinkingOptionId: info.thinkingOptionId });
  }

  function schedule() {
    if (!closed && !timer) timer = setTimeout(render, 100);
  }

  function append(item) {
    const display = item.type === "user_message" ? { ...item, text: displayCodexQuestionAnswer(item.text) } : item;
    timeline.push(...projectAgentMessages(display));
  }

  function queue({ method, params }) {
    events = events.then(async () => {
      if (closed) return;
      if (method === "item/completed") {
        if (seen.has(params.item.id)) return;
        seen.add(params.item.id);
        applyCodexQuestionItem(state.prompts, params.item);
        const item = await threadItemToTimeline(params.item, { cwd: binding.cwd });
        if (item) append(item);
      } else if (method === "thread/tokenUsage/updated") {
        const usage = toAgentUsage(params.tokenUsage);
        if (params.tokenUsage?.last?.totalTokens === 0 && usage) usage.contextWindowUsedTokens = 0;
        if (usage?.contextWindowUsedTokens === undefined) return;
        state.lastUsage = usage;
      } else if (method === "turn/started") {
        state.running = true;
        state.activeTurn = presentation(params.turn);
      } else if (method === "turn/completed") {
        state.running = false;
        state.activeTurn = null;
      } else if (method === "thread/status/changed") {
        state.running = params.status?.type === "active";
        if (!state.running) state.activeTurn = null;
      } else if (method === "thread/settings/updated") {
        const settings = params.threadSettings ?? {};
        if (typeof settings.model === "string") info.model = settings.model;
        if (typeof settings.effort === "string") info.thinkingOptionId = settings.effort;
      } else {
        return;
      }
      schedule();
    }).catch(error => { if (!closed) onError(error); });
  }

  function close(force = false) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    unsubscribe?.();
    if (force) {
      appServerProcess.close();
      if (session) void session.close().catch(() => {});
    } else if (session) void session.close().catch(onError).finally(() => appServerProcess.close());
    else appServerProcess.close();
  }

  try {
    session = await client.resumeSession({ sessionId: threadId }, { cwd: binding.cwd });
    // Paseo는 서버에 이미 로드된 스레드에서 resume을 생략하므로 같은 연결에 이벤트를 구독
    const resumed = await request("thread/resume", { threadId, excludeTurns: true });
    const thread = await readSharedCodexThread(request, threadId, resumed.thread);
    info = await session.getRuntimeInfo();
    info.model = resumed.model ?? info.model;
    info.thinkingOptionId = resumed.reasoningEffort ?? info.thinkingOptionId;
    const catalogProcess = createCodexAppServerProcess({ socketPath });
    const catalogClient = new CodexAppServerAgentClient(logger, undefined, {
      appServerProcess: catalogProcess,
    });
    try {
      models = (await catalogClient.fetchCatalog({ cwd: binding.cwd })).models;
    } catch (error) {
      logger.warn({ err: error }, "Codex 모델 목록을 읽지 못했습니다");
      models = [];
    } finally { catalogProcess.close(); }
    availableModes = await session.getAvailableModes();
    if (thread.historyMode !== "paginated") {
      for await (const event of session.streamHistory()) {
        if (event.type === "timeline") append(event.item);
      }
    }
    const useThreadItems = !timeline.length;
    for (const turn of thread.turns) {
      for (const item of turn.items) {
        seen.add(item.id);
        if (!useThreadItems) continue;
        const entry = await threadItemToTimeline(item, { cwd: binding.cwd });
        if (entry) append(entry);
      }
    }
    const active = activeTurn(thread);
    state = { lastUsage: readUsage?.(thread.path), prompts: pendingCodexQuestions(thread.turns), running: thread.status?.type === "active" || !!active, activeTurn: presentation(active) };
    for (const event of initialEvents) queue(event);
    unsubscribe = session.subscribe(event => {
      if (["permission", "permission_resolved", "permission_requested"].includes(event.type)) schedule();
    });
    render();
  } catch (error) { close(true); throw error; }

  return {
    action(msg) {
      return serialize(threadId, async () => {
        if (closed) throw new Error("Codex 대화 연결이 닫혔습니다");
        assertNativeSettingsUsable(nativeSettingsState(session));
        const pane = await assertPane(agent, herdr);
        if (codexTerminalTitleIdentity(pane.terminal_title)) {
          if (await matchSharedCodexTitle(request, pane.terminal_title) !== threadId) throw new Error("현재 터미널의 Codex 대화를 확인할 수 없습니다");
        } else if (!pane.confirmed) {
          await assertSingleNativeThread(request, threadId);
        }
        if (msg.type === "agentchat.commands") return session.listCommands();
        if (msg.type === "agentchat.setting") {
          if (msg.setting !== "config") throw new Error("Codex 설정 번들을 확인하세요");
          const result = await applySharedCodexConfig({ AgentConfigApplySchema, AgentConfigSession, logger, session, request, threadId, config: msg.value });
          info = await session.getRuntimeInfo();
          availableModes = await session.getAvailableModes();
          schedule();
          return result;
        }
        if (msg.type === "agentchat.permission" && !String(msg.requestId).startsWith("codex-async:")) {
          if (typeof msg.requestId !== "string" || !["allow", "deny"].includes(msg.response?.behavior)) throw new Error("Codex 질문 응답을 확인하세요");
          return session.respondToPermission(msg.requestId, msg.response);
        }
        const thread = await readSharedCodexThread(request, threadId);
        if (msg.type === "agentchat.permission") {
          const pending = pendingCodexQuestions(thread.turns).get(msg.requestId);
          if (!pending) throw new Error("Codex에서 이미 처리한 질문입니다");
          if (msg.response?.behavior === "deny") {
            dismissed.add(msg.requestId);
            schedule();
            return;
          }
          return submit(request, threadId, thread, nativeQuestionAnswer(pending, msg.response));
        }
        if (msg.type === "agentchat.send") {
          if (typeof msg.text !== "string" || !msg.text.trim()) throw new Error("메시지가 비어 있습니다");
          const command = session.tryHandleOutOfBand?.(msg.text);
          if (command) return command.run({ emit(event) {
            if (event.type === "timeline") { append(event.item); schedule(); }
          } });
          return submit(request, threadId, thread, msg.text);
        }
        const active = activeTurn(thread);
        if (msg.type === "agentchat.cancel" && active) return request("turn/interrupt", { threadId, turnId: active.id });
      });
    },
    close,
  };
}
