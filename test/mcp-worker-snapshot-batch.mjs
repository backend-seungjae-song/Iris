import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import test from "node:test";

import { buildSnapshot } from "../server/mcp-worker/snapshot-engine.js";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
// 묶기 전 엔진(요소별 순차 호출)과 결과 대조
const { buildSnapshot: legacyBuildSnapshot } = require("../native/electron/snapshot-engine.cjs");

const MANY = `<!doctype html><html lang="ko"><body><main><h1>많은 클릭 요소</h1>
<h2 tabindex="0" style="cursor:pointer">트리에 이미 있는 제목</h2><div tabindex="0" onclick="1">포커스 가능</div>
<button>일반 버튼</button><a href="#x">링크</a>
${Array.from({ length: 70 }, (_, i) => `<div style="cursor:pointer">클릭 ${i}</div>`).join("")}
</main></body></html>`;
const FEW = `<!doctype html><html><body><main><div onclick="1">하나</div><span style="cursor:pointer">둘</span><div style="cursor:pointer"></div></main></body></html>`;
const NONE = `<!doctype html><html><body><main><button>버튼만</button></main></body></html>`;

const serve = (html) => new Promise((resolve) => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  server.listen(0, "127.0.0.1", () => resolve(server));
});

// 왕복 수 세기 · 묶음은 1회 · fail 로 호출 순번별 실패 주입
function makeSend(session, { batch = true, failBatch = false, failDescribeNth = 0, batchCommandFailures = false } = {}) {
  const counts = { trips: 0, batches: 0, describe: 0 };
  const run = async (method, params) => {
    if (method === "DOM.describeNode") {
      counts.describe += 1;
      if (counts.describe === failDescribeNth) throw new Error("describeNode 실패 주입");
    }
    return session.send(method, params || {});
  };
  const send = async (method, params) => { counts.trips += 1; return run(method, params); };
  if (batch) {
    send.batch = async (commands) => {
      counts.trips += 1; counts.batches += 1;
      if (failBatch) throw new Error("batch 실패 주입");
      const results = [];
      for (const c of commands) results.push(await session.send(c.method, c.params || {}));
      return { results };
    };
  }
  return { send, counts };
}

const OPTIONS = [{}, { budget: 700 }, { budget: 700, cursor: 20 }, { role: "clickable" }, { name: "클릭 6" }];
const plain = (s) => ({ ...s, refMap: [...s.refMap] });

test("cursor 요소 해석을 묶어도 snapshot 출력이 순차 경로와 같다 · 왕복 수가 줄고 · 묶음 실패는 하나씩 대체한다", async (t) => {
  const servers = { many: await serve(MANY), few: await serve(FEW), none: await serve(NONE) };
  const browser = await puppeteer.launch(headlessLaunchOptions());
  t.after(async () => { await browser.close(); for (const s of Object.values(servers)) s.close(); });

  const sessions = {};
  for (const [name, server] of Object.entries(servers)) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
    sessions[name] = await page.createCDPSession();
  }

  for (const [name, session] of Object.entries(sessions)) {
    for (const options of OPTIONS) {
      const label = `${name} ${JSON.stringify(options)}`;
      const legacy = makeSend(session, { batch: false });
      const expected = plain(await legacyBuildSnapshot(legacy.send, options));
      const fast = makeSend(session);
      assert.deepEqual(plain(await buildSnapshot(fast.send, options)), expected, `묶음 ${label}`);
      const failed = makeSend(session, { failBatch: true });
      assert.deepEqual(plain(await buildSnapshot(failed.send, options)), expected, `묶음 실패 대체 ${label}`);
      const noBatch = makeSend(session, { batch: false });
      assert.deepEqual(plain(await buildSnapshot(noBatch.send, options)), expected, `batch 없음 ${label}`);
    }
  }

  // 전제: many 는 50개 상한에 걸림
  const base = plain(await buildSnapshot(makeSend(sessions.many).send, {}));
  const clickable = base.snapshot.split("\n").filter((l) => l.includes("clickable"));
  // 상한 50개가 모두 해석되면 49~50, 트리와 겹친 제목은 빠짐
  assert.ok(clickable.length >= 45 && clickable.length < 50, `clickable ${clickable.length}`);
  assert.ok(!clickable.some((l) => l.includes("트리에 이미 있는 제목")));

  // 왕복 수: 순차 경로는 요소 수의 2배 이상, 묶음 경로는 열 번 이하
  const legacyMany = makeSend(sessions.many, { batch: false });
  await buildSnapshot(legacyMany.send, {});
  const fastMany = makeSend(sessions.many);
  await buildSnapshot(fastMany.send, {});
  assert.ok(legacyMany.counts.trips >= 100, `순차 ${legacyMany.counts.trips}`);
  assert.ok(fastMany.counts.trips <= 10 && fastMany.counts.batches === 1, `묶음 ${fastMany.counts.trips} 왕복 / ${fastMany.counts.batches} 묶음`);

  // 요소 하나의 describeNode 실패: 건너뛰고 나머지를 계속(순차 · 묶음 실패 뒤 대체 둘 다 같은 결과)
  for (const nth of [2, 3, 50]) {
    const expected = plain(await legacyBuildSnapshot(makeSend(sessions.many, { batch: false, failDescribeNth: nth }).send, {}));
    assert.notDeepEqual(expected.snapshot, base.snapshot, `실패 주입 ${nth} 이 결과를 바꿔야 비교가 의미 있다`);
    const viaFallback = plain(await buildSnapshot(makeSend(sessions.many, { failBatch: true, failDescribeNth: nth }).send, {}));
    assert.deepEqual(viaFallback, expected, `묶음 실패 + describeNode ${nth}번째 실패`);
  }

  // 요소가 없는 페이지는 묶음을 보내지 않음
  const none = makeSend(sessions.none);
  await buildSnapshot(none.send, {});
  assert.equal(none.counts.batches, 0);
});
