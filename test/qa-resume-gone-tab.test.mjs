import assert from "node:assert/strict";
import test from "node:test";
import { splitQaRestoreTabs } from "../server/browser-commands.js";

// 진입 탭이 qa_close_tab 밖에서 닫히면 그 회차를 영구히 이어받지 못했음(2026-10-29 qa-99daee6f)
// qa_close_tab 은 이어받은 뒤에만 쓸 수 있어 기록으로 닫을 길도 없었음

const facts = ({ own = [], live = [], stored = [], owners = {} }) => ({
  own: new Set(own),
  exists: (tab) => live.includes(tab) || stored.includes(tab),
  ownerOf: (tab) => owners[tab] || null,
});

test("어디에도 없는 진입 탭은 닫힌 것으로 빼고 나머지로 이어받음", () => {
  const r = splitQaRestoreTabs(["gone", "mine"], "run-1", facts({ own: ["mine"], live: ["mine"] }));
  assert.deepEqual(r, { ok: true, live: ["mine"], gone: ["gone"] });
});

test("있는데 이 세션 그룹 밖이면 그룹 밖이라고 거절", () => {
  const r = splitQaRestoreTabs(["elsewhere"], "run-1", facts({ stored: ["elsewhere"] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /세션 탭 그룹 밖/);
});

test("다른 회차가 소유한 탭이면 소유권으로 거절", () => {
  const r = splitQaRestoreTabs(["mine"], "run-1", facts({ own: ["mine"], live: ["mine"], owners: { mine: "run-2" } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /다른 QA 회차/);
});
