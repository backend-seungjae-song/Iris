import assert from "node:assert/strict";
import test from "node:test";

import { initWorkspaceRuntime, startWorkspaceRuntime } from "../server/workspace-runtime.js";

// 사람이 터미널에서 휠을 굴리면 herdr 가 pane.scroll_changed 를 쏟아낸다. 그 이벤트는 관제
// 상태를 바꾸지 않는다. 어느 워크스페이스에 어떤 에이전트가 있는지와 무관하다.
// 그래서 handleHerdrEvent 는 그 분기에서 곧바로 반환한다. 그 return 이 없으면 아래 debounce 가
// 굴리는 내내 150ms 마다 전체 재계산을 돌린다(파일 I/O 가 있는 작업이다).
//
// 이 지점을 검사하는 것이 없으면 return 을 지워도 검사는 전부 통과하고, 증상은 사람이
// 스크롤할 때만 나타난다. 그래서 여기서 검사한다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const calls = { recompute: 0, refresh: 0, broadcast: [] };
  let onEvent = null;
  const herdr = {
    on(name, fn) { if (name === "event") onEvent = fn; },
    connect() {},
    refreshSubscription() { calls.refresh++; },
  };
  initWorkspaceRuntime({
    herdr,
    requestRecompute: () => { calls.recompute++; },
    broadcast: (m) => calls.broadcast.push(m),
  });
  startWorkspaceRuntime();
  assert.ok(onEvent, "startWorkspaceRuntime 이 event 핸들러를 걸어야 한다");
  return { calls, fire: (ev) => onEvent(ev) };
}

test("스크롤 이벤트는 관제 재계산을 부르지 않는다", async () => {
  const { calls, fire } = harness();
  for (let i = 0; i < 20; i++) {
    fire({ type: "pane.scroll_changed", data: { pane_id: "w1:p1", scroll: { offset_from_bottom: i, max_offset_from_bottom: 100, viewport_rows: 40 } } });
  }
  await sleep(300);
  assert.equal(calls.recompute, 0, "휠을 굴리는 내내 재계산이 돌면 안 된다");
  assert.equal(calls.refresh, 0, "스크롤은 구독을 갱신할 이유가 없다");
});

test("pane 집합이 바뀌는 이벤트는 재계산과 구독 갱신을 부른다", async () => {
  const { calls, fire } = harness();
  fire({ type: "pane.created", data: { pane_id: "w1:p2" } });
  await sleep(500);
  assert.ok(calls.recompute >= 1, "새 pane 은 재계산을 불러야 한다");
  assert.ok(calls.refresh >= 1, "새 pane 은 구독 갱신을 불러야 한다");
});

test("그 밖의 이벤트도 재계산까지는 간다", async () => {
  const { calls, fire } = harness();
  fire({ type: "pane.status_changed", data: { pane_id: "w1:p3" } });
  await sleep(300);
  assert.ok(calls.recompute >= 1, "상태 변화는 재계산을 불러야 한다");
  assert.equal(calls.refresh, 0, "pane 집합이 안 바뀌면 구독은 그대로다");
});
