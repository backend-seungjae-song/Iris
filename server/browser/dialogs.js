// 페이지가 띄우는 대화상자(alert·confirm·prompt·이탈 확인)를 사람과 AI 사이에서 다룬다.
//
// 소유 범위
//   답을 기다리는 질문 목록과 그 타이머, browser_dialogs 로 무장한 자동 응답 계획,
//   그리고 탭 메타에 확인 창이 떠 있음을 기록하는 필드.
//
// 제공 API
//   createDialogs(deps) 하나. 무장·조회·열기·닫기·응답을 반환한다.
//
// 의존 대상
//   조립부가 넘겨주는 metaOfWc(탭 레지스트리)와 broadcast(화면 알림)뿐이다.
//   broadcast 는 나중에 결정되므로 값이 아니라 호출 함수로 받는다.
//
// 유지 조건
//   기본은 사용자가 응답한다. 무장은 명시적으로 켤 때만 하고 끝나면 해제한다. 무장한 채로 두면
//   파괴적인 확인 창을 자동으로 승인하게 된다.
//   아무도 답하지 않아도 영원히 멈춰 있지 않는다(3분 뒤 취소).
//   질문을 지울 때 타이머도 함께 지운다. 그러지 않으면 이미 없는 질문을 3분 뒤에 다시 닫는다.
//
// 영향 범위
//   공급자는 server/browser-runtime.js 의 조립부이고, 소비자는 server/index.js 의 HTTP
//   dialog 경로와 web/js/main.js 의 browser-dialog 메시지다.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs server/browser/dialogs.js

// 시간은 주입받는다. 그러지 않으면 3분 뒤 취소를 검사할 수 없고, 검사할 수 없는 규칙은
// 문서에만 남는다. 타임아웃을 지워도 검사가 모두 통과한다.
export function createDialogs({ metaOfWc, broadcast, aiTab = () => false,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, timeoutMs = 180000,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
// 페이지가 띄우고 응답을 기다리는 질문 목록. 응답이 올 때까지 HTTP 응답을 보류해 페이지를 멈춘다.
const dialogAsks = new Map(); // id → { wc, kind, msg, done, timer }
// browser_dialogs 로 무장한 자동 응답. wc → { mode, queue, text }. 비어 있으면 사용자가 응답한다.
const dialogPlans = new Map();
let dialogSeq = 0;

function plannedAnswer(wc) {
  const plan = dialogPlans.get(wc);
  if (!plan) return null;
  if (plan.queue && plan.queue.length) return plan.queue.shift();
  return plan.mode || null;
}

function dialogPlanText(wc) {
  const plan = dialogPlans.get(wc);
  return plan && plan.text != null ? String(plan.text) : null;
}

function setDialogPlan(wc, plan, text) {
  if (!plan) dialogPlans.delete(wc);
  else dialogPlans.set(wc, { mode: plan.mode || null,
    queue: Array.isArray(plan.queue) ? plan.queue.slice() : [],
    text: text == null ? null : String(text) });
}

function setFrameOrigins(wc, origins) {
  const meta = metaOfWc(Number(wc));
  if (meta) meta.frameOrigins = Array.isArray(origins) ? origins.slice(0, 32) : [];
  return meta;
}

// 문구는 200자로 잘라 보이고, 자르기 전 원문은 JSON 에 안 나가는 full 에 저장
// 가리기 전에 자르면 잘린 자리에 걸친 비밀값을 가리는 쪽이 못 알아봄
function withFull(dialog, message) {
  Object.defineProperty(dialog, "full", { value: String(message || ""), enumerable: false });
  return dialog;
}

function setTabDialog(wc, open, kind, message) {
  const meta = metaOfWc(wc);
  if (meta) {
    if (open) meta.dialog = withFull({ kind: kind || "alert", message: String(message || "").slice(0, 200), ...(aiTab(wc) ? { ai: true } : {}) }, message);
    else delete meta.dialog;
  }
  return meta;
}

function openDialogAsk(wc, kind, msg, onDone, def = "") {
  const id = "dlg" + (++dialogSeq);
  const done = (answer, text) => {
    if (!dialogAsks.has(id)) return;
    const ask = dialogAsks.get(id);
    clearTimeoutFn(ask.timer);
    dialogAsks.delete(id);
    setTabDialog(wc, false);
    broadcast({ type: "browser-dialog", wc, open: false, id });
    onDone(answer, text);
  };
  // 아무도 응답하지 않아도 멈춰 있으면 안 되므로 3분 뒤 취소로 해제한다.
  const timer = setTimeoutFn(() => done("cancel", ""), timeoutMs);
  dialogAsks.set(id, { wc, kind, msg, done, timer });
  const meta = setTabDialog(wc, true, kind, msg);
  // AI가 조작 중인 탭의 질문은 사용자 알림 없이 그 탭에만 표시. AI 는 명령 결과(dialogBlocked)로 받음
  broadcast({ type: "browser-dialog", wc, open: true, id, kind, message: msg.slice(0, 200),
    def: String(def || ""), space: (meta && meta.space) || null, ai: !!(meta && meta.dialog && meta.dialog.ai) });
  return id;
}

// 확인 창이 떠 있어 페이지가 멈췄을 때 AI 에게 돌려줄 결과. 답할 도구 이름을 함께 적음
function dialogBlocked(dialog, answerTool) {
  const kind = (dialog && dialog.kind) || "alert", message = String((dialog && dialog.message) || "");
  return { ok: false, dialogOpen: withFull({ kind, message }, dialog && typeof dialog.full === "string" ? dialog.full : message),
    error: `페이지의 확인 창(${kind})이 떠 있어 이 탭이 멈췄습니다: "${message}". ${answerTool}로 answer "ok" 또는 "cancel"을 보내 닫은 뒤 이어 가세요.` };
}

// 명령 응답과 확인 창 중 먼저 오는 것으로 끝냄
// 조작이 확인 창을 띄우면 페이지가 동기 XHR 로 멈춰 명령이 시간 초과까지 응답하지 않음
function raceDialog(wc, pending, answerTool, { pollMs = 100 } = {}) {
  return new Promise((resolve) => {
    let finished = false, timer = null;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      if (timer != null) clearIntervalFn(timer);
      resolve(value);
    };
    const check = () => { const open = metaOfWc(wc)?.dialog; if (open) finish(dialogBlocked(open, answerTool)); };
    check();
    if (!finished) timer = setIntervalFn(check, pollMs);
    Promise.resolve(pending).then(finish, (error) => finish({ ok: false, error: String((error && error.message) || error) }));
  });
}

function closeDialogAsk(id) {
  const ask = dialogAsks.get(id);
  if (!ask) return false;
  clearTimeoutFn(ask.timer);
  dialogAsks.delete(id);
  setTabDialog(ask.wc, false);
  broadcast({ type: "browser-dialog", wc: ask.wc, open: false, id });
  return true;
}

function answerDialogAsk(wc, answer, text) {
  for (const [, ask] of dialogAsks) {
    if (ask.wc !== wc) continue;
    const result = withFull({ kind: ask.kind, message: ask.msg.slice(0, 200) }, ask.msg);
    ask.done(answer === "ok" ? "ok" : "cancel", text);
    return result;
  }
  return null;
}

  return { plannedAnswer, dialogPlanText, setDialogPlan, setFrameOrigins, setTabDialog,
    openDialogAsk, closeDialogAsk, answerDialogAsk, dialogBlocked, raceDialog };
}
