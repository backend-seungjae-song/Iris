import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  assignOrdinals,
  reconcile,
  pruneDeadProcesses,
  pick,
  unpick,
  movePicked,
  selectTarget,
  serialize,
  deserialize,
} = require("../native/electron/switcher-core.cjs");

function window(overrides = {}) {
  return {
    id: 60026,
    cgId: 60026,
    idConfidence: "exact",
    pid: 787,
    pidStart: "Thu Aug 28 09:12:01 2026",
    matchApp: "Google Chrome",
    matchTitle: "GeekNews - Chrome",
    displayApp: "Google Chrome",
    displayTitle: "GeekNews - Chrome",
    bounds: [0, 38, 1728, 1018],
    minimized: false,
    ...overrides,
  };
}

function saved(overrides = {}) {
  const current = window(overrides);
  const item = {
    cgId: current.cgId,
    pid: current.pid,
    pidStart: current.pidStart,
    matchApp: current.matchApp,
    matchTitle: current.matchTitle,
    ordinal: current.ordinal || 1,
    bounds: current.bounds.slice(),
    pickKey: pickKey(stableAppKey(current.appKey) || current.matchApp, current.matchTitle, current.ordinal || 1),
  };
  if (typeof current.appKey === "string") item.appKey = current.appKey;
  return item;
}

function stableAppKey(value) {
  return typeof value === "string" && value && !value.startsWith("pid:") ? value : "";
}

function pickKey(appIdentity, matchTitle, ordinal) {
  return `${appIdentity}\u001f${matchTitle}\u001f${ordinal}`;
}

test("T7 앞 창이 목록에 있으면 그다음 항목을 고른다", () => {
  const base = { ordered: ["A", "B", "C"], resolved: ["A", "B", "C"], cursor: null };

  assert.deepEqual(selectTarget({ ...base, front: "B", dir: 1 }), { id: "C" });
  assert.deepEqual(selectTarget({ ...base, front: "B", dir: -1 }), { id: "A" });
});

test("R9 앞 창이 목록 밖이면 커서를 무시하고 방향의 첫 창부터 고른다", () => {
  const base = { ordered: ["A", "B", "C"], resolved: ["A", "B", "C"], cursor: "B" };

  assert.deepEqual(selectTarget({ ...base, front: "D", dir: 1 }), { id: "A" });
  assert.deepEqual(selectTarget({ ...base, front: "D", dir: -1 }), { id: "C" });
});

test("R9 앞 창을 알 수 없을 때만 커서 다음부터 고른다", () => {
  const base = { ordered: ["A", "B", "C"], resolved: ["A", "B", "C"], cursor: "B", front: null };

  assert.deepEqual(selectTarget({ ...base, dir: 1 }), { id: "C" });
  assert.deepEqual(selectTarget({ ...base, dir: -1 }), { id: "A" });

  // front 키를 아예 안 넘긴 호출도 "못 읽음"이다. null 과 같게 다룬다.
  assert.deepEqual(selectTarget({ ordered: base.ordered, resolved: base.resolved, cursor: "B", dir: 1 }), { id: "C" });
});

test("T8 항목이 하나뿐이면 앞 창과 같아도 그 창을 고른다", () => {
  const base = { ordered: ["A"], resolved: ["A"], cursor: null, dir: 1 };

  assert.deepEqual(selectTarget({ ...base, front: "D" }), { id: "A" });
  assert.deepEqual(selectTarget({ ...base, front: "A" }), { id: "A" });
});

test("고른 창을 한 칸 앞으로와 뒤로 옮긴다", () => {
  const state = {
    version: 1,
    picked: [
      saved({ cgId: 1, matchTitle: "하나" }),
      saved({ cgId: 2, matchTitle: "둘" }),
      saved({ cgId: 3, matchTitle: "셋" }),
    ],
    cursor: 2,
  };

  const forward = movePicked({ state, id: 2, dir: -1 });
  const backward = movePicked({ state: forward, pickKey: forward.picked[0].pickKey, dir: 1 });

  assert.deepEqual(forward.picked.map((item) => item.cgId), [2, 1, 3]);
  assert.deepEqual(backward.picked.map((item) => item.cgId), [1, 2, 3]);
  assert.equal(forward.cursor, 2);
});

test("고른 창 순서의 경계와 없는 대상은 원래 상태를 그대로 돌려준다", () => {
  const state = {
    version: 1,
    picked: [
      saved({ cgId: 1, matchTitle: "하나" }),
      saved({ cgId: 2, matchTitle: "둘" }),
      saved({ cgId: 3, matchTitle: "셋" }),
    ],
    cursor: null,
  };

  assert.strictEqual(movePicked({ state, id: 1, dir: -1 }), state);
  assert.strictEqual(movePicked({ state, id: 3, dir: 1 }), state);
  assert.strictEqual(movePicked({ state, id: 999, dir: -1 }), state);
  assert.strictEqual(movePicked({ state, pickKey: "없는 키", dir: 1 }), state);
});

test("고른 창을 옮기면 selectTarget이 새 순서로 돈다", () => {
  const state = {
    version: 1,
    picked: [
      saved({ cgId: 1, matchTitle: "하나" }),
      saved({ cgId: 2, matchTitle: "둘" }),
      saved({ cgId: 3, matchTitle: "셋" }),
    ],
    cursor: null,
  };
  const moved = movePicked({ state, id: 3, dir: -1 });
  const ordered = moved.picked.map((item) => item.cgId);

  assert.deepEqual(ordered, [1, 3, 2]);
  assert.deepEqual(selectTarget({ ordered, resolved: ordered, front: 1, cursor: null, dir: 1 }), { id: 3 });
});

test("T9 재시작은 순번으로 메모 둘째 창을 붙이고 제목이 달라진 Chrome은 버린다", () => {
  const state = {
    version: 1,
    picked: [
      saved({ cgId: 101, pid: 10, pidStart: "old", matchApp: "메모", matchTitle: "메모", ordinal: 2, bounds: [400, 0, 300, 300] }),
      saved({ cgId: 202, pid: 20, pidStart: "old", matchApp: "Google Chrome", matchTitle: "GeekNews - Chrome" }),
    ],
    cursor: null,
  };
  const windows = [
    window({ id: 302, cgId: 302, pid: 30, pidStart: "new", matchApp: "메모", matchTitle: "메모", displayApp: "메모", displayTitle: "메모", bounds: [400, 0, 300, 300] }),
    window({ id: 301, cgId: 301, pid: 30, pidStart: "new", matchApp: "메모", matchTitle: "메모", displayApp: "메모", displayTitle: "메모", bounds: [0, 0, 300, 300] }),
    window({ id: 401, cgId: 401, pid: 40, pidStart: "new", matchTitle: "다른 페이지 - Chrome", displayTitle: "다른 페이지 - Chrome" }),
  ];

  const result = reconcile({ state, windows, phase: "restart" });

  assert.equal(result.dropped, 1);
  assert.equal(result.state.picked.length, 1);
  assert.equal(result.state.picked[0].cgId, 302);
  assert.equal(result.rows.find((row) => row.id === 302).picked, true);
  assert.equal(result.rows.find((row) => row.id === 301).picked, false);
});

test("T11 현재 없는 창을 건너뛰고 실제로 존재하는 다음 창을 고른다", () => {
  assert.deepEqual(selectTarget({ ordered: ["A", "B", "C"], resolved: ["A", "C"], front: "A", cursor: null, dir: 1 }), { id: "C" });
  assert.deepEqual(selectTarget({ ordered: ["A", "B", "C"], resolved: [], front: "A", cursor: null, dir: 1 }), { id: null });
});

test("T12 끝난 앱의 저장 항목을 빼고 제거 수와 커서를 갱신한다", () => {
  const state = {
    version: 1,
    picked: [saved({ cgId: 10, pid: 1, pidStart: "alive" }), saved({ cgId: 20, pid: 2, pidStart: "dead" })],
    cursor: 20,
  };

  const result = pruneDeadProcesses({ state, alive: { "1|alive": true } });

  assert.equal(result.removed, 1);
  assert.deepEqual(result.state.picked.map((item) => item.cgId), [10]);
  assert.equal(result.state.cursor, null);
});

test("T20 손상 입력과 다른 버전은 빈 상태가 되고 pid 0 항목은 남는다", () => {
  assert.deepEqual(deserialize("{{"), { version: 1, picked: [], cursor: null });
  assert.deepEqual(deserialize({ version: 2, picked: [saved()] }), { version: 1, picked: [], cursor: null });

  const valid = saved({ cgId: null });
  const result = deserialize({ version: 1, picked: [valid, { pid: 1 }, saved({ pid: 0 })], cursor: "bad" });

  assert.equal(result.picked.length, 2);
  assert.deepEqual(result.picked[0], valid);
  assert.equal(result.picked[1].pid, 0);
  assert.equal(result.cursor, null);
});

test("deserialize는 크기와 자료형을 저장 경계 안으로 정규화한다", () => {
  const long = "가".repeat(450);
  const items = Array.from({ length: 205 }, (_, index) => saved({ cgId: index, matchApp: long, matchTitle: long, ordinal: 0 }));

  const result = deserialize(JSON.stringify({ version: 1, picked: items, cursor: -7 }));

  assert.equal(result.picked.length, 200);
  assert.equal(result.picked[0].matchApp.length, 400);
  assert.equal(result.picked[0].matchTitle.length, 400);
  assert.equal(result.picked[0].ordinal, 1);
  assert.equal(result.cursor, -7);
});

// 창을 하나도 못 본 회차는 아무것도 증명하지 않는다. 앱을 새로 깔면 macOS 가 권한을 다시
// 물어 그 사이 열거가 전부 실패하는데, 그 회차가 고른 창을 지우면 window-switcher.json 이
// picked:[] 가 되어 고른 창이 사라진다.
test("T33 창을 하나도 못 본 회차는 고른 창을 빼지 않는다", () => {
  const state = { version: 1, picked: [saved({ cgId: 1 }), saved({ cgId: 2 })], cursor: null };

  const result = reconcile({ state, windows: [], phase: "restart" });

  assert.equal(result.dropped, 0);
  assert.equal(result.state.picked.length, 2, "못 본 것을 없어진 것으로 보면 안 된다");
  assert.equal(result.rows.filter((row) => row.visible === false).length, 2);
});

test("T33 그 앱 창을 봤는데 제목을 못 읽으면 빼지 않는다", () => {
  const state = { version: 1, picked: [saved({ cgId: 1 })], cursor: null };
  const titleless = window({ id: 9, cgId: 9, matchTitle: "", displayTitle: "" });

  const result = reconcile({ state, windows: [titleless], phase: "restart" });

  assert.equal(result.dropped, 0, "제목을 못 읽으면 그 창인지 아닌지 판정할 수 없다");
  assert.equal(result.state.picked.length, 1);
});

test("T33 그 앱 창을 제대로 봤는데 없으면 그때는 뺀다", () => {
  const state = { version: 1, picked: [saved({ cgId: 1, matchTitle: "사라진 창" })], cursor: null };
  const other = window({ id: 9, cgId: 9, matchTitle: "남은 창", displayTitle: "남은 창" });

  const result = reconcile({ state, windows: [other], phase: "restart" });

  assert.equal(result.dropped, 1);
  assert.deepEqual(result.state.picked, []);
});

test("T34 같은 제목의 창 순번은 입력 z-order가 아니라 bounds 사전순으로 정한다", () => {
  const left = window({ id: 1, cgId: 1, bounds: [0, 50, 400, 300] });
  const right = window({ id: 2, cgId: 2, bounds: [500, 50, 400, 300] });

  const forward = assignOrdinals([left, right]);
  const reversed = assignOrdinals([right, left]);

  assert.equal(forward.find((item) => item.id === 1).ordinal, 1);
  assert.equal(forward.find((item) => item.id === 2).ordinal, 2);
  assert.equal(reversed.find((item) => item.id === 1).ordinal, 1);
  assert.equal(reversed.find((item) => item.id === 2).ordinal, 2);
});

test("표시 앱과 제목이 같아도 안정 appKey가 다르면 순번·선택 키·재결합이 섞이지 않는다", () => {
  const first = window({ id: 1, cgId: 1, appKey: "com.example.First", bounds: [0, 0, 300, 300] });
  const second = window({ id: 2, cgId: 2, appKey: "com.example.Second", bounds: [400, 0, 300, 300] });
  const assigned = assignOrdinals([first, second]);

  assert.deepEqual(assigned.map((item) => item.ordinal), [1, 1]);

  const pickedFirst = pick({ state: { version: 1, picked: [], cursor: null }, window: assigned[0] });
  const pickedBoth = pick({ state: pickedFirst, window: assigned[1] });
  assert.equal(pickedBoth.picked.length, 2);
  assert.equal(pickedBoth.picked[0].pickKey, pickKey("com.example.First", first.matchTitle, 1));
  assert.equal(pickedBoth.picked[1].pickKey, pickKey("com.example.Second", second.matchTitle, 1));

  const state = { version: 1, picked: [saved({ id: 1, cgId: 1, appKey: "com.example.First" })], cursor: null };
  const restart = reconcile({ state, windows: [second, first], phase: "restart" });
  assert.equal(restart.state.picked[0].cgId, 1);
  assert.equal(restart.state.picked[0].appKey, "com.example.First");
  assert.equal(restart.rows.find((row) => row.id === 1).picked, true);
  assert.equal(restart.rows.find((row) => row.id === 2).picked, false);

  const reused = window({ id: 1, cgId: 1, appKey: "com.example.Second" });
  const session = reconcile({ state, windows: [reused], phase: "session" });
  assert.equal(session.rows.find((row) => row.id === 1).picked, false);
  assert.equal(session.rows.find((row) => row.visible === false).appKey, "com.example.First");
});

test("안정 appKey가 같으면 표시 앱 이름이 달라도 같은 앱으로 판단한다", () => {
  const left = window({ id: 1, cgId: 1, appKey: "com.example.Same", matchApp: "예전 이름", bounds: [0, 0, 300, 300] });
  const right = window({ id: 2, cgId: 2, appKey: "com.example.Same", matchApp: "새 이름", bounds: [400, 0, 300, 300] });
  const assigned = assignOrdinals([right, left]);
  assert.equal(assigned.find((item) => item.id === 1).ordinal, 1);
  assert.equal(assigned.find((item) => item.id === 2).ordinal, 2);

  const state = {
    version: 1,
    picked: [saved({ cgId: null, appKey: "com.example.Same", matchApp: "예전 이름", ordinal: 2 })],
    cursor: null,
  };
  const restart = reconcile({ state, windows: [right, left], phase: "restart" });
  assert.equal(restart.state.picked[0].cgId, 2);
  assert.equal(restart.state.picked[0].matchApp, "새 이름");

  const noSessionId = window({
    id: "없음", cgId: null, pid: 999, pidStart: "다른 프로세스",
    appKey: "com.example.Same", matchApp: "새 이름", ordinal: 2,
  });
  assert.deepEqual(pick({ state, window: noSessionId }), state);
});

test("R6a 세션에서는 같은 cgId의 제목 변경을 따라가 저장 제목도 갱신한다", () => {
  const state = { version: 1, picked: [saved({ cgId: 60026, matchTitle: "이전 제목" })], cursor: 60026 };
  const windows = [window({ cgId: 60026, id: 60026, matchTitle: "새 제목", displayTitle: "새 제목" })];

  const result = reconcile({ state, windows, phase: "session" });

  assert.equal(result.dropped, 0);
  assert.equal(result.state.picked[0].matchTitle, "새 제목");
  assert.equal(result.rows[0].picked, true);
});

test("R6b 같은 앱의 같은 cgId라도 재시작에서는 제목이 바뀌면 빠지고 세션에서는 붙는다", () => {
  const state = { version: 1, picked: [saved({ cgId: 60026, matchTitle: "이전 제목" })], cursor: 60026 };
  const changed = window({ cgId: 60026, id: 60026, matchTitle: "새 제목", displayTitle: "새 제목" });

  const restart = reconcile({ state, windows: [changed], phase: "restart" });
  const session = reconcile({ state, windows: [changed], phase: "session" });

  assert.equal(restart.dropped, 1);
  assert.deepEqual(restart.state.picked, []);
  assert.equal(restart.rows[0].picked, false);
  assert.equal(session.dropped, 0);
  assert.equal(session.state.picked[0].matchTitle, "새 제목");
  assert.equal(session.rows[0].picked, true);
});

test("R6b 재시작과 세션 모두 다른 앱이 재사용한 cgId에는 붙지 않는다", () => {
  const state = {
    version: 1,
    picked: [saved({ cgId: 60026, matchApp: "Google Chrome", matchTitle: "고른 페이지" })],
    cursor: 60026,
  };
  const reused = window({
    id: 60026, cgId: 60026, pid: 999, pidStart: "새 프로세스",
    matchApp: "미리보기", displayApp: "미리보기", matchTitle: "다른 문서", displayTitle: "다른 문서",
  });

  const session = reconcile({ state, windows: [reused], phase: "session" });
  const restart = reconcile({ state, windows: [reused], phase: "restart" });

  assert.equal(session.rows.find((row) => row.id === 60026).picked, false);
  assert.equal(session.rows.find((row) => row.visible === false).displayApp, "Google Chrome");
  assert.equal(restart.rows[0].picked, false);
  // Chrome 창을 한 개도 못 봤으므로 그 창이 없어졌는지 알 수 없다. 빼지 않고 숨은 행으로 둔다.
  assert.equal(restart.dropped, 0);
  assert.equal(restart.state.picked.length, 1);
  assert.equal(restart.rows.find((row) => row.visible === false).displayApp, "Google Chrome");
});

test("재결합은 같은 프로세스의 제목을 bounds보다 먼저 보고 그다음 bounds를 쓴다", () => {
  const state = {
    version: 1,
    picked: [saved({ cgId: null, pid: 77, pidStart: "same", matchTitle: "고른 제목", bounds: [10, 20, 300, 400] })],
    cursor: null,
  };
  const titleMatch = window({ id: 1, cgId: 1, pid: 77, pidStart: "same", matchTitle: "고른 제목", bounds: [900, 20, 300, 400] });
  const boundsMatch = window({ id: 2, cgId: 2, pid: 77, pidStart: "same", matchTitle: "바뀐 제목", bounds: [10, 20, 300, 400] });

  const byTitle = reconcile({ state, windows: [boundsMatch, titleMatch], phase: "session" });
  const byBounds = reconcile({ state, windows: [boundsMatch], phase: "session" });

  assert.equal(byTitle.state.picked[0].cgId, 1);
  assert.equal(byBounds.state.picked[0].cgId, 2);
  assert.equal(byBounds.state.picked[0].matchTitle, "바뀐 제목");
});

test("세션에서 못 붙인 선택은 appKey를 가진 흐린 행으로 남긴다", () => {
  const state = {
    version: 1,
    picked: [saved({ appKey: "com.apple.TextEdit", matchApp: "메모", matchTitle: "사라진 메모" })],
    cursor: null,
  };

  const result = reconcile({ state, windows: [], phase: "session" });

  assert.equal(result.dropped, 0);
  assert.equal(result.state.picked.length, 1);
  assert.deepEqual(result.rows, [{
    id: null,
    appKey: "com.apple.TextEdit",
    pickKey: pickKey("com.apple.TextEdit", "사라진 메모", 1),
    displayApp: "메모",
    displayTitle: "사라진 메모",
    picked: true,
    visible: false,
  }]);
});

test("흐린 행의 선택 키로 체크를 풀 수 있다", () => {
  const state = { version: 1, picked: [saved({ matchApp: "메모", matchTitle: "사라진 메모" })], cursor: null };
  const reconciled = reconcile({ state, windows: [], phase: "session" });

  const result = unpick({ state: reconciled.state, pickKey: reconciled.rows[0].pickKey });

  assert.deepEqual(result.picked, []);
});

test("붙은 행에도 선택 키가 실리고 그 키로 체크를 풀 수 있다", () => {
  const current = window({ matchTitle: "현재 제목", ordinal: 1 });
  const state = { version: 1, picked: [saved({ matchTitle: "이전 제목" })], cursor: null };
  const reconciled = reconcile({ state, windows: [current], phase: "session" });

  assert.equal(reconciled.rows[0].pickKey, pickKey("Google Chrome", "현재 제목", 1));
  assert.deepEqual(unpick({ state: reconciled.state, pickKey: reconciled.rows[0].pickKey }).picked, []);
});

test("pick은 체크 순서를 지키고 같은 창을 거듭 넣지 않는다", () => {
  const empty = { version: 1, picked: [], cursor: null };
  const a = window({ id: -1, cgId: null, idConfidence: "none", matchTitle: "A", displayTitle: "A" });
  const b = window({ id: 2, cgId: 2, matchTitle: "B", displayTitle: "B" });

  const first = pick({ state: empty, window: a });
  const second = pick({ state: first, window: b });
  const duplicate = pick({ state: second, window: a });

  assert.deepEqual(second.picked.map((item) => item.matchTitle), ["A", "B"]);
  assert.deepEqual(duplicate, second);
  assert.equal(unpick({ state: second, id: -1 }).picked.length, 1);
  assert.equal(unpick({ state: { ...second, cursor: -1 }, id: -1 }).cursor, null);
});

test("appKey 없는 구 저장 항목은 현재 창과 붙을 때 안정 appKey를 얻어 다시 저장된다", () => {
  const legacy = deserialize({ version: 1, picked: [saved()], cursor: null });
  const current = window({ appKey: "com.google.Chrome" });

  assert.equal(Object.hasOwn(legacy.picked[0], "appKey"), false);
  const reconciled = reconcile({ state: legacy, windows: [current], phase: "restart" });
  assert.equal(reconciled.state.picked[0].appKey, "com.google.Chrome");
  assert.equal(reconciled.state.picked[0].pickKey, pickKey("com.google.Chrome", current.matchTitle, 1));

  const stored = serialize(reconciled.state);
  assert.equal(stored.version, 1);
  assert.equal(stored.picked[0].appKey, "com.google.Chrome");
  assert.deepEqual(Object.keys(stored.picked[0]).sort(), [
    "appKey", "bounds", "cgId", "matchApp", "matchTitle", "ordinal", "pickKey", "pid", "pidStart",
  ]);
});

test("serialize은 optional appKey를 포함한 저장 스키마만 남기고 bounded normalize를 적용한다", () => {
  const runtime = pick({
    state: { version: 1, picked: [], cursor: null },
    window: window({ id: -9, cgId: null, appKey: "com.google.Chrome" }),
  });

  const result = serialize(runtime);

  assert.deepEqual(Object.keys(result.picked[0]).sort(), [
    "appKey", "bounds", "cgId", "matchApp", "matchTitle", "ordinal", "pickKey", "pid", "pidStart",
  ]);
  assert.equal(result.picked[0].appKey, "com.google.Chrome");
  assert.equal(result.cursor, null);
});

test("serialize은 pid appKey를 다음 실행의 저장 항목에 남기지 않는다", () => {
  const runtime = pick({
    state: { version: 1, picked: [], cursor: null },
    window: window({ id: -9, cgId: null, appKey: "pid:787" }),
  });

  assert.equal(runtime.picked[0].appKey, "pid:787");
  assert.equal(runtime.picked[0].pickKey, pickKey("Google Chrome", "GeekNews - Chrome", 1));
  const result = serialize(runtime);
  assert.deepEqual(Object.keys(result.picked[0]).sort(), [
    "bounds", "cgId", "matchApp", "matchTitle", "ordinal", "pickKey", "pid", "pidStart",
  ]);
  assert.equal(Object.hasOwn(result.picked[0], "appKey"), false);
});

test("serialize은 불완전한 선택의 bounds와 pid를 기본값으로 채워 남긴다", () => {
  const item = saved();
  delete item.bounds;
  item.pid = "알 수 없음";

  const result = serialize({ version: 1, picked: [item], cursor: null });

  assert.equal(result.picked.length, 1);
  assert.deepEqual(result.picked[0].bounds, [0, 0, 0, 0]);
  assert.equal(result.picked[0].pid, 0);
});

test("같은 앱과 제목이어도 순번이 다르면 선택 키가 다르다", () => {
  const empty = { version: 1, picked: [], cursor: null };
  const first = pick({ state: empty, window: window({ id: 1, cgId: 1, ordinal: 1 }) });
  const second = pick({ state: first, window: window({ id: 2, cgId: 2, ordinal: 2 }) });

  assert.equal(second.picked[0].pickKey, pickKey("Google Chrome", "GeekNews - Chrome", 1));
  assert.equal(second.picked[1].pickKey, pickKey("Google Chrome", "GeekNews - Chrome", 2));
  assert.notEqual(second.picked[0].pickKey, second.picked[1].pickKey);
});

test("모든 함수는 전달받은 객체와 배열을 바꾸지 않는다", () => {
  const windows = [window({ id: 1, cgId: 1 }), window({ id: 2, cgId: 2, bounds: [20, 20, 200, 200] })];
  const state = { version: 1, picked: [saved({ cgId: 1 })], cursor: 1 };
  const alive = { "787|Thu Aug 28 09:12:01 2026": true };
  const ordered = [1, 2];
  const resolved = [1, 2];
  const before = JSON.stringify({ windows, state, alive, ordered, resolved });

  assignOrdinals(windows);
  reconcile({ state, windows, phase: "session" });
  pruneDeadProcesses({ state, alive });
  pick({ state, window: windows[1] });
  unpick({ state, id: 1 });
  movePicked({ state, id: 1, dir: 1 });
  selectTarget({ ordered, resolved, front: 1, cursor: 1, dir: 1 });
  serialize(state);
  deserialize(state);

  assert.equal(JSON.stringify({ windows, state, alive, ordered, resolved }), before);
});
