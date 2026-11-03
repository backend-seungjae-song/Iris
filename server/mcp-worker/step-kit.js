// worker 처리기 공통 · 기본 명령 호출 래퍼와 엔진용 send (입력·페이지·읽기·캡처·네이티브 처리기가 같이 씀)
// 옛 cdp-control.cjs 의 send(ensureAttached 가 돌려주던 함수)와 같은 모양: send · send.on · send.frames · send.ask · send.all

const FRAME_ASK_MS = 6000;

// 확인 창 등이 기본 명령을 막음 · 응답을 그대로 돌려주고 정리 호출은 하지 않음 (메인이 명령 단위 종료 때 반환)
export class StepStopped extends Error {
  constructor(response) { super("처리기 중단"); this.response = response; }
}
// 기본 명령이 오류 응답을 돌려줌 · 응답을 돌려주되, 메인 중계가 code 없는 일반 오류에 붙이는 INTERNAL 은 옛 처리기 응답에 없던 값이라 뗌
export class StepFailed extends Error {
  constructor(response) {
    super(String(response?.error || "기본 명령 실패"));
    if (response && response.code === "INTERNAL") { const { code: _code, ...rest } = response; this.response = rest; }
    else this.response = response;
  }
}

export function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function failure(error) {
  return { ok: false, error: String((error && error.message) || error), ...(error && error.code ? { code: error.code } : {}) };
}

export function createStepKit(base) {
  let blocked = null;
  let frameIds = [null];

  const rawCall = async (command, baseArgs, options) => {
    const { raw, response } = await base(command, baseArgs, options);
    if (raw?.commandState !== "completed") { blocked = blocked || response; throw new StepStopped(response); }
    return response;
  };
  const step = async (command, baseArgs, options) => {
    const response = await rawCall(command, baseArgs, options);
    if (!response.ok) throw new StepFailed(response);
    return response.data;
  };
  // 엔진 안의 CDP 실패는 옛 send 거부와 같이 code 없는 일반 오류
  const sender = (sessionId, extra = {}) => async (method, params) => {
    const response = await rawCall("cdp.send", { method, params: params || {}, ...(sessionId ? { sessionId } : {}), ...extra });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  };
  const send = sender(null);
  send.on = (sid) => (sid ? sender(sid) : send);
  send.frames = () => frameIds;
  // 옛 send.ask: 실패·6초 초과는 null · 확인 창 차단만 처리기를 멈춤
  send.ask = (sid, method, params) => new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, FRAME_ASK_MS);
    send.on(sid)(method, params).then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
      (error) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error instanceof StepStopped) reject(error); else resolve(null);
      },
    );
  });
  send.all = async (method, params) => {
    const results = await Promise.all(send.frames().map((sid) => send.ask(sid, method, params)));
    return results.filter((result) => result != null);
  };

  const refreshFrames = async () => {
    const data = await step("cdp.frames", {});
    frameIds = [null, ...(data?.frames || []).filter(Boolean)];
  };

  // 최종 응답은 비밀 원문을 가진 메인의 redactSecrets 를 한 번 거쳐 나감 (옛 경로의 guard 와 같음) · 가리지 못하면 응답을 내지 않음
  const redacted = async (value, last) => {
    const response = await rawCall("result.redact", { value }, { last });
    if (!response.ok || !response.data || !("value" in response.data)) return { ok: false, error: "결과를 안전하게 가리지 못했습니다." };
    return response.data.value;
  };

  // 조회 실패는 "모름"(null) · 보이는 탭 판정과 창 그림 판정의 입력
  const focusState = async () => {
    const response = await rawCall("focus.state", {});
    return response.ok ? response.data : null;
  };
  // 창을 합성 대상으로 붙잡거나 놓음 · 붙잡았는지를 돌려줌
  const hold = async (on) => {
    const response = await rawCall("hold.capture", { on });
    if (!response.ok) throw new Error(response.error);
    return response.data?.held === true;
  };

  // 옛 cdp-control.cjs nodeFromArgs: ref 는 메인 registry(ref.resolve), 선택자는 프레임을 차례로 조회
  async function nodeFromArgs(_send, _wc, nodeArgs) {
    const sel = nodeArgs && nodeArgs.sel ? String(nodeArgs.sel) : null;
    if (!sel) {
      const response = await rawCall("ref.resolve", { ref: nodeArgs && nodeArgs.ref });
      if (!response.ok) throw response.code ? codedError(response.code, response.error) : new Error(response.error);
      return { backendNodeId: response.data.backendDOMNodeId, sid: response.data.sid || null };
    }
    await refreshFrames();
    for (const sid of send.frames()) {
      await send.ask(sid, "DOM.enable");
      const doc = await send.ask(sid, "DOM.getDocument", { depth: 1 });
      if (!doc || !doc.root) continue;
      const q = await send.ask(sid, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
      if (!q || !q.nodeId) continue;
      const d = await send.ask(sid, "DOM.describeNode", { nodeId: q.nodeId });
      if (d && d.node && d.node.backendNodeId) return { backendNodeId: d.node.backendNodeId, sid };
    }
    throw codedError("not_found", "선택자에 맞는 요소가 없습니다: " + sel);
  }

  return { rawCall, step, sender, send, refreshFrames, redacted, nodeFromArgs, focusState, hold, blocked: () => blocked };
}
