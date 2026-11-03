import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import test from "node:test";

import { buildSnapshot } from "../server/mcp-worker/snapshot-engine.js";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { pruneAxNodes } = require("../native/electron/ax-prune.cjs");

// 줄이지 않은 트리와 줄인 트리로 만든 snapshot 출력이 같은지 실제 Chromium 페이지로 대조
const MAIN = `<!doctype html><html lang="ko"><body>
<header><a href="#h">홈</a><nav aria-label="주 메뉴"><a href="#a">소개</a><a href="#b">소개</a></nav></header>
<main><h1>주문서</h1><h2><a href="#t">제목 링크</a></h2>
<form aria-label="주문"><label>이메일 <input type="email"></label><label>동의 <input type="checkbox" disabled></label>
<select aria-label="수량"><option>1</option><option>2</option></select><button>저장</button><button>저장</button><button disabled>잠김</button></form>
<div role="alert">오류가 있습니다</div><div role="status">처리 중</div>
<div onclick="1" style="cursor:pointer">더보기</div><div tabindex="0">포커스 가능</div><span role="presentation">장식</span>
<p>안내 <b>문구</b></p><div aria-hidden="true"><button>숨김</button></div><div hidden><button>보이지 않음</button></div>
<ul>${Array.from({ length: 120 }, (_, i) => `<li><a href="#i${i}">항목 ${i % 7}</a></li>`).join("")}</ul></main>
<footer>끝</footer></body></html>`;

const serve = (html) => new Promise((resolve) => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  server.listen(0, "127.0.0.1", () => resolve(server));
});

// 대조 질의: 기본 · 작은 예산(잘림·cursor) · 이어보기 · role/name/region 질의
const OPTIONS = [{}, { budget: 700 }, { budget: 700, cursor: 20 }, { role: "button", name: "저장" }, { region: "주 메뉴" }];

async function treeSend(session, { prune }) {
  return async (method, params) => {
    const result = await session.send(method, params || {});
    if (prune && method === "Accessibility.getFullAXTree") return JSON.parse(JSON.stringify({ nodes: pruneAxNodes(result.nodes) }));
    return result;
  };
}

async function compare(session, frameSessions, label) {
  const sizes = { full: 0, pruned: 0 };
  for (const options of OPTIONS) {
    const out = {};
    for (const prune of [false, true]) {
      const send = await treeSend(session, { prune });
      const frames = [];
      for (const [sid, frameSession] of frameSessions) frames.push({ sid, send: await treeSend(frameSession, { prune }) });
      const snapshot = await buildSnapshot(send, { ...options, frames });
      out[prune ? "pruned" : "full"] = { ...snapshot, refMap: [...snapshot.refMap] };
    }
    assert.deepEqual(out.pruned, out.full, `${label} ${JSON.stringify(options)}`);
    assert.ok(out.full.refMap.length > 0, `${label}: ref 가 있어야 비교가 의미 있다`);
  }
  const raw = await session.send("Accessibility.getFullAXTree");
  sizes.full = JSON.stringify(raw).length;
  sizes.pruned = JSON.stringify({ nodes: pruneAxNodes(raw.nodes) }).length;
  assert.ok(sizes.pruned < sizes.full, `${label}: 줄인 쪽이 작아야 한다`);
}

test("실제 Chromium 페이지: 줄인 트리로 만든 snapshot 출력이 줄이지 않은 트리와 같다(일반·질의·잘림·교차 출처 iframe)", async (t) => {
  const inner = await serve(`<!doctype html><html><body><button>결제하기</button><input aria-label="카드"><a href="#x">약관</a><div role="alert">카드 오류</div></body></html>`);
  const outer = await serve(`<!doctype html><html><body><h1>프레임 페이지</h1><button>바깥 버튼</button>
    <iframe title="결제" src="http://localhost:${inner.address().port}/"></iframe>
    <iframe title="같은 출처" srcdoc="<button>안쪽 같은 출처</button>"></iframe></body></html>`);
  const plain = await serve(MAIN);
  const base = headlessLaunchOptions();
  const browser = await puppeteer.launch({ ...base, args: [...(base.args || []), "--site-per-process"] });
  t.after(async () => { await browser.close(); inner.close(); outer.close(); plain.close(); });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${plain.address().port}/`, { waitUntil: "load" });
  const plainSession = await page.createCDPSession();
  await plainSession.send("Accessibility.enable");
  await compare(plainSession, [], "일반 페이지");

  const framed = await browser.newPage();
  await framed.goto(`http://127.0.0.1:${outer.address().port}/`, { waitUntil: "load" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const frameTargets = browser.targets().filter((target) => target.type() !== "page" && target.type() !== "browser" && target.url().startsWith("http://localhost:"))  // puppeteer 는 OOPIF 를 other 로 표시;
  assert.ok(frameTargets.length >= 1, "교차 출처 iframe 이 별도 타깃으로 떠야 한다");
  const frameSessions = [];
  for (const target of frameTargets) frameSessions.push([`f${frameSessions.length + 1}`, await target.createCDPSession()]);
  const framedSession = await framed.createCDPSession();
  await framedSession.send("Accessibility.enable");
  await compare(framedSession, frameSessions, "iframe 페이지");
  const snapshot = await buildSnapshot(await treeSend(framedSession, { prune: true }), {
    frames: await Promise.all(frameSessions.map(async ([sid, session]) => ({ sid, send: await treeSend(session, { prune: true }) }))) });
  assert.ok([...snapshot.refMap.values()].some((entry) => entry.sid), "iframe 안 요소가 sid 와 함께 있어야 한다");
  assert.match(snapshot.snapshot, /결제하기/);
});

// backendDOMNodeId 가 없는 상호작용 노드는 focusable 속성 하나로 ref 여부가 갈린다 (실제 페이지에서는 거의 안 나오는 경우)
test("합성 트리: focusable 속성·ignored·중첩 childIds 가 줄인 뒤에도 같은 출력을 낸다", async () => {
  const prop = (name, value) => ({ name, value: { type: "booleanOrUndefined", value } });
  const node = (nodeId, role, name, extra = {}) => ({ nodeId, role: { type: "role", value: role }, name: { type: "computedString", value: name, sources: [{ type: "x" }] }, ...extra });
  const nodes = [
    node("1", "RootWebArea", "문서", { childIds: ["2", "3", "4", "5", "6", "7"], frameId: "F" }),
    node("2", "button", "초점 가능", { properties: [prop("invalid", false), prop("focusable", true)] }),
    node("3", "button", "초점 없음", { properties: [prop("focusable", false), prop("focusable", true)] }),
    node("4", "button", "속성 없음"),
    node("5", "link", "속성 목록 있음", { properties: [prop("url", true)] }),
    { nodeId: "6", ignored: true, ignoredReasons: [{ name: "x" }], childIds: ["8"] },
    node("7", "main", "", { childIds: ["9"], backendDOMNodeId: 70 }),
    node("8", "textbox", "무시된 부모 아래", { backendDOMNodeId: 80, properties: [prop("focusable", true)] }),
    node("9", "heading", "제목", { childIds: ["10"] }),
    node("10", "link", "제목 링크", { backendDOMNodeId: 100 }),
  ];
  const send = (prune) => async (method) => {
    if (method === "Accessibility.getFullAXTree") return JSON.parse(JSON.stringify({ nodes: prune ? pruneAxNodes(nodes) : nodes }));
    if (method === "Runtime.evaluate") return { result: { value: "[]" } };
    return {};
  };
  const full = await buildSnapshot(send(false), {});
  const pruned = await buildSnapshot(send(true), {});
  assert.deepEqual({ ...pruned, refMap: [...pruned.refMap] }, { ...full, refMap: [...full.refMap] });
  assert.match(full.snapshot, /초점 가능/);
  assert.doesNotMatch(full.snapshot, /\[@e\d+\] button "초점 없음"/);
  assert.match(full.snapshot, /무시된 부모 아래/);
});
