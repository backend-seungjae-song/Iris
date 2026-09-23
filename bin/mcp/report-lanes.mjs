// 역할별 흐름도(스윔레인). 보고서 "구현 내용"에서 제품마다 다른 역할(사용자·운영자·제휴사 등)이
// 무엇을 하고 어디서 서로 넘기는지를 한 장으로 보인다.
//
// 소유 범위
//   흐름도 데이터 검사(checkLanes)와 SVG 생성(lanesSvg). 역할·단계·연결은 부르는 쪽이 준다.
//
// 유지 조건
//   도해 규칙은 diagram-design 스킬의 swimlane 유형과 report 프로파일을 따른다. 역할 5·단계 9·
//   연결 12·강조 2를 넘으면 그리지 않고 나누라고 돌려준다. 연결은 둥근 직각으로만 꺾고 연결 글은
//   달지 않는다. 단계 상자가 이미 무슨 일인지 말하므로 글을 더하면 선만 가린다.
//
// 영향 범위
//   report-plain.mjs 가 부르고 bin/smoke/sections/qa-report-page.mjs 가 렌더 결과를 검사한다.

const T = { paper: "#ffffff", paper2: "#fafafa", ink: "#121212", muted: "#6b6b6b",
  rule: "#00000017", ruleSolid: "#dedede", accent: "#2a78d6", accentTint: "#2a78d614" };
const SANS = "'Geist', 'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', sans-serif";
const LIMIT = { lanes: 5, steps: 9, links: 12, focal: 2 };

const PAD = 14, LABEL_W = 96, COL_W = 164, BOX_W = 128, GUTTER = COL_W - BOX_W, R = 8, FS = 12, LINE_H = 16;

const up4 = (n) => Math.ceil(n / 4) * 4;
const wide = (ch) => /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);
const textW = (s) => [...String(s)].reduce((a, ch) => a + (wide(ch) ? FS : FS * 0.6), 0);

// 상자 폭 안에 들어가게 낱말 단위로 줄을 나눈다. 한 낱말이 폭보다 길면 글자 단위로 자른다.
function wrap(s, max) {
  const lines = [];
  let cur = "";
  for (const word of String(s).split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (textW(next) <= max) { cur = next; continue; }
    if (cur) lines.push(cur);
    if (textW(word) <= max) { cur = word; continue; }
    cur = "";
    for (const ch of word) {
      if (textW(cur + ch) > max) { lines.push(cur); cur = ch; } else cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// 흐름도 하나를 검사한다. 문제가 있으면 무엇이 왜 안 되는지 문장 목록을 돌려준다.
function checkLanes(d, n) {
  const at = `흐름도 ${n}`;
  const problems = [];
  const lanes = Array.isArray(d && d.lanes) ? d.lanes.map(String) : [];
  const steps = Array.isArray(d && d.steps) ? d.steps : [];
  const links = Array.isArray(d && d.links) ? d.links : [];
  if (!lanes.length) problems.push(`${at}: lanes(역할 목록) 없음`);
  if (lanes.length > LIMIT.lanes) problems.push(`${at}: 역할 ${lanes.length}개 · 한 장에 ${LIMIT.lanes}개까지 · 흐름도를 나눌 것`);
  if (!steps.length) problems.push(`${at}: steps(단계) 없음`);
  if (steps.length > LIMIT.steps) problems.push(`${at}: 단계 ${steps.length}개 · 한 장에 ${LIMIT.steps}개까지 · 흐름도를 나눌 것`);
  if (links.length > LIMIT.links) problems.push(`${at}: 연결 ${links.length}개 · 한 장에 ${LIMIT.links}개까지`);
  const focal = steps.filter((s) => s && s.focal).length + links.filter((l) => l && l.focal).length;
  if (focal > LIMIT.focal) problems.push(`${at}: 강조 ${focal}곳 · ${LIMIT.focal}곳까지`);
  const ids = new Set();
  steps.forEach((s, i) => {
    const id = String((s && s.id) || "");
    if (!id) problems.push(`${at}: ${i + 1}번째 단계에 id 없음`);
    else if (ids.has(id)) problems.push(`${at}: 단계 id '${id}' 중복`);
    ids.add(id);
    if (!lanes.includes(String(s && s.lane))) problems.push(`${at}: 단계 '${id}'의 역할 '${s && s.lane}'이 lanes에 없음`);
    if (!String((s && s.text) || "").trim()) problems.push(`${at}: 단계 '${id}'에 text 없음`);
  });
  links.forEach((l) => {
    if (!ids.has(String(l && l.from)) || !ids.has(String(l && l.to))) {
      problems.push(`${at}: 연결 ${l && l.from} → ${l && l.to}의 단계가 없음`);
    }
  });
  return problems;
}

// 꺾이는 점 목록을 둥근 직각 경로로. 모서리마다 반지름 8, 짧은 구간에서는 그 절반까지 줄인다.
function roundPath(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const r = Math.min(R, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const ax = cx - Math.sign(cx - px) * r, ay = cy - Math.sign(cy - py) * r;
    const bx = cx + Math.sign(nx - cx) * r, by = cy + Math.sign(ny - cy) * r;
    d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

// 한 변에 연결이 여럿 붙으면 붙는 점을 변 길이에 고르게 나눈다. 한 점을 두 연결이 같이 쓰지 않는다.
const spread = (start, len, k, n) => start + (len * (k + 1)) / (n + 1);

function lanesSvg(d, n, esc) {
  const lanes = d.lanes.map(String);
  const steps = d.steps.map((s, i) => ({ ...s, id: String(s.id), col: Number.isInteger(s.col) ? s.col : i }));
  const cols = Math.max(...steps.map((s) => s.col)) + 1;
  const W = PAD * 2 + LABEL_W + cols * COL_W;
  // 상자 크기와 역할 줄 높이.
  for (const s of steps) {
    s.lines = wrap(s.text, BOX_W - 16);
    s.h = up4(s.lines.length * LINE_H + 16);
  }
  let y = PAD;
  const laneBox = lanes.map((name) => {
    const mine = steps.filter((s) => s.lane === name);
    const nameLines = wrap(name, LABEL_W - 16);
    const h = up4(Math.max(40, nameLines.length * LINE_H + 16, ...mine.map((s) => s.h)) + 32);
    const box = { name, nameLines, y, h };
    y += h;
    return box;
  });
  const H = y + PAD;
  const byId = new Map();
  for (const s of steps) {
    const lb = laneBox[lanes.indexOf(s.lane)];
    s.x = PAD + LABEL_W + s.col * COL_W + GUTTER / 2;
    s.y = lb.y + (lb.h - s.h) / 2;
    byId.set(s.id, s);
  }
  const links = (d.links || []).map((l) => ({ ...l, a: byId.get(String(l.from)), b: byId.get(String(l.to)) }));
  // 변마다 붙는 연결을 모아 붙는 점을 나눈다.
  const edges = new Map();
  const claim = (s, side, l) => { const k = `${s.id}:${side}`; if (!edges.has(k)) edges.set(k, []); edges.get(k).push(l); };
  for (const l of links) {
    const { a, b } = l;
    if (a.col === b.col) { const down = b.y > a.y; claim(a, down ? "b" : "t", l); claim(b, down ? "t" : "b", l); l.kind = "v"; }
    else if (b.col > a.col) { claim(a, "r", l); claim(b, "l", l); l.kind = "f"; }
    else { claim(a, "b", l); claim(b, "b", l); l.kind = "back"; }
  }
  const attach = (s, side, l) => {
    const list = edges.get(`${s.id}:${side}`) || [l];
    const k = list.indexOf(l);
    return side === "r" || side === "l"
      ? [side === "r" ? s.x + BOX_W : s.x, spread(s.y, s.h, k, list.length)]
      : [spread(s.x, BOX_W, k, list.length), side === "b" ? s.y + s.h : s.y];
  };
  // 같은 사이 칸에 세로 구간이 여럿이면 12씩 비켜 세운다.
  const gutterUse = new Map();
  const gutterX = (col) => {
    const used = gutterUse.get(col) || 0;
    gutterUse.set(col, used + 1);
    return PAD + LABEL_W + col * COL_W + GUTTER / 2 - 8 - used * 12;
  };
  const boxesIn = (lane, from, to) => steps.some((s) => s.lane === lane && s.col > from && s.col < to);
  const paths = links.map((l) => {
    const { a, b } = l;
    let pts;
    if (l.kind === "v") {
      const p = attach(a, b.y > a.y ? "b" : "t", l), q = attach(b, b.y > a.y ? "t" : "b", l);
      pts = p[0] === q[0] ? [p, q] : [p, [p[0], (p[1] + q[1]) / 2], [q[0], (p[1] + q[1]) / 2], q];
    } else if (l.kind === "f") {
      const p = attach(a, "r", l), q = attach(b, "l", l);
      if (p[1] === q[1]) pts = [p, q];
      else {
        // 세로로 꺾는 자리는 가는 쪽 칸 바로 앞 사이 칸. 그 줄에 가로막는 상자가 있으면 떠나는 칸 바로 뒤로.
        const gx = boxesIn(a.lane, a.col, b.col) ? gutterX(a.col + 1) : gutterX(b.col);
        pts = [p, [gx, p[1]], [gx, q[1]], q];
      }
    } else {
      const p = attach(a, "b", l), q = attach(b, "b", l);
      const low = Math.max(a.y + a.h, b.y + b.h) + 14;
      pts = [p, [p[0], low], [q[0], low], q];
    }
    const color = l.focal ? T.accent : T.muted;
    return `<path d="${roundPath(pts)}" fill="none" stroke="${color}" stroke-width="1.2"${
      l.dashed ? ' stroke-dasharray="5,4"' : ""} marker-end="url(#lanes${n}-${l.focal ? "accent" : "arrow"})"/>`;
  }).join("");
  const slug = `lanes${n}`;
  const laneRows = laneBox.map((lb, i) => `${i ? `<line x1="${PAD}" y1="${lb.y}" x2="${W - PAD}" y2="${lb.y}" stroke="${T.ruleSolid}" stroke-width="1"/>` : ""}
    <rect x="${PAD}" y="${lb.y}" width="${LABEL_W}" height="${lb.h}" fill="${T.paper2}"/>
    ${lb.nameLines.map((t, k) => `<text x="${PAD + 12}" y="${lb.y + lb.h / 2 - ((lb.nameLines.length - 1) * LINE_H) / 2 + k * LINE_H + 4}" fill="${T.ink}" font-size="12" font-weight="600" font-family="${SANS}">${esc(t)}</text>`).join("")}`).join("");
  const boxes = steps.map((s) => {
    const focal = !!s.focal;
    return `<rect x="${s.x}" y="${s.y}" width="${BOX_W}" height="${s.h}" rx="6" fill="${T.paper}"/>
    <rect x="${s.x}" y="${s.y}" width="${BOX_W}" height="${s.h}" rx="6" fill="${focal ? T.accentTint : T.paper}" stroke="${focal ? T.accent : T.ink}" stroke-width="1"/>
    ${s.lines.map((t, k) => `<text x="${s.x + BOX_W / 2}" y="${s.y + 8 + (k + 1) * LINE_H - 4}" fill="${T.ink}" font-size="12" font-weight="500" font-family="${SANS}" text-anchor="middle">${esc(t)}</text>`).join("")}`;
  }).join("");
  const title = String(d.title || `역할별 흐름 ${n}`);
  const desc = `${lanes.join(", ")}이 ${steps.map((s) => s.text).join(", ")} 순서로 일하는 흐름`;
  return `<figure class="lanes">${d.title ? `<figcaption>${esc(title)}</figcaption>` : ""}
<svg class="dia" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${slug}-title ${slug}-desc" style="max-width:${W}px">
<title id="${slug}-title">${esc(title)}</title><desc id="${slug}-desc">${esc(desc)}</desc>
<defs>
<marker id="${slug}-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${T.muted}"/></marker>
<marker id="${slug}-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="${T.accent}"/></marker>
</defs>
<rect width="100%" height="100%" fill="${T.paper}"/>
<rect x="${PAD}" y="${PAD}" width="${W - PAD * 2}" height="${H - PAD * 2}" fill="none" stroke="${T.ruleSolid}" stroke-width="1" rx="6"/>
${laneRows}
${paths}
${boxes}
</svg></figure>`;
}

export { checkLanes, lanesSvg, LIMIT };
