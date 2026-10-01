import assert from "node:assert/strict";
import { clearHistory, markAllRead, pendingCount, reconcileNotifications, unreadCount } from "../web/js/notifications/model.js";

const agent = (status, question = false) => ({ paneId: "pane-1", workspaceId: "space-1",
  tabLabel: "검토", status, question });
let state = { initialized: false, seen: {}, records: [] };
state = reconcileNotifications(state, [agent("working")], 10);
assert.equal(state.records.length, 0, "첫 방송은 알림을 만들지 않는다");
state = reconcileNotifications(state, [agent("done", true)], 20);
assert.equal(state.records.length, 1);
assert.equal(state.records[0].kind, "question");
assert.equal(pendingCount(state), 1);
assert.equal(unreadCount(state), 1);
state = reconcileNotifications(state, [agent("done", true)], 21);
assert.equal(state.records.length, 1, "같은 방송을 다시 받아도 중복되지 않는다");
state = markAllRead(state);
assert.equal(unreadCount(state), 0);
assert.equal(pendingCount(state), 1, "읽음은 질문 대기를 해결하지 않는다");
state = reconcileNotifications(state, [agent("working")], 30);
assert.equal(pendingCount(state), 0);
state = reconcileNotifications(state, [agent("done")], 40);
assert.equal(state.records[0].kind, "done");
assert.equal(unreadCount(state), 1);
state = clearHistory(state);
assert.equal(state.records.length, 0);

let initialPending = { initialized: false, seen: {}, records: [] };
initialPending = reconcileNotifications(initialPending, [agent("blocked")], 50);
assert.equal(pendingCount(initialPending), 1);
assert.equal(unreadCount(initialPending), 0, "재시작 때 기존 대기는 새 알림으로 세지 않는다");
const restored = reconcileNotifications({ initialized: false, seen: {},
  records: initialPending.records.map((record) => ({ ...record, pending: false })) }, [agent("blocked")], 60);
assert.equal(restored.records.length, 1, "저장된 대기 알림을 중복 생성하지 않는다");
assert.equal(pendingCount(restored), 1);

let reused = reconcileNotifications({ initialized: false, seen: {}, records: [] },
  [{ ...agent("blocked"), terminalId: "old" }], 70);
reused = reconcileNotifications(reused, [{ ...agent("blocked"), terminalId: "new" }], 80);
assert.equal(reused.records.length, 2, "pane을 재사용한 새 터미널은 별개 알림으로 남는다");
assert.equal(pendingCount(reused), 1);
const resumed = reconcileNotifications(reused, [{ ...agent("working", true), terminalId: "new" }], 90);
assert.equal(pendingCount(resumed), 0, "작업 재개는 이전 질문 플래그보다 우선한다");
