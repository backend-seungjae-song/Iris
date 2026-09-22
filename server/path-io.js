// 같은 경로의 파일 I/O를 도착 순서대로 실행하는 공용 직렬화 큐.
//
// 소유 범위
//   경로별 Promise tail Map과 실패 격리·settled tail 정리 순서.
//
// 제공 API
//   같은 큐 키의 작업을 FIFO로 실행하는 enqueuePathIo.
//
// 의존 대상
//   기능 모듈이나 외부 상태에는 기대지 않는다. 호출자가 같은 실제 파일에 같은 큐 키를 넘긴다.
//
// 유지 조건
//   실패한 작업도 다음 작업을 막지 않는다. 완료된 작업은 자신이 최신 tail일 때만 Map에서 빠지고,
//   호출자는 작업 본래의 성공값이나 실패를 그대로 받는다.
//
// 영향 범위
//   server/index.js의 fs·sheet·docx read/write와 rename·move·create I/O 호출부,
//   bin/smoke.mjs의 공용 path queue FIFO·정리·stale tail 검사.

const pathWriteQueue = new Map(); // path → Promise(tail)

export function enqueuePathIo(p, fn) {
  const prev = pathWriteQueue.get(p) || Promise.resolve();
  const cur = prev.then(fn, fn);
  const task = cur.catch(() => undefined);
  const next = () => { if (pathWriteQueue.get(p) === settled) pathWriteQueue.delete(p); };
  const settled = task.finally(next);
  pathWriteQueue.set(p, settled);
  return cur;
}
