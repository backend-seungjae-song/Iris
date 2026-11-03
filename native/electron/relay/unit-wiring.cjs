"use strict";

// cdp-control.cjs 와 command-units.cjs 사이 배선 · 메인 조립부에서 떼어 대역으로 시험
// 단위 표시가 있는 worker 기본 명령 → 단위 실행, 없으면 지금 설치 앱의 worker 와 호환되는 직접 실행
function createUnitWiring({ getUnits, getRelay, codedError, liveWc }) {
  const keyOf = (value) => Number(value) || 0;
  return {
    dispatchBase(request, unit) {
      if (unit) return getUnits().run(request, { unit, key: keyOf(request.target?.wcId) });
      return getRelay().execute(request);
    },
    // 단위 명시 종료는 기본 명령이 아니라 단위 닫기만 함
    endUnit(meta, wcId) {
      return getUnits().run({ workerGeneration: meta.workerGeneration, commandId: meta.commandId }, { unit: meta.unit, key: keyOf(wcId) });
    },
    // 세대 교체·재연결·회수 때 그 세대 단위가 탭 대기열을 물고 있지 않게 먼저 풀어 줌
    relayControl(baseCommands) {
      return {
        acceptGeneration: (generation, connection, options) => {
          getUnits().releaseAll(codedError("STALE_WORKER", "작업 프로세스 세대가 바뀌었습니다."));
          return getRelay().acceptGeneration(generation, connection, options);
        },
        retireGeneration: (generation, options) => {
          getUnits().releaseGeneration(generation, codedError("STALE_WORKER", "이미 종료된 작업 프로세스 세대입니다."));
          return getRelay().retireGeneration(generation, options);
        },
        isBaseCommand: (command) => baseCommands.has(command),
      };
    },
    // 탭이 닫히면 그 탭의 단위를 실패로 닫음
    watchTab(key, onGone) {
      const wc = liveWc(key);
      if (!wc) return null;
      wc.once("destroyed", onGone);
      return () => { try { wc.removeListener("destroyed", onGone); } catch {} };
    },
  };
}

module.exports = { createUnitWiring };
