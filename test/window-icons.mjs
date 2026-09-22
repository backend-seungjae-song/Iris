// macOS를 부르지 않고 앱 아이콘 러너의 실행·크기·취소 경계를 고정한다.
//
// 소유 범위
//   가짜 execFile로 argv·응답 정규화·실패 분류·바이트 제한·독립 실행 슬롯을 관찰하는 카드.
//
// 제공 API
//   node --test test/window-icons.mjs 한 명령으로 C3 아이콘 러너 계약을 판정한다.
//
// 의존 대상
//   window-icons.cjs와 주입한 execFile만 쓰며 실제 osascript·Electron·AppKit은 띄우지 않는다.
//
// 유지 조건
//   앱 열쇠는 argv JSON으로만 건네고, 한 아이콘이나 전체 응답이 커도 나머지 아이콘은 살린다.
//   아이콘 실행 슬롯은 window-catalog의 enumerate·step 슬롯과 완전히 독립이다.
//
// 영향 범위
//   공급자는 C3 아이콘 러너이고, 소비자는 switcher-host의 media 응답과 설정 화면이다.
//   지금 목록은 이걸로 센다: node bin/importers.mjs test/window-icons.mjs

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const {
  createWindowIcons, ICON_SCRIPT, MAX_ICON_BYTES, MAX_RESPONSE_BYTES,
} = require("../native/electron/window-icons.cjs");
const { createWindowCatalog } = require("../native/electron/window-catalog.cjs");

function child(kill = () => {}) {
  return { kill };
}

function runnerWith(execFile) {
  return createWindowIcons({ execFile, log: () => {} });
}

test("AppKit JXA 본문은 독립된 JavaScript로 파싱된다", () => {
  assert.doesNotThrow(() => new vm.Script(ICON_SCRIPT));
});

test("정상 응답은 앱 열쇠별 PNG data URI와 못 찾은 사유로 나눈다", async () => {
  const calls = [];
  const runner = runnerWith((file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, JSON.stringify({ ok: true, apps: [
      { pid: 11, bundleId: "com.example.One", name: "하나", icon: "AQID" },
      { pid: 22, bundleId: "", name: "둘", icon: "BAUG" },
    ] }), "");
    return child();
  });

  const result = await runner.icons({ appKeys: ["com.example.One", "pid:22", "com.example.Missing"] });

  assert.deepEqual(result, {
    icons: {
      "com.example.One": "data:image/png;base64,AQID",
      "pid:22": "data:image/png;base64,BAUG",
    },
    missing: [{ appKey: "com.example.Missing", reason: "not-found" }],
  });
  assert.equal(calls[0].file, "osascript");
  assert.deepEqual(JSON.parse(calls[0].args[4]).appKeys,
    ["com.example.One", "pid:22", "com.example.Missing"]);
  assert.doesNotMatch(calls[0].args[3], /com\.example\.One/);
  assert.equal(calls[0].options.timeout > 0, true);
  assert.equal(calls[0].options.maxBuffer > MAX_RESPONSE_BYTES, true);
  assert.match(calls[0].args[3], /Number\(app\.activationPolicy\) !== 0/);
  assert.match(calls[0].args[3], /\$\.NSMakeSize\(64, 64\)/);
  assert.match(calls[0].args[3], /irisIconBase64\(png\.base64EncodedStringWithOptions\(0\)\)/);
  assert.match(calls[0].args[3], /pid: pid,[\s\S]*bundleId: bundleId,[\s\S]*name:[\s\S]*icon:/);
});

test("timeout·parse·exec 실패는 요청한 앱마다 같은 사유를 남긴다", async () => {
  const cases = [
    ["timeout", Object.assign(new Error("늦음"), { killed: true }), ""],
    ["parse", null, "{깨짐"],
    ["exec", new Error("실행 실패"), ""],
  ];
  for (const [reason, error, stdout] of cases) {
    const runner = runnerWith((_file, _args, _options, callback) => {
      callback(error, stdout, error?.message || "");
      return child();
    });
    assert.deepEqual(await runner.icons({ appKeys: ["a", "b"] }), {
      icons: {},
      missing: [{ appKey: "a", reason }, { appKey: "b", reason }],
    });
  }
});

test("한 아이콘 바이트 상한을 넘은 항목만 빼고 작은 아이콘은 살린다", async () => {
  const large = "A".repeat(MAX_ICON_BYTES + 1);
  const runner = runnerWith((_file, _args, _options, callback) => {
    callback(null, JSON.stringify({ ok: true, apps: [
      { pid: 1, bundleId: "too.big", name: "큼", icon: large },
      { pid: 2, bundleId: "small", name: "작음", icon: "AQID" },
    ] }), "");
    return child();
  });

  const result = await runner.icons({ appKeys: ["too.big", "small"] });

  assert.deepEqual(result.icons, { small: "data:image/png;base64,AQID" });
  assert.deepEqual(result.missing, [{ appKey: "too.big", reason: "too-large" }]);
});

test("전체 바이트 상한 뒤의 항목만 빼고 앞에서 담은 아이콘은 살린다", async () => {
  const oneSize = Math.floor(MAX_RESPONSE_BYTES / 2) + 100;
  const icon = "A".repeat(Math.min(oneSize, MAX_ICON_BYTES));
  const count = Math.ceil(MAX_RESPONSE_BYTES / icon.length) + 1;
  const keys = Array.from({ length: count }, (_, index) => `app.${index}`);
  const apps = keys.map((bundleId, index) => ({ pid: index + 1, bundleId, name: bundleId, icon }));
  const runner = runnerWith((_file, _args, _options, callback) => {
    callback(null, JSON.stringify({ ok: true, apps }), "");
    return child();
  });

  const result = await runner.icons({ appKeys: keys });

  assert.equal(Object.keys(result.icons).length > 0, true);
  assert.equal(Object.keys(result.icons).length < keys.length, true);
  assert.equal(result.missing.every((item) => item.reason === "too-large"), true);
});

test("cancel은 자식을 죽이고 뒤늦은 성공 결과를 버린다", async () => {
  let callback;
  let kills = 0;
  const runner = runnerWith((_file, _args, _options, done) => {
    callback = done;
    return child(() => { kills += 1; });
  });
  const pending = runner.icons({ appKeys: ["com.example.One"] });

  runner.cancel();
  callback(null, JSON.stringify({ ok: true, apps: [
    { pid: 1, bundleId: "com.example.One", name: "하나", icon: "AQID" },
  ] }), "");

  assert.deepEqual(await pending, {
    icons: {}, missing: [{ appKey: "com.example.One", reason: "cancelled" }],
  });
  assert.equal(kills, 1);
});

test("실행 중 두 번째 아이콘 요청만 busy로 돌려보낸다", async () => {
  let finish;
  const runner = runnerWith((_file, _args, _options, callback) => {
    finish = callback;
    return child();
  });
  const first = runner.icons({ appKeys: ["first"] });

  assert.deepEqual(await runner.icons({ appKeys: ["second"] }), {
    icons: {}, missing: [{ appKey: "second", reason: "busy" }],
  });
  finish(null, JSON.stringify({ ok: true, apps: [] }), "");
  await first;
});

test("아이콘 promise가 미완료여도 catalog.step은 busy 없이 자기 슬롯에서 끝난다", async () => {
  const runner = runnerWith(() => child());
  const iconPending = runner.icons({ appKeys: ["com.example.One"] });
  const catalog = createWindowCatalog({
    readCoreSource: () => "module.exports.selectTarget = () => null;",
    log: () => {},
    execFile(file, _args, _options, callback) {
      assert.equal(file, "osascript");
      callback(null, JSON.stringify({ ok: true, raised: null, resolved: [], missing: [], front: null }), "");
      return child();
    },
  });

  const stepped = await catalog.step({ ordered: [], cursor: null, dir: 1, targets: [] });

  assert.equal(stepped.ok, true);
  assert.notEqual(stepped.reason, "busy");
  runner.cancel();
  await iconPending;
});
