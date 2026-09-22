// 나가기 전에 세션 저장소를 비운다.
//
// 소유 범위
//   비우기 실패를 한 번만 알리는 표식과, 종료가 이미 준비됐는지·비우는 중인지의 두 상태.
//
// 제공 API
//   createStorageLifecycle(deps) 가 flush() 와 handleBeforeQuit(event) 를 제공한다.
//   원시 상태는 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. 어떤 partition 을 비울지는 주입받은 forEachHardened,
//   실제 비우기는 주입받은 flushPartition, 준비 여부·종료·대기는 주입받은
//   isReady · quit · wait · log 다.
//
// 유지 조건
//   ready 전 종료는 그대로 진행한다. 등록된 세션이 없어 비울 것도 없고, single-instance handoff 나
//   Chromium 의 조기 재기동이 그 경로로 온다.
//   비우기가 도는 동안 들어온 두 번째 종료 요청은 새 비우기를 시작하지 않는다.
//   비우기가 늦어도 정해진 시간이 지나면 종료한다. 그러지 않으면 앱이 종료되지 않는다.
//   실패해도 종료는 진행한다. 같은 실패를 매번 찍지 않는다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron app·session 과 profile-session-policy 의 hardened 목록이다.
//   양방향 소비자는 앱 종료 경로 하나뿐이다. 여기가 어긋나면 마지막 로그인·쿠키가
//   디스크에 기록되지 않은 채 사라져, 다음 실행에서 로그인이 풀린 상태로 나타난다.
//   현재 목록 확인: node bin/importers.mjs native/electron/storage-lifecycle.cjs

function createStorageLifecycle({ forEachHardened, flushPartition, isReady, quit, wait, log }) {
  // Chromium의 persist 파티션이 세션 정본이다. 별도 쿠키 사본을 복원하면 서버가 갱신한 상태를
  // 되돌릴 수 있으므로, 알려진 모든 프로필의 원본 저장소만 flush한다.
  let storageFlushWarned = false;
  let storageQuitReady = false, storageQuitInFlight = false;

  async function flush() {
    try {
      await forEachHardened(async (partition) => { await flushPartition(partition); });
      storageFlushWarned = false;
      return true;
    } catch (error) {
      if (!storageFlushWarned) {
        storageFlushWarned = true;
        log("[session] 세션 저장 실패:", String((error && error.message) || error));
      }
      return false;
    }
  }

  function handleBeforeQuit(event) {
    // single-instance handoff나 Chromium의 조기 재기동은 ready 전에 quit할 수 있다.
    // 이때는 등록된 세션이 없으므로 flush하지 않는다.
    if (!isReady()) return;
    if (storageQuitReady) return;
    event.preventDefault();
    if (storageQuitInFlight) return;
    storageQuitInFlight = true;
    const timeout = wait(2500);
    Promise.race([flush(), timeout]).finally(() => {
      storageQuitReady = true;
      quit();
    });
  }

  return { flush, handleBeforeQuit };
}

module.exports = { createStorageLifecycle };
