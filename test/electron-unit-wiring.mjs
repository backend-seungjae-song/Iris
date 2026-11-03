import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createUnitWiring } = require("../native/electron/relay/unit-wiring.cjs");

const codedError = (code, message) => Object.assign(new Error(message), { code });

function fixture(wc = null) {
  const calls = [];
  const units = {
    run: (request, opts) => { calls.push(["units.run", request, opts]); return "unit-result"; },
    releaseAll: (error) => calls.push(["releaseAll", error.code]),
    releaseGeneration: (generation, error) => calls.push(["releaseGeneration", generation, error.code]),
  };
  const relay = {
    execute: (request) => { calls.push(["relay.execute", request]); return "direct-result"; },
    acceptGeneration: (...args) => { calls.push(["accept", ...args]); return "accepted"; },
    retireGeneration: (...args) => { calls.push(["retire", ...args]); return "retired"; },
  };
  const wiring = createUnitWiring({ getUnits: () => units, getRelay: () => relay, codedError, liveWc: () => wc });
  return { calls, wiring };
}

test("unit 표시가 있는 기본 명령은 단위 실행으로, 없으면 직접 중계로 간다", () => {
  const { calls, wiring } = fixture();
  const request = { workerGeneration: "g1", commandId: "g1/a", command: "wc.info", target: { wcId: "7" } };
  assert.equal(wiring.dispatchBase(request, { phase: "last", command: "url" }), "unit-result");
  assert.deepEqual(calls[0], ["units.run", request, { unit: { phase: "last", command: "url" }, key: 7 }]);
  assert.equal(wiring.dispatchBase(request, undefined), "direct-result");
  assert.equal(calls[1][0], "relay.execute");
});

test("명시 종료는 기본 명령 없이 단위만 닫는다", () => {
  const { calls, wiring } = fixture();
  const unit = { phase: "end", command: "url" };
  assert.equal(wiring.endUnit({ workerGeneration: "g1", commandId: "g1/a", unit }, 7), "unit-result");
  assert.deepEqual(calls[0], ["units.run", { workerGeneration: "g1", commandId: "g1/a" }, { unit, key: 7 }]);
});

test("세대 수락과 회수는 단위를 먼저 풀고 중계에 전달한다", () => {
  const { calls, wiring } = fixture();
  const control = wiring.relayControl(new Set(["wc.info"]));
  assert.equal(control.acceptGeneration("g2", "conn", { a: 1 }), "accepted");
  assert.deepEqual(calls.slice(0, 2), [["releaseAll", "STALE_WORKER"], ["accept", "g2", "conn", { a: 1 }]]);
  assert.equal(control.retireGeneration("g1", { b: 2 }), "retired");
  assert.deepEqual(calls.slice(2), [["releaseGeneration", "g1", "STALE_WORKER"], ["retire", "g1", { b: 2 }]]);
  assert.equal(control.isBaseCommand("wc.info"), true);
  assert.equal(control.isBaseCommand("click"), false);
});

test("watchTab 은 탭 destroyed 에 걸고 해제 함수를 돌려주며 탭이 없으면 null", () => {
  const listeners = new Map();
  const wc = {
    once: (name, fn) => listeners.set(name, fn),
    removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const { wiring } = fixture(wc);
  let gone = 0;
  const stop = wiring.watchTab(7, () => { gone++; });
  listeners.get("destroyed")();
  assert.equal(gone, 1);
  stop();
  assert.equal(listeners.size, 0);
  assert.equal(fixture(null).wiring.watchTab(7, () => {}), null);
});

test("cdp-control 은 네 배선을 모두 이 모듈로 지난다", () => {
  const source = fs.readFileSync(new URL("../native/electron/cdp-control.cjs", import.meta.url), "utf8");
  assert.match(source, /relayControl:\s*unitWiring\.relayControl\(BASE_COMMANDS\)/);
  assert.match(source, /return unitWiring\.dispatchBase\(request, meta\.unit\)/);
  assert.match(source, /meta\.unit\?\.phase === "end"\) return unitWiring\.endUnit\(meta, wcId\)/);
  assert.match(source, /watchTab:\s*\(key, onGone\) => unitWiring\.watchTab\(key, onGone\)/);
  assert.match(source, /features:\s*\["worker-command-unit", "worker-input-commands", "worker-page-commands", "worker-native-commands", "worker-qa-input-commands", "worker-qa-observe-commands", "worker-ax-tree"\]/);
  assert.match(source, /releaseAttach:\s*\(wcId\) => attachPolicy\.release\(wcId\)/);
  assert.match(source, /paint:\s*paintState\(wc\.id\)/);
  assert.match(source, /refs:\s*\{ record: [^\n]*resolve: \(wcId, ref\) => refRegistry\.resolveRef\(wcId, ref\) \}/);
  assert.match(source, /detachIdle:\s*\(wc\) => detachIdle\(wc\)/);
  assert.match(source, /onClose:\s*\(\{ generation, commandId \}\) => electronRelay\?\.releaseCommand\(generation, commandId\)/);
});
