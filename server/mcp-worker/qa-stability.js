// worker 사본 · 원본 cdp-qa-stability.cjs 와 같은 본문 (test/mcp-worker-qa-observe-route.mjs 가 대조)
// 원본은 ⑧에서 지움
// 다른 점 하나: 대기 요청 수가 메인의 obs.pending 이라 비동기 · await 를 붙임
const CAP_MS = 3000;
const QUIET_MS = 120;

// 격리 영역의 DOM 변경 시각과 다음 화면 프레임
async function inspectStabilityFrame(budgetMs) {
  const key = "__irisQaStability";
  let state = globalThis[key];
  if (!state || state.document !== document) {
    state = { document, changedAt: performance.now() };
    state.observer = new MutationObserver(() => { state.changedAt = performance.now(); });
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    globalThis[key] = state;
  }
  await new Promise(resolve => {
    let raf;
    const timer = setTimeout(() => { cancelAnimationFrame(raf); resolve(); }, budgetMs);
    raf = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
  return { animations: document.getAnimations().filter(a => a.playState === "running" || a.pending).length,
    quietForMs: document.readyState === "complete" ? Math.max(0, performance.now() - state.changedAt) : 0 };
}

async function bounded(task, budgetMs) {
  let timer;
  try {
    return await Promise.race([task(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("QA 안정 확인 시간 상한")), Math.max(0, budgetMs));
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForWebStability(send, wc, { observation, timeoutMs = CAP_MS, quietMs = QUIET_MS, now = Date.now } = {}) {
  const started = now(), deadline = started + Math.max(0, Math.min(CAP_MS, Number(timeoutMs) || CAP_MS));
  let remaining = ["animations", "network", "dom"], animations = null, pending = null, quietForMs = 0;
  const result = () => ({ waitedMs: Math.max(0, now() - started), stable: remaining.length === 0,
    remaining, animations, networkPending: pending, domQuietMs: quietForMs });
  try {
    const frames = new Map();
    const sessions = typeof send.frames === "function" ? send.frames() : [null];
    if (!Array.isArray(sessions) || !sessions.includes(null)) throw new Error("QA 안정 확인 프레임 목록 불완전");
    for (const sid of new Set(sessions)) {
      const frameSend = sid == null ? send : send.on(sid);
      const tree = await bounded(() => frameSend("Page.getFrameTree"), deadline - now());
      const visit = (node, root = true) => {
        const id = node?.frame?.id;
        if (!id) throw new Error("QA 안정 확인 프레임 없음");
        if (root || !frames.has(id)) frames.set(id, { frameSend });
        for (const child of node.childFrames || []) visit(child, false);
      };
      visit(tree.frameTree);
    }
    for (const [frameId, frame] of frames) {
      const world = await bounded(() => frame.frameSend("Page.createIsolatedWorld", { frameId, worldName: "iris-qa-stability" }), deadline - now());
      if (!world?.executionContextId) throw new Error("QA 안정 확인 격리 영역 없음");
      frame.contextId = world.executionContextId;
    }
    do {
      const states = await bounded(() => Promise.all([...frames.values()].map(frame => frame.frameSend("Runtime.evaluate", {
        expression: `(${inspectStabilityFrame.toString()})(${Math.max(0, deadline - now())})`,
        contextId: frame.contextId, returnByValue: true, awaitPromise: true,
      }).then(response => {
        const state = response?.result?.value;
        if (response?.exceptionDetails || !Number.isFinite(state?.animations) || !Number.isFinite(state?.quietForMs)) throw new Error("QA 안정 조건 조회 실패");
        return state;
      }))), deadline - now());
      animations = states.reduce((sum, state) => sum + state.animations, 0);
      quietForMs = Math.min(...states.map(state => state.quietForMs));
      pending = observation?.pendingRequests ? await observation.pendingRequests(wc.id) : null;
      remaining = [...(animations > 0 ? ["animations"] : []), ...(pending !== 0 ? ["network"] : []), ...(quietForMs < quietMs ? ["dom"] : [])];
      if (!remaining.length) return result();
    } while (now() < deadline);
  } catch (error) {
    if (now() < deadline) remaining = [...new Set([...remaining, "observation"])];
    return { ...result(), error: String(error?.message || error) };
  }
  return result();
}

export { waitForWebStability, inspectStabilityFrame };
