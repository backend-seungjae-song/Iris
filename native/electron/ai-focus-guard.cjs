// AI 명령이 뒤에 깐 탭을 조작하는 동안 창 안 포커스 보호를 켜고 끄는 모듈
//
// 소유 범위
//   AI 명령 시작·종료(causality enter·leave)에 맞춰 뒤에 깐 탭의 포커스 보호 arm·release
//
// 제공 API
//   createAiFocusGuard({ causality, isBehind, liveWc, arm, release }) → { enter, armed, leave, released, driving, anyDriving, hold }
//   enter 는 causality 표를 돌려주며, 보호를 건너뛴 호출은 leave 용 핸들을 돌려준다. armed(표) 는 보호가 켜지면 풀리는 Promise
//   leave 는 기다리지 않고 바로 돌아오며, 복원 결과는 released(wcId) 로만 확인
//
// 유지 조건
//   같은 탭에서 겹친 명령은 마지막 명령이 끝날 때 한 번만 release
//   같은 탭의 다음 명령 arm 은 앞 명령의 release 가 끝난 뒤(호스트에서 순서가 뒤집히면 저장값이 틀어짐)
//   앞 탭 명령은 arm·release 하지 않음. arm·release 실패는 명령 결과를 바꾸지 않음

function createAiFocusGuard({ causality, isBehind, liveWc, arm, release }) {
  const open = new Map();   // wcId → { depth, armed: Promise<boolean> }
  const tail = new Map();   // wcId → 마지막 release Promise
  const skipped = Symbol("ai-focus-guard-skipped");
  const ticketId = (value) => value && value[skipped] ? value.ticket : value;

  function enter(wcId) {
    const ticket = causality.enter(wcId);
    if (ticket == null) return ticket;
    if (!isBehind(ticket)) return { ticket, [skipped]: true };
    const entry = open.get(ticket);
    if (entry) { entry.depth += 1; return ticket; }
    const prior = tail.get(ticket) || Promise.resolve();
    open.set(ticket, { depth: 1, armed: prior.then(() => {
      // 앞 명령의 해제 뒤에 다시 탭과 뒤 배치 상태를 확인한다
      if (!isBehind(ticket)) return false;
      const wc = liveWc(ticket);
      return wc ? arm(wc) : false;
    }).then((ok) => ok === true, () => false) });
    return ticket;
  }

  function armed(ticket) {
    const entry = open.get(ticketId(ticket));
    return entry ? entry.armed.then(() => {}) : Promise.resolve();
  }

  function leave(ticket, opts) {
    const id = ticketId(ticket);
    causality.leave(id, opts);
    if (ticket && ticket[skipped]) return;
    const entry = open.get(id);
    if (!entry) return;
    entry.depth -= 1;
    if (entry.depth > 0) return;
    open.delete(id);
    const done = entry.armed.then(async (ok) => {
      if (!ok) return;
      const wc = liveWc(id);
      if (wc) await release(wc);
    }).catch(() => {});
    tail.set(id, done);
    done.then(() => { if (tail.get(id) === done) tail.delete(id); });
  }

  function released(wcId) { return tail.get(Number(wcId)) || Promise.resolve(); }

  return { enter, armed, leave, released, driving: causality.driving, anyDriving: causality.anyDriving, hold: causality.hold };
}

module.exports = { createAiFocusGuard };
