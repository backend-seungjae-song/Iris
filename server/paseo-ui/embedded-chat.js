import path from "node:path";
import { herdrSession } from "../herdr-session.cjs";
import { childEnv, portWithLegacy } from "../env.cjs";
import { stateHome } from "../state-home.cjs";
import { readEmbeddedHandoff, recoverStaleEmbeddedHandoff, returnEmbeddedHandoff, startEmbeddedHandoff } from "./embedded-handoff.mjs";
import { embeddedRelease } from "./index.js";
import { embeddedPane, reportEmbeddedState } from "./embedded-pane.js";

const runtimes = new Map();
const sessions = new Map();

async function getRuntime(build) {
  const release = embeddedRelease(build);
  if (!release) throw new Error("이 세션의 Paseo 제공자 파일을 찾지 못했습니다");
  if (!runtimes.has(release.dir)) {
    const pending = import("./embedded-worker.mjs").then(({ createSharedEmbeddedRuntime }) =>
      createSharedEmbeddedRuntime({ runtime: release.dir, stateDir: path.join(stateHome(), "paseo-ui", "sessions", build) }));
    runtimes.set(release.dir, pending);
    pending.catch(() => runtimes.delete(release.dir));
  }
  return runtimes.get(release.dir);
}

function paneEnvironment(paneId) {
  const target = herdrSession();
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: target.socket,
    ...childEnv({ stateDir: stateHome(), port: portWithLegacy() }), IRIS_HERDR_SESSION: target.name };
  return env;
}

function paneState(frame) {
  if (frame.permissions.length) return "blocked";
  return frame.status === "running" ? "working" : "idle";
}

export async function watchEmbeddedChat({ agent, herdr, onFrame, onError }) {
  const record = embeddedPane(agent.terminalId);
  if (!record || record.provider !== agent.embeddedProvider || record.agentId !== agent.sessionUuid) throw new Error("대화 세션이 변경되었습니다");
  if (record.startingNative && !await readEmbeddedHandoff(record)) throw new Error("터미널을 시작하는 중입니다");
  const id = record.agentId;
  let shared = sessions.get(id);
  const reused = !!shared;
  if (!shared) {
    shared = { views: new Set(), state: "idle", reports: Promise.resolve(), timer: null };
    sessions.set(id, shared);
    shared.ready = (async () => {
      const runtime = await getRuntime(record.build);
      const env = paneEnvironment(agent.paneId);
      shared.resume = async () => {
        await recoverStaleEmbeddedHandoff({ runtime, record, paneId: agent.paneId, herdr });
        const handoff = await readEmbeddedHandoff(record);
        if (handoff?.phase === "dispatched" || handoff?.phase === "running") {
          throw new Error("터미널을 시작하는 중입니다");
        }
        if (handoff?.phase === "exited") await returnEmbeddedHandoff({ runtime, record, paneId: agent.paneId, herdr });
        await runtime.ensureAgent({ ...record, workspaceId: agent.workspaceId, env });
      };
      await shared.resume();
      shared.runtime = runtime;
      async function publish() {
        const frame = await runtime.snapshot(id);
        if (!frame || sessions.get(id) !== shared) return;
        const state = paneState(frame);
        if (state !== shared.state) {
          shared.state = state;
          shared.reports = shared.reports.then(() => reportEmbeddedState(herdr, agent.paneId, record, state))
            .catch(error => console.warn("대화 상태를 herdr에 전달하지 못했습니다", error.message));
        }
        for (const view of shared.views) view.onFrame({ ...frame, models: shared.models });
        if (!shared.views.size && state === "idle") evict();
      }
      function evict() {
        if (shared.views.size || shared.state !== "idle" || shared.releasing) return;
        shared.unsubscribe();
        clearTimeout(shared.timer);
        shared.releasing = Promise.resolve(runtime.release(id)).catch(error => console.warn("대화 메모리를 해제하지 못했습니다", error.message))
          .finally(() => { if (sessions.get(id) === shared) sessions.delete(id); shared.releasing = null; });
      }
      shared.evict = evict;
      void runtime.models(id).then(models => {
        shared.models = models;
        if (sessions.get(id) === shared && shared.views.size) return publish();
      }).catch(error => console.warn("대화 모델 목록을 읽지 못했습니다", error.message));
      shared.unsubscribe = runtime.subscribe(id, () => {
        if (shared.publishing) { shared.dirty = true; return; }
        if (shared.timer) return;
        shared.timer = setTimeout(() => {
          shared.timer = null;
          shared.publishing = true;
          void (async () => {
            do { shared.dirty = false; await publish(); } while (shared.dirty && sessions.get(id) === shared);
          })().catch(error => { for (const view of shared.views) view.onError(error); })
            .finally(() => { shared.publishing = false; });
        }, 35);
        shared.timer.unref?.();
      });
    })();
    shared.ready.catch(() => sessions.delete(id));
  }
  if (shared.releasing) {
    await shared.releasing;
    if (sessions.get(id) !== shared) return watchEmbeddedChat({ agent, herdr, onFrame, onError });
  }
  const view = { onFrame, onError };
  shared.views.add(view);
  try {
    await shared.ready;
    if (reused && record.native && await readEmbeddedHandoff(record)) {
      shared.returning ??= shared.resume().finally(() => { shared.returning = null; });
      await shared.returning;
    }
    onFrame({ ...await shared.runtime.snapshot(id), models: shared.models });
  } catch (error) {
    shared.views.delete(view);
    throw error;
  }
  return {
    async action(msg) {
      const pane = await herdr.paneGet(agent.paneId);
      if (pane.terminal_id !== record.terminalId) throw new Error("터미널이 변경되었습니다");
      if (msg.type === "agentchat.commands") return shared.runtime.listCommands(id);
      if (msg.type === "agentchat.terminal") {
        if (!record.native) throw new Error("이 제공자의 터미널 실행 명령이 없습니다");
        await startEmbeddedHandoff({ runtime: shared.runtime, record, paneId: agent.paneId, herdr,
          commandsPath: path.join(embeddedRelease(record.build).dir, "native-handoff-commands.json"), nodePath: process.execPath });
        return;
      }
      if (msg.type === "agentchat.setting") {
        if (msg.setting === "config") return shared.runtime.setSetting(id, "config", msg.value);
        if (!["mode", "model", "thinking"].includes(msg.setting) || !(msg.value === null || typeof msg.value === "string")) {
          throw new Error("대화 설정값을 확인하세요");
        }
        return shared.runtime.setSetting(id, msg.setting, msg.value);
      }
      if (msg.type === "agentchat.send") {
        if (typeof msg.text !== "string" || !msg.text.trim()) throw new Error("메시지가 비어 있습니다");
        return shared.runtime.sendMessage(id, msg.text, { clientMessageId: msg.id });
      }
      if (msg.type === "agentchat.cancel") return shared.runtime.cancel(id);
      if (msg.type === "agentchat.permission") {
        if (typeof msg.requestId !== "string" || !msg.response || !["allow", "deny"].includes(msg.response.behavior)) throw new Error("질문 응답을 확인하세요");
        return shared.runtime.respondToPermission(id, msg.requestId, msg.response);
      }
    },
    close() {
      shared.views.delete(view);
      if (!shared.views.size) shared.evict();
    },
  };
}

export async function closeEmbeddedChat() {
  for (const shared of sessions.values()) {
    clearTimeout(shared.timer);
    shared.unsubscribe?.();
    shared.views.clear();
  }
  sessions.clear();
  const running = [...runtimes.values()];
  runtimes.clear();
  await Promise.all(running.map(async pending => (await pending).close()));
}
