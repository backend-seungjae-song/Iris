import { INPUT_COMMAND_NAMES, INPUT_HANDLERS } from "./input-route.js";
import { NATIVE_COMMAND_NAMES, NATIVE_HANDLERS, OUTSIDE_COMMANDS } from "./native-route.js";
import { loginHint, humanHint } from "./page-hints.js";
import { PAGE_COMMAND_NAMES, PAGE_HANDLERS } from "./page-route.js";
import { QA_OBSERVE_COMMAND_NAMES, QA_OBSERVE_HANDLERS } from "./qa-observe-route.js";
import { QA_COMMAND_NAMES, QA_HANDLERS } from "./qa-route.js";
import { AX_TREE_FEATURE, COMMAND_UNIT_FEATURE, INPUT_COMMANDS_FEATURE, NATIVE_COMMANDS_FEATURE, PAGE_COMMANDS_FEATURE, QA_INPUT_COMMANDS_FEATURE,
  QA_OBSERVE_COMMANDS_FEATURE } from "./relay-contract.js";
import { buildSnapshot } from "./snapshot-engine.js";

// 명령별 처리 경로 표: legacy = Electron 옛 처리기 봉투, worker = worker 처리기 + Electron 기본 명령
// 값만 바꿔 worker 를 교체하면 되돌림 완료 (앱 재시작 불필요)
export const COMMAND_ROUTES = Object.freeze({
  url: "worker",
  snapshot: "worker",
  ...Object.fromEntries(INPUT_COMMAND_NAMES.map((command) => [command, "worker"])),
  ...Object.fromEntries(PAGE_COMMAND_NAMES.map((command) => [command, "worker"])),
  ...Object.fromEntries(NATIVE_COMMAND_NAMES.map((command) => [command, "worker"])),
  ...Object.fromEntries(QA_COMMAND_NAMES.map((command) => [command, "worker"])),
  ...Object.fromEntries(QA_OBSERVE_COMMAND_NAMES.map((command) => [command, "worker"])),
  // 일반 MCP 명령이 아니라 host 작업 위임(host-task-service.js)이 쓰는 확인 창 문구 가리기
  redact: "worker",
});

// worker 경로를 쓰려면 메인이 알려야 하는 기능 · 하나라도 없으면 옛 봉투(legacy)
export function requiredFeatures(command) {
  if (INPUT_COMMAND_NAMES.includes(command)) return [COMMAND_UNIT_FEATURE, INPUT_COMMANDS_FEATURE];
  if (PAGE_COMMAND_NAMES.includes(command)) return [COMMAND_UNIT_FEATURE, PAGE_COMMANDS_FEATURE];
  if (NATIVE_COMMAND_NAMES.includes(command)) return [COMMAND_UNIT_FEATURE, NATIVE_COMMANDS_FEATURE];
  if (QA_COMMAND_NAMES.includes(command)) return [COMMAND_UNIT_FEATURE, QA_INPUT_COMMANDS_FEATURE];
  if (QA_OBSERVE_COMMAND_NAMES.includes(command)) return [COMMAND_UNIT_FEATURE, QA_INPUT_COMMANDS_FEATURE, QA_OBSERVE_COMMANDS_FEATURE];
  return [COMMAND_UNIT_FEATURE];
}

// 탭 대기열 밖에서 실행할 명령 · 옛 QUEUE_BYPASS (확인 창에 막힌 명령 뒤에 서면 그것을 푸는 명령까지 갇힘)
export function runsOutsideQueue(command) {
  return OUTSIDE_COMMANDS.has(command);
}

// base(command, args, { last }) = Electron 기본 명령 호출. { raw, response } 반환
// 한 처리기의 마지막 base 호출에는 last: true (메인이 그 호출로 대기열 단위를 닫고 관찰 순간을 비움)
// raw.commandState 가 completed 가 아니면 확인 창 차단·실행 중 응답이라 그대로 통과
export const WORKER_HANDLERS = Object.freeze({
  // 옛 cdp-cmd-page.cjs url: { url, title } 만 노출
  async url({ base }) {
    const { raw, response } = await base("wc.info", {}, { last: true });
    if (raw?.commandState !== "completed" || !response.ok) return response;
    return { ok: true, data: { url: response.data?.url, title: response.data?.title } };
  },
  snapshot: snapshotHandler,
  ...INPUT_HANDLERS,
  ...PAGE_HANDLERS,
  ...NATIVE_HANDLERS,
  ...QA_HANDLERS,
  ...QA_OBSERVE_HANDLERS,
});

// 기본 명령 하나가 막히거나(확인 창) 실패해 처리기를 멈춰야 할 때 던짐 · 응답을 그대로 돌려줌
class StepStopped extends Error {
  constructor(response) { super("처리기 중단"); this.response = response; }
}

// 옛 cdp-cmd-inspect.cjs snapshot + cdpExecRaw 앞 단계(붙임·viewport 준비)
// ref 기록은 메인 registry(ref.record)에 남김 · click·fill 이 계속 메인에서 읽음
async function snapshotHandler({ args, base, mainHasFeatures }) {
  let stopped = null;
  const step = async (command, baseArgs, options) => {
    const { raw, response } = await base(command, baseArgs, options);
    if (raw?.commandState !== "completed" || !response.ok) {
      stopped = stopped || response;
      throw new StepStopped(response);
    }
    return response.data;
  };
  // 접근성 트리는 메인이 엔진이 읽는 필드만 남겨 돌려줌(ax.tree) · 그 기능을 알리지 않는 옛 메인이면 cdp.send 로 전체를 받음
  const axTree = typeof mainHasFeatures === "function" && await mainHasFeatures([AX_TREE_FEATURE]);
  // 엔진 안의 CDP 실패는 옛 send 거부와 같이 일반 오류 · 확인 창 차단만 처리기를 멈춤
  const sender = (sessionId, options) => async (method, params) => {
    const viaAx = axTree && method === "Accessibility.getFullAXTree" && !(params && Object.keys(params).length);
    const { raw, response } = await base(viaAx ? "ax.tree" : "cdp.send",
      viaAx ? (sessionId ? { sessionId } : {}) : { method, params: params || {}, ...(sessionId ? { sessionId } : {}) }, options);
    if (raw?.commandState !== "completed") { stopped = stopped || response; throw new StepStopped(response); }
    if (!response.ok) throw new Error(response.error);
    return response.data;
  };
  try {
    await step("cdp.attach", { command: "snapshot" });
    await step("viewport.ensureReady", { command: "snapshot" });
    const { frames } = await step("cdp.frames", {});
    const frameSenders = (frames || []).filter(Boolean).map((sid) => ({ sid, send: sender(sid) }));
    const send = sender(null);
    // cursor 요소 해석의 describeNode 를 한 번에 보냄 · 최상위 sender 만 가짐 · 실패하면 엔진이 하나씩 대체
    send.batch = async (commands) => {
      const { raw, response } = await base("cdp.batch", { commands });
      if (raw?.commandState !== "completed") { stopped = stopped || response; throw new StepStopped(response); }
      if (!response.ok) throw new Error(response.error);
      return response.data;
    };
    const s = await buildSnapshot(send, {
      budget: args.budget, cursor: args.cursor,
      role: args.role, name: args.name, region: args.region,
      frames: frameSenders,
    });
    if (stopped) return stopped;
    await step("ref.record", { refs: [...s.refMap] });
    const info = await step("wc.info", {});
    const out = { url: info.url, title: info.title, refCount: s.refs.length, snapshot: s.snapshot,
      lines: s.total, shown: s.shownCount, bytes: s.bytes,
      frames: frameSenders.length ? frameSenders.length + 1 : undefined,
      truncated: s.truncated || undefined, cursor: s.cursor ?? undefined, query: s.query || undefined };
    const login = await loginHint(send);
    if (stopped) return stopped;
    if (login) out.loginHint = login;
    // 마지막 기본 명령 · 메인이 이 호출로 단위를 닫고 관찰 순간을 붙임
    const human = await humanHint(sender(null, { last: true }));
    if (stopped) return stopped;
    if (human) out.humanHint = human;
    return { ok: true, data: out };
  } catch (error) {
    if (error instanceof StepStopped) return error.response;
    throw error;
  }
}

export function workerHandlerFor(command, routes = COMMAND_ROUTES, handlers = WORKER_HANDLERS) {
  return routes[command] === "worker" && Object.hasOwn(handlers, command) ? handlers[command] : null;
}
