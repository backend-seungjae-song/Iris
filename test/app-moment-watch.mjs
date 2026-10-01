import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 가짜 idb: describe-all 을 부를 때마다 미리 만들어 둔 화면을 순서대로 하나씩 돌려준다. 조작 뒤 알림
// 하나가 떴다 사라지고, 같은 위치에 두 번째 알림이 연달아 뜨고, 글자만 잠깐 바뀌고, 요소 네 개가 함께
// 나타났다 사라진다(화면이 바뀐 경우). 알림 두 개만 기록돼야 한다.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-moment-"));
const UDID = "D21A6DEC-41A5-4996-9A40-DF2BF656FF4A";
const el = (label, y) => ({ type: "StaticText", AXLabel: label, frame: { x: 10, y, width: 200, height: 40 } });
const appEl = { type: "Application", AXLabel: "앱", frame: { x: 0, y: 0, width: 402, height: 874 } };
const base = [appEl, el("홈", 100)];
const scenes = [
  base,                                                   // 조작 전 화면
  base, base,                                             // 조작 직후, 알림 뜨기 전
  [...base, el("오늘 출석하기 완료!\n주사위 +1개", 300)],   // 알림
  [...base, el("오늘 출석하기 완료!\n주사위 +1개", 300)],
  [...base, el("포인트 획득 완료!\n2P", 300)],             // 같은 자리에 잇따라 뜨는 두 번째 알림
  [...base, el("포인트 획득 완료!\n2P", 300)],
  base,                                                   // 알림 사라짐
  [appEl, el("홈 2", 100)],                               // 같은 자리 글자만 바뀜(수량 갱신)
  base,
  [...base, el("가", 400), el("나", 440), el("다", 480), el("라", 520)], // 화면 전환 묶음
  base,
];
fs.writeFileSync(path.join(dir, "scenes.json"), JSON.stringify(scenes));
fs.writeFileSync(path.join(dir, "n"), "0");
const fake = path.join(dir, "idb");
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const d = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
if (a[0] === "ui" && a[1] === "describe-all") {
  const s = JSON.parse(fs.readFileSync(path.join(d, "scenes.json"), "utf8"));
  const n = Number(fs.readFileSync(path.join(d, "n"), "utf8"));
  fs.writeFileSync(path.join(d, "n"), String(n + 1));
  process.stdout.write(JSON.stringify(s[Math.min(n, s.length - 1)]));
} else if (a[0] === "screenshot") {
  fs.writeFileSync(a[a.length - 1], Buffer.from("89504e470d0a1a0a", "hex"));
}
`);
fs.chmodSync(fake, 0o755);
process.env.IRIS_IDB = fake;
process.env.IRIS_STATE_DIR = path.join(dir, "state");

test("조작 뒤 잠깐 떴다 사라진 알림만 장부에 싣고 다음 앱 도구 결과에 얹는다", async () => {
  const { createAppSurface } = await import("../bin/mcp/app.mjs");
  const journaled = [];
  const surface = createAppSurface({
    currentSession: async () => "s",
    journal: async (ev) => { journaled.push(ev); return { shot: ev.shot, call_id: "c1" }; },
    addReceipt: () => ({ id: "r1" }),
    call: async (cmd) => cmd === "app-targets-get" ? { ok: true, data: { devices: [UDID] } }
      : cmd === "app-devices" ? { ok: true, data: { tabs: [{ udid: UDID, name: "iPhone", mine: true }] } }
      : { ok: true, data: {} },
  });
  const tool = (n) => surface.tools.find((t) => t.name === n);
  const tapped = await tool("app_tap").run({ x: 10, y: 10 });
  assert.equal(tapped.ok, true);
  // 감시가 준비한 화면을 다 읽을 때까지 기다린다(가짜 idb 는 곧바로 답한다).
  for (let i = 0; i < 200 && Number(fs.readFileSync(path.join(dir, "n"), "utf8")) < scenes.length + 1; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  // 다음 조작이 감시를 끝낸다. 그 결과에 앞선 감시가 찾은 알림이 함께 온다.
  const next = await tool("app_tap").run({ x: 20, y: 20 });
  const moments = journaled.filter((e) => e.source === "moment");
  assert.equal(moments.length, 2, "잇따라 뜬 알림 둘 다 실린다 — 글자 변화와 화면 전환 묶음은 빠진다");
  assert.match(moments[0].caption, /오늘 출석하기 완료!/);
  assert.match(moments[1].caption, /포인트 획득 완료!/);
  assert.ok(moments[0].shot && fs.existsSync(moments[0].shot), "뜬 순간의 장면이 있다");
  assert.equal(next.data.moments.length, 2);
  assert.equal(next.data.moments[0].journaled, true);
});
