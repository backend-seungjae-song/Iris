// 장부 회차의 기본 지면. 개발자가 아닌 사람이 이 페이지만 보고 확인 결과를 다시 판정한다.
//
// 소유 범위
//   장부 회차의 report.html 화면. 줄마다 흐름(화면 > 행동 > 결과), 색 판정, 결과 줄, 장면.
//
// 제공 API
//   renderPlain. report.mjs 의 buildReport 가 장부를 읽은 뒤 부른다.
//
// 의존 대상
//   부르는 쪽이 넘기는 도구 묶음(h)과 장부(led)뿐이다. 파일 보존·장면 삽입·색 표는 report.mjs 가 소유한다.
//
// 유지 조건
//   확인 기록 번호·선택자·주소·코드 경로·조건 원문을 싣지 않는다. 그것들은 같은 폴더의
//   report-dev.html 이 그대로 싣는다. 이 지면은 장부의 글을 고치지 않고 고르기만 한다.
//
// 영향 범위
//   bin/smoke/sections/qa-report-page.mjs 가 렌더 결과를 검사한다.

import { checkLanes, lanesSvg } from "./report-lanes.mjs";

// 판정 색 이름. 개발자 지면과 뜻은 같고 이름만 읽는 사람의 말로 적는다.
const PLAIN = {
  red: "실패", orange: "사용 불편", yellow: "개선 권장",
  blue: "결정 대기", gray: "미확인", green: "통과",
};
const BASIS_PLAIN = { spec: "명세", plan: "기획서", code: "기존 구현", user: "사용자 결정", assumed: "확인자 판단" };

// 장부 글에 줄바꿈이 문자 그대로(\n) 들어간 옛 기록도 줄로 나눈다.
const splitLines = (t) => String(t || "").split(/\n|\\n/).map((x) => x.trim()).filter(Boolean);

// 확인 한 건을 선택자 없이 적는다. 대상은 확인할 때 붙인 이름, 없으면 기대 문구로 대신한다.
const MODE_WANT = { equals: "일치", contains: "포함", absent: "없음", exists: "있음" };
function checkText(x) {
  const w = x.want != null && String(x.want) !== "" ? `'${String(x.want)}'` : "";
  const target = x.label ? String(x.label) : x.element ? String(x.element) : "";
  // 글자 없이 있음·없음만 본 확인은 "화면에 있음·없음"으로 적는다.
  const want = w ? `${w} ${MODE_WANT[x.mode] || "확인"}` : x.mode === "absent" ? "화면에 없음" : "화면에 있음";
  // 실제값은 통과하면 기대값이 곧 사실이라 싣지 않는다. 실패했을 때만 무엇이 나왔는지 적는다.
  const got = x.pass ? "" : x.got == null || String(x.got) === "" ? (x.found === false ? "대상을 못 찾음" : "")
    : String(x.got);
  return { target, want, got, pass: !!x.pass };
}

// 설명을 달아 찍은 장면과 판정 순간의 장면을 찍은 순서대로 모두 싣는다. 무효로 돌린 판정의
// 장면은 증거가 아니므로 뺀다. 둘 다 없으면 시작과 끝 화면. 읽을 수 없을 만큼 작은 그림은 뺀다.
function pickScenes(ln, h, voidShots) {
  // 읽을 수 없을 만큼 작은 그림은 고르기 전에 뺀다. 고른 뒤에 빼면 대신 설 장면이 없다.
  const usable = (f) => { const d = h.pngSize(f.path); return !d || (d.w >= TINY && d.h >= TINY); };
  const live = (ln.frames || []).filter((f) => !h.frameStale(f) && !voidShots.has(f.path) && usable(f));
  const byShot = new Map((ln.receipts || []).filter((x) => x.shot).map((x) => [x.shot, x]));
  const chosen = live.filter((f) => f.why === "찍음" || (f.why === "판정" && byShot.has(f.path)));
  const pool = chosen.length ? chosen
    : live.length > 1 ? [live[0], live[live.length - 1]] : live;
  return pool.map((f, k) => {
    if (f.why === "찍음") return { f, band: String(f.caption || "설명 없음"), bad: false };
    const x = byShot.get(f.path);
    if (x) {
      const c = checkText(x);
      return { f, bad: !c.pass, band: `${c.target ? c.target + " · " : ""}${c.want}${
        c.got ? ` · 실제값 '${c.got.slice(0, 80)}'` : ""} → ${c.pass ? "통과" : "실패"}` };
    }
    return { f, band: k ? "끝 화면" : "시작 화면", bad: false };
  });
}

const TINY = 64;
// 장면은 한 자리에 한 장씩 크게 싣고 넘긴다. 나란히 늘어놓으면 한 장이 작아져 글자를 못 읽는다.
function carouselHtml(dir, key, all, h) {
  let lost = 0, tiny = 0;
  const scenes = all.map((s, k) => {
    const kept = h.keepShot(dir, s.f.path, `plain-${key}-${String(k + 1).padStart(2, "0")}`);
    const size = kept && h.pngSize(kept);
    if (size && (size.w < TINY || size.h < TINY)) { tiny += 1; return null; }
    const src = kept && h.dataUri(kept);
    if (!src) { lost += 1; return null; }
    return { ...s, src, marks: h.readMarks(kept) };
  }).filter(Boolean);
  const gone = [lost ? `파일 유실 장면 ${lost}장` : "", tiny ? `판독 불가 크기 장면 ${tiny}장 제외` : ""].filter(Boolean);
  if (!scenes.length) return { html: "", gone };
  const n = scenes.length;
  return { gone, html: `<div class="car" aria-roledescription="캐러셀" aria-label="장면 ${n}장">
    <div class="view">${scenes.map((s, k) => `<figure class="sc${k ? "" : " on"}${s.bad ? " bad" : ""}"${k ? " hidden" : ""}>
      <button type="button" class="shot" aria-label="장면 ${k + 1} 크게 보기"><span class="frame"><img src="${s.src}" alt="${h.esc(s.band)}">${
        h.boxesOf({ marks: s.marks })}</span></button>
      <figcaption aria-live="polite"><b>${k + 1}/${n}</b><span>${h.esc(s.band)}</span></figcaption></figure>`).join("")}
      ${n > 1 ? `<button type="button" class="arw prev" aria-label="이전 장면">‹</button><button type="button" class="arw next" aria-label="다음 장면">›</button>` : ""}</div>
    ${n > 1 ? `<ol class="thumbs">${scenes.map((s, k) => `<li><button type="button" class="th${k ? "" : " on"}${s.bad ? " bad" : ""}" data-i="${k}"${
      k ? "" : ' aria-current="true"'} aria-label="장면 ${k + 1}: ${h.esc(s.band.slice(0, 60))}"><img alt=""><b>${k + 1}</b></button></li>`).join("")}</ol>` : ""}</div>` };
}

function linesHtml(note, h, cls = "result") {
  const xs = splitLines(note);
  return xs.length ? `<ul class="${cls}">${xs.map((x) => `<li>${h.esc(x)}</li>`).join("")}</ul>` : "";
}

function flowHtml(what, h) {
  const parts = String(what || "").split(/\s*>\s*/).map((x) => x.trim()).filter(Boolean);
  return `<ol class="flow">${parts.map((x) => `<li>${h.esc(x)}</li>`).join("")}</ol>`;
}

function laneHtml(dir, r, ln, many, h, voidShots) {
  const lc = ln.color || "gray";
  const checks = (ln.receipts || []).map(checkText);
  const stale = (ln.frames || []).filter((f) => h.frameStale(f)).length;
  const voids = ln.voids || [];
  const aside = ln.aside || [];
  const car = carouselHtml(dir, `${r.id}-${ln.path}`, pickScenes(ln, h, voidShots), h);
  const tiny = (ln.frames || []).filter((f) => {
    if (f.why !== "찍음" && f.why !== "판정") return false;
    const d = h.pngSize(f.path); return !!d && (d.w < TINY || d.h < TINY);
  }).length;
  const why = (x) => (x.why ? ` · 사유 ${x.why}` : "");
  const out = [
    ...voids.map((v) => `잘못 설정한 확인 제외${why(v)}`),
    ...aside.map((a) => `증거에서 제외한 장면${why(a)}`),
    stale ? `촬영 시각 불일치 장면 ${stale}장 제외` : "",
    tiny ? `판독 불가 크기 장면 ${tiny}장 제외` : "",
    ...car.gone,
  ].filter(Boolean);
  const picks = Array.isArray(ln.options) ? ln.options : [];
  const info = `<div class="info">
    ${many ? `<h3>${h.esc(ln.path)} 경로 <span class="chip ${lc}">${PLAIN[lc]}</span></h3>` : ""}
    <section><h4>결과</h4>${linesHtml(ln.note, h) || `<p class="none">${ln.color ? "결과 기록 없음" : "미확인"}</p>`}</section>
    ${checks.length ? `<section><h4>확인 ${checks.length}건 · 통과 ${checks.filter((c) => c.pass).length}건</h4><ul class="checks">${
      checks.map((c) => `<li class="${c.pass ? "ok" : "no"}"><b>${c.pass ? "통과" : "실패"}</b><span>${
        c.target ? `<em>${h.esc(c.target)}</em>` : ""}${h.esc(c.want)}${
        c.got ? `<small title="${h.esc(c.got)}">실제값 ${h.esc(c.got)}</small>` : ""}</span></li>`).join("")}</ul></section>` : ""}
    ${picks.length || ln.lean ? `<section class="ask"><h4>선택지</h4>${picks.length ? `<ol class="picks">${picks.map((o) => `<li><b>${h.esc(o.pick)}</b>${
      o.then ? `<span>선택 시 ${h.esc(o.then)}</span>` : ""}${o.cost ? `<span>감수할 점 ${h.esc(o.cost)}</span>` : ""}</li>`).join("")}</ol>` : ""}${
      ln.lean ? `<p class="lean">확인자 의견 ${h.esc(ln.lean)}</p>` : ""}</section>` : ""}
    ${out.length ? `<p class="warn">${out.map(h.esc).join("<br>")}</p>` : ""}</div>`;
  return `<div class="lane${car.html ? "" : " noscene"}">${car.html}${info}</div>`;
}

// 장부의 줄 번호(W1·A1)는 확인자가 붙인 약어라 읽는 사람이 뜻을 모른다. 기본 지면은 순서대로
// Case 1, Case 2로 부르고 장부 번호는 개발자 지면에만 둔다.
function rowHtml(dir, r, i, h, voidShots, reqsOf = new Map(), featNames = []) {
  const c = h.rowColor(r);
  const lanes = r.paths.map((p) => r.lanes.get(p) || { path: p, frames: [], receipts: [] });
  const basis = BASIS_PLAIN[r.basis];
  const quotes = r.quotes && r.quotes.length ? r.quotes : r.quote ? [r.quote] : [];
  const srcShot = r.sourceShot ? h.keepShot(dir, r.sourceShot, `plain-basis-${r.id}`) : null;
  const srcUri = srcShot && h.dataUri(srcShot);
  const srcLost = r.sourceShot && !srcUri;
  return `<article id="w${i + 1}" class="row ${c}">
    <header><span class="id">Case ${i + 1}</span><span class="chip ${c}">${PLAIN[c]}</span>${
      (reqsOf.get(String(r.id)) || []).map((k) => `<a class="reqlink" href="#q${k}">${h.esc(featNames[k - 1] || `기능 ${k}`)}</a>`).join("")}</header>
    ${flowHtml(r.what, h)}
    <dl class="meta">${r.given ? `<div><dt>조건</dt><dd>${h.esc(r.given)}</dd></div>` : ""}${
      basis ? `<div><dt>기대 근거</dt><dd>${basis}${r.basisNote ? ` · ${h.esc(r.basisNote)}` : ""}</dd></div>` : ""}</dl>
    ${quotes.length || srcUri ? `<div class="quote">${quotes.map((q) => `<blockquote>${h.esc(String(q))}</blockquote>`).join("")}${
      srcUri ? `<button type="button" class="shot src" aria-label="근거 화면 크게 보기"><span class="frame"><img src="${srcUri}" alt="근거 화면"></span></button>` : ""}</div>` : ""}
    ${srcLost ? `<p class="warn">근거 화면 파일 유실</p>` : ""}
    ${lanes.map((ln) => laneHtml(dir, r, ln, lanes.length > 1, h, voidShots)).join("")}</article>`;
}

function noteHtml(dir, nt, h) {
  const shot = nt.shot ? h.keepShot(dir, nt.shot, "plain-note-" + nt.id) : null;
  const src = shot && h.dataUri(shot);
  const picks = Array.isArray(nt.options) ? nt.options : [];
  return `<article class="row blue decide">
    <header><span class="chip blue">결정 대기</span></header>
    <p class="q">${h.esc(nt.decide || "")}</p>
    ${linesHtml(nt.what, h)}${nt.why ? linesHtml(nt.why, h) : ""}
    ${src ? `<div class="car"><div class="view"><figure class="sc on"><button type="button" class="shot" aria-label="크게 보기"><span class="frame"><img src="${src}" alt="당시 화면"></span></button><figcaption><b>1/1</b><span>당시 화면</span></figcaption></figure></div></div>` : ""}
    ${picks.length ? `<ol class="picks">${picks.map((o) => `<li><b>${h.esc(o.pick)}</b>${
      o.then ? `<span>선택 시 ${h.esc(o.then)}</span>` : ""}${o.cost ? `<span>감수할 점 ${h.esc(o.cost)}</span>` : ""}</li>`).join("")}</ol>` : ""}</article>`;
}

// 맨 위는 기능 추적표다. 사용자의 최종 요구를 기능 단위로 종합하고, 확인자가 그것을 어떻게
// 이해해서 무엇을 만들었는지, 어느 케이스가 스크린샷으로 확인했는지를 기능 한 줄로 잇는다.
// 이 보고서 한 장으로 요구·이해·구현·검증을 대조하려는 것이다. 요청 발화를 하나씩 늘어놓지 않는다.
// 기능 안에서 케이스가 없는 부분은 "확인 빈 곳"으로 그 자리에 드러낸다.
function asLines(v) {
  return (Array.isArray(v) ? v : splitLines(v)).map((x) => String(x).trim()).filter(Boolean);
}
function featuresHtml(features, caseOf, h) {
  const list = (Array.isArray(features) ? features : []).filter((q) => q && (q.name || q.need || q.built));
  if (!list.length) return "";
  const linked = (q) => (Array.isArray(q.cases) ? q.cases : []).map((id) => caseOf.get(String(id))).filter(Boolean);
  const gapsOf = (q) => asLines(q.gaps);
  const withGap = list.filter((q) => !linked(q).length || gapsOf(q).length).length;
  return `<h2>기능과 구현 ${list.length}</h2>
  <p class="tally"><span class="chip gray">기능 ${list.length}</span>${
    withGap ? `<span class="chip yellow">확인 빈 곳이 있는 기능 ${withGap}</span>` : ""}</p>
  <ol class="req">${list.map((q, k) => {
    const cs = linked(q);
    const gaps = gapsOf(q);
    return `<li id="q${k + 1}">
    <div class="need"><h3>${h.esc(q.name || `기능 ${k + 1}`)}</h3><h4>최종 요구</h4>${linesHtml(asLines(q.need).join("\n"), h, "plain")}</div>
    <div><h4>AI 이해</h4>${linesHtml(asLines(q.understood).join("\n"), h, "plain")}</div>
    <div><h4>구현</h4>${linesHtml(asLines(q.built).join("\n"), h, "plain")}</div>
    <div class="cases"><h4>확인</h4>${cs.length
      ? cs.map((c) => `<a class="chip ${c.color}" href="#w${c.i + 1}">Case ${c.i + 1} ${PLAIN[c.color]}</a>`).join("")
      : `<span class="chip yellow">확인 케이스 없음</span>`}${
      gaps.length || (!cs.length && q.why) ? `<small class="gap">확인 빈 곳<br>${[...gaps, ...(!cs.length && q.why ? [q.why] : [])].map(h.esc).join("<br>")}</small>` : ""}</div></li>`;
  }).join("")}</ol>`;
}

// 역할별 흐름도. 역할은 제품마다 다르므로 부르는 쪽이 정한다.
function diagramsHtml(diagrams, h) {
  const list = Array.isArray(diagrams) ? diagrams : [];
  if (!list.length) return "";
  return `<h2>역할별 흐름</h2><div class="lanes-wrap">${list.map((d, k) => lanesSvg(d, k + 1, h.esc)).join("")}</div>`;
}

// 예전 형태(블록 목록)도 받는다. 블록마다 제목·흐름·사실 줄.
function blocksHtml(blocks, h) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && (b.title || b.flow || (b.lines || []).length));
  if (!list.length) return "";
  return `<div class="ov">${list.map((b) => `<section>
    ${b.title ? `<h3>${h.esc(b.title)}</h3>` : ""}${b.flow ? flowHtml(b.flow, h) : ""}${
      Array.isArray(b.lines) && b.lines.length ? `<ul>${b.lines.map((x) => `<li>${h.esc(x)}</li>`).join("")}</ul>` : ""}</section>`).join("")}</div>`;
}

function overviewHtml(overview, caseOf, h) {
  if (!overview) return "";
  if (Array.isArray(overview)) return overview.length ? `<h2>구현 내용</h2>${blocksHtml(overview, h)}` : "";
  return [featuresHtml(overview.features || overview.requests, caseOf, h), diagramsHtml(overview.diagrams, h),
    overview.blocks ? blocksHtml(overview.blocks, h) : "",
    asLines(overview.scope).length ? `<h2>이번 확인 범위</h2>${linesHtml(asLines(overview.scope).join("\n"), h, "plain")}` : ""].join("\n");
}

const hasOverview = (o) => (Array.isArray(o) ? o.length > 0 : !!(o && (o.features || o.requests || o.diagrams || o.blocks)));

function renderPlain({ title, summary, overview, led, dir, devHref }, h) {
  const diagrams = overview && !Array.isArray(overview) && Array.isArray(overview.diagrams) ? overview.diagrams : [];
  const problems = diagrams.flatMap((d, k) => checkLanes(d, k + 1));
  if (problems.length) throw new Error(`역할별 흐름도를 그릴 수 없음\n${problems.join("\n")}`);
  const rows = led.rows;
  const colorOf = rows.map((r) => h.rowColor(r));
  const caseOf = new Map(rows.map((r, i) => [String(r.id), { i, color: colorOf[i] }]));
  // 케이스에서 거꾸로 그 케이스가 확인한 요청으로 간다.
  const reqsOf = new Map();
  const featList = overview && !Array.isArray(overview) ? (overview.features || overview.requests || []) : [];
  (Array.isArray(featList) ? featList : []).filter((q) => q && (q.name || q.need || q.built)).forEach((q, k) => {
    for (const id of (Array.isArray(q.cases) ? q.cases : [])) {
      const key = String(id); if (!reqsOf.has(key)) reqsOf.set(key, []); reqsOf.get(key).push(k + 1);
    }
  });
  const count = {};
  for (const c of colorOf) count[c] = (count[c] || 0) + 1;
  const order = Object.keys(PLAIN).sort((a, b) => h.COLOR[a].rank - h.COLOR[b].rank);
  // 요약 한 줄은 줄의 색을 정한 경로(가장 나쁜 경로)의 결과다. 경로가 여럿이면 이름을 붙인다.
  const firstNote = (r) => {
    const lanes = r.paths.map((p) => r.lanes.get(p)).filter(Boolean);
    const rank = (ln) => (ln.color ? h.COLOR[ln.color].rank : 99);
    const ln = lanes.filter((x) => x.note).sort((a, b) => rank(a) - rank(b))[0];
    if (!ln) return "";
    const line = splitLines(ln.note)[0] || "";
    return r.paths.length > 1 ? `${ln.path} 경로: ${line}` : line;
  };
  const sorted = rows.map((r, i) => ({ r, i, c: colorOf[i] }))
    .sort((a, b) => h.COLOR[a.c].rank - h.COLOR[b.c].rank || a.i - b.i);
  // 무효로 돌린 판정이 남긴 장면. 장부는 판정만 빼고 장면은 남겨 두므로 여기서 거른다.
  const voidShots = new Set([...led.receipts.values()]
    .filter((x) => led.voided.has(String(x.id)) && x.shot).map((x) => x.shot));
  // 한 화면에서 전 줄을 훑는다. 급한 색이 위에 오고, 누르면 그 줄로 간다.
  const table = `<table class="sum"><thead><tr><th>케이스</th><th>판정</th><th>확인 절차</th><th>결과</th></tr></thead><tbody>${
    sorted.map(({ r, i, c }) => `<tr class="${c}"><td class="id"><a href="#w${i + 1}">Case ${i + 1}</a></td>
      <td><span class="chip ${c}">${PLAIN[c]}</span></td><td class="what">${h.esc(r.what)}</td>
      <td class="res">${h.esc(firstNote(r))}</td></tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h.esc(title || "확인 보고서")}</title>
<style>
:root{color-scheme:light;--bg:#f6f6f4;--card:#fff;--fg:hsl(40 6% 10%);--muted:hsl(40 4% 40%);--line:hsl(40 8% 88%);
 --red:hsl(358 66% 46%);--red-2:hsl(0 90% 96%);--orange:hsl(24 90% 38%);--orange-2:hsl(24 100% 95%);
 --amber:hsl(36 100% 30%);--amber-2:hsl(44 100% 92%);--blue:hsl(211 90% 40%);--blue-2:hsl(210 100% 96%);
 --gray:hsl(40 4% 32%);--gray-2:hsl(40 8% 93%);--green:hsl(140 50% 28%);--green-2:hsl(130 50% 94%);
 --sans:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo",-apple-system,BlinkMacSystemFont,sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);word-break:keep-all;font-variant-numeric:tabular-nums}
main{max-width:1440px;margin:0 auto;padding:32px 16px 72px}
h1{font-size:26px;line-height:1.3;letter-spacing:-.02em;margin:0 0 6px;font-weight:700;text-wrap:balance}
.lede{color:var(--muted);margin:0 0 20px}
h2{font-size:17px;margin:36px 0 12px;letter-spacing:-.01em}
.req{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:10px}
.req>li{display:grid;grid-template-columns:1.1fr 1fr 1.2fr 150px;gap:16px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;scroll-margin-top:12px}
.req h4{margin:0 0 6px;font-size:12.5px;color:var(--muted);font-weight:600}
.req h3{font-size:15.5px;margin:0 0 8px}.req .gap{color:var(--amber);font-size:12.5px;flex-basis:100%}
.req blockquote{margin:0 0 6px;padding:0 0 0 10px;border-left:2px solid var(--line);font-size:14px;white-space:pre-wrap}
.req .plain{margin:0;padding:0 0 0 18px;font-size:14px}.req .plain li{margin:2px 0}
.req .cases{display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px}.req .cases h4{margin-bottom:0;flex-basis:100%}.req .cases small{flex-basis:100%}
.req .cases a{text-decoration:none}.req .cases small{color:var(--muted);font-size:12.5px}
.reqlink{font-size:12.5px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:5px;padding:1px 8px}.reqlink:hover{color:var(--fg)}
.lanes-wrap{display:grid;gap:14px}.lanes{margin:0;overflow-x:auto}.lanes figcaption{font-size:14px;font-weight:600;margin:0 0 6px}.lanes svg{width:100%;height:auto;display:block}
@media (max-width:1000px){.req>li{grid-template-columns:1fr}}
.ov{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:12px;margin:0 0 8px}
.ov section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.ov h3{font-size:15.5px;margin:0 0 8px}.ov .flow{margin:0 0 8px}.ov .flow li{font-size:13.5px}
.ov ul{margin:0;padding:0 0 0 18px;font-size:14px}.ov li{margin:2px 0}
.tally{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}.tally .chip{font-size:13.5px;padding:3px 10px}
.chip{display:inline-block;font-size:12.5px;font-weight:600;padding:2px 9px;border-radius:5px;white-space:nowrap}
.chip.red{background:var(--red-2);color:var(--red)}.chip.orange{background:var(--orange-2);color:var(--orange)}
.chip.yellow{background:var(--amber-2);color:var(--amber)}.chip.blue{background:var(--blue-2);color:var(--blue)}
.chip.gray{background:var(--gray-2);color:var(--gray)}.chip.green{background:var(--green-2);color:var(--green)}
.sum{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
.sum th{text-align:left;font-size:12.5px;color:var(--muted);font-weight:600;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--gray-2)}
.sum td{padding:8px 12px;border-top:1px solid var(--line);vertical-align:top}
.sum td.id{font-weight:700;white-space:nowrap}.sum td.id a{color:inherit}
.sum td.what{width:52%}.sum td.res{color:var(--muted)}
.sum tr.red td{background:var(--red-2)}
.row{position:relative;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px 18px 28px;margin:0 0 16px;scroll-margin-top:12px}
/* 판정 색 막대. 카드 테두리를 칠하면 둥근 모서리를 따라 휘므로, 안쪽에 곧은 막대로 세운다. */
.row::before{content:"";position:absolute;left:12px;top:18px;bottom:18px;width:4px;border-radius:2px;background:var(--bar,var(--line))}
.row.red{--bar:var(--red)}.row.orange{--bar:var(--orange)}.row.yellow{--bar:var(--amber)}
.row.blue{--bar:var(--blue)}.row.gray{--bar:var(--gray)}.row.green{--bar:var(--green)}
.row header{display:flex;align-items:center;gap:10px;margin:0 0 10px}
.row header .id{font-size:18px;font-weight:700}
.flow{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-wrap:wrap;gap:6px 0;align-items:center;counter-reset:f}
.flow li{counter-increment:f;display:inline-flex;align-items:center;gap:7px;background:var(--gray-2);border-radius:6px;padding:4px 10px;font-size:14.5px;font-weight:500}
.flow li::before{content:counter(f);font-size:11.5px;font-weight:700;color:#fff;background:var(--fg);border-radius:4px;min-width:18px;height:18px;display:inline-grid;place-items:center}
.flow li+li{margin-left:24px;position:relative}
.flow li+li::after{content:"›";position:absolute;left:-17px;color:var(--muted);font-size:18px;line-height:1}
.meta{margin:0 0 14px;font-size:13.5px;color:var(--muted);display:flex;flex-wrap:wrap;gap:2px 22px}
.meta div{display:flex;gap:8px}.meta dt{font-weight:600;color:var(--fg)}.meta dd{margin:0}
.lane{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}
.lane.noscene{grid-template-columns:minmax(0,760px)}
.lane+.lane{margin-top:16px;padding-top:16px;border-top:1px dashed var(--line)}
.info h3{font-size:15px;margin:0 0 8px;display:flex;gap:8px;align-items:center}
.info section{margin:0 0 12px}
.info h4{margin:0 0 4px;font-size:12.5px;color:var(--muted);font-weight:600}
.result{margin:0;padding:0 0 0 18px}.result li{margin:2px 0}
.checks{list-style:none;margin:0;padding:0;font-size:14px}
.checks li{display:flex;gap:8px;padding:4px 0;border-top:1px solid var(--line)}.checks li:first-child{border-top:0}
.checks b{flex:none;font-size:12px;padding:1px 7px;border-radius:4px;height:fit-content}
.checks .ok b{background:var(--green-2);color:var(--green)}.checks .no b{background:var(--red-2);color:var(--red)}
.checks small{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--muted);word-break:break-word;white-space:pre-wrap}
.ask{background:var(--blue-2);border-radius:8px;padding:10px 12px}.ask .picks{margin:4px 0 0}.lean{margin:6px 0 0;font-size:13.5px;color:var(--muted)}
.checks em{display:block;font-style:normal;font-weight:600}
.quote{margin:0 0 14px;padding:10px 14px;background:var(--gray-2);border-radius:8px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.quote blockquote{margin:0;flex:1 1 320px;white-space:pre-wrap;font-size:14px}
.quote .shot.src{width:auto;height:auto;padding:0;max-width:360px}.quote .shot.src img{max-height:200px}
.warn{margin:0;padding:8px 12px;border-radius:8px;background:var(--amber-2);color:var(--amber);font-size:13px}
.none{color:var(--muted);font-size:13.5px;margin:4px 0}
.car{min-width:0;outline:none}
.view{position:relative;background:var(--gray-2);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.view{display:grid}.sc{grid-area:1/1;margin:0;display:flex;flex-direction:column}.sc[hidden]{display:flex;visibility:hidden}
.shot{display:flex;justify-content:center;align-items:center;padding:8px;border:0;background:transparent;cursor:zoom-in;width:100%;flex:1}
.frame{position:relative;display:inline-block;max-width:100%;max-height:100%}
.shot img{display:block;max-width:100%;max-height:min(62vh,620px);width:auto;height:auto}
.shot:focus-visible,.car:focus-visible .view{outline:3px solid var(--blue);outline-offset:-3px}
.box{position:absolute;border:3px solid #ff5a36;border-radius:4px;pointer-events:none}
.box i{position:absolute;left:-3px;top:-24px;font-style:normal;font-size:12px;font-weight:700;color:#fff;padding:2px 7px;border-radius:4px;white-space:nowrap}
.sc figcaption{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;background:var(--fg);color:#fff;font-size:14.5px;line-height:1.5;min-height:44px}
.sc figcaption b{flex:none;font-size:12.5px;opacity:.75;padding-top:1px}
.sc.bad figcaption{background:var(--red)}
.arw{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:56px;border:0;border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font-size:26px;line-height:1;cursor:pointer;opacity:.75;transition:opacity .15s}
.arw:hover,.arw:focus-visible{opacity:1}.arw.prev{left:8px}.arw.next{right:8px}
.thumbs{list-style:none;margin:8px 0 0;padding:0;display:flex;gap:6px;overflow-x:auto}
.th{position:relative;padding:0;border:2px solid transparent;border-radius:6px;background:var(--gray-2);cursor:pointer;display:block;width:88px;height:56px;overflow:hidden}
.th img{width:100%;height:100%;object-fit:cover;object-position:top;display:block;opacity:.7}
.th b{position:absolute;left:3px;top:3px;font-size:11px;background:var(--fg);color:#fff;border-radius:3px;padding:0 5px}
.th.on{border-color:var(--fg)}.th.on img{opacity:1}.th.bad{border-color:var(--red)}
.decide .q{font-size:17px;font-weight:700;margin:0 0 10px}
.picks{margin:12px 0 0;padding:0 0 0 22px}
.picks li{margin:0 0 8px}.picks b{display:block}.picks span{display:block;color:var(--muted);font-size:14px}
footer{margin-top:48px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
footer a{color:inherit}
dialog{border:0;padding:0;background:transparent;max-width:none;max-height:none;width:100vw;height:100vh}
dialog[open]{display:grid;place-items:center}
dialog::backdrop{background:rgba(10,10,10,.85)}
dialog figure{margin:0;max-width:calc(100vw - 32px);background:var(--card);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
dialog .shot{cursor:default;height:auto;padding:0}
dialog .shot img{max-height:calc(100vh - 110px);max-width:calc(100vw - 32px)}
dialog .close{position:fixed;top:12px;right:12px;font:inherit;font-weight:700;padding:8px 14px;border:0;border-radius:6px;background:#fff;cursor:pointer}
@media (max-width:1000px){.lane{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){main{padding:20px 16px 56px}.row{padding:14px 14px 14px 24px}.row::before{left:10px;top:14px;bottom:14px}.sum thead{display:none}.sum tr{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:8px 12px;border-top:1px solid var(--line)}.sum td{border:0;padding:0}.sum td.what,.sum td.res{grid-column:1/-1;width:auto}.shot img{max-height:48vh}}
@media print{body{background:#fff}.view{display:block}.sc,.sc[hidden]{display:flex;visibility:visible;break-inside:avoid}.arw,.thumbs{display:none}.shot{height:auto}.shot img{max-height:120mm}dialog,dialog[open]{display:none!important}.lane{grid-template-columns:1fr}}
</style>
<main>
<h1>${h.esc(title || "확인 보고서")}</h1>
${summary ? `<p class="lede">${h.esc(summary)}</p>` : ""}
${overviewHtml(overview, caseOf, h)}
${hasOverview(overview) ? `<h2>케이스 ${rows.length}</h2>` : ""}
<p class="tally">${order.filter((c) => count[c]).map((c) => `<span class="chip ${c}">${PLAIN[c]} ${count[c]}</span>`).join("")}</p>
${table}
${led.notes.length ? `<h2>결정할 사항 ${led.notes.length}</h2>${led.notes.map((nt) => noteHtml(dir, nt, h)).join("")}` : ""}
<h2>케이스별 확인 내용 ${rows.length}</h2>
${rows.map((r, i) => rowHtml(dir, r, i, h, voidShots, reqsOf, (Array.isArray(featList) ? featList : []).map((f) => String((f && f.name) || "")))).join("\n")}
${devHref ? `<footer>개발자용 상세 기록 <a href="${h.esc(devHref)}">${h.esc(devHref)}</a></footer>` : ""}
</main>
<dialog id="lb" aria-label="장면 크게 보기"><button type="button" class="close">닫기</button><figure></figure></dialog>
<script>
const lb = document.getElementById("lb");
function go(car, i) {
  const sc = [...car.querySelectorAll(".sc")], th = [...car.querySelectorAll(".th")];
  if (!sc.length) return;
  const k = (i + sc.length) % sc.length;
  sc.forEach((f, j) => { f.classList.toggle("on", j === k); f.hidden = j !== k; });
  th.forEach((t, j) => { t.classList.toggle("on", j === k); if (j === k) t.setAttribute("aria-current", "true"); else t.removeAttribute("aria-current"); });
  if (th[k]) th[k].scrollIntoView({ block: "nearest", inline: "nearest" });
}
const at = (car) => [...car.querySelectorAll(".sc")].findIndex((f) => f.classList.contains("on"));
// 썸네일은 파일에 그림을 한 번 더 심지 않고 본 장면의 그림을 가져다 쓴다. 두 번 심으면 지면 크기가 두 배가 된다.
for (const car of document.querySelectorAll(".car")) {
  const imgs = [...car.querySelectorAll(".sc .shot img")];
  car.querySelectorAll(".th img").forEach((t, k) => { if (imgs[k]) t.src = imgs[k].src; });
}
// 화살표 키는 포인터가 올라가 있거나 포커스가 들어간 캐러셀만 넘긴다. 밖에서 누른 키는 건드리지 않는다.
let hot = null;
document.addEventListener("mouseover", (e) => { hot = e.target.closest(".car"); });
document.addEventListener("click", (e) => {
  if (e.target.closest("#lb .close") || e.target === lb) { lb.close(); return; }
  const src = e.target.closest("main .shot.src");
  const car = e.target.closest("main .car");
  if (!car && !src) return;
  const a = e.target.closest(".arw");
  if (a) { go(car, at(car) + (a.classList.contains("next") ? 1 : -1)); return; }
  const t = e.target.closest(".th");
  if (t) { go(car, Number(t.dataset.i)); return; }
  const b = src || e.target.closest(".shot");
  if (!b) return;
  const box = lb.querySelector("figure");
  box.innerHTML = "";
  box.appendChild(b.cloneNode(true));
  const cap = b.closest("figure") && b.closest("figure").querySelector("figcaption");
  if (cap) box.appendChild(cap.cloneNode(true));
  lb.showModal();
});
document.addEventListener("keydown", (e) => {
  if (lb.open || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  const car = (e.target.closest && e.target.closest(".car")) || (e.target === document.body ? hot : null);
  if (!car) return;
  go(car, at(car) + (e.key === "ArrowRight" ? 1 : -1)); e.preventDefault();
});
</script></html>`;
}

export { renderPlain, PLAIN };
