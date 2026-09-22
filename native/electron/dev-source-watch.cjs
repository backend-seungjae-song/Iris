// 개발 환경에서 server/ 를 수정하면 서버 자식 프로세스만 재시작한다. 앱은 그대로 유지된다.
//
// 소유 범위
//   재시작 대상인 파일 변경의 판정, 연속된 저장을 하나로 묶는 지연,
//   그리고 감시가 끊겼는지 판단하는 데 필요한 시각 기록.
//
// 제공 API
//   createDevSourceWatch(deps) 가 start · stop · status · noteReloaded · shouldReact 를 제공한다.
//   감시자 객체 자체는 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. fs·path·시계·타이머·로그·재시작 함수를 주입받는다.
//   재시작을 직접 하지 않고 요청만 한다. 실제 수명주기는 server-host 가 소유한다.
//
// 유지 조건
//   설치본에서는 실행되지 않는다. 호출하는 server-host 가 app.isPackaged 로 막고,
//   여기서는 그 판정을 반복하지 않는다. 두 곳에서 판정하면 한쪽만 수정되기 쉽다.
//   자기 산출물에 반응하지 않는다. server.log · server.lock · .tmp · node_modules 를 감시하면
//   재시작이 재시작을 부르는 순환이 생긴다.
//   연속된 저장은 하나로 묶는다. 묶지 않으면 재시도 예산이 소진되어 재시작이 중단된다.
//   재시작 요청만 하고 끝내지 않는다. 반영 시각을 기록하고, 그 시각이 오래되면 알린다.
//   호출되는 자리가 없는 감시자는 아무 일도 하지 않으므로 등록 여부를 함께 확인한다.
//   감시가 끊기면 수정이 반영되지 않은 상태가 그대로 남는다.
//
// 영향 범위
//   공급자는 server-host.cjs 이고, 그쪽의 reload() 와 log() 를 주입받는다.
//   양방향 소비자도 server-host.cjs 하나다. 그쪽 재시도 예산(RESTART_BACKOFF_MS)과
//   상태 폴더 잠금 이전이 이 모듈의 전제이므로 함께 확인한다.
//   현재 목록 확인: node bin/importers.mjs native/electron/dev-source-watch.cjs

// 서버가 실제로 읽는 파일만 감시한다. 그 밖의 파일은 수정해도 재시작할 이유가 없다.
const SOURCE_EXT = /\.(?:js|mjs|cjs|json)$/;
// 외부 파일과 자기 산출물을 제외한다. 확장자 허용목록이 .log·.tmp·server.lock 을 이미 걸러
// 내므로 그 세 항목은 중복 방어이고, 그것만 지우는 변경은 검사가 잡지 못한다. 그래도 남기는
// 이유는 허용목록이 넓어질 때 이 줄이 먼저 막기 때문이다. node_modules·.git·숨김 파일은 현재
// 이 줄만 제외하므로, 그 항목을 지우면 검사가 실패한다.
const IGNORED = /(?:^|\/)(?:node_modules|\.git)\/|(?:^|\/)\.|\.tmp$|\.log$|(?:^|\/)server\.lock/;

function createDevSourceWatch({
  fs, path, root, log, reload,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  debounceMs = 200,
  // 변경을 감지한 뒤 이 시간이 지나도 반영이 없으면 감시가 끊긴 것으로 보고 알린다.
  graceMs = 10000,
  healthMs = 5000,
}) {
  const dir = path.join(root, "server");
  let watcher = null, timer = null, health = null;
  let lastChangeAt = 0, lastReloadAt = 0, complained = false, broken = null;
  // 시각 대신 일련번호로 비교한다. 같은 밀리초에 들어온 저장은 시각만으로는 이미 반영된 것과
  // 구별되지 않아 그 변경이 누락된다.
  let changeSeq = 0, reflectedSeq = 0;

  function shouldReact(rel) {
    const name = String(rel || "").split(path.sep).join("/");
    if (!name) return false;
    if (IGNORED.test(name)) return false;
    return SOURCE_EXT.test(name);
  }

  function noteReloaded() {
    lastReloadAt = now();
    reflectedSeq = changeSeq;
    complained = false;
  }

  function status() {
    return { watching: !!watcher, broken, lastChangeAt, lastReloadAt, changeSeq, reflectedSeq };
  }

  function fire(rel) {
    lastChangeAt = now();
    changeSeq++;
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      reload(rel);
    }, debounceMs);
    if (timer && timer.unref) timer.unref();
  }

  function onChange(_event, filename) {
    if (!filename) return;                       // 무엇이 바뀌었는지 모르면 반응하지 않는다
    if (!shouldReact(filename)) return;
    fire(String(filename));
  }

  // (3) 감시가 끊겼는지 확인한다. 변경을 감지했는데 반영되지 않았거나 감시자가 종료됐으면 알린다.
  function tick() {
    if (broken) return;                          // 이미 알렸으므로 반복하지 않는다
    if (!changeSeq) return;
    if (reflectedSeq >= changeSeq) return;
    if (now() - lastChangeAt < graceMs) return;
    if (complained) return;
    complained = true;
    log("server/ 변경을 봤는데 반영되지 않았습니다 — 감시가 끊겼을 수 있습니다. 앱을 다시 켜 보세요.");
  }

  function start() {
    if (watcher) return true;
    try {
      watcher = fs.watch(dir, { recursive: true }, onChange);
    } catch (e) {
      broken = String((e && e.message) || e);
      log(`server/ 감시를 걸지 못했습니다: ${broken} — 서버 변경은 앱을 다시 켜야 반영됩니다.`);
      return false;
    }
    watcher.on("error", (e) => {
      broken = String((e && e.message) || e);
      log(`server/ 감시가 끊겼습니다: ${broken} — 서버 변경은 앱을 다시 켜야 반영됩니다.`);
      stop();
    });
    if (watcher.unref) watcher.unref();
    health = setIntervalFn(tick, healthMs);
    if (health && health.unref) health.unref();
    log(`server/ 를 지켜봅니다 — 고치면 서버 자식만 다시 뜹니다(개발 갈래 전용).`);
    return true;
  }

  function stop() {
    if (timer) { clearTimeoutFn(timer); timer = null; }
    if (health) { clearIntervalFn(health); health = null; }
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  }

  return { start, stop, status, noteReloaded, shouldReact, tick };
}

module.exports = { createDevSourceWatch };
