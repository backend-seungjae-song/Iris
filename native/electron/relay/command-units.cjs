"use strict";

// worker 명령 하나(commandId)의 기본 명령들을 같은 탭 cdpQueues 안에서 한 단위로 실행
// 앞 단위·옛 명령 뒤에 서고 그 사이에 다른 명령이 끼지 않음
// 종료: 마지막 호출(phase last) · 명시 종료(phase end) · 시간 초과 · 세대 회수 · 탭 닫힘
function createCommandUnits({
  queues,
  execute,
  redact,
  attachMoments,
  resetSession,
  deadSession = null,
  liveTab = () => true,
  refreshTarget = null,
  watchTab = () => () => {},
  codedError,
  onClose = null,
  timeoutMs = 25000,
  tailGraceMs = 3000,
} = {}) {
  const units = new Map();
  // 실패로 닫힌 단위의 이후 호출은 새 단위를 열지 않고 같은 오류를 받음 (상한 초과분은 오래된 것부터 잊음)
  const failed = new Map();
  const FAILED_LIMIT = 256;

  const unitKey = (generation, commandId, key) => `${generation}\n${commandId}\n${key}`;

  function open(request, key, command) {
    const unit = {
      id: unitKey(request.workerGeneration, request.commandId, key),
      generation: request.workerGeneration,
      commandId: request.commandId,
      key,
      command,
      closed: false,
      failure: null,
      timer: null,
      stopWatch: null,
      inflight: new Set(),
    };
    unit.started = new Promise((resolve) => { unit.markStarted = resolve; });
    unit.finished = new Promise((resolve) => { unit.markFinished = resolve; });
    // 실패 알림을 기다리는 호출이 없어도 처리되지 않은 거부가 되지 않게 함
    unit.expired = new Promise((_, reject) => { unit.expire = reject; });
    unit.expired.catch(() => {});
    units.set(unit.id, unit);
    const prev = queues.get(key) || Promise.resolve();
    const body = () => {
      if (unit.closed) return undefined;
      unit.timer = setTimeout(() => fail(unit, timeoutError(key, command), { reset: true }), timeoutMs);
      unit.stopWatch = watchTab(key, () => fail(unit, codedError("TAB_GONE", "탭이 닫혔습니다."))) || null;
      unit.markStarted();
      return unit.finished;
    };
    const turn = prev.then(body, body);
    // 실행 중이던 호출이 정리될 때까지 기다리되 상한을 둠 (큐가 영구히 잠기는 것이 더 나쁨)
    const tail = turn.then(() => {}, () => {}).then(() => Promise.race([
      Promise.allSettled([...unit.inflight]),
      new Promise((resolve) => { setTimeout(resolve, tailGraceMs); }),
    ]));
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return unit;
  }

  function timeoutError(key, command) {
    return codedError("TIMEOUT",
      `이 탭이 ${Math.round(timeoutMs / 1000)}초 동안 ${command || "명령"}에 응답하지 않았습니다(wc=${key}). 페이지가 멈춰 있을 수 있습니다(모달·무한 루프·resolve 안 되는 promise). 다른 탭은 영향받지 않습니다.`);
  }

  function close(unit) {
    if (unit.closed) return;
    unit.closed = true;
    clearTimeout(unit.timer);
    try { unit.stopWatch?.(); } catch {}
    units.delete(unit.id);
    unit.markStarted();
    unit.markFinished();
    // 실행 중이던 호출이 끝난 뒤 그 명령이 얻은 자원을 반환 (옛 처리기의 finally 와 같은 시점)
    if (onClose) {
      Promise.race([
        Promise.allSettled([...unit.inflight]),
        new Promise((resolve) => { setTimeout(resolve, tailGraceMs); }),
      ]).then(() => onClose({ generation: unit.generation, commandId: unit.commandId, key: unit.key }))
        .catch(() => {});
    }
  }

  // 실패 종료: 대기·실행 중 호출이 같은 오류를 받고 큐를 놓음
  function fail(unit, error, { reset = false } = {}) {
    if (unit.closed) return;
    unit.failure = error;
    failed.set(unit.id, error);
    while (failed.size > FAILED_LIMIT) failed.delete(failed.keys().next().value);
    unit.expire(error);
    close(unit);
    // 시간 초과 시 실행 중인 명령을 실제로 취소하려고 그 탭의 CDP 세션을 끊음 (옛 경로와 같음)
    if (reset) { try { resetSession(unit.key); } catch {} }
  }

  // 끊긴 디버거 세션은 실패가 아니라 상태 · 옛 execWithReattachRaw 와 같은 조건으로 한 번 다시 붙여 재시도
  const REATTACH_COMMANDS = new Set(["cdp.send", "cdp.batch", "cdp.frames", "ax.tree"]);
  const isDead = (e) => !!deadSession && deadSession.test(String((e && e.message) || e));
  // 옛 execWithReattachRaw 는 qa- 로 시작하는 명령(QA 모드 해제 포함)을 다시 붙이지 않음 · 반응 관찰이 심은 스크립트·바인딩이 새 세션에 없어 조용히 틀어지므로 오류로 알림
  async function executeWithReattach(request, key, userCommand = "") {
    try { return await execute(request); }
    catch (e) {
      if (!REATTACH_COMMANDS.has(request.command) || e?.code === "cdp_blocked" || String(userCommand).startsWith("qa-") || !isDead(e)) throw e;
      if (!liveTab(key)) throw tagCode(e, "tab_gone");
      resetSession(key);
      // 다시 붙이면 debugger 세대가 바뀌므로 새 세대로 재시도 (자식 세션은 옛 세대 것이라 뺌)
      const { childSessionId, ...rest } = request.target || {};
      const target = refreshTarget ? { ...rest, ...refreshTarget(key) } : rest;
      return execute({ ...request, target }).catch((retryError) => {
        if (isDead(retryError)) throw tagCode(retryError, "session_detached");
        throw retryError;
      });
    }
  }
  function tagCode(error, code) {
    if (error && typeof error === "object") { error.code = error.code || code; return error; }
    return codedError(code, String(error));
  }

  // 대기열 밖 단위(meta.outside): 옛 QUEUE_BYPASS 처럼 대기열에 서지 않고 호출마다 바로 실행
  // 같은 시간 제한·비밀 가리기·끊긴 세션 재붙임을 거치고, 마지막 호출(last)과 명시 종료(end)에서 얻은 자원을 반환
  // 시간 초과는 CDP 세션을 끊지 않음 (옛 경로도 bypass 명령은 끊지 않음)
  async function runOutside(request, meta, key, phase) {
    const close = () => {
      if (!onClose) return;
      Promise.resolve().then(() => onClose({ generation: request.workerGeneration, commandId: request.commandId, key })).catch(() => {});
    };
    if (phase === "end") { close(); return { ended: true }; }
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError(key, meta.command)), timeoutMs); });
      let value = await Promise.race([executeWithReattach(request, key, meta.command), timeout]);
      value = await redact(key, value);
      if (phase === "last") value = attachMoments(key, meta.command, value);
      return value;
    } finally {
      clearTimeout(timer);
      if (phase === "last") close();
    }
  }

  async function run(request, { unit: meta = {}, key } = {}) {
    const phase = meta.phase === "last" || meta.phase === "end" ? meta.phase : "run";
    if (meta.outside === true) return runOutside(request, meta, key, phase);
    const id = unitKey(request.workerGeneration, request.commandId, key);
    let unit = units.get(id);
    if (phase === "end") {
      if (unit) close(unit);
      return { ended: !!unit };
    }
    if (!unit && failed.has(id)) throw failed.get(id);
    if (!unit) unit = open(request, key, meta.command);
    try {
      await Promise.race([unit.started, unit.expired]);
      if (unit.failure) throw unit.failure;
      const call = Promise.resolve().then(() => executeWithReattach(request, key, meta.command));
      unit.inflight.add(call);
      call.then(() => unit.inflight.delete(call), () => unit.inflight.delete(call));
      let value = await Promise.race([call, unit.expired]);
      value = await redact(key, value);
      if (phase === "last") value = attachMoments(key, meta.command, value);
      return value;
    } finally {
      if (phase === "last") close(unit);
    }
  }

  function releaseWhere(match, error) {
    for (const unit of [...units.values()]) if (match(unit)) fail(unit, error);
  }

  return {
    run,
    releaseGeneration(generation, error) { releaseWhere((unit) => unit.generation === generation, error); },
    releaseAll(error) { releaseWhere(() => true, error); },
    releaseTab(key, error) { releaseWhere((unit) => unit.key === Number(key), error); },
    size: () => units.size,
  };
}

module.exports = { createCommandUnits };
