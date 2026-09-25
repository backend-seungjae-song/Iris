import assert from "node:assert/strict";
import test from "node:test";

import { initArchive, arTailView } from "../web/js/devtool/archive.js";

// 보관함 검색이 마지막 화면 내용에서 걸렸을 때의 미리보기. 원문에서 일치 구간을 찾고 조각마다
// 이스케이프해야 < · & 검색이 맞게 강조되고, 엔티티(&lt; · &amp;) 안이 걸리지 않는다.
const esc = (s) => (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
initArchive({ $: () => null, esc, wsSend() {}, showToast() {} });
const view = (tail, q, open = false) => arTailView({ tail }, q, true, open).replace(/^<div class="ar-tail[^"]*">|<\/div>$/g, "");
const firstLine = (html) => html.split("\n")[0];

test("< 로 검색하면 원문의 < 가 강조된다", () => {
  assert.equal(view("a < b", "<"), "a <mark>&lt;</mark> b");
});

test("& 로 검색해도 이스케이프 결과(&lt;)가 쪼개지지 않는다", () => {
  assert.equal(view("x & y < z", "&"), "x <mark>&amp;</mark> y &lt; z");
});

test("amp 로 검색하면 원문의 & 는 걸리지 않는다", () => {
  assert.equal(view("a & b amp", "amp"), "a &amp; b <mark>amp</mark>");
});

test("<>& 가 섞인 검색어도 한 구간으로 강조한다", () => {
  assert.equal(view("if (a<>&b) {}", "<>&"), "if (a<mark>&lt;&gt;&amp;</mark>b) {}");
});

test("한글과 대소문자", () => {
  assert.equal(view("빌드 Error 발생", "error"), "빌드 <mark>Error</mark> 발생");
  assert.equal(view("배포가 끝났습니다", "끝났"), "배포가 <mark>끝났</mark>습니다");
});

test("긴 앞 줄이 있어도 걸린 줄이 첫 줄로 온다", () => {
  const html = view("x".repeat(2000) + "\n빌드 실패: needle\n다음 줄", "needle");
  assert.match(firstLine(html), /<mark>needle<\/mark>/);
  assert.ok(!html.includes("xxxx"));
});

test("걸린 줄의 앞문맥이 길면 적중 바로 앞에서 자른다", () => {
  const html = view("y".repeat(2000) + "needle" + "z".repeat(500), "needle");
  const pre = firstLine(html).split("<mark>")[0];
  assert.ok(pre.startsWith("…"));
  assert.ok(pre.length <= 41 + 1, `앞문맥 ${pre.length}자`);
  assert.match(html, /<mark>needle<\/mark>z/);
});

test("앞문맥이 짧으면 자르지 않고 뒤 두 줄까지 붙인다", () => {
  assert.equal(view("a needle b\nc\nd\ne", "needle"), "a <mark>needle</mark> b\nc\nd");
});

test("펼친 미리보기는 전체 원문을 이스케이프하고 모두 강조한다", () => {
  const html = view("<a>\n" + "q".repeat(100) + " <\n끝 <", "<", true);
  assert.equal(html.match(/<mark>/g).length, 3);
  assert.ok(html.startsWith("<mark>&lt;</mark>a&gt;\n"));
});
