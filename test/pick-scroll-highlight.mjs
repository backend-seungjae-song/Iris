import test from "node:test";
import assert from "node:assert/strict";
import { withWebPage, overrideFromEnv } from "./lib/web-page.mjs";

// PICK_SRC: 고치기 전 판의 pick-host.js 로 같은 검사를 돌릴 때
const overrides = overrideFromEnv({ PICK_SRC: "/js/browser/pick-host.js" });

const rows = Array.from({ length: 80 }, (_, i) => `<div id="r${i}" style="height:40px">줄 ${i}</div>`).join("")
  + `<div id="box" style="position:fixed;left:0;top:0;width:300px;height:200px;overflow:auto">`
  + Array.from({ length: 40 }, (_, i) => `<div id="b${i}" style="height:30px">칸 ${i}</div>`).join("") + `</div>`;

// 앱은 커서 좌표가 그대로면 페이지에 좌표를 다시 보내지 않고, 스크롤은 mousemove 를 만들지 않음
// 스크롤 거리는 줄 높이의 배수가 아니게: 배수면 옛 상자가 우연히 새 줄과 겹침
const run = (scroll) => withWebPage(async (page) => {
  await page.setViewport({ width: 800, height: 600 });
  const ORCA = await page.evaluate(async () => (await import("/js/browser/pick-host.js")).ORCA_INJECT);
  await page.evaluate((s) => {
    window.__orcaDesired = true; (0, eval)(s);
    window.__picked = null;
    window.addEventListener("message", (e) => { if (e.data && e.data.__orca === "pick") window.__picked = e.data.pick.selector; });
  }, ORCA);
  const at = scroll === "page" ? { x: 500, y: 300 } : { x: 100, y: 100 };
  // 앱 경로: OS 커서 좌표를 메시지로 받음
  await page.evaluate((p) => window.postMessage({ __orcaHover: p }, "*"), at);
  await new Promise((r) => setTimeout(r, 100));
  await page.evaluate((s) => { if (s === "page") window.scrollBy(0, 415); else document.getElementById("box").scrollTop = 310; }, scroll);
  await new Promise((r) => setTimeout(r, 300));
  const box = await page.evaluate((p) => {
    const hl = [...document.documentElement.children].find((n) => n.style && n.style.zIndex === "2147483647" && n.style.border);
    const r = hl.getBoundingClientRect();
    const under = document.elementFromPoint(p.x, p.y);
    const u = under.getBoundingClientRect();
    return { under: under.id, hlTop: Math.round(r.top), underTop: Math.round(u.top) };
  }, at);
  await page.mouse.click(at.x, at.y);
  await new Promise((r) => setTimeout(r, 100));
  return { ...box, picked: await page.evaluate(() => window.__picked) };
}, { body: rows, overrides });

test("요소 선택 강조 상자는 페이지를 스크롤해도 커서 아래 요소를 따라감", async () => {
  const r = await run("page");
  assert.equal(r.hlTop, r.underTop, `커서 아래 ${r.under} 와 강조 상자 위치가 같아야 함`);
  assert.equal(r.picked, "#" + r.under, "누르면 커서 아래 요소를 고름");
});

test("요소 선택 강조 상자는 안쪽 스크롤 영역을 스크롤해도 커서 아래 요소를 따라감", async () => {
  const r = await run("inner");
  assert.equal(r.hlTop, r.underTop, `커서 아래 ${r.under} 와 강조 상자 위치가 같아야 함`);
  assert.equal(r.picked, "#" + r.under, "누르면 커서 아래 요소를 고름");
});
