// 확인 보고서. 찍은 장면과 판정 영수증을 사람이 읽고 눌러 보는 한 장으로 묶는다.
//
// 소유 범위
//   판정 영수증 장부(receipts)와 그 발급·조회, 회차 폴더로 증거를 보존하는 처리,
//   그리고 보고서 HTML 화면 전체. 장면 배치·판정 표시·색인·인쇄 규칙.
//
// 제공 API
//   buildReport 와 addReceipt·receiptById, 그리고 보고서 화면이 지키는 규칙을 밖에서 셀 수 있게
//   coverGaps·borrowedBefores·unshotClaims.
//
// 의존 대상
//   artifacts-home.cjs 가 정한 부산물 폴더 아래 qa/<회차> 와 Node 파일 API 뿐이다.
//   MCP 연결·herdr·시뮬레이터를 모르며, 그쪽에서 이 모듈을 부른다.
//
// 유지 조건
//   통과는 영수증에서만 나온다. 지어낸 통과가 문서로 나가는 경로를 열지 않는다.
//   보고서에 실린 장면은 회차 폴더로 옮겨 남는다(찍은 자리는 60장·7일로 정리된다).
//   보고서 화면은 항상 라이트 테마다. 사진 없는 주장은 판정과 무관하게 그렇다고 적힌다.
//
// 영향 범위
//   공급자는 bin/iris-mcp.mjs 의 browser_report·app 도구 연결이고, 양방향 소비자는
//   bin/smoke/sections/qa-report-page.mjs 다. 거기서 이 모듈을 불러 보고서 화면을 만든다.
//   현재 목록은 다음으로 확인한다: node bin/importers.mjs bin/mcp/report.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { artifactDir } from "../../server/artifacts-home.cjs";
import { renderPlain } from "./report-plain.mjs";

// 개발 인스턴스와 설치된 앱이 같은 폴더를 쓰면 회차 장부가 섞인다. 어디인지는 한 곳이 정한다.
// 상태 폴더를 import 시점에 고정하면 그 뒤에 IRIS_STATE_DIR 을 지정해도 반영되지 않는다. 개발 환경이
// 설치된 앱의 회차 폴더를 읽고 쓰게 되는 경로이고, 이 저장소가 데이터 보존 조건으로 두는
// 분리가 여기서 깨진다(확인 결과: 검사가 tmp 에 쓴 장부 대신 ~/.iris 를 읽었다).
// 부를 때마다 해석한다. state-home.cjs 가 상태 폴더를, artifacts-home.cjs 가 그 안의 회차 위치를 정한다.

// ── 확인 보고서 ──
// 스크린샷 여러 장이 폴더에 흩어져 있으면 사람은 열어보지 않는다. 한 장짜리 HTML로 묶어 "무엇을
// 확인했고 어떻게 나왔는지"를 순서대로 보여준다. 이미지는 파일 안에 심어 어디로 옮겨도 열린다.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// 장면에 얹는 표시는 이미지에 합성하지 않고 옆 파일(.marks.json)에 상대좌표로 둔다. 그래야
// 확대해도 안 깨지고, 장면을 옮길 때 표시도 따라간다. 쓰는 쪽은 브라우저·앱 양쪽이고
// 읽어서 그리는 쪽은 이 보고서 화면이라 소유는 여기다.
const markSidecar = (shot) => String(shot) + ".marks.json";
function writeMarks(shot, marks, frame) {
  if (!marks || !marks.length || !frame || !frame.width) return;
  const rel = marks.map((m) => ({ label: m.label || "", color: m.color || "#85E8F6",
    x: m.x / frame.width, y: m.y / frame.height, w: m.w / frame.width, h: m.h / frame.height }));
  try { fs.writeFileSync(markSidecar(shot), JSON.stringify({ marks: rel })); } catch {}
}
function readMarks(shot) {
  try { return JSON.parse(fs.readFileSync(markSidecar(shot), "utf8")).marks || []; } catch { return []; }
}

// ── 판정 영수증 ──
// 화면을 읽고 "됐다"고 적는 것은 판정이 아니라 인상이다. 통과는 도구가 같은 순간에 요소를 찾아
// 값을 읽은 사실에서만 나온다. browser_expect가 부를 때마다 그 사실을 여기 남기고, 보고서는
// 이 기록에 걸리지 않은 통과를 받지 않는다. 지어낸 통과가 문서로 나가는 경로 자체를 없앤다.
const receipts = [];
// 회차(browser_run begin)에 묶여 있으면 번호는 서버가 매긴다. 영수증과 단계가 같은 append-only
// 스트림에서 나와야 둘이 어긋날 수 없고, 이 프로세스가 죽어도 장부가 남는다. 안 묶였으면
// 지금까지처럼 여기서 매긴다(회차 없이 쓰는 단발 확인을 깨지 않는다).
// 어느 회차의 영수증인가를 함께 적는다. 이 배열은 MCP 프로세스가 사는 내내 쌓이므로 회차
// 경계가 없다. 확인 결과: 14단계짜리 회차의 보고서가 영수증 195건을 들고 있었고 그
// 시간 범위가 38시간이었다(r1의 장면 경로가 아예 다른 회차 폴더를 가리켰다). "보고서에 안
// 실린 확인"이 다른 회차의 증거로 채워지는 경로다.
function addReceipt(d, serverId, runId) {
  receipts.push({ id: serverId || "r" + (receipts.length + 1), at: Date.now(),
    ...(runId ? { run: String(runId) } : {}), ...d });
  return receipts[receipts.length - 1];
}
// 이 보고서가 자기 것이라 말할 수 있는 영수증. 회차를 모르는 것(회차 없이 쓴 단발 확인)은
// 잃지 않도록 포함한다. 모르는 것을 빼면 증거가 기록 없이 사라진다.
function receiptsOfRun(runs) {
  const mine = new Set([...runs].filter(Boolean).map(String));
  if (!mine.size) return receipts;
  return receipts.filter((r) => !r.run || mine.has(String(r.run)));
}
function receiptById(id) { return receipts.find((r) => r.id === String(id || "")); }

// 증거는 사라지면 증거가 아니다. 찍은 위치(상태 폴더의 shots)는 60장·7일로 정리되므로,
// 보고서에 실린 장면은 실행 폴더로 옮겨 이름을 갖고 남는다. 다음 회귀의 '이전' 장이자
// 남에게 넘길 문서의 기준 이미지가 같은 파일이다.
function runStore(runId) {
  const dir = path.join(artifactDir("qa"), runId);
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  return dir;
}
function keepShot(dir, src, name) {
  if (!src || !fs.existsSync(src)) return null;
  const dest = path.join(dir, "shots", name + path.extname(src || ".png"));
  try {
    fs.copyFileSync(src, dest);
    // 표시는 이미지 옆 파일에 있어 장면만 옮기면 표시가 사라진다. 같이 옮긴다.
    for (const ext of [".marks.json", ".caption.txt"]) {
      if (fs.existsSync(String(src) + ext)) fs.copyFileSync(String(src) + ext, dest + ext);
    }
    return dest;
  } catch { return src; }
}
// 장면의 실제 픽셀 크기. 세로로 긴 폰 화면과 가로로 넓은 웹 화면은 보고서에서 배치 방식이 달라야 한다.
function pngSize(p2) {
  try {
    const fd = fs.openSync(String(p2), "r"); const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd);
    if (b.toString("latin1", 1, 4) !== "PNG") return null;
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    return w > 0 && h > 0 ? { w, h } : null;
  } catch { return null; }
}
// 보고서에 넣는 그림은 화면에서 읽을 만큼만 크면 된다. 찍은 그대로(레티나 배율의 전체 페이지)
// 넣으면 보고서 한 장이 93MB가 된다. 열리지 않는 보고서는 증거가 아니다(확인 결과).
// 원본은 회차 폴더에 그대로 남고, 굽는 사본만 줄인다. 줄이지 못하면 원본을 그대로 쓴다.
const EMBED_MAX_W = 1600;
const shrunk = new Map();
function forEmbed(p) {
  if (shrunk.has(p)) return shrunk.get(p);
  let out = p;
  try {
    const d = pngSize(p);
    if (d && d.w > EMBED_MAX_W) {
      const tmp = p.replace(/\.png$/i, `.w${EMBED_MAX_W}.png`);
      if (!fs.existsSync(tmp)) {
        execFileSync("sips", ["-Z", String(EMBED_MAX_W), p, "--out", tmp], { stdio: "ignore" });
      }
      if (fs.existsSync(tmp)) out = tmp;
    }
  } catch {}
  shrunk.set(p, out);
  return out;
}
const dataUri = (p) => {
  try {
    if (!p || !fs.existsSync(p)) return null;
    return `data:image/png;base64,${fs.readFileSync(forEmbed(p)).toString("base64")}`;
  } catch { return null; }
};
// 한 장면 안의 표시(요소 테두리·설명)는 이미지에 합성하지 않고 겹쳐 그린다. 확대해도 깨지지 않는다.
function boxesOf(c) {
  return (c.marks || []).map((m) =>
    `<span class="box" style="left:${(m.x * 100).toFixed(2)}%;top:${(m.y * 100).toFixed(2)}%;` +
    `width:${(m.w * 100).toFixed(2)}%;height:${(m.h * 100).toFixed(2)}%;border-color:${esc(m.color || "#85E8F6")}">` +
    (m.label ? `<i style="background:${esc(m.color || "#85E8F6")};${m.x > 0.5 ? "right:0;left:auto" : ""}">${esc(m.label)}</i>` : "") + `</span>`).join("");
}
// 검증용 보고서에서 장면은 "무엇이 어떻게 바뀌었나"다. 나란히 늘어놓으면 한 장이 작아져 못 읽고,
// 크게 놓으면 한 장이 카드를 다 차지한다. 영역을 하나로 고정해 전→후→달라진 곳을 그 자리에서 넘긴다.
// 종이에서는 넘길 수 없으므로 인쇄 규칙이 전부 펼친다.
// 장면의 모양이 배치를 정한다. 두 배치는 서로 다른 사실에서 나온다.
//
// 가로로 넓은 웹 화면: 한 장이 영역을 다 쓴다. 두 장을 나란히 놓으면 둘 다 못 읽는다. 그래서
//   한 영역에 겹쳐 놓고 넘긴다. 같은 위치에서 바뀌므로 무엇이 달라졌는지 드러난다.
// 세로로 긴 폰 화면: 한 장이 영역의 3할도 못 쓰고, 세로가 화면 높이에 막혀 더 키울 수도 없다.
//   대신 화면 안의 글자·버튼이 화면 대비 커서 작게 놓아도 읽힌다. 그러면 넘길 이유가 없다.
//   여정 순서대로 한 줄에 늘어놓고, 각 장 밑에 그 장이 무엇을 증명하는지 붙인다. 판정을 옆으로
//   몰면 어느 사진이 어느 주장의 근거인지 눈이 매번 다시 맞춰야 한다.
// perCheck: 장면마다 판정과 확인 내용을 다는가. 확인이 하나뿐이면 카드 머리의 태그와 옆 목록이
// 이미 같은 말을 하고 있다. 같은 말을 두 번 하면 읽는 사람이 둘을 대조하느라 시간을 쓰고,
// 대조해 봐야 같은 말이다. 확인이 여럿일 때만 어느 장면이 어느 확인의 근거인지 갈라 준다.
function shotStage(cells, perCheck) {
  const live = cells.filter((c) => c.src);
  if (!live.length) return { html: "", cls: "" };
  const sizes = live.map((c) => pngSize(c.file)).filter(Boolean);
  const tall = sizes.length === live.length && sizes.every((d) => d.h / d.w >= 1.2);
  const cap = (c) => `<figcaption><span class="lb">${esc(c.label)}</span>${
    c.check && perCheck ? `<span class="ck ${c.check.pass ? "ok" : "no"}">${c.check.pass ? "됨" : "안 됨"}</span>` +
      `<span class="cw">${esc(c.check.text)}</span>` : ""}${
    c.said ? `<span class="cs">${esc(c.said)}</span>` : ""}${
    c.note ? `<span class="cw">${esc(c.note)}</span>` : ""}</figcaption>`;
  const frames = live.map((c, i) =>
    `<figure class="fr${i === 0 || tall ? " on" : ""}"><div class="frame"><img src="${c.src}" alt="">${boxesOf(c)}</div>` +
    cap(c) + `</figure>`).join("");
  const tabs = live.map((c, i) =>
    `<button type="button" class="tab${i ? "" : " on"}" data-i="${i}">${esc(c.label)}</button>`).join("");
  // 넘겨야 하는 배치에서만 넘김 장치를 단다. 한 줄에 늘어놓으면 넘길 것이 없다.
  const paging = live.length > 1 && !tall;
  const nav = paging
    ? `<button type="button" class="arw prev" aria-label="이전 장면">‹</button>
       <button type="button" class="arw next" aria-label="다음 장면">›</button>
       <span class="count"><b>1</b>/${live.length}</span>`
    : "";
  // 폰 화면 한 장뿐이면 줄로 세울 것이 없다. 영역을 사진 비율만큼만 잡고 남는 폭은 글에 준다.
  const solo = tall && live.length === 1;
  // 가로로 긴 장면(웹)은 병목이 반대다. 영역 높이를 창 높이로만 잡으면 보고서 폭이 한참 남는데도
  // 사진이 그 높이에 맞춰 줄어 글자가 읽히지 않는다. 확인 결과: 1920폭 캡처가 1266px
  // (66%)로 표시됐고 보고서 1760px 중 494px이 비어 있었다. 사진이 지나치게 작아 검증이
  // 어렵다고 판단된 자리가 여기다. 그래서 가로형에도 비율을 넘겨 자리 높이를 폭에서 되돌려 잡는다.
  // 여러 장이면 가장 낮은 비(가장 높은 장면)를 쓴다. 그래야 어느 장도 영역을 넘지 않는다.
  const wide = sizes.length === live.length && sizes.length > 0 && sizes.every((d) => d.w / d.h >= 1.2);
  const ar = solo && sizes.length ? sizes[0].w / sizes[0].h
    : (wide ? Math.min(...sizes.map((d) => d.w / d.h)) : 0);
  // 실물 크기까지 키우면 한 장이 보고서를 다 차지한다. 원본 높이를 함께 넘겨 배율을 고정한다. 창 크기에 따라 66%가 되기도 했다
  // 95%였다 흔들리지 않고, 어느 화면에서 보든 같은 크기로 실린다.
  const ih = wide ? Math.max(...sizes.map((d) => d.h)) : 0;
  const vars = [ar ? `--ar:${ar.toFixed(3)}` : "", ih ? `--ih:${ih}px` : ""].filter(Boolean).join(";");
  return {
    html: `<div class="stage${wide ? " wide" : ""}"${vars ? ` style="${vars}"` : ""}>` +
      `<div class="track${tall ? (solo ? " solo" : " strip") : ""}">${frames}${nav}</div>
      ${paging ? `<div class="tabs">${tabs}</div>` : ""}</div>`,
    cls: tall ? (solo ? " tall solo" : " tall strip") : "",
  };
}
// 안내서(handoff)는 다른 사람이 종이·화면으로 훑는 절차서다. 넘기는 장치 없이 나란히 둔다.
// 주소를 분류로 줄인다. 호스트와 첫 경로 조각을 쓴다. 목록 화면과 상세 화면은 같은 분류이고
// 로그인 벽은 다른 분류다. 질의문자열은 분류를 나누지 않는다(같은 화면의 다른 조건일 뿐).
function urlFamily(u) {
  if (!u) return null;
  try {
    const x = new URL(String(u));
    return x.host + "/" + (x.pathname.replace(/^\/+/, "").split("/")[0] || "");
  } catch { return null; }
}

function shotRow(cells) {
  const live = cells.filter((c) => c.src);
  if (!live.length) return "";
  const sizes = live.map((c) => pngSize(c.file)).filter(Boolean);
  const tall = sizes.length === live.length && sizes.every((d) => d.h / d.w >= 1.2);
  return `<div class="shots${live.length > 1 ? " pair" : ""}${tall ? " tall" : ""}">` + live.map((c) => {
    // 앱 장면의 표시는 이미지에 합성하지 않고 여기서 겹쳐 그린다. 확대해도 깨지지 않고 원본이 손상되지 않는다.
    const boxes = (c.marks || []).map((m) =>
      `<span class="box" style="left:${(m.x * 100).toFixed(2)}%;top:${(m.y * 100).toFixed(2)}%;` +
      `width:${(m.w * 100).toFixed(2)}%;height:${(m.h * 100).toFixed(2)}%;border-color:${esc(m.color || "#85E8F6")}">` +
      (m.label ? `<i style="background:${esc(m.color || "#85E8F6")};${m.x > 0.5 ? "right:0;left:auto" : ""}">${esc(m.label)}</i>` : "") + `</span>`).join("");
    return `<figure><div class="frame"><img src="${c.src}" alt="">${boxes}</div>` +
      `<figcaption>${esc(c.label)}${c.note ? " · " + esc(c.note) : ""}</figcaption></figure>`;
  }).join("") + `</div>`;
}
// QA는 기대와 실제를 맞대는 일인데, 지금까지 보고서에는 실제만 있고 기대가 어디서 왔는지가
// 없었다. 화면을 보고 기대를 만들면 구현이 곧 명세가 되어 그 확인은 언제나 통과한다.
// 잘못 만들어진 화면도 그대로 통과시키므로 그 통과는 아무것도 보증하지 않는다.
// 그래서 단계마다 기대의 출처를 함께 싣는다. 적는 것은 강제하되 무엇을 적을지는 열어 둔다:
// 출처가 없으면 "내가 정한 것"을 고를 수 있어 막히지 않고, 대신 그 사실이 보고서에 남는다.
// 출처를 요구해 버리면 없는 출처를 지어내게 되고 그쪽이 더 나쁘다.
const BASIS = {
  spec: { label: "명세", need: "어느 문서 어느 대목" },
  plan: { label: "기획서", need: "어느 기획서 어느 대목" },
  code: { label: "코드", need: "파일과 줄" },
  user: { label: "사용자 결정", need: "사용자가 한 말" },
  assumed: { label: "임의", need: "무엇을 어떤 근거로 그렇게 잡았는지" },
};

// 실패한 회차를 이어받는 경로가 없으면 수정분만 조각 보고서로 따로 내거나,
// 처음부터 전부 다시 실행해야 한다. 중간이 없다. 이미 통과했고
// 그 사이에 아무것도 바뀌지 않은 구간을 다시 실행하는 것은 시간만 쓰고 새로 아는 것이 없다.
//
// 그래서 앞 회차의 통과 단계를 그대로 물려받고, 다시 볼 것만 새로 실행한다. 무엇이 바뀌었는지는
// 기계가 알 수 없으므로 다시 실행할 단계는 부르는 쪽이 redo로 지목한다. 지목하지 않은 것은
// "그때 확인된 그대로"라고 이 회차가 주장하는 셈이고, 그 사실이 보고서에 드러난다.
function resumeSteps(resume) {
  if (!resume || !resume.from) return { carried: [], from: null, at: null, missing: null };
  const mf = path.join(runStore(String(resume.from)), "manifest.json");
  let m = null;
  try { m = JSON.parse(fs.readFileSync(mf, "utf8")); } catch {}
  if (!m) return { carried: [], from: resume.from, at: null, missing: "그 회차의 기록을 찾지 못했다" };
  if (!Array.isArray(m.steps) || !m.steps.length)
    return { carried: [], from: resume.from, at: m.at || null,
             missing: "그 회차에는 단계별 기록이 없다 — 이어받기가 생기기 전 회차다" };
  if (String(m.kind || "") === "handoff")
    return { carried: [], from: resume.from, at: m.at || null,
             missing: "넘기기 문서는 판정이 아니라 절차다 — 확인한 적 없는 것을 이어받을 수는 없다" };
  const redo = new Set((resume.redo || []).map((x) => String(x).trim()));
  const carried = m.steps
    .filter((st) => st && st.verdict === "pass" && !redo.has(String(st.name || "").trim()))
    .map((st) => ({ ...st, from: String(resume.from), fromAt: m.at || null }));
  return { carried, from: String(resume.from), at: m.at || null, missing: null };
}

// 이 단계가 실제 화면을 들고 있는가. 영수증에 붙은 장면도 화면이다. 부르는 쪽이 after를
// 안 넘겼을 뿐 디스크에는 있다(buildReport의 after 폴백과 같은 자리를 본다).
function stepShot(s) {
  if (s.after || s.shot) return true;
  const ids = Array.isArray(s.receipts) ? s.receipts : (s.receipt ? [s.receipt] : []);
  return ids.map((id) => receiptById(id)).some((r) => r && r.shot);
}

// 화면에 대해 무언가를 주장한 단계는 그 화면이 있어야 한다. expected가 곧 주장이다.
// "무엇이 보여야 한다"고 적어 놓고 사진이 없으면 그것은 확인이 아니라 기억이다.
//
// 판정으로 나누지 않는 이유: pass에만 "사진 없음" 표시를 붙이면 사진 없는
// 주장이 전부 info로 빠져나간다. 확인 결과: 회차 17개 349단계 중 사진 없는 44단계가
// expected를 달고 있었고 그중 26이 info였다(pass 16, fail 2). 딱지를 피하는 값이 하나라도
// 있으면 규율이 아니라 표시가 된다.
function unshotClaims(steps, handoff) {
  if (handoff) return [];
  return (steps || [])
    .map((s, i) => ({ n: i + 1, s }))
    // 이어받은 단계는 이번에 실행한 것이 아니다. 사진은 그 회차에 있다.
    .filter(({ s }) => s && String(s.expected || "").trim() && !s.from
      && !String(s.noShot || "").trim() && !stepShot(s))
    .map(({ n, s }) => `${n}. ${String(s.name || "확인").slice(0, 40)} — 원한 것: ${
      String(s.expected).slice(0, 50)}`);
}

// 한 항목에 주장이 몇 개인가는 글자로 판정하지 않는다. 접속 기호를 세어 봤더니
// "벌점 + 조정"의 +는 연산자이고 "점수·원장"의 ·는 단어 구분이다. 확인 결과:
// 합의 9항목 중 7항목이 오탐이었고, 그대로 두면 규칙이 오히려 과분할을 유도한다. 동작 하나를
// 여러 항목으로 쪼개게 된다. 쪼갤 것인가는 사람이 정하고, 기계는
// 관측 가능한 것만 본다. 항목이 어느 단계에 연결됐는가를 본다.
//
// 합의 항목과 단계를 잇는다. 수만 비교해서는 잡히지 않는다. 19개를 합의하고 21단계를 실행해도
// 그중 하나가 어느 항목도 안 덮을 수 있고, 실제로 그랬다. 어느 단계가 어느 항목을 덮었는지는
// 실행한 쪽만 아는 사실이므로 짐작하지 않고 covers로 받는다. 이름으로 넘겨도 되고 번호로 넘겨도
// 된다. 이름은 앞에서부터 겹치면 맞은 것으로 본다("R11"이 "R11 — …"을 집는다).
// unverified가 원장 옆에 나란히 서면 그것이 값싼 우회가 된다.
//
// 확인 결과: 알림 발신 위치 여섯 중 하나만 실행하고, 나머지 다섯을 "코드와
// 단위테스트로만 확인"이라 적어 unverified로 넘긴 사례가 있다. 게이트는 선언한 경로를 다 실행했는지만
// 봤으므로 그대로 통과했다. 몰라서가 아니라 빠져나가는 값이 쌌던 것이다.
//
// 실행하지 않은 것을 남기는 기능은 그대로 둔다. 경로만 하나로 모은다. 원장이 있는 회차에서
// 실행하지 않은 것은 줄로 표시되어 색을 받고, 그래야 집계·목록 대조·다음 회차 이어받기에 들어간다.
function unverifiedOutsideLedger(run, hasLedger) {
  if (!hasLedger) return null;
  const un = (run && Array.isArray(run.unverified) ? run.unverified : [])
    .filter((x) => x && String(x.what || "").trim());
  if (!un.length) return null;
  return `원장이 있는 회차는 못 밟은 것도 줄로 선다 — unverified ${un.length}건.\n`
    + un.slice(0, 8).map((x) => `  ${String(x.what).slice(0, 60)}`).join("\n")
    + (un.length > 8 ? `\n  … 외 ${un.length - 8}건` : "")
    + "\n\n글로 옆에 적으면 그 항목은 집계에도 목록 대조에도 안 들어가고, 다음 회차가\n"
    + "이어받을 것도 없다. 사유만 적으면 무제한으로 통과하므로 그 자리가 가장 싼 길이 된다.\n\n"
    + "각 항목마다 줄을 세우고 못 밟은 사유와 함께 닫는다.\n"
    + '  browser_row { action:"declare", row:{ id:"N-7", what:"…", given:"…", basis:"spec", paths:["정상"] } }\n'
    + '  browser_row { action:"close", row:"N-7", path:"정상", color:"gray", note:"…" }\n'
    + "gray·blue는 장면 없이 닫힌다 — 사유가 그 자리에 남고 지면이 그것을 센다.";
}

function coverGaps(agreed, steps) {
  const names = (steps || []).map((s, i) => ({ n: i + 1, name: String(s.name || "").trim() }));
  const hit = (c) => {
    const k = String(c).trim();
    if (/^\d+$/.test(k)) return names.some((x) => x.n === Number(k));
    return names.some((x) => x.name === k || x.name.startsWith(k));
  };
  const gaps = [];
  for (const a of agreed) {
    const what = String(a.what || "").trim();
    const covers = Array.isArray(a.covers) ? a.covers.filter((x) => String(x).trim()) : [];
    if (!covers.length)
      gaps.push(`"${what.slice(0, 60)}" — 이 항목을 덮은 단계가 covers에 없음.`);
    else {
      const miss = covers.filter((c) => !hit(c));
      if (miss.length)
        gaps.push(`"${what.slice(0, 60)}" — covers가 가리킨 단계가 없다: ${miss.join(", ")}`);
    }
  }
  return gaps;
}

function shaOf(f) {
  try { return crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex"); } catch { return null; }
}

// 전/후 짝이 그 동작의 앞뒤인가. 셋을 본다.
//
// 하나. 바로 앞 단계의 후가 이번 단계의 전이면 그 둘은 한 동작이다. 누르기·확인
// 다이얼로그·반영을 항목 셋으로 나누면 "겨우 동작 하나"가 세 줄이 되고 읽는 사람은 같은
// 것을 세 번 읽는다. 나누지 말고 하나로 합치고, 거쳐간 화면은
// via에 순서대로 넣는다.
//
// 둘. 붙어 있지 않은 단계의 후를 전으로 갖다 쓰면 그것은 이 조작의 직전 상태가 아니다.
// 확인 결과: 전이 있는 9단계 중 6단계가 다른 단계의 후 그림이었다.
//
// 셋. 전과 후가 같은 그림이면 그 동작이 무엇을 바꿨는지 드러나지 않는다. 확인 결과:
// "판매 제한 해제" 단계의 전·후가 둘 다 "판매 제한을 해제할까요?" 다이얼로그
// 한 장이었다. 누르기 전 화면도, 해제된 화면도 없었다.
function pairProblems(steps) {
  const list = steps || [];
  const afters = new Map();
  list.forEach((s, i) => {
    const a = s.after || s.shot;
    const h = a ? shaOf(a) : null;
    if (h && !afters.has(h)) afters.set(h, i + 1);
  });
  const bad = [];
  list.forEach((s, i) => {
    const n = i + 1, label = `${n}. ${String(s.name || "확인").slice(0, 40)}`;
    const hb = s.before ? shaOf(s.before) : null;
    const ha = (s.after || s.shot) ? shaOf(s.after || s.shot) : null;
    if (hb && ha && hb === ha && !s.unchanged)
      bad.push(`${label} — 전과 후가 같은 그림\n이 동작이 무엇을 바꿨는지 안 보임`);
    if (!hb) return;
    const from = afters.get(hb);
    if (!from || from === n) return;
    if (from === n - 1)
      bad.push(`${label} — 전이 바로 앞 ${from}번의 후\n둘은 한 동작. 하나로 합칠 것`);
    else
      bad.push(`${label} — 전이 ${from}번의 후와 같은 그림\n이 조작의 직전 아님`);
  });
  return bad;
}

// ── 장부에서 지면을 뽑는다 ──────────────────────────────────────
// 회차의 원본은 append-only 장부(journal.jsonl)다. 보고서 화면이 그것을 읽어 그리면 단계를 직접
// 쓰는 자리가 없어지고, 사진 없는 단계·전후 어긋남·과분할·안 실린 확인이 전부 "그렇게 될 수
// 없는" 형태가 된다. 직접 쓴 회차(장부에 줄이 없는 회차)는 기존 경로로 그대로 나간다.
// 이 사실이 어느 줄의 증거인가. 조건이 같은 줄들을 함께 실행하면 한 장면·한 판정이 여러 줄의
// 증거가 되므로 lanes에 다 실린다. 옛 기록에는 row·path_ 한 쌍뿐이니 그것도 받는다.
function lanesOf(e, open) {
  if (Array.isArray(e.lanes) && e.lanes.length) {
    return e.lanes.filter((l) => Array.isArray(l) && l[0] && l[1]).map((l) => [l[0], l[1]]);
  }
  if (e.row && e.path_) return [[e.row, e.path_]];
  // 표식이 없는 줄은 그 시점에 열려 있던 줄에서 되찾는다. 다만 열린 줄이 하나일 때만이다.
  // 여럿이 열려 있었으면 이 장면이 그중 어느 줄의 것인지 장부가 말하지 않으므로, 짐작해서
  // 전부에 실으면 오래 열어둔 줄이 다른 줄의 장면을 스물다섯 장씩 가져간다(확인 결과).
  // 표식을 남기게 고친 뒤로는 이 되찾기가 옛 회차에만 쓰인다.
  return open && open.length === 1 ? [[open[0][0], open[0][1]]] : [];
}

function readLedger(runId) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(runStore(runId), "journal.jsonl"), "utf8").split("\n"); }
  catch { return null; }
  const rows = new Map(), notes = [], receipts = new Map(), voided = new Set();
  const voids = [];
  let list = null;
  const sets = [];
  const aside = new Map();
  // 열린 줄은 여럿일 수 있다. 하나만 들고 있으면 조건이 같아 함께 연 줄들 중 마지막 것만
  // 증거를 받는다. 서버가 같은 규칙을 쓰므로 읽는 쪽도 같아야 한다.
  let kind = "review", open = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === "run_begin" && e.runKind) kind = e.runKind;
    else if (e.kind === "row") {
      if (e.act === "declare") rows.set(e.row, { id: e.row, what: e.what, given: e.given,
        basis: e.basis, basisNote: e.basisNote, quote: e.quote, source: e.source,
        sourceShot: e.sourceShot, covers: e.covers, paths: e.paths || [], lanes: new Map() });
      else if (e.act === "basis") {
        const r0 = rows.get(e.row);
        if (r0) {
          if (e.quote) r0.quotes = [...(r0.quotes || (r0.quote ? [r0.quote] : [])), e.quote];
          if (e.source) r0.source = e.source;
          if (e.sourceShot) r0.sourceShot = e.sourceShot;
          if (e.basisNote) r0.basisNote = e.basisNote;
          if (e.what) r0.what = e.what;
        }
      }
      else if (e.act === "open") {
        if (!open.some((l) => l[0] === e.row && l[1] === e.path)) open.push([e.row, e.path]);
        const r = rows.get(e.row); if (r && !r.lanes.has(e.path)) r.lanes.set(e.path, { path: e.path, frames: [], receipts: [] }); }
      else if (e.act === "close") {
        const r = rows.get(e.row); if (!r) continue;
        const ln = r.lanes.get(e.path) || { path: e.path, frames: [], receipts: [] };
        ln.color = e.color; ln.note = e.note;
        ln.options = e.options; ln.lean = e.lean; ln.simple = e.simple;
        r.lanes.set(e.path, ln);
        open = open.filter((l) => !(l[0] === e.row && l[1] === e.path));
      }
    } else if (e.kind === "note") notes.push(e);
    else if (e.kind === "list") { if (!list) list = e;
      if (!sets.some((x) => x.name === e.name)) sets.push(e); }
    else if (e.kind === "aside") {
      for (const f of (e.frames || [])) aside.set(String(f), e.why || "");
    }
    else if (e.kind === "void" && e.receipt) {
      voided.add(String(e.receipt));
      voids.push({ receipt: String(e.receipt), why: e.why, row: e.row, path_: e.path_ });
    }
    // 한 줄이 보여줄 그림은 세 곳에서 온다. 조작이 자동으로 남긴 전·후, 설명을 달아 일부러
    // 찍은 장면, 판정이 그 자리에서 남긴 화면. 셋을 한 줄기로 모아야 "됐다"도 사진으로 증명된다.
    else if (e.kind === "frame" || e.kind === "artifact") {
      // 직전과 같아서 파일을 안 만든 프레임은 경로가 없다. 그래도 "이 줄에서 몇 장이 안
      // 변했나"는 사실이므로 수로 센다. 장부는 그 사실을 적지만 보고서 화면이 읽지 않았다.
      // 확인 결과: same 136건 전부, 만드는 코드는 있고 부르는 곳이 없었다.
      if (!e.path) {
        if (e.same) for (const [rid, pth] of lanesOf(e, open)) {
          const r = rows.get(rid); if (!r) continue;
          const ln = r.lanes.get(pth) || { path: pth, frames: [], receipts: [] };
          ln.same = (ln.same || 0) + 1;
          r.lanes.set(pth, ln);
        }
        continue;
      }
      for (const [rid, pth] of lanesOf(e, open)) {
        const r = rows.get(rid); if (!r) continue;
        const ln = r.lanes.get(pth) || { path: pth, frames: [], receipts: [] };
        ln.frames.push({ path: e.path, why: e.kind === "artifact" ? "찍음" : e.why,
          caption: e.caption, url: e.url, t: e.t });
        r.lanes.set(pth, ln);
      }
    } else if (e.kind === "assertion") {
      receipts.set(e.id, e);
      if (voided.has(String(e.id))) continue;
      for (const [rid, pth] of lanesOf(e, open)) {
        const r = rows.get(rid); if (!r) continue;
        const ln = r.lanes.get(pth) || { path: pth, frames: [], receipts: [] };
        ln.receipts.push(e);
        if (e.shot) ln.frames.push({ path: e.shot, why: "판정", url: e.url, t: e.t,
          caption: `${e.id} · ${e.expected}${e.pass ? "" : " → 어긋남"}` });
        r.lanes.set(pth, ln);
      }
    }
  }
  if (!rows.size) return null;
  // 무효 표시는 판정보다 뒤에 오므로 한 번 더 걸러낸다. 앞에서 이미 담긴 것을 뺀다.
  if (voided.size) {
    for (const r of rows.values()) {
      for (const ln of r.lanes.values()) ln.receipts = ln.receipts.filter((x) => !voided.has(String(x.id)));
    }
    // 무효로 돌린 판정을 보고서에서 통째로 빼면 그 줄만 보는 사람은 판정이 있었다는 사실조차
    // 모른다. 사유를 요구해 놓고 그 사유를 싣지 않는 셈이다(확인 결과: 통과
    // 판정 하나가 다른 줄의 내용을 사유로 달고 제외됐고, 그 줄 화면에는 흔적이 없었다).
    // 옛 회차의 무효 사건에는 줄이 안 박혀 있으므로 영수증에서 되찾는다.
    for (const v of voids) {
      const src = receipts.get(v.receipt);
      const rid = v.row || (src && src.row), pth = v.path_ || (src && src.path_);
      if (!rid) continue;
      const r = rows.get(rid); if (!r) continue;
      const ln = r.lanes.get(pth) || [...r.lanes.values()][0]; if (!ln) continue;
      (ln.voids = ln.voids || []).push({ ...v, expected: src && src.expected, pass: src && src.pass });
    }
  }
  // 곁가지로 표시된 장면은 그 줄의 증거에서 뺀다. 지우지 않고 사유와 함께 따로 싣는다.
  if (aside.size) {
    for (const r of rows.values()) {
      for (const ln of r.lanes.values()) {
        ln.aside = ln.frames.filter((f) => aside.has(String(f.path)))
          .map((f) => ({ ...f, why: aside.get(String(f.path)) }));
        ln.frames = ln.frames.filter((f) => !aside.has(String(f.path)));
      }
    }
  }
  return { kind, rows: [...rows.values()], notes, receipts, voided, list, sets };
}

// 색은 여섯이다. 이름과 뜻을 한 곳에 둔다. 보고서 화면·집계·정렬이 같은 표를 본다.
const COLOR = {
  red: { label: "흐름 깨짐", lede: "반드시 고쳐야 한다", rank: 0 },
  orange: { label: "쓰기 어렵다", lede: "고칠 대상이다", rank: 1 },
  yellow: { label: "수정 권함", lede: "판단이 필요하다", rank: 2 },
  blue: { label: "정해야 함", lede: "QA가 정할 수 없다 — 사람이 정한다", rank: 3 },
  gray: { label: "분류 불가", lede: "무엇인지 못 가렸다", rank: 4 },
  green: { label: "정상", lede: "", rank: 5 },
};
// 줄의 색은 그 줄의 경로 중 가장 나쁜 것이다. 정상 경로만 확인하고 통과로 덮는 것을 막는다.
function rowColor(r) {
  let worst = null;
  for (const ln of r.lanes.values()) {
    if (!ln.color) continue;
    if (!worst || COLOR[ln.color].rank < COLOR[worst].rank) worst = ln.color;
  }
  return worst || "gray";
}

// 한 줄을 그린다. 경로마다 그때 실행한 프레임이 순서대로 놓이고, 그 흐름이 곧 녹화본이다.
// 무엇을 실을지 고르는 단계가 없다. 장부에 있는 것이 전부 실린다.
// 근거 원문. 이름만 적으면 읽는 사람이 명세를 찾아 열어야 하고, 그러면 보고서가 혼자 서지
// 못한다. 적힌 문장을 그대로 싣고, 그 화면이 있으면 함께 싣는다. 문서를 열지 않고 판단한다.
// 이 장면 파일이 정말 그때 찍힌 것인가.
//
// 장부는 "이 줄의 증거는 이 파일"이라고 적지만 파일은 나중에 바뀔 수 있다.
// 회차 도중 앱이 재시작되면 프레임 번호가 1로 돌아가 앞서 찍은 열여섯 장을 덮고, 보고서 화면은
// 그 그림을 그 줄의 증거로 싣는다. 원인은 고쳤지만 고침이 적용되지 않는
// 옛 회차가 남아 있고, 다른 이유로 같은 일이 또 생길 수 있다.
//
// 판정은 추측이 아니다. 장부에 적힌 시각보다 파일이 한참 뒤에 쓰였으면 그 파일은 그때 그것이
// 아니다. 넉넉히 잡는다. 찍고 저장하는 데 걸리는 시간과 시계 오차를 넘길 만큼만 허용한다.
const STALE_AFTER_MS = 120000;
function frameStale(f) {
  if (!f || !f.path || !f.t) return false;
  try { return fs.statSync(f.path).mtimeMs - f.t > STALE_AFTER_MS; } catch { return false; }
}

// 주소를 사람이 읽는 만큼만. 호스트는 대개 같으니 경로가 정보다.
function shortUrl(u) {
  if (!u) return "";
  try { const x = new URL(String(u)); return x.pathname + (x.search ? x.search.slice(0, 30) : ""); }
  catch { return String(u).slice(0, 40); }
}

// 이 레인의 장면들이 몇 가지 주소에서 왔는가. 하나면 표시하지 않고, 여럿이면 그 사실만 적는다.
// 어느 것이 옳은지는 사람이 정한다. 판단하지 않고 세기만 하므로 대리 판정이 아니다.
function lanePaths(ln) {
  return [...new Set((ln.frames || []).map((f) => shortUrl(f.url)).filter(Boolean))];
}

// 결정을 읽는 사람은 이 화면을 안 봤고 코드도 안 읽는다. 한 덩어리 산문은 훑을 수 없어서
// 읽고 넘기는 것 말고 할 수 있는 것이 없다. 짧게 쓰기를 기대하는 대신 화면이 문장마다 줄을 나눈다. 기대하는 것은
// 지켜지지 않고, 다음 회차의 글은 또 한 덩어리로 온다.
//
// 숫자 뒤의 마침표는 문장 끝이 아니다(1.0.24·102-103). 그 자리만 빼고 나눈다.
function sentences(s) {
  return String(s == null ? "" : s)
    .split(/\n+/)
    .flatMap((para) => para.split(/(?<=[^0-9]\.|[?!])\s+/))
    .map((x) => x.trim()).filter(Boolean);
}
const lineHtml = (s) => sentences(s).map((x) => `<p>${esc(x)}</p>`).join("");

function basisBlock(dir, o, key) {
  const quotes = (o && o.quotes && o.quotes.length) ? o.quotes : (o && o.quote ? [o.quote] : []);
  const kept = o && o.sourceShot ? keepShot(dir, o.sourceShot, `basis-${key}`) : null;
  if (!quotes.length && !kept) return "";
  return `<div class="basis"><h4>근거 원문</h4>
    ${quotes.map((q) => `<blockquote>${esc(String(q))}</blockquote>`).join("")}
    ${kept ? `<div class="proof">${shotRow([{ src: dataUri(kept), file: kept,
      label: o.source ? String(o.source).slice(0, 40) : "그 문서" }])}</div>` : ""}</div>`;
}

// 결정 카드는 세 칸이다. 무엇을 보았나(근거) · 왜 정해야 하나 · 무엇을 고를 것인가.
// 순서를 바꾸지 않는다. 근거보다 질문이 먼저 오면 읽는 사람이 무엇을 보고 답해야 하는지
// 모른 채 질문부터 받는다.
// blue는 "사용자가 정해야 함"이다. 판정문만 실으면 읽는 사람은 무엇을 정하라는 것인지
// 모른 채 문장을 받는다. 노트와 같은 분류로 둔다.
const PICK_NUM = ["가", "나", "다", "라", "마"];
function picksBlock(o) {
  const picks = Array.isArray(o && o.options) ? o.options : [];
  if (!picks.length) {
    return o && o.color === "blue"
      ? `<p class="from">갈래 없음 — 간단한 결정</p>` : "";
  }
  return `<div class="nb ask lane-ask"><h4>무엇을 고를 것인가</h4>
    <div class="picks">${picks.map((x, k) => `<div class="pick">
      <b>${PICK_NUM[k] || k + 1}</b><span class="do">${esc(x.pick)}</span>
      <dl><div><dt>고르면</dt><dd>${esc(x.then)}</dd></div>
      ${x.cost ? `<div><dt>대신</dt><dd>${esc(x.cost)}</dd></div>` : ""}</dl></div>`).join("")}</div>
    ${o.lean ? `<p class="lean"><b>밟은 사람 생각</b> ${esc(o.lean)}</p>` : ""}</div>`;
}

function noteCard(dir, nt) {
  const shot = nt.shot ? keepShot(dir, nt.shot, "note-" + nt.id) : null;
  const basis = basisBlock(dir, nt, "note-" + nt.id);
  const picks = Array.isArray(nt.options) ? nt.options : [];
  return `<section class="req note"><header><span class="num">${esc(nt.id)}</span>
    <h2>${esc(sentences(nt.what)[0] || nt.what)}</h2>
    ${nt.simple ? `<span class="tag">간단한 결정</span>` : ""}</header>

    <div class="nb"><h4>무엇을 보았나</h4>
      ${lineHtml(sentences(nt.what).slice(1).join(" ")) || `<p class="from">위 한 줄이 전부임.</p>`}
      ${nt.row ? `<p class="from">${esc(nt.row)} 줄을 밟다가 나옴.</p>` : ""}
      ${shot ? `<div class="proof">${shotRow([{ src: dataUri(shot), file: shot,
        label: "그때 화면" }])}</div>` : ""}
      ${basis}
      ${!shot && !basis ? `<p class="from">붙일 근거 없는 자리</p>` : ""}</div>

    ${nt.why ? `<div class="nb"><h4>왜 정해야 하나</h4>${lineHtml(nt.why)}</div>` : ""}

    <div class="nb ask"><h4>정해야 할 것</h4>
      <p class="q">${esc(nt.decide)}</p>
      ${picks.length
        ? `<div class="picks">${picks.map((o, k) => `<div class="pick">
            <b>${PICK_NUM[k] || k + 1}</b><span class="do">${esc(o.pick)}</span>
            <dl><div><dt>고르면</dt><dd>${esc(o.then)}</dd></div>
            ${o.cost ? `<div><dt>대신</dt><dd>${esc(o.cost)}</dd></div>` : ""}</dl></div>`).join("")}</div>`
        : `<p class="from">갈래 없음 — 간단한 결정</p>`}
      ${nt.lean ? `<p class="lean"><b>밟은 사람 생각</b> ${esc(nt.lean)}</p>` : ""}</div>
  </section>`;
}

function ledgerCard(dir, r, i) {
  const c = rowColor(r), meta = COLOR[c];
  const lanes = r.paths.map((p2) => r.lanes.get(p2) || { path: p2, frames: [], receipts: [] });
  const line = (k, v) => (v ? `<div class="qa"><dt>${k}</dt><dd>${esc(String(v))}</dd></div>` : "");
  const basisHard = r.basis === "spec" || r.basis === "plan" || r.basis === "user";
  const laneHtml = lanes.map((ln, k) => {
    const lc = ln.color ? COLOR[ln.color] : null;
    // 덮인 파일은 증거 자리에 세우지 않는다. 그림을 보여주는 것보다 "그 그림이 없다"가 낫다.
    const live = ln.frames.filter((f) => !frameStale(f));
    const stale = ln.frames.length - live.length;
    // 열려 있는 동안 지나간 것이 전부 이 줄의 장면이 되면 한 줄에 수십 장이 실린다. 그것은
    // 검토 자료가 아니라 더미다. 뜻을 담아 남긴 것(설명을 달아 찍은 장면·판정이 남긴 화면)은
    // 하나도 접지 않고, 저절로 흐른 녹화분만 처음과 끝만 남기고 접는다. 접은 수를 적는다.
    // 반드시 서는 것: 설명을 달아 일부러 찍은 장면, 그리고 어긋난 판정이 남긴 화면.
    // 접는 것: 통과한 판정의 화면(판정은 아래 표에 글로 다 있다)과 흐르는 녹화분.
    // 접어도 처음과 끝은 남긴다. 그 줄이 어디서 시작해 어디서 끝났는지는 보여야 한다.
    const meant = (f) => f.why === "찍음" || (f.why === "판정" && /어긋남/.test(f.caption || ""));
    const rest = live.filter((f) => !meant(f));
    // 무엇을 남길지는 판정 자리가 정한다.
    //
    // 접기는 처음 둘과 끝 둘을 남긴다. 다만 실행 도중 세션이 끊기면 다시 로그인하는 화면이
    // 레인의 앞부분에 오고, 그래서 "처음 둘"이 줄마다 로그인이 된다. 확인 결과:
    // 증거 300장 중 67장이 로그인·문자 인증이었고 전부 저절로 흐른 녹화분이었다(일부러 찍은
    // 로그인은 0장). 사람이 보고서를 열면 줄마다 로그인이 먼저 보인다.
    //
    // 무엇이 범위 밖인지를 목록으로 받지 않는다. 경우마다 새 문자열이 필요하고 끝이 없다.
    // 그 줄이 판정을 내린 주소 갈래가 곧 그 줄의 화면이다. 그 갈래의 것을 먼저 뽑고, 모자라면
    // 나머지로 채운다. 빼는 것이 아니라 고르는 순서라서, 판정 자리를 못 아는 줄(앱 판정·
    // 주소 없는 옛 회차)에서는 지금까지와 똑같이 동작한다.
    const judged = new Set(ln.receipts.map((f) => urlFamily(f.url)).filter(Boolean));
    const onSubject = (f) => { const fam = urlFamily(f.url); return !fam || judged.has(fam); };
    const pref = judged.size ? rest.filter(onSubject) : [];
    const pool = pref.length ? pref : rest;
    const keepRest = new Set(pool.length <= 4 ? pool
      : [pool[0], pool[1], pool[pool.length - 2], pool[pool.length - 1]]);
    const shown = live.filter((f) => meant(f) || keepRest.has(f));
    const folded = live.length - shown.length;
    // 접힌 것 중 판정 대상 밖이었던 것은 따로 센다. 몇 장이 어느 분류에서 왔는지가 보여야
    // 사람이 "그 줄이 로그인 벽에 몇 번 걸렸나"를 알 수 있다.
    const passedBy = {};
    if (judged.size) for (const f of live) {
      if (shown.includes(f) || onSubject(f)) continue;
      const k = urlFamily(f.url); passedBy[k] = (passedBy[k] || 0) + 1;
    }
    const kept = shown.map((f, n) =>
      keepShot(dir, f.path, `${r.id}-${ln.path}-${String(n + 1).padStart(3, "0")}`)).filter(Boolean);
    // 장면마다 어느 주소에서 찍은 것인지 함께 싣는다. 이것이 없으면 "매물 관리" 줄에 로그인
    // 화면이 실려도 읽는 사람이 알 방법이 없다.
    // 주소는 도구가 찍는 순간 적은 사실이라 판단이 끼지 않는다.
    // 라벨은 순서가 아니라 무엇인지로 붙인다. 자동으로 남은 전·후인지, 설명을 달아 찍은
    // 장면인지, 판정이 남긴 화면인지. 읽는 사람이 그림 하나하나의 성격을 먼저 안다.
    const cells = kept.map((p3, n) => {
      const f = shown[n] || {};
      const label = f.why === "찍음" ? "찍음" : f.why === "판정" ? "판정"
        : f.why === "before" ? "조작 전" : f.why === "after" ? "조작 후"
        : n === 0 ? "처음" : n === kept.length - 1 ? "끝" : String(n + 1);
      return { src: dataUri(p3), file: p3, label, marks: readMarks(p3),
        said: f.caption || "", note: shortUrl(f.url) };
    });
    const stage = cells.length ? shotStage(cells, cells.length > 2) : { html: "", cls: "" };
    const lp = [...new Set(shown.map((f) => shortUrl(f.url)).filter(Boolean))];
    const rcs = ln.receipts.map((x) => `<div class="qa"><dt>${x.id}</dt><dd>${
      esc(String(x.expected || ""))}${x.got != null && String(x.got) !== String(x.expected)
        ? ` → ${esc(String(x.got).slice(0, 80))}` : ""}</dd></div>`).join("");
    return `<section class="lane ${ln.color || "open"}">
      <h3><span class="lane-n">${esc(ln.path)} 경로</span>${lc
        ? `<span class="chip ${ln.color}">${lc.label}</span>` : `<span class="chip gray">안 밟음</span>`}
        <span class="lane-c">장면 ${kept.length}${folded ? ` (녹화 ${folded}장 접음)` : ""}${
          ln.same ? ` · 안 변한 장면 ${ln.same}장` : ""}${
          shown.length !== kept.length ? ` · ${shown.length - kept.length}장은 사라짐` : ""} · 판정 ${ln.receipts.length}${
          lp.length > 1 ? ` · 주소 ${lp.length}가지` : ""}</span></h3>
      ${stale ? `<p class="lane-warn">장면 ${stale}장이 장부 시각보다 뒤에 쓰인 파일<br>촬영 시점 불일치<br>증거 아님</p>` : ""}
      ${(ln.voids || []).length
        ? `<p class="lane-warn">무효로 돌린 판정 ${ln.voids.length}건<br>${
            ln.voids.map((v) => `${esc(v.receipt)}${v.expected ? ` · ${esc(String(v.expected))}` : ""}${
              v.pass ? " · 통과 판정" : ""}<br>사유: ${esc(String(v.why || ""))}`).join("<br>")
          }</p>`
        : ""}
      ${Object.keys(passedBy).length
        ? `<p class="lane-warn">지나간 자리 ${Object.values(passedBy).reduce((a2, b2) => a2 + b2, 0)}장<br>${
            Object.entries(passedBy).map(([k, v]) => `${esc(k)} ${v}장`).join("<br>")
          }<br>판정을 낸 자리: ${esc([...judged].join(" · "))}<br>접은 것<br>회차 폴더에 그대로</p>`
        : ""}
      ${lp.length > 1 ? `<p class="lane-warn">장면 출처 주소 ${
        lp.length}가지<br>${lp.slice(0, 4).map(esc).join("<br>")}${
        lp.length > 4 ? "<br>…" : ""}<br>장면마다 대상 화면 확인할 것</p>` : ""}
      ${ln.note ? `<div class="lane-note">${lineHtml(ln.note)}</div>` : ""}
      ${picksBlock(ln)}
      ${stage.html ? `<div class="proof">${stage.html}</div>`
        : `<p class="noproof">${stale ? "장면 파일 덮임. 남아 있지 않음"
          : ln.color ? "장면 없음" : "밟지 않음"}</p>`}
      ${rcs ? `<dl class="qalist">${rcs}</dl>` : ""}${
        (ln.aside || []).length ? `<p class="lane-aside">증거 아님으로 표시한 장면 ${
          ln.aside.length}장<br>${esc(ln.aside[0].why || "")}</p>` : ""}</section>`;
  }).join("");
  return `<section id="q${i + 1}" class="req case ${c} row"><header><span class="num">${esc(r.id)}</span>
    <h2>${esc(r.what)}</h2><span class="chip ${c}">${meta.label}</span></header>
    <dl class="qalist">${line("조건", r.given)}
      <div class="qa"><dt>기대 근거</dt><dd><b${basisHard ? "" : ' class="no"'}>${
        esc(r.basis)}</b>${basisHard ? `<span class="hardnote">미충족 시 red 고정</span>` : ""}${
        r.basisNote ? `<div class="bnote">${esc(r.basisNote)}</div>` : ""}</dd></div>
      ${r.source ? `<div class="qa"><dt>어디에</dt><dd>${esc(r.source)}</dd></div>` : ""}
    </dl>${basisBlock(dir, r, r.id)}${laneHtml}</section>`;
}

// 몇 항목부터 조밀 지면으로 바꾸는가. 13~25개 회차는 한 항목이 한 화면일 때 잘 읽혔고,
// 94개에서 무너졌다(문서 95000px). 그 사이 어디를 경계로 둘지는 취향이 아니라 규모의 문제다.
const DENSE_FROM = 40;

function buildReport({ title, summary, steps, out, kind, runId, target, setup, run, resume, overview }) {
  const handoff = kind === "handoff";
  const rid = runId || "run-" + Date.now();
  const dir = runStore(rid);
  const kept = [];
  // 이어받은 단계가 앞에 온다. 읽는 사람이 "어디까지는 그때 것이고 어디부터 이번 것인지"를
  // 위에서부터 순서대로 알 수 있게.
  // 장부에 줄이 있으면 화면은 장부를 그린다. 무엇을 실을지 고르는 단계가 없어진다.
  const led = handoff ? null : readLedger(rid);
  const res = resumeSteps(resume);
  const allSteps = [...res.carried, ...(steps || [])];
  const built = allSteps.map((s, i) => {
    const n2 = String(i + 1).padStart(2, "0");
    const before = keepShot(dir, s.before, `s${n2}-before`);
    const diff = keepShot(dir, s.diff, `s${n2}-diff`);
    const rc = receiptById(s.receipt || (Array.isArray(s.receipts) ? s.receipts[0] : null));
    const v = s.verdict === "fail" ? "fail" : s.verdict === "info" ? "info" : "pass";
    const vt = v === "fail" ? "안 됨" : v === "info" ? "참고" : "됨";
    const cap = (p2) => { try { return fs.readFileSync(String(p2) + ".caption.txt", "utf8").trim(); } catch { return ""; } };
    // 한 화면에서 볼 것이 여럿이면 확인도 여럿이다. 영수증마다 그 순간의 증거 장면이 이미 있으므로
    // 그것들을 그대로 싣는다. 하나만 찍고 나머지를 글로 적으면 확인이 아니라 주장이 된다.
    const rcs = (Array.isArray(s.receipts) ? s.receipts : (s.receipt ? [s.receipt] : []))
      .map((id) => receiptById(id)).filter(Boolean);
    // 영수증에는 판정한 그 순간의 장면이 이미 붙어 있다. 부르는 쪽이 after를 안 넘겼다고 그것을
    // 안 그리면 증거가 디스크에 있는데 보고서에는 "사진 없음"이 찍힌다(확인 결과).
    const after = keepShot(dir, s.after || s.shot || (!handoff && rc ? rc.shot : null), `s${n2}-after`);
    const keptRow = { step: i + 1, name: s.name || "", before, after, diff };
    kept.push(keptRow);
    const extra = handoff ? [] : rcs.slice(rc ? 1 : 0).map((r2, k) => keepShot(dir, r2.shot, `s${n2}-c${k + 2}`));
    // 각 장면이 증명하는 것을 그 장면에 붙인다. 판정을 따로 몰아 두면 어느 사진이 어느 주장의
    // 근거인지 매번 다시 확인해야 한다. 그 확인이 반복되면 결국 보지 않게 된다.
    const proof = (r2) => (!r2 || handoff ? null
      : { pass: !!r2.pass, text: String(r2.got && String(r2.got) !== String(r2.expected)
          ? `${r2.expected} → ${String(r2.got).slice(0, 60)}` : (r2.expected || "")).slice(0, 90) });
    // 한 동작이 여러 화면을 지난다. 누르기 전, 확인 다이얼로그, 반영된 뒤. 그것을 항목 셋으로
    // 나누면 읽는 사람이 같은 것을 세 번 읽는다. 한 항목에 순서대로 세워 여정으로 읽게 한다.
    const via = (Array.isArray(s.via) ? s.via : (s.via ? [s.via] : []))
      .map((v, k) => keepShot(dir, v, `s${n2}-via${k + 1}`)).filter(Boolean);
    const cells = [
      { src: dataUri(before), file: before, label: "전", marks: readMarks(before), note: cap(before) },
      ...via.map((p3, k) => ({ src: dataUri(p3), file: p3, label: via.length > 1 ? `거쳐 ${k + 1}` : "거쳐",
        marks: readMarks(p3), note: cap(p3) })),
      { src: dataUri(after), file: after, label: handoff ? "이렇게 보이면 정상" : "후",
        marks: readMarks(after), note: cap(after), check: proof(rcs[0]) },
      ...extra.map((p3, k) => ({ src: dataUri(p3), file: p3, label: "확인 " + (k + 2),
        marks: readMarks(p3), note: cap(p3), check: proof(rcs[k + 1]) })),
      ...(handoff ? [] : [{ src: dataUri(diff), file: diff, label: "달라진 곳" }]),
    ];
    if (via.length) keptRow.via = via;
    const stage = handoff ? { html: shotRow(cells), cls: "" } : shotStage(cells, rcs.length > 1 || via.length > 0);
    const shots = stage.html;
    const kv = (k, val) => (val ? `<div class="kv"><b>${k}</b><span>${esc(val)}</span></div>` : "");
    // 사진이 있는가가 이 단계의 성격을 바꾼다. 통과인데 화면이 없으면 그것은 확인이 아니라
    // 글로 적은 주장이다. 통과와 같은 모양으로 그리면 읽는 사람이 구별할 방법이 없다.
    const proven = !!(after || extra.some(Boolean));
    if (handoff) {
      const card = `<section class="step"><header><span class="n">${i + 1}</span>
        <h2>${esc(s.name || "확인")}</h2></header>
        <div class="detail">${kv("한다", s.action)}${kv("보인다", s.expected)}</div>${shots}</section>`;
      return { card, row: "", v, proven };
    }
    // 한 줄씩 같은 위치에 놓는다. 원한 것, 나온 것, 그 증거 순이고 이 순서가 곧 읽는 순서다.
    const line = (k, val) => (val ? `<div class="qa"><dt>${k}</dt><dd>${esc(val)}</dd></div>` : "");
    // 원한 것과 나온 것이 같으면 "나온 것" 줄은 아무것도 더하지 않는다. 같다는 사실은 머리의
    // 됨 태그가 이미 보여 준다. 다를 때만 적는다. 그때는 그 값이 유일하게 새로운 정보다.
    const gotRows = rcs.length
      ? rcs.filter((r2) => !r2.pass || (r2.got != null && String(r2.got) !== String(r2.expected)))
          .map((r2) => `<div class="qa"><dt>나온 것</dt><dd>${
            esc(String(r2.got ?? "").slice(0, 160)) || "—"}</dd></div>`).join("")
      : (s.got && String(s.got) !== String(s.expected) ? line("나온 것", s.got) : "");
    // 출처는 "원한 것" 바로 아래에 붙는다. 기대와 그 근거는 함께 읽어야 뜻이 있다.
    const basisKey = String(s.basis || "");
    const basisMeta = BASIS[basisKey];
    // 출처가 있으면 그 자리에서 알려 주고, 없으면 라벨만 둔다. 왜 그렇게 잡았는지는 바로 아래
    // 눈에 띄는 블록이 받는다. 같은 문장을 두 곳에 두면 읽는 사람이 무엇이 새 정보인지 못 가린다.
    const basisLine = basisMeta
      ? `<div class="qa"><dt>기대 근거</dt><dd>${
          basisKey === "assumed"
            ? `<b class="no">${esc(basisMeta.label)}</b>`
            : esc(basisMeta.label) + (s.basisNote ? ` · ${esc(String(s.basisNote).slice(0, 240))}` : "")
        }</dd></div>`
      : "";
    // 화면을 주장했으면(expected) 판정이 무엇이든 사진이 있어야 한다. 표시를 pass에만 붙이면
    // 사진 없는 주장이 전부 info로 빠져나간다. 아무것도 주장하지 않은 메모에는 묻지 않는다.
    const claims = !!String(s.expected || "").trim();
    const why = String(s.noShot || "").trim();
    const proofBlock = proven ? `<div class="proof">${shots}</div>`
      : why ? `<p class="noproof"><b>사진 없이 적은 것</b><br>${esc(why.slice(0, 300))}</p>`
      : claims ? `<p class="noproof">화면 확인 아님. 글로 적은 것</p>`
      : "";
    // 출처 없는 기대는 읽는 사람이 그 자리에서 알아야 한다. 다른 문서를 찾아보게 하지 않는다.
    const assumedBlock = basisKey === "assumed"
      ? `<p class="assumed"><b>기대를 내가 정했다 — 문서에 근거 없음.</b>
         ${esc(String(s.basisNote || "").slice(0, 400))}</p>`
      : "";
    // 영수증 번호·시각은 근거를 되짚을 사람에게만 필요하다. 카드 맨 아래 작은 줄로 둔다.
    const trace = [rcs.map((r2) => r2.id).join(" "), s.at].filter(Boolean).join(" · ");
    // 넓은 화면 회차는 사진 한 장이 폭을 다 쓰므로 왼쪽 사진·오른쪽 목록으로 나눈다.
    // 폰 화면 회차는 사진이 좁고 판정이 각 장에 이미 붙어 있으므로 나눌 이유가 없다. 제목 밑에
    // 한 줄 띠로 무엇을 원했는지만 두고, 여정을 폭 전체에 늘어놓는다.
    const look = proven || !claims ? v : "unproven";
    const strip = proven && stage.cls === " tall strip";
    const cardCls = `req case ${look}${proven ? (strip ? " strip" : " two" + stage.cls) : ""}`;
    // 적을 줄이 하나도 없으면 목록 자체를 만들지 않는다. 참고 단계처럼 원한 것도 한 일도 없는
    // 항목에 빈 테두리 상자가 그려져, 무엇이 빠진 것처럼 읽혔다.
    const qaRows = strip
      ? `${line("원한 것", s.expected)}${basisLine}${line("한 일", s.action)}`
      : `${line("원한 것", s.expected)}${basisLine}${gotRows}${line("한 일", s.action)}`;
    const qa = qaRows ? `<dl class="qalist${strip ? " band" : ""}">${qaRows}</dl>` : "";
    // 이어받은 단계는 이번에 실행한 것이 아니다. 같은 모양으로 그리면 읽는 사람이 "이번에 다
    // 확인했다"고 읽는다. 언제 어느 회차에서 온 것인지를 그 자리에 적는다.
    const carriedBlock = s.from
      ? `<p class="carried">이번 회차 미실행<br>${esc(String(s.from))}에서 이어받음${
          s.fromAt ? ` (${esc(String(s.fromAt).slice(0, 16).replace("T", " "))})` : ""}.</p>`
      : "";
    const card = `<section id="q${i + 1}" class="${cardCls}${s.from ? " carried" : ""}"><header><span class="num">${i + 1}</span>
      <h2>${esc(s.name || "확인")}</h2><span class="chip ${look}">${
        claims && !proven ? "사진 없음" : vt}</span>${
        s.from ? `<span class="chip carry">이어받음</span>` : ""}</header>
      ${qa}${carriedBlock}${assumedBlock}${proofBlock}${trace ? `<p class="trace">${esc(trace)}</p>` : ""}</section>`;
    // 훑는 구역은 지문을 같은 세로줄에 맞춘다. 시각이 거꾸로 가거나 엔터티가 나뉘거나 연결이
    // 한 줄만 다르면, 읽지 않고 눈을 내리는 것만으로 드러난다.
    const thumbs = [after, ...extra].filter(Boolean).slice(0, 3)
      .map((p3) => `<span class="th"><img src="${dataUri(p3)}" alt=""></span>`).join("");
    const row = `<tr class="${v}"><td class="t">${esc(s.at || "")}</td><td>${esc(s.name || "확인")}</td>
      <td class="id">${esc(s.entityId || "—")}</td><td class="id">${esc(s.wiring || "")}</td>
      <td class="v"><span class="chip ${v}">${vt}</span></td><td class="sh" data-q="${i + 1}">${thumbs}</td></tr>`;
    return { card, row, v, proven, name: String(s.name || "확인"), num: i + 1 };
  });
  const rows = built.map((b) => b.card).join("\n");
  // 항목이 수십 개를 넘으면 "한 항목이 한 화면"이 되돌아보기를 스크롤 노동으로 만든다.
  // 확인 결과: 94항목 회차가 문서 높이 95000px·106MB였고, 항목당 사진은 한 장이라
  // 그 화면의 대부분이 여백이었다. 규모가 바뀌면 배치도 바뀌어야 한다. 색인과 밀집 배치로 전환한다.
  const many = !handoff && built.length >= DENSE_FROM;
  const failed = built.filter((b) => b.v === "fail");
  const navBlock = many
    ? `<nav id="qnav"><b>안 됨 ${failed.length}</b>${
        failed.map((b) => `<a class="fail" href="#q${b.num}" title="${esc(b.name)}">${b.num}</a>`).join("")
      }<b class="all">전체 ${built.length}</b>${
        built.map((b) => `<a href="#q${b.num}" title="${esc(b.name)}">${b.num}</a>`).join("")}</nav>`
    : "";
  const n = allSteps.length, bad = allSteps.filter((s) => s.verdict === "fail").length;
  const checkIds = new Set(allSteps.flatMap((s) =>
    [String(s.receipt || ""), ...(Array.isArray(s.receipts) ? s.receipts.map(String) : [])].filter(Boolean)));
  const checks = [...checkIds].map((i2) => receiptById(i2)).filter(Boolean);
  const checkBad = checks.filter((r2) => !r2.pass).length;
  // 보고서에 없는 확인은 실패를 감출 수 있다. 실행 중 부른 판정 중 어느 것도 보고서에서
  // 빠질 수 없게, 빠진 것을 사실 그대로 적는다.
  const cited = new Set(allSteps.flatMap((s) =>
    [String(s.receipt || ""), ...(Array.isArray(s.receipts) ? s.receipts.map(String) : [])]));
  // 이 회차(이어받은 회차 포함)의 것만 본다.
  const missing = receiptsOfRun([rid, resume && resume.from]).filter((r) => !cited.has(r.id));
  // 요약이 먼저다. 이 회차를 믿을 만한지(연결·시작이 없음이었는지·정리)와 무엇이 안 됐는지가
  // 첫 화면에 다 들어와야 한다. 미확인을 여기 세우지 않으면 "안 됨 0건"이 "다 확인됨"으로 읽힌다.
  const R = run || {};
  const unver = Array.isArray(R.unverified) ? R.unverified : [];
  const rk = (k, v2) => (v2 ? `<div class="qa"><dt>${k}</dt><dd>${esc(String(v2))}</dd></div>` : "");
  // 연결·격리·정리는 이 회차를 믿을지 다시 확인하는 사람을 위한 것이다. 첫 화면에 두면 결론이 밀린다.
  // 무엇을 확인하기로 했는지가 먼저다. 결과부터 보면 읽는 사람은 그 결과가 전부라고 생각한다.
  // 빠뜨린 것은 이 목록과 대조해야만 드러나고, 목록이 없으면 대조할 것이 없다.
  // 도중에 더해진 것은 표시가 붙는다. 범위가 자란 회차와 처음부터 그 범위였던 회차는 다르다.
  const agreedList = Array.isArray(R.agreed) ? R.agreed.filter((x) => x && String(x.what || "").trim()) : [];
  // 이어받았다는 사실은 맨 앞에 있어야 한다. 단계마다 흩어져 있으면 "이번에 몇 개를 실제로
  // 실행했는가"가 보이지 않고, 읽는 사람은 전부 이번에 확인한 것으로 읽는다.
  const resumeBlock = (!handoff && (res.from))
    ? `<section class="req sum resumed"><dl class="qalist">
       ${rk("이어받은 회차", String(res.from) + (res.at ? ` (${String(res.at).slice(0, 16).replace("T", " ")})` : ""))}
       ${rk("이번에 다시 밟지 않은 단계", res.carried.length ? `${res.carried.length}개 — 그때 확인된 그대로다` : "없음")}
       ${rk("이번에 밟은 단계", String((steps || []).length) + "개")}
       ${res.missing ? rk("이어받지 못함", res.missing) : ""}</dl></section>`
    : "";
  const runBlock = (!handoff && (R.intent || R.wiring || R.entity || R.scope || R.teardown || R.started))
    ? `<section class="req sum"><dl class="qalist">
       ${rk("무엇을 확인했나", R.intent)}${rk("어디에 붙어서 봤나", R.wiring)}${rk("다룬 데이터", R.entity)}
       ${rk("격리", R.scope)}${rk("쓰기 허용 범위", R.allowance)}
       ${rk("시각", R.started ? `${R.started}${R.finished ? " → " + R.finished : ""}` : "")}
       ${rk("시작할 때", R.startedEmpty === false ? "대상 데이터가 이미 있었다" : R.startedEmpty === true ? "대상 데이터 없음에서 시작" : "")}
       ${rk("끝나고 정리", R.teardown)}</dl></section>`
    : "";
  // 판정은 첫 화면 한 문장이다. 세는 단위는 단계가 아니라 "원한 것"이다. 참고로 남긴 단계는
  // 요구가 아니므로 분모에서 뺀다. 사진 없는 통과를 됨에 섞으면 이 문장 자체가 거짓이 된다.
  const reqs = allSteps.map((s, i) => ({ s, i, ...built[i] })).filter((x) => x.v !== "info");
  const okReq = reqs.filter((x) => x.v === "pass" && x.proven);
  const unprovenReq = reqs.filter((x) => x.v === "pass" && !x.proven);
  const failReq = reqs.filter((x) => x.v === "fail");

  // 합의 목록이 보고서에 실리기만 하고 단계와 대조되지 않으면, 열 개를 합의하고 하나만 실행해도
  // 화면은 정상으로 보인다. 수만이라도 대조해 둔다. 한 단계가 여러 합의를 덮을 수 있으므로
  // 막지는 않고, 어긋난 사실을 눈에 보이게 한다.
  const agreedGap = (!handoff && agreedList.length && reqs.length < agreedList.length)
    ? `<p class="lede warn-line">확인하기로 한 것은 ${agreedList.length}개인데 판정한 단계는 ${reqs.length}개다 —
       한 단계가 여럿을 덮은 것이 아니라면 빠진 것이 있음.</p>`
    : "";
  // 무언가를 눌렀다고 적은 단계는 누르기 전 화면이 있어야 한다. 없으면 "그 화면이 원래
  // 그랬는지 이 조작이 바꾼 것인지"를 읽는 사람이 판단할 수 없다. 확인 결과: 24단계
  // 회차에서 전이 있는 것은 9개였고 그중 6개는 앞 단계의 후를 빌린 것이었다. 막지는 않는다
  // (전은 지나간 뒤에 만들 수 없어 거부가 회차 전체를 다시 실행하게 만든다). 대신 수를 세워 둔다.
  const acted = allSteps.map((s2, i) => ({ s2, i })).filter(({ s2 }) => String(s2.action || "").trim());
  const noBefore = acted.filter(({ i }) => !kept[i] || !kept[i].before);
  const beforeGap = (!handoff && noBefore.length)
    ? `<p class="lede warn-line">누른 단계 ${acted.length}개 중 ${noBefore.length}개에 "전"이 없다 —
       ${esc(noBefore.slice(0, 6).map(({ i }) => i + 1).join(", "))}${noBefore.length > 6 ? " 외" : ""}번.
       그 화면이 원래 그랬는지 이 조작이 바꾼 것인지는 전이 있어야 갈림.</p>`
    : "";
  // 항목마다 어느 단계가 덮었고 그 단계에 장면이 몇 장인지 적는다. 한 항목이 두 가지를
  // 주장하는데 단계 하나·장면 하나로 끝났다면 그 사실이 여기서 드러난다. 글자를 세어
  // 짐작하는 대신, 무엇으로 답했는지를 보여 준다.
  const shotsOf = (n) => {
    const k = kept[n - 1];
    if (!k) return 0;
    return [k.before, k.after, k.diff].filter(Boolean).length + (k.via ? k.via.length : 0);
  };
  const stepNo = (c) => {
    const key = String(c).trim();
    if (/^\d+$/.test(key)) return Number(key);
    const hit = allSteps.findIndex((st) => {
      const nm = String(st.name || "").trim();
      return nm === key || nm.startsWith(key);
    });
    return hit < 0 ? null : hit + 1;
  };
  const coverNote = (x) => {
    const ns = (Array.isArray(x.covers) ? x.covers : []).map(stepNo).filter(Boolean);
    if (!ns.length) return "";
    const shots = ns.reduce((a2, n) => a2 + shotsOf(n), 0);
    return ` <span class="mid">${ns.join("·")}번 · 장면 ${shots}장</span>`;
  };
  const agreedBlock = (!handoff && agreedList.length)
    ? `<h2 class="sec">확인하기로 한 것 ${agreedList.length}</h2>${agreedGap}${beforeGap}
       <section class="req sum"><dl class="qalist">${agreedList.map((x) =>
        `<div class="qa"><dt>${x.added === "mid" ? '<span class="mid">도중 추가</span>' : ""}</dt>
         <dd>${esc(String(x.what))}${coverNote(x)}</dd></div>`).join("")}</dl></section>`
    : "";
  // 첫 화면은 "어디를 보면 되는가" 하나다. 몇 가지 중 몇 가지라는 문장은 아래 번호가 이미
  // 말하고 있다. 세어 봐야 같은 수이고, 세는 동안 정작 볼 번호를 놓친다.
  const tone = failReq.length ? "bad" : unprovenReq.length ? "warn" : "ok";
  const at = (label, list, cls) => (list.length
    ? `<span class="pt ${cls}">${label} <b>${list.map((x) => x.i + 1).join(", ")}번</b></span>` : "");
  const pts = [
    at("안 됨", failReq, "bad"),
    // 안 된 것이 있으면 사진 없음은 그 다음 문제다. 둘 다 세우면 무엇부터 볼지가 흐려진다.
    failReq.length ? "" : at("사진 없음", unprovenReq, "warn"),
    unver.length ? `<span class="pt warn">확인 못 함 <b>${unver.length}건</b></span>` : "",
  ].filter(Boolean).join("");
  const KINDS = { review: "확인", proof: "증명", regression: "회귀", handoff: "넘기기" };
  const kindLabel = KINDS[String(kind || "review")] || "확인";
  // 요구가 하나도 없으면 "모두 됨"은 거짓이다. 공집합은 어떤 검사든 통과하므로, 아무것도
  // 확인하지 않은 회차가 가장 깨끗한 보고서를 냈다.
  const nothingChecked = !reqs.length;
  const verdictBlock = handoff ? ""
    : `<div class="verdict ${nothingChecked ? "warn" : tone}">${
        pts || (nothingChecked
          ? `<span class="pt warn"><b>확인한 것이 없음</b></span>`
          : `<span class="pt ok"><b>모두 됨</b></span>`)}</div>`;
  // 버린 구간이 보고서에 나오지 않으면, 게이트에서 그 구간의 위반이 지워졌다는 사실을 읽는 사람이
  // 알 방법이 없다. 얕게 확인한 구간을 통째로 빼고도 보고서는 정상으로 보인다.
  // 뺐다는 사실과 이유를 그대로 싣는다.
  const discardList = (Array.isArray(R.discarded) ? R.discarded : [])
    .filter((d) => d && (Array.isArray(d.receipts) ? d.receipts.length : 0));
  const discardBlock = (!handoff && discardList.length)
    ? `<h2 class="sec">결과 근거에서 뺀 구간 ${discardList.length}</h2>
       <p class="lede">결과에서 제외한 구간<br>제외 사유 병기</p>
       <section class="req info"><dl class="qalist">${discardList.map((d) =>
        `<div class="qa"><dt>${esc((d.receipts || []).join(" "))}</dt><dd>${
          esc(String(d.why || "이유가 적히지 않았다"))}</dd></div>`).join("")}</dl></section>`
    : "";
  const unverBlock = (!handoff && unver.length)
    ? `<h2 class="sec">확인 못 한 것 ${unver.length}</h2>
       <p class="lede">통과·실패 판정 아님</p>
       <section class="req info"><dl class="qalist">${
        unver.map((u) => `<div class="qa"><dt>${esc(u.what || "")}</dt><dd>${esc(u.why || "")}</dd></div>`).join("")}</dl></section>`
    : "";
  // 안 실린 확인에도 그 순간의 장면이 이미 붙어 있다. 글줄만 싣던 동안 그 그림들은 상태 폴더에
  // 남아 정리(60장·7일) 대상이 된다. 확인 결과: 영수증 107건짜리 회차에서 보고서가 인용한
  // 것은 20건이었고, 남은 87건의 장면 중 디스크에 살아 있는 것은 27장뿐이었다. 찍어 둔 증거를
  // 안 실어서 없어진 것이다. 그러므로 여기서도 회차 폴더로 옮기고(정리에서 살아남는다) 싣는다.
  // 장면은 전부 회차 폴더로 옮긴다. 상태 폴더의 정리(60장·7일)에서 지워지지 않아야 나중에 확인할
  // 수 있다. 다만 보고서에 넣는 것은 "안 됨"뿐이다. 이 구역의 목적이 감춰진 실패이고, 통과한
  // 것까지 모두 넣으면 보고서가 지나치게 무거워진다. 확인 결과: 영수증 195건 회차에서
  // 안 실린 182건을 전부 구웠더니 보고서가 31.7MB였다(안 됨만이면 그중 33건).
  const missKept = missing.map((r, k) => {
    const p2 = keepShot(dir, r.shot, `miss${String(k + 1).padStart(2, "0")}`);
    return { r, p: p2, show: !!p2 && !r.pass };
  });
  const missShown = missKept.filter((m) => m.show).length;
  const missHeld = missKept.filter((m) => m.p && !m.show).length;
  const missingBlock = (!handoff && missing.length)
    ? `<h2 class="sec">보고서에 안 실린 확인 ${missing.length}건</h2>
       <p class="lede">본문에 인용되지 않은 판정<br>장면은 판정 시점 기준${
         missHeld ? `<br>통과한 ${missHeld}건의 장면은 지면 무게 때문에 안 실림<br>회차 폴더(${esc(path.join(dir, "shots"))})에 miss 번호로 남아 있음.` : ""}</p>
       <div class="misses">${missKept.map(({ r, p: mp, show }) => `<figure class="miss${r.pass ? "" : " bad"}">
         ${show ? `<img src="${dataUri(mp)}" alt="" loading="lazy">`
              : mp ? `<div class="gone">장면은 회차 폴더에 있음</div>`
              : `<div class="gone">장면이 정리되어 없음</div>`}
         <figcaption><b>${r.id}</b> ${esc(String(r.expected || ""))} → ${r.pass ? "됨" : "안 됨"}${
           r.got ? ` · 실제 "${esc(String(r.got).slice(0, 80))}"` : ""}</figcaption></figure>`).join("")}</div>`
    : "";
  // 첫 화면은 한 문장이다. 미결(블루·그레이)을 여기 세우지 않으면 "흐름 깨짐 0건"이
  // "다 확인됨"으로 읽힌다. 안 됨을 세지 않는 것과 같은 종류의 오류다.
  const ledCount = {};
  if (led) for (const r of led.rows) { const c = rowColor(r); ledCount[c] = (ledCount[c] || 0) + 1; }
  const ledOrder = Object.keys(COLOR).sort((a2, b2) => COLOR[a2].rank - COLOR[b2].rank);
  const ledVerdict = led
    ? `<p class="verdict ${ledCount.red ? "bad" : ledCount.orange || ledCount.blue || ledCount.gray ? "warn" : "ok"}">${
        ledCount.red ? `흐름이 깨진 줄 ${ledCount.red}` : "흐름이 깨진 줄 없음"}${
        ledCount.blue || ledCount.gray ? ` · 아직 정하지 못한 줄 ${(ledCount.blue || 0) + (ledCount.gray || 0)}` : ""}</p>
       <div class="tally">${ledOrder.filter((c) => ledCount[c]).map((c) =>
         `<span class="pt ${c}"><b>${ledCount[c]}</b> ${COLOR[c].label}</span>`).join("")}</div>`
    : "";
  // 회차가 따른 목록. 2차 QA처럼 앞 회차의 지적을 받아 도는 경우, 그 목록이 맨 앞에 서야
  // "무엇을 고치기로 했고, 어느 줄이 그것을 봤고, 지금 어떻게 됐는가"가 이 문서 하나로 닫힌다.
  // 아무 줄도 보지 않은 항목은 그 자리에 그대로 남는다. 기록 없이 빠지지 않는다.
  const setsOf = led ? (led.sets && led.sets.length ? led.sets : (led.list ? [led.list] : [])) : [];
  const ledList = setsOf.filter((L) => (L.items || []).length).map((L, si) => (() => {
        const byItem = new Map();
        for (const r of led.rows) {
          for (const cv of (r.covers || [])) {
            if (!byItem.has(cv)) byItem.set(cv, []);
            byItem.get(cv).push(r);
          }
        }
        const shot = L.shot ? keepShot(dir, L.shot, `list${si}`) : null;
        const rowsHtml = L.items.map((it) => {
          const mine = byItem.get(it.id) || [];
          const worst = mine.length
            ? mine.map((r) => rowColor(r)).sort((a2, b2) => COLOR[a2].rank - COLOR[b2].rank)[0] : null;
          const itShot = it.shot ? keepShot(dir, it.shot, `list${si}-${it.id}`) : null;
          return `<div class="qa"><dt>${worst
            ? `<span class="chip ${worst}">${COLOR[worst].label}</span>` : `<span class="chip gray">안 다룸</span>`
            } ${esc(it.id)}</dt><dd>${esc(it.text)}${
            it.was ? `<span class="said"> — 그때: ${esc(it.was)}</span>` : ""}${
            it.at ? `<span class="said"> — ${esc(it.at)}</span>` : ""}${
            it.unused ? ` <span class="chip red">부르는 자리 없음</span>` : ""}${
            mine.length ? ` <span class="said">→ ${mine.map((r) => `<a href="#q${
              led.rows.indexOf(r) + 1}">${esc(r.id)}</a>`).join(" · ")}에서 봤다</span>`
              : ` <span class="mid">이번 회차가 안 봤다</span>`}${
            itShot ? `<div class="proof">${shotRow([{ src: dataUri(itShot), file: itShot,
              label: "그때 그 화면" }])}</div>` : ""}</dd></div>`;
        }).join("");
        // 안 본 항목의 수를 목록 머리에 세운다. 항목이 스무 개면 "안 봤다" 딱지 셋은
        // 스크롤 속에 묻히고, 읽는 사람은 다 본 목록과 구별하지 못한다.
        const unseen = L.items.filter((it) => !(byItem.get(it.id) || []).length);
        const head = unseen.length
          ? `<p class="verdict warn">${L.items.length}가지 중 ${
              L.items.length - unseen.length}가지를 봄 · 안 본 것 ${unseen.length}가지: ${
              esc(unseen.map((x) => x.id).join(" · "))}</p>`
          : `<p class="verdict ok">${L.items.length}가지를 다 봄</p>`;
        return `<h2 class="sec">${esc(L.name)}</h2>
        <p class="lede">이번 회차가 따른 목록<br>${L.from
          ? `항목을 손으로 적지 않고 <b>${esc(L.from.source)}</b>에서 <b>${esc(L.from.pick)}</b>로 떠 옴 — 코드에 있는 자리가 곧 목록${
              L.from.usedIn ? `<br>부르는 자리는 <b>${esc(L.from.usedIn)}</b>에서 파일 ${L.from.scanned || 0}개를 훑어 셈${
                L.from.capped ? ` · 상한 ${L.from.capped}개에 걸려 덜 훑은 결과` : ""}` : ""}`
          : "원문 없이 여기서 확인 가능"}${
          L.source && !L.from ? ` 출처: ${esc(L.source)}` : ""}</p>
        ${head}
        <section class="req sum"><dl class="qalist idx">${rowsHtml}</dl>${
          shot ? `<div class="proof">${shotRow([{ src: dataUri(shot), file: shot,
            label: "목록 원문" }])}</div>` : ""}</section>`;
      })()).join("");
  // 사람이 보고서를 여는 이유는 "무엇부터 봐야 하는가"다. 카드가 한 화면씩이라 훑으려면
  // 스크롤을 다 내려야 하는데, 그 사이에 급한 줄이 어디 있는지가 안 보인다. 색 순서대로
  // 세우고 눌러서 그 줄로 이동한다. 흐름이 깨진 것이 항상 맨 위에 온다.
  const ledIndex = led
    ? `<h2 class="sec">줄 ${led.rows.length}</h2>
       <p class="lede">↓ 색이 급한 순<br>클릭 시 해당 줄로 이동</p>
       <section class="req sum"><dl class="qalist idx">${led.rows
         .map((r, n) => ({ r, n, c: rowColor(r) }))
         .sort((x, y) => COLOR[x.c].rank - COLOR[y.c].rank || x.n - y.n)
         .map(({ r, n, c }) => `<div class="qa"><dt><a href="#q${n + 1}"><span class="chip ${c}">${
           COLOR[c].label}</span> ${esc(r.id)}</a></dt><dd>${esc(r.what)}${
           (() => {
             const said = r.paths.map((p2) => r.lanes.get(p2)).find((ln) => ln && ln.note);
             return said ? `<div class="said">${esc(String(said.note))}</div>` : "";
           })()}</dd></div>`).join("")}</dl></section>`
    : "";
  // 질문이 하나로 좁혀지지 않은 판정. 선택자가 여러 곳에 걸리면 판정은 그중 하나만 보고 내려진다.
  // 판정문에 "(3곳 중 1번째)"로 적히지만 그것은 문자열이라 셀 수 없었고, 그래서 회차 전체에
  // 몇 건인지 알 수 없었다(확인 결과: matched 143건 전부 기록 없음).
  const wide = led ? [...led.receipts.values()].filter((x) => Number(x.matched) > 1) : [];
  const wideBlock = wide.length
    ? `<h2 class="sec">하나로 안 좁혀진 판정 ${wide.length}건</h2>
       <p class="lede">선택자가 여러 곳에 걸림<br>판정은 그중 하나만 봄<br>질문을 좁히면 사라짐</p>
       <section class="req sum"><dl class="qalist">${wide
         .map((x) => `<div class="qa"><dt>${esc(String(x.id))}</dt><dd>${
           esc(String(x.selector || ""))} — ${esc(String(x.matched))}곳${
           x.row ? ` · ${esc(String(x.row))}` : ""}</dd></div>`).join("")}</dl></section>`
    : "";
  // 조건이 곧 실행 순서다. 같은 조건을 쓰는 줄이 몇 개인지가 여기 보이면, 하나뿐인 조건은
  // 그 값이 한 가지 상태만 가진다고 선언한 것으로 읽힌다.
  const ledPlan = led
    ? (() => {
        const g = new Map();
        for (const r of led.rows) { if (!g.has(r.given)) g.set(r.given, []); g.get(r.given).push(r.id); }
        return `<h2 class="sec">조건 ${g.size}가지</h2>
        <p class="lede">같은 조건은 한 번의 준비로 함께 확인</p>
        <section class="req sum"><dl class="qalist">${[...g.entries()].map(([given, ids]) =>
          `<div class="qa"><dt>${esc(ids.join(" · "))}</dt><dd>${esc(given)}${
            ids.length === 1 ? ` <span class="mid">이 조건은 이 줄 하나뿐</span>` : ""}</dd></div>`).join("")}</dl></section>`;
      })()
    : "";
  // 고칠 코드가 없는 발견. 결함 목록에 섞으면 개발자는 고칠 수 없는 항목을 받고, 정해야 할
  // 사람은 그것이 자기 것인 줄 모른다.
  const ledNotes = led && led.notes.length
    ? `<h2 class="sec">정해야 할 것 ${led.notes.length}</h2>
       <p class="lede">고칠 코드가 없는 발견<br>결함 아님. 정해야 할 자리</p>
       ${led.notes.map((nt) => noteCard(dir, nt)).join("")}`
    : "";
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title || "확인 보고서")}</title>
<style>
/* 페이지는 항상 라이트다. 보고서는 인쇄되고 다른 사람에게 전달되므로 보는 사람의 설정에 따라
   바탕색이 바뀌면 안 된다. 같은 판정이 화면마다 다른 색으로 읽힌다. 다크 정의를 두지
   않는다(report-profile references/report-page.md 정본, check-report.mjs가 같은 것을 검사한다). */
:root{color-scheme:light;
 --bg:#fff;--bg2:#fafafa;--fg:hsl(0 0% 7%);--card:#fff;--line:hsl(0 0% 91%);--line2:hsl(0 0% 87%);
 --muted:hsl(0 0% 42%);--ink:hsl(0 0% 22%);
 --red:hsl(358 66% 48%);--red-2:hsl(0 100% 96%);--red-3:hsl(0 100% 95%);
 --green:hsl(133 50% 32%);--green-2:hsl(120 60% 95%);--green-3:hsl(120 60% 91%);
 --amber:hsl(30 100% 32%);--amber-2:hsl(44 100% 92%);--amber-3:hsl(43 96% 87%);
 --blue:hsl(211 100% 42%);--blue-2:hsl(210 100% 96%);--blue-3:hsl(209 95% 93%);
 --purple:hsl(272 51% 54%);--purple-2:hsl(276 100% 97%);--purple-3:hsl(276 100% 92%);
 --sans:"Geist","Pretendard Variable",Pretendard,"Apple SD Gothic Neo",-apple-system,BlinkMacSystemFont,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
 font:14px/1.6 var(--sans);font-variant-numeric:tabular-nums;word-break:keep-all;padding:24px 16px 56px}
/* 검증용은 데스크탑에서 본다. 좁은 단으로 제한하면 남는 가로 폭만큼 세로가 길어지고, 그만큼
   대조가 스크롤 작업이 된다. 안내서(handoff)는 종이로도 보므로 좁은 단을 유지한다. */
.wrap{max-width:1000px;margin:0 auto}
/* 넓은 화면에서 끝까지 늘리면 사진은 세로 제한에 걸려 더 커지지 않고 글줄만 길어진다. 폭이
   더 커져도 얻는 것이 없는 지점(사진 폭 + 글 칸)에서 끊고 가운데에 배치한다. */
/* 검토용 페이지는 창 폭을 다 쓴다. 캡처를 크게 넣어도 페이지가 좁으면 그만큼 줄어든다.
   상한은 산문 한 줄이 너무 길어지지 않게 하려는 것이고, 산문 블록은 저마다
   자기 max-width를 가지므로 페이지를 넓혀도 글줄은 길어지지 않는다. */
.wrap.rev{max-width:min(2400px, calc(100vw - 40px))}
h1{font-size:22px;margin:0 0 6px;letter-spacing:-.02em;font-weight:600;line-height:1.3}
.lede{color:var(--muted);margin:0 0 12px;font-size:13px}
.tally{display:flex;gap:8px;margin:0 0 26px;flex-wrap:wrap}
.tally span{background:var(--card);padding:5px 12px;font-size:13px;border:1px solid var(--line);border-radius:8px}
/* 결론이 첫 화면을 차지한다. 세부는 그 아래 어디든 두어도 되지만 이 한 문장은 밀리면 안 된다. */
.verdict{background:var(--bg2);padding:12px 14px;margin:0 0 14px;border:1px solid var(--line);
 border-left:4px solid var(--tone);display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}
.verdict.ok{--tone:var(--green)}.verdict.warn{--tone:var(--amber)}.verdict.bad{--tone:var(--red)}
/* 수치 칸은 칸마다 따로 카드(P1b). 결정적 수치를 페이지에서 가장 크게 표시한다 */
.pt{font-size:12px;color:var(--muted);padding:10px 14px;background:var(--card);border:1px solid var(--line);
 display:inline-flex;flex-direction:column;gap:4px;min-width:120px}
.pt b{font-size:26px;font-weight:600;color:var(--fg);letter-spacing:-.035em;line-height:1.15}
.pt.bad{background:var(--red-2);border-color:var(--red-3)}.pt.bad b{color:var(--red)}
.pt.warn{background:var(--amber-2);border-color:var(--amber-3)}.pt.warn b{color:var(--amber)}
.pt.ok b{color:var(--green)}
/* 한 요구 = 한 장. 번호·이름·판정이 한 줄, 그 아래 원한 것 / 나온 것, 그 아래 사진. */
.req,.step{background:var(--card);padding:14px 16px 12px;margin:0 0 12px;
 border:1px solid var(--line);border-radius:8px}
/* 한 케이스가 한 화면 전체를 차지한다. 여러 개가 한 화면에 겹치면 어느 사진이 어느 주장의
   근거인지 매번 다시 확인해야 한다. 스크롤은 케이스 경계에서만 멈춘다. 반쯤 걸친 화면이
   없어야 "지금 보고 있는 것이 몇 번"이 항상 분명하다. */
/* mandatory로 지정하면 마지막 케이스 아래(되짚을 기록)가 스냅 지점이 아니어서 스크롤이 그리로
   가지 못하고 되돌아온다. 문서 끝 884px에 도달하지 못했다. proximity로 두고 케이스뿐 아니라
   뒤 구역도 스냅 지점으로 지정한다. 경계에 맞추되 고정하지는 않는다. 정확히 한 장씩 넘기는
   것은 PageUp/PageDown이 담당한다. */
html{scroll-snap-type:y proximity;scroll-behavior:smooth}
/* 높이는 최소값이지 최대값이 아니다. height로 고정하면 "크게"로 사진을 키운 순간 내용이 상자를
   넘쳐 뒤 케이스 위로 넘어가고, 그 안의 "작게" 단추가 다음 케이스에 가려져 다시는
   눌리지 않는다(확인 결과: 상자 919px 유지 · 내용 5568px · 단추가 5513px로 밀림). min-height면
   상자가 내용을 따라 늘어나 단추가 항상 해당 케이스 안에 남는다.
   content-visibility는 화면 밖 케이스를 렌더링하지 않는다. 장면이 100장을 넘으면 원본
   해상도 비트맵이 1GB를 넘겨 렌더러가 멈췄다(확인 결과: 28MB 보고서에서 스크린샷 25초 무응답).
   화면에 걸린 케이스만 렌더링하면 같은 파일이 즉시 표시된다. */
/* 좌우 여백이 0이면 4px 색 띠에 글자가 붙는다. 띠는 경계이지 글의 시작점이 아니다. */
.case{min-height:100vh;content-visibility:auto;contain-intrinsic-size:auto 100vh;
 margin:0;padding:14px 16px 10px;background:transparent;border:0;border-radius:0;
 border-top:1px solid var(--line);align-content:start;scroll-snap-align:start}
/* 판정 블록은 스냅 지점이 아니다. 지점으로 두면 맨 위에서 그리로 이동해 제목이 화면 밖으로
   밀린다(확인 결과: scrollTo(0,0)이 93에서 멈춤). 스냅은 케이스와 뒤 구역만. */
.back{scroll-snap-align:start}
/* 장면이 없는 항목은 한 화면을 차지할 이유가 없다. 창 높이로 잡아 두면 글 몇 줄 아래가 전부
   빈다. 내용 높이만큼만 잡는다. */
.case:not(:has(.stage)){min-height:0;contain-intrinsic-size:auto}
.case .qalist,.case .noproof{background:var(--card);padding:10px 14px;border:1px solid var(--line);border-radius:8px}
.case .qa:first-child{border-top:0}
/* 사진이 없는 케이스는 채울 것이 없다. 위에 몰아 두면 화면 대부분이 빈칸으로 남는다.
   가운데에 배치하고 폭을 제한해 한 덩어리로 읽히게 한다. */
.case:not(.two){display:grid;align-content:center;justify-items:start}
.case:not(.two) header{width:100%}
.case:not(.two) .qalist,.case:not(.two) .noproof{max-width:760px;width:100%}
.req.case.row > .qalist{max-width:none}
.req.case.row > .qalist .qa{padding:7px 0}
.req.case.row > .qalist dt{width:92px}
/* 왼쪽이 증거, 오른쪽이 그 증거로 무엇을 주장하는지. 글은 읽는 데 360px면 충분하고 남는 폭은
   전부 사진에 준다. 작아서 못 읽는 사진은 증거가 아니다. */
.req.two{display:grid;grid-template-columns:minmax(620px,1fr) minmax(260px,340px);
 column-gap:14px;align-items:start}
.req.two header,.req.two .trace{grid-column:1/-1}
.req.two .proof{grid-column:1;grid-row:2}
.req.two .qalist{grid-column:2;grid-row:2;margin-bottom:0}
.req.two.case .trace{grid-column:2;text-align:right}
/* 글줄이 화면 끝까지 늘어나면 눈이 줄 끝에서 다음 줄 앞을 못 찾는다. */
.req.two .qalist{max-width:860px}
/* 폰 화면 한 장. 영역을 사진 비율만큼만 잡는다. 글은 사진과 같은 높이에서 시작해야 둘이
   한 쌍으로 읽힌다. 가운데에 맞추면 글만 따로 떨어져 보인다. */
.req.two.tall.solo{grid-template-columns:auto minmax(420px,1fr);align-items:start}
.track.solo{width:calc((var(--sh) - 74px) * var(--ar) + 30px)}
/* 폰 화면 회차. 여정을 폭 전체에 늘어놓는다. 원한 것은 제목 밑 한 줄 띠로, 판정은 각 장면에. */
/* 여정 줄 카드는 제목 밑에 띠가 하나 더 있다. 그만큼 사진 영역을 줄여야 한 화면에 들어간다. */
.req.strip{display:block}
.req.strip .stage{--sh:max(300px,calc(100vh - 196px))}
.qalist.band{display:inline-flex;flex-wrap:wrap;gap:8px 26px;padding:8px 14px;margin:0 0 8px;background:var(--bg2)}
.qalist.band .qa{border-top:0;padding:0;gap:10px;align-items:baseline}
.qalist.band dt{width:auto}
.req header,.step header{display:flex;align-items:center;gap:9px;margin:0 0 8px}
.req h2,.step h2{font-size:16px;margin:0;flex:1;font-weight:600;letter-spacing:-.01em}
.n{width:26px;height:26px;background:var(--fg);color:#fff;display:grid;border-radius:4px;
 place-items:center;font-size:13px;font-weight:600;flex:none}
.num{min-width:26px;height:24px;padding:0 9px;background:var(--fg);color:#fff;
 display:inline-flex;align-items:center;justify-content:center;font-size:12.5px;
 font-weight:600;flex:none;border-radius:4px;letter-spacing:.02em;white-space:nowrap}
.hardnote{margin-left:8px;font-size:12px;color:var(--muted);font-weight:400}
.bnote{margin-top:3px;color:var(--muted);font-size:14px;line-height:1.65}
.chip{font-size:12px;padding:2px 8px;font-weight:500;flex:none;border-radius:4px;border:1px solid transparent;
 white-space:nowrap;display:inline-block}
.chip.pass{background:var(--green-2);color:var(--green);border-color:var(--green-3)}
.chip.fail{background:var(--red-2);color:var(--red);border-color:var(--red-3)}
.chip.info{background:var(--blue-2);color:var(--blue);border-color:var(--blue-3)}
.chip.unproven{background:var(--amber-2);color:var(--amber);border-color:var(--amber-3)}
.req.fail{border-left:4px solid var(--red)}.req.unproven{border-left:4px solid var(--amber)}
.qalist{margin:0 0 10px}
.qa{display:flex;gap:12px;padding:4px 0;font-size:14px;border-top:1px solid var(--line)}
.qa:first-child{border-top:0}
.qa dt{flex:none;width:112px;color:var(--muted);font-size:13px;padding-top:2px}
.qa dd{margin:0;flex:1;white-space:pre-wrap}
.qa dd b.no{color:var(--red);font-weight:700}
.proof{margin:0}
.noproof{margin:0;padding:10px 14px;background:var(--amber-2);
 border:1px solid var(--amber-3);border-radius:8px;font-size:13px}
h1 .kind{margin-left:10px;padding:2px 8px;border:1px solid var(--line2);border-radius:4px;background:hsl(0 0% 95%);
 font-size:12px;font-weight:500;color:var(--ink);vertical-align:middle}
.mid{padding:1px 6px;border:1px solid var(--amber-3);background:var(--amber-2);border-radius:4px;font-size:11.5px;color:var(--amber)}
.assumed{margin:0;padding:10px 14px;background:var(--purple-2);
 border:1px solid var(--purple-3);border-radius:8px;font-size:13px;line-height:1.6}
/* 이어받은 단계는 이번 회차가 실행한 것이 아니다. 옆줄로 갈라 두어 훑기만 해도 구별된다. */
.carried>.carried,.case.carried .carried{margin:6px 0 0;padding:7px 11px;border-left:3px solid var(--muted);
 background:hsl(0 0% 95%);font-size:13px;color:var(--muted)}
.warn-line{color:var(--amber)}
.chip.carry{background:hsl(0 0% 95%);color:var(--ink);border-color:var(--line2)}
.assumed b{display:block;margin-bottom:2px}
.trace{margin:6px 0 0;font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.req.sum .qa dt{width:132px}
.detail{margin:0 0 12px}.kv{display:flex;gap:10px;font-size:13.5px;padding:2px 0}
.kv b{flex:none;width:52px;color:var(--muted);font-weight:600}
/* 장면은 장식이 아니라 근거다. 높이를 제한해 한눈에 훑게 하고, 자세히 볼 것은 눌러서 펼친다.
   세로로 긴 폰 화면이 가로 화면과 같은 영역을 차지하지 않게 높이를 기준으로 맞춘다. */
img{max-width:100%;display:block}
/* 여섯 색. 라이트 배경에서 서로 구별되고, 인쇄해도 구별되는 값으로 잡는다. 초록만 채도를 낮추고
   나머지는 눈에 띄게 한다. 정상은 기준선이지 알릴 내용이 아니다. */
.chip.red,.pt.red b{color:var(--red)}.chip.red{background:var(--red-2);border-color:var(--red-3)}
.chip.orange,.pt.orange b{color:hsl(24 90% 38%)}.chip.orange{background:hsl(24 100% 95%);border-color:hsl(24 100% 90%)}
.chip.yellow,.pt.yellow b{color:var(--amber)}.chip.yellow{background:var(--amber-2);border-color:var(--amber-3)}
.chip.blue,.pt.blue b{color:var(--blue)}.chip.blue{background:var(--blue-2);border-color:var(--blue-3)}
.chip.gray,.pt.gray b{color:var(--ink)}.chip.gray{background:hsl(0 0% 95%);border-color:var(--line2)}
.chip.green,.pt.green b{color:var(--green)}.chip.green{background:var(--green-2);border-color:var(--green-3)}
.req.case.red{border-left:4px solid var(--red)}
.req.case.orange{border-left:4px solid hsl(24 90% 38%)}
.req.case.yellow{border-left:4px solid var(--amber)}
.req.case.blue{border-left:4px solid var(--blue)}
.req.case.gray{border-left:4px solid var(--ink)}
.req.case.green{border-left:4px solid var(--line2)}
/* 줄은 경로마다 별도 흐름을 갖는다. 정상과 실패가 한 영역에 섞이면 무엇을 실행했는지 구별되지 않는다. */
/* 줄 칸은 내용 크기로 결정되므로(justify-items:start) 그냥 두면 증거 사진이 400px로 줄어든다.
 화면은 1700px가 남아 있는데 CMS 글자를 읽을 수 없다(확인 결과). 증거 영역은 페이지 폭을
   다 쓴다. 글은 자기 max-width가 따로 있어 이 폭에 영향받지 않는다. */
.req.row > .lane{justify-self:stretch;width:100%}
.req.row > .basis{justify-self:stretch;width:100%;max-width:1200px}
.basis .proof,.basis figure{width:100%}
.basis figure img{width:100%;max-width:1200px;max-height:none}
.lane{margin:14px 0 0;padding:12px 0 0;border-top:1px solid var(--line)}
.lane h3{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.lane-n{font-weight:600}
.lane-c{color:var(--muted);font-size:12px;font-weight:400;margin-left:auto}
.lane-note{margin:0 0 8px;color:var(--fg)}
.lane-note p{margin:0 0 6px;line-height:1.75}
.lane-note p:last-child{margin-bottom:0}
.nb.ask.lane-ask{margin:10px 0 12px}
.lane.open{opacity:.72}
/* 훑어보는 색인. 색 배지가 먼저 오고 그 뒤에 줄 번호가 온다. 급한 것이 왼쪽 위에 온다. */
.idx dt{min-width:8.5em}
.idx a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
.idx a:hover{border-bottom-color:currentColor}
.idx .chip{margin-right:.4em}
/* 한 레인의 장면이 여러 주소에서 왔다는 사실만 알린다. 어느 것이 옳은지는 사람이 판단한다.
   로그인 화면에서 다시 진입한 구간이 그 줄의 증거로 들어갈 수 있다. */
.lane-aside{margin:8px 0 0;font-size:13px;color:var(--muted)}
.lane-warn{margin:6px 0 10px;padding:8px 12px;font-size:13px;color:var(--amber);
  background:var(--amber-2);border:1px solid var(--amber-3);border-radius:8px}
/* 근거 원문. 판정 옆이 아니라 그 아래 한 덩어리로 둔다. 읽는 사람이 "무엇이 적혀 있었나"를
   먼저 보고 화면을 본다. 인용은 원문 그대로라 줄바꿈을 지운다. */
/* 강조 상자(R2b): 바탕색 + 흰 배지 이름표 */
.basis{margin:10px 0 14px;padding:10px 14px;background:hsl(0 0% 95%);border-radius:8px}
.basis h4,.nb > h4{display:inline-block;background:#fff;border:1px solid var(--line2);border-radius:4px;padding:0 7px;
  font-size:11.5px;font-weight:600;color:var(--ink);line-height:19px;margin:0 0 6px;letter-spacing:0}
.basis blockquote{margin:0 0 8px;white-space:pre-wrap;font-size:14px;line-height:1.6}
/* 판정 한 줄은 설명이지 경고가 아니다. 주의 표시(.mid)를 쓰면 모든 줄이 문제처럼 읽힌다.
   글자 수로 자르지 않는다. 90자에서 끊으면 단어 중간이 잘려 뜻이 반대로 읽힐 수 있다.
   전체를 담고 화면에서만 두 줄로 줄여 표시한다. 찾기(⌘F)에도 전문이 걸린다. */
.said{color:var(--muted);display:block;margin-top:4px;white-space:pre-wrap}
.idx dd{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
@media print{.idx dd{display:block;overflow:visible}}
/* 정해야 할 것은 결함이 아니다. 결함 카드와 다른 모양으로 표시한다. */
.req.note{border-left:4px solid var(--blue);background:var(--card)}
/* 세 칸을 눈으로 갈라 둔다. 칸 제목이 없으면 결국 한 덩어리로 읽힌다. */
.nb{padding:14px 0;border-top:1px solid var(--line)}
.nb:first-of-type{border-top:0;padding-top:8px}
.nb > p{margin:0 0 7px;line-height:1.75}
.nb > p:last-child{margin-bottom:0}
.nb .from{color:var(--muted);font-size:13.5px}
/* 결정의 근거는 판정할 수 있을 만큼 커야 한다. 300px 썸네일로는 무엇을 보고 정할지
   알 수 없다. 여기서만 프레임 상한을 푼다. */
.nb .proof .frame{display:block;max-width:1000px}
.nb .proof .frame img{max-height:none;width:100%;max-width:1000px}
.nb .proof figcaption{font-size:12px}
.nb.ask{background:var(--blue-2);border-radius:8px;padding:14px 16px;border-top:0;margin-top:12px}
.nb.ask > h4{color:var(--blue);border-color:var(--blue-3)}
.nb.ask .q{margin:0 0 12px;font-size:17px;font-weight:700;line-height:1.6}
/* 갈래는 나란히 놓여야 비교가 된다. 세로로 쌓으면 두 번째 것을 안 읽는다. */
.picks{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
.pick{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.pick > b{display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;
  background:var(--fg);color:#fff;border-radius:4px;font-size:12px;margin-right:7px}
.pick .do{font-weight:700;line-height:1.6}
.pick dl{margin:9px 0 0}
.pick dl > div{display:grid;grid-template-columns:44px 1fr;gap:8px;margin-top:5px}
.pick dt{font-size:12px;color:var(--muted);font-weight:600}
.pick dd{margin:0;line-height:1.65}
.lean{margin:12px 0 0;padding-top:10px;border-top:1px dashed var(--line);color:var(--muted);line-height:1.7}
.lean b{color:var(--fg);margin-right:6px}
.req.note .tag{margin-left:8px;font-size:11px;color:var(--ink);border:1px solid var(--line2);background:hsl(0 0% 95%);
  border-radius:4px;padding:2px 8px;white-space:nowrap}
@media print{.nb.ask{background:#fff;border:1px solid #ccc}}
/* 줄 카드는 한 항목이 한 화면이라는 규칙에서 제외한다. 경로가 둘이면 흐름도 둘이라 더 길다. */
.req.case.row{min-height:0;content-visibility:visible}
/* 보고서에 없는 확인은 수가 많다(회차 하나에 87건). 한 장씩 크게 배치하면 본문보다 길어지므로
   훑어보는 격자로 둔다. 실패한 것은 테두리로 먼저 눈에 띈다. */
.misses{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;margin:0 0 18px}
.miss{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;min-width:0}
.miss.bad{border-color:var(--red-3);background:var(--red-2)}
.miss img{width:100%;max-height:200px;object-fit:contain;object-position:top;display:block;border-radius:4px}
.miss .gone{height:64px;display:grid;place-items:center;color:var(--muted);font-size:12px}
.miss figcaption{font-size:11px;line-height:1.45;color:var(--muted);margin-top:6px;word-break:break-word}
.miss.bad figcaption b{color:var(--red)}
.shots{display:grid;gap:12px}
.shots.pair{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
figure{margin:0;display:flex;flex-direction:column;align-items:flex-start}
/* 커서 모양은 다음 동작의 예고다. 사진을 누르면 확대가 아니라 다음 장면으로 넘어가므로 돋보기
   커서를 쓰면 예고와 실제 동작이 일치하지 않는다. 넘길 것이 있는 영역에만 커서를 바꾼다.
   여정 줄(strip)은 이미 다 펼쳐져 있어 넘길 것이 없다. */
.frame{position:relative;display:inline-block;max-width:100%}
.track .frame{cursor:zoom-in}
.frame img{max-height:300px;width:auto;max-width:100%}
/* 장면 영역은 하나다. 전·후·달라진 곳이 같은 크기·같은 위치에서 바뀌어야 무엇이 달라졌는지
   눈에 띈다. 영역 높이를 고정해 한 장이 카드를 다 차지하거나 여러 장이 함께 작아지지 않게 한다. */
/* 영역 높이를 한 곳에서 정하고 사진은 그 안에 맞춘다. 한 케이스가 한 화면이므로 그 화면에서
   남는 세로를 전부 사진에 준다. */
.stage{margin:0;--sh:max(300px,calc(100vh - 148px));position:relative}
.track{position:relative;height:var(--sh);background:hsl(0 0% 95%);
 border:1px solid var(--line);border-radius:8px}
/* 가로로 긴 장면은 폭이 병목이다. 영역 높이를 창 높이로만 잡으면 페이지 폭이 남는데도 사진이
   줄어 글자가 읽히지 않는다. 그래서 세 가지 중 가장 작은 값으로 영역을 잡는다.
   ① 원본의 80%. 실물 크기까지 키우면 한 장이 페이지를 다 차지한다. 대개 이 값이 선택된다.
   ② 페이지 폭에 맞춘 높이. 창이 좁으면 폭이 먼저 모자라므로 여기서 걸린다.
   ③ 창 높이의 1.4배. 한 케이스가 대체로 한 화면이라는 성질을 지키는 상한.
   더 크게 보려면 사진을 누르면 가운데 모달에 한 장씩 나온다. 기본값이 화면을 다 차지하지 않아야 한다. */
.stage.wide{--sh:min(calc(var(--ih) * 0.8 + 46px),
                     calc((100vw - 96px) / var(--ar) + 46px),
                     calc((100vh - 148px) * 1.4))}
/* 장이 즉시 전환되면 두 장을 따로 보게 된다. 짧게 겹쳐 넘겨야 같은 영역에서 무엇이 달라졌는지
   비교된다. 숨긴 장도 영역을 그대로 차지한 채 투명해질 뿐이라 크기가 변하지 않는다. */
.fr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
 padding:4px;opacity:0;pointer-events:none;transition:opacity .22s ease}
.fr.on{opacity:1;pointer-events:auto}
/* 두 장을 같은 영역에서 겹쳐 보는 것이 이 보고서에서 비교가 성립하는 방식이다. 이 겹침과 스크롤
   애니메이션은 OS 의 동작 줄이기 설정과 무관하게 유지한다. */
/* 캡션 몫을 상수로 빼면 캡션이 길어질 때 그림+캡션이 트랙을 넘고, .fr이 수직 중앙정렬이라
 넘친 양의 절반이 아래로 가 캡션 마지막 줄이 잘린다(확인 결과: 1440x900에서 장면 87장
   중 16장이 12~21px 초과, 창을 키우면 사라짐. 판정 인용문이 3~4줄이면 캡션이 62~79px다).
   그래서 상수가 아니라 실제 캡션 높이를 재서 넣는다(아래 스크립트가 --cap을 채운다). */
.fr .frame img{max-height:calc(var(--sh) - var(--cap, 40px))}
/* 여정 줄. 순서대로 늘어놓고, 화면보다 길면 가로로 스크롤한다. 폰 회차는 단계가 길어진다. */
/* safe center. 장면이 영역보다 좁으면 가운데로 모으고, 넘치면 왼쪽부터 붙여 첫 장이 잘리지
   않게 한다. 그냥 center로 두면 넘칠 때 앞쪽이 잘려 스크롤로도 돌아갈 수 없다. */
.track.strip{display:flex;gap:10px;align-items:flex-start;justify-content:safe center;
 padding:8px;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x proximity}
.track.strip .fr{position:static;opacity:1;pointer-events:auto;padding:0;flex:0 0 auto;
 scroll-snap-align:start;max-width:none}
.track.strip .fr .frame img{max-height:calc(var(--sh) - var(--cap, 66px) - 26px)}
.track.strip figcaption{max-width:100%}
/* 크게 보기는 페이지 안에서 키우지 않는다. 카드가 화면을 넘기면 오히려 보이지 않는다.
   사진을 누르면 가운데 모달에 그 항목의 장면을 한 장씩 표시하고 넘긴다. 사진은 창 안에 맞추고,
   표시 상자는 비율 좌표라 그대로 따라온다. 닫기는 오른쪽 위 단추와 Esc. 되짚을 기록의 썸네일도
   같은 모달을 연다. 인쇄에서는 닫힌 상태라 아무것도 출력되지 않는다. */
dialog#lb{border:0;padding:0;margin:0;background:transparent;max-width:none;max-height:none;
 width:100vw;height:100vh;display:none;align-items:center;justify-content:center}
dialog#lb[open]{display:flex}
dialog#lb::backdrop{background:rgba(0,0,0,.78)}
#lb .lbv{background:var(--card);border-radius:8px;padding:8px;max-width:calc(100vw - 150px);
 display:flex;flex-direction:column;align-items:center}
#lb .frame{cursor:pointer}
#lb .frame img{max-height:calc(100vh - 110px - var(--lcap,0px));max-width:calc(100vw - 170px);width:auto;height:auto}
#lb figcaption{max-width:100%;justify-content:center}
#lb .arw{position:fixed;top:50%;transform:translateY(-50%);opacity:.85;width:44px;height:64px}
#lb .arw.prev{left:14px}#lb .arw.next{right:14px}
#lb .count{position:fixed;left:50%;right:auto;bottom:14px;transform:translateX(-50%);font-size:12.5px}
#lb .lbx{position:fixed;top:14px;right:16px;font:inherit;font-size:13px;font-weight:600;line-height:1;
 padding:8px 12px;border:0;border-radius:4px;background:#fff;color:var(--fg);cursor:pointer}
#lb.one .arw,#lb.one .count{display:none}
.arw{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:56px;border:0;border-radius:4px;
 background:rgba(0,0,0,.7);color:#fff;font-size:26px;line-height:1;cursor:pointer;
 opacity:.42;transition:opacity .12s}
.arw.prev{left:6px}.arw.next{right:6px}
.track:hover .arw{opacity:1}
.count{position:absolute;right:8px;bottom:6px;font-size:11.5px;padding:2px 7px;
 background:rgba(0,0,0,.6);color:#fff;font-variant-numeric:tabular-nums;border-radius:4px}
.count b{font-weight:700}
.tabs{display:flex;gap:5px;margin:6px 0 0;flex-wrap:wrap}
.tab{font:inherit;font-size:12.5px;padding:4px 11px;cursor:pointer;border-radius:4px;
 border:1px solid var(--line2);background:transparent;color:var(--ink)}
.tab.on{background:var(--fg);border-color:var(--fg);color:#fff;font-weight:600}
.box{position:absolute;border:2px solid #85E8F6;box-shadow:0 0 0 9999px rgba(0,0,0,.18) inset}
.box i{position:absolute;left:0;top:-19px;font-style:normal;font-size:10.5px;color:#04202B;
 padding:1px 6px;white-space:nowrap;font-weight:650}
/* 한 장면의 설명은 "이건 무엇이고, 그래서 무엇이 확인됐나" 두 조각이다. 판정을 배지로 표시해
   훑을 때 초록·빨강만 보고도 어느 장이 실패했는지 보이게 한다. */
figcaption{font-size:12px;color:var(--muted);padding:6px 2px 0;display:flex;flex-wrap:wrap;
 gap:5px 8px;align-items:baseline;line-height:1.45}
figcaption .lb{color:var(--fg);font-weight:650;font-size:12.5px}
figcaption .cs{color:var(--fg);flex:1 1 100%;line-height:1.5}
figcaption .ck{font-size:11px;font-weight:600;padding:0 6px;flex:none;border-radius:4px;border:1px solid transparent}
figcaption .ck.ok{background:var(--green-2);color:var(--green);border-color:var(--green-3)}
figcaption .ck.no{background:var(--red-2);color:var(--red);border-color:var(--red-3)}
figcaption .cw{flex:1 1 100%;font-size:11.5px}
.miss{color:var(--red);font-size:13px}
.sec{font-size:16px;margin:34px 0 10px;padding:0;border-bottom:0;font-weight:600;letter-spacing:-.01em}
.req.sum{border:1px solid var(--line)}
.back{margin:34px 0 0;padding:9px 0 0;border-top:2px solid var(--fg)}
.back .sec:first-child{margin-top:0}
/* 통과는 한 줄로 간결하게, 실패는 위에 크게 표시한다. 지문(시각·엔터티·배선)이 매 행 같은 세로
   위치에 있어야 훑는 것만으로 불일치가 보인다. 문장 속에 섞으면 읽어야 알 수 있다. */
.walk{width:100%;border-collapse:collapse;font-size:13px;border:1px solid var(--line2)}
.walk th{text-align:left;font-weight:600;color:#fff;background:var(--fg);font-size:12px;padding:5px 10px;white-space:nowrap;
 border:1px solid var(--ink);border-top:0;border-bottom:2px solid var(--fg)}
.walk td{padding:5px 10px;border:1px solid var(--line);border-top:0;vertical-align:middle}
.walk tbody tr:last-child td{border-bottom:0}
.walk td:first-child{background:hsl(0 0% 95%)}
.walk td.t,.walk td.id{font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap;font-size:12px}
.walk td.v{width:1%}.walk td.sh{width:1%;white-space:nowrap}
.walk tr.fail td{background:var(--red-2)}
.th{display:inline-block;margin:0 3px 0 0;vertical-align:middle}
.th img{height:34px;width:auto;border:1px solid var(--line);cursor:zoom-in}
/* 이 보고서는 대개 PDF로 넘어간다. 인쇄본에서는 눌러 펼치기가 없으므로 처음 보이는 크기가 곧
   판정 가능한 크기여야 한다. 어두운 배경은 잉크를 많이 쓰고 표시 색을 가리므로 흰 배경으로 바꾸고,
   한 단계가 페이지 경계에서 나뉘지 않게 묶는다. 가로로 넓은 화면은 한 줄에 하나만 둔다. 두 칸으로
   나누면 종이 폭에서 글자가 읽히지 않는다. 세로로 긴 폰 화면만 나란히 둔다. */
@media print{
  body{padding:0;font-size:10.5pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .wrap{max-width:none}
  h1{font-size:18pt}
  /* 단계 전체를 묶으면 단계가 한 페이지보다 클 때 앞 장이 전부 빈다. 나뉘면 안 되는 것은
     그림과 그 설명이지 단계가 아니다. 제목만 페이지 끝에 남지 않게 붙여 둔다. */
  .step,.req{box-shadow:none;border:1px solid var(--line);padding:12px 12px 10px;margin:0 0 12px}
  .step header,.req header{break-after:avoid;page-break-after:avoid}
  .detail,.qalist{break-inside:avoid;page-break-inside:avoid}
  figure{break-inside:avoid;page-break-inside:avoid}
  /* 인쇄본에서는 장면을 넘길 수 없으므로 넘김 장치를 지우고 모든 장면을 펼친다. 화면에서 쓰던
     좌우 두 단은 종이 폭에서 글자가 읽히지 않으므로 한 단으로 되돌린다. */
  .req.two{display:block}
  html{scroll-snap-type:none}
  /* 화면에서는 보이지 않는 케이스를 그리지 않아 렌더링 부담을 줄이지만, 인쇄에서는 그리지
     않은 케이스가 그대로 빈 페이지가 되므로 전부 되돌려 펼친다. */
  .case{min-height:0;content-visibility:visible;contain-intrinsic-size:none;
   border-top:0;border:1px solid var(--line);padding:12px;margin:0 0 12px;
   break-inside:auto;break-before:page;page-break-before:always}
  .arw,.count{display:none}
  .track{position:static;height:auto;border:0;background:none}
  /* 여정 줄은 종이에서 가로로 스크롤할 수 없으므로 줄바꿈해서 다 보이게 한다. */
  .track.strip{flex-wrap:wrap;overflow:visible;padding:0}
  .track.strip .fr .frame img{max-height:95mm}
  .fr{position:static;display:flex;padding:0 0 6pt;opacity:1;pointer-events:auto;transition:none}
  .fr .frame img{max-height:110mm}
  .tabs{display:none}
  .verdict{border:1px solid var(--line);border-left:6pt solid var(--tone);padding:12pt 14pt;margin:0 0 16pt}
  .verdict .head{font-size:15pt}
  .noproof{background:var(--amber-2)}
  .back{margin-top:18pt;padding-top:12pt;break-before:page;page-break-before:always}
  .shots{gap:8px}
  .shots.pair{grid-template-columns:1fr}
  .shots.pair.tall{grid-template-columns:repeat(auto-fit,minmax(46mm,1fr))}
  .frame{cursor:auto}
  .frame img{max-height:135mm;width:auto}
  .shots.pair:not(.tall) .frame img{width:100%;max-height:160mm;object-fit:contain}
  figcaption{font-size:9pt}
  .sec{font-size:13pt;margin:14pt 0 8pt;break-after:avoid;page-break-after:avoid}
  .walk{font-size:9.5pt}
  .walk thead{display:table-header-group}
  .walk tr{break-inside:avoid;page-break-inside:avoid}
  .walk tr.fail td{background:var(--red-2)}
  .th img{height:14mm}
}
/* ── 조밀 화면(항목이 많은 회차) ──
   셋을 함께 낮춰야 한다. 사진 높이만 낮추면 화면 밖 항목의 자리표시(contain-intrinsic-size)가
   여전히 화면 하나씩을 차지해 스크롤 길이가 그대로다(확인 결과: 조밀안에서도 95000px). */
.wrap.rev.dense{max-width:1180px}
.dense .stage,.dense .stage.wide{--sh:340px}
.dense .case{min-height:0;contain-intrinsic-size:auto 420px}
.dense .req,.dense .step{padding:12px 14px 10px;margin:0 0 10px}
/* 34px 썸네일은 증거로 읽히지 않으면서 파일만 두 배로 만든다. 사진은 이미 항목마다 있다. */
.dense td.sh,.dense th.sh,.dense .th{display:none}
/* 한 장씩 맞추는 장치는 항목이 한 화면일 때 쓴다. 조밀 화면에서는 방해만 된다. */
html:has(.dense){scroll-snap-type:none}
#qnav{position:sticky;top:0;z-index:50;background:var(--bg);border-bottom:1px solid var(--line);
 padding:8px 0;margin:0 0 14px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#qnav a{font-size:12px;text-decoration:none;color:var(--fg);border:1px solid var(--line2);border-radius:4px;
 padding:3px 7px;background:var(--card)}
#qnav a.fail{border-color:var(--red-3);color:var(--red);background:var(--red-2)}
#qnav b{font-size:12px;color:var(--muted);font-weight:500;margin-right:4px}
#qnav b.all{margin-left:10px}
/* 번호를 눌러 온 항목이 색인 뒤에 숨지 않게 도착 지점을 색인 높이만큼 내린다. 줄 수가 창 폭에
   따라 달라지므로 상수로 박지 않고 실제로 재서 --navh에 넣는다(아래 스크립트). */
.dense section[id^="q"]{scroll-margin-top:calc(var(--navh, 140px) + 12px)}
</style>
<div class="wrap${handoff ? "" : " rev"}${many ? " dense" : ""}"><h1>${esc(title || (handoff ? "QA 안내" : "확인 보고서"))}<span class="kind">${kindLabel}</span></h1>
${navBlock}
${summary ? `<p class="lede">${esc(summary)}</p>` : ""}
${handoff
  ? `<div class="tally">${target ? `<span>대상 ${esc(target)}</span>` : ""}<span>${n}단계</span>${setup ? `<span>준비 ${esc(setup)}</span>` : ""}</div>
${rows}`
  // 읽는 순서가 곧 판단 순서다. 결론, 못 본 것, 요구 하나씩, 그 다음에 되짚을 기록 순이다.
  : led
  ? `${ledVerdict}
${resumeBlock}
${ledList}
${ledIndex}${wideBlock}
${ledPlan}
${ledNotes}
<h2 class="sec">하나씩</h2>
${led.rows.map((r, i) => ledgerCard(dir, r, i)).join("\n")}
<div class="back">
<h2 class="sec">되짚을 기록</h2>
${runBlock}
${missingBlock}
</div>`
  : `${verdictBlock}
${resumeBlock}
${agreedBlock}
${discardBlock}
${unverBlock}
<h2 class="sec">하나씩</h2>
${built.map((b) => b.card).join("\n")}
<div class="back">
<h2 class="sec">되짚을 기록</h2>
${runBlock}
<table class="walk"><thead><tr><th>시각</th><th>단계</th><th>다룬 데이터</th><th>붙은 곳</th><th>판정</th><th>장면</th></tr></thead>
<tbody>${built.map((b) => b.row).join("\n")}</tbody></table>
<p class="lede">판정 ${checks.length}건 · 됨 ${checks.length - checkBad}건${checkBad ? ` · 안 됨 ${checkBad}건` : ""}</p>
${missingBlock}
</div>`}
${handoff ? missingBlock : ""}</div>
<dialog id="lb" aria-label="장면 크게 보기"><button type="button" class="lbx" aria-label="닫기">X</button><div class="lbv"></div><button type="button" class="arw prev" aria-label="이전 장면">‹</button><button type="button" class="arw next" aria-label="다음 장면">›</button><span class="count"><b>1</b>/<i>1</i></span></dialog>
<script>
// 장면 넘기기. 같은 영역에서 전→후→달라진 곳을 바꿔 표시해야 무엇이 달라졌는지 보인다.
// 색인의 실제 높이를 재서 앵커 도착 지점에 넘긴다. 창 폭이 바뀌면 줄 수가 바뀌고, 사진이
// 늦게 들어오면 한 번 더 바뀐다. 상수로 고정하면 그때마다 항목 제목이 색인에 가려진다.
(function () {
  var nav = document.getElementById("qnav");
  if (!nav) return;
  var set = function () { document.documentElement.style.setProperty("--navh", nav.offsetHeight + "px"); };
  set();
  addEventListener("resize", set);
  addEventListener("load", set);
})();
// 캡션이 실제로 몇 픽셀인지 재서 그림에 남는 높이를 전달한다. 창 폭이 바뀌면 캡션이 다시
// 줄바꿈되어 높이가 달라지므로 그때마다 다시 측정한다. 한 트랙 안에서는 가장 높은 캡션에
// 맞춰 장면을 넘길 때 그림 크기가 변하지 않게 한다.
function fitCaptions() {
  for (const stage of document.querySelectorAll(".stage")) {
    let tall = 0;
    for (const cap of stage.querySelectorAll("figcaption")) tall = Math.max(tall, cap.offsetHeight);
    if (tall) stage.style.setProperty("--cap", (tall + 10) + "px");
  }
}
fitCaptions();
addEventListener("resize", fitCaptions);
addEventListener("load", fitCaptions);
// 표시 상자는 비율 좌표라 크기가 바뀌어도 그대로 맞는다.
function show(stage, i) {
  const fr = [...stage.querySelectorAll(".fr")], tb = [...stage.querySelectorAll(".tab[data-i]")];
  if (!fr.length) return;
  const k = (i + fr.length) % fr.length;
  fr.forEach((f, j) => f.classList.toggle("on", j === k));
  tb.forEach((t, j) => t.classList.toggle("on", j === k));
  const c = stage.querySelector(".count b"); if (c) c.textContent = k + 1;
}
const at = (stage) => [...stage.querySelectorAll(".fr")].findIndex((f) => f.classList.contains("on"));
// 크게 보기. 사진을 누르면 가운데 모달에 그 항목의 장면이 한 장씩 표시된다. 페이지 안에서
// 키우면 카드가 화면을 넘겨 오히려 보이지 않는다. 되짚을 기록의 썸네일도 같은
// 모달을 연다. 표시 상자는 비율 좌표라 복제해도 그대로 맞는다.
const lb = document.getElementById("lb");
let lbItems = [], lbI = 0;
function lbShow(i) {
  if (!lbItems.length) return;
  lbI = (i + lbItems.length) % lbItems.length;
  const v = lb.querySelector(".lbv"); v.innerHTML = "";
  const it = lbItems[lbI];
  v.appendChild(it.frame.cloneNode(true));
  if (it.cap) v.appendChild(it.cap.cloneNode(true));
  const c = v.querySelector("figcaption");
  v.style.setProperty("--lcap", (c ? c.offsetHeight : 0) + "px");
  lb.querySelector(".count b").textContent = lbI + 1;
  lb.querySelector(".count i").textContent = lbItems.length;
  lb.classList.toggle("one", lbItems.length < 2);
}
function lbOpen(items, i) {
  if (!items.length) return;
  lbItems = items; lbShow(i);
  if (!lb.open) lb.showModal();
}
const itemsOf = (stage) => [...stage.querySelectorAll(".fr")].map((f) => ({
  frame: f.querySelector(".frame"), cap: f.querySelector("figcaption"),
  src: (f.querySelector("img") || {}).src }));
document.addEventListener("click", (e) => {
  if (e.target.closest(".lbx")) { lb.close(); return; }
  const la = e.target.closest("#lb .arw");
  if (la) { lbShow(lbI + (la.classList.contains("next") ? 1 : -1)); return; }
  if (e.target.closest("#lb .frame")) { lbShow(lbI + 1); return; }
  if (e.target === lb) { lb.close(); return; }                 // 바탕을 누르면 닫힌다
  const a = e.target.closest(".arw");
  if (a) { const s = a.closest(".stage"); show(s, at(s) + (a.classList.contains("next") ? 1 : -1)); return; }
  const t = e.target.closest(".tab[data-i]");
  if (t) { show(t.closest(".stage"), Number(t.dataset.i)); return; }
  // 사진을 누르면 그 항목의 장면 전부를 모달에 표시하고 누른 장에서 시작한다.
  const f = e.target.closest(".fr");
  if (f) { const s = f.closest(".stage"); lbOpen(itemsOf(s), [...s.querySelectorAll(".fr")].indexOf(f)); return; }
  // 되짚을 기록의 썸네일도 같은 모달로 열고, 누른 사진과 같은 장에서 시작한다.
  const th = e.target.closest("td.sh[data-q] .th");
  if (th) {
    const td = th.closest("td"), sec = document.getElementById("q" + td.dataset.q);
    const stage = sec && sec.querySelector(".stage");
    const src = th.querySelector("img").src;
    let items = stage ? itemsOf(stage) : [];
    if (!items.length) items = [...td.querySelectorAll(".th img")].map((im) => {
      const d = document.createElement("div"); d.className = "frame"; d.appendChild(im.cloneNode(true));
      return { frame: d, cap: null, src: im.src }; });
    lbOpen(items, Math.max(0, items.findIndex((it) => it.src === src)));
  }
});
// 마우스를 올려둔 장면은 ←→로 넘긴다. 여러 카드를 훑으며 대조할 때 손을 옮기지 않아도 된다.
let hot = null;
document.addEventListener("mouseover", (e) => { const s = e.target.closest(".stage"); if (s) hot = s; });
// 케이스는 PageUp/PageDown으로 넘긴다. 스크롤 스냅이 경계에 맞추고 이 동작이 한 장씩 이동한다.
function page(dir) {
  const cs = [...document.querySelectorAll(".case")];
  const cur = cs.findIndex((c) => c.getBoundingClientRect().top > -40);
  const k = Math.min(cs.length - 1, Math.max(0, (cur < 0 ? cs.length - 1 : cur) + dir));
  cs[k] && cs[k].scrollIntoView({ block: "start" });
}
document.addEventListener("keydown", (e) => {
  // 모달이 열려 있으면 ←→는 모달의 장을 넘기고 Esc는 닫는다. dialog가 Esc를 스스로 받기도 하지만
  // 그 동작은 브라우저가 보낸 키에만 반응하므로, 여기서 직접 닫아 어느 경로로 오든 같게 한다.
  if (lb.open) {
    if (e.key === "Escape") { lb.close(); e.preventDefault(); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { lbShow(lbI + (e.key === "ArrowRight" ? 1 : -1)); e.preventDefault(); }
    return;
  }
  if (e.key === "PageDown" || e.key === "PageUp") { page(e.key === "PageDown" ? 1 : -1); e.preventDefault(); return; }
  if (!hot || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  show(hot, at(hot) + (e.key === "ArrowRight" ? 1 : -1)); e.preventDefault();
});
</script>`;
  const p = out || path.join(dir, handoff ? "handoff.html" : "report.html");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 장부 회차의 기본 지면은 개발자가 아닌 사람이 읽는다. 확인 기록 번호·선택자·주소는
  // 그 사람이 검증에 쓸 수 없어서 옆 파일(-dev)에 두고, 기본 지면에는 흐름과 장면만 싣는다.
  const devPath = led ? p.replace(/(\.html?)?$/i, "-dev.html") : null;
  if (led) {
    fs.writeFileSync(devPath, html);
    fs.writeFileSync(p, renderPlain({ title, summary, overview, led, dir, devHref: path.basename(devPath) },
      { esc, keepShot, dataUri, pngSize, readMarks, boxesOf, rowColor, frameStale, COLOR }));
  } else fs.writeFileSync(p, html);
  // 다음 실행이 이 장면들을 '이전'으로 집어 쓸 수 있게 이름과 함께 남긴다.
  const mf = path.join(dir, "manifest.json");
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(mf, "utf8")); } catch {}
  // 회차에 종류와 합의한 범위를 남긴다. 지금까지 manifest에는 이것이 없어서, 나중에 이 회차가
  // 무엇이었는지 폴더 이름으로만 알 수 있었다. "지난번 그거"를 기계가 찾지 못했고 회귀 비교의
  // 전제가 없었다(확인 결과: 회차 46개 중 kind를 가진 것 0개).
  // 단계별 결과를 남긴다. 지금까지는 단계 '수'만 남아서, 다음 회차가 무엇을 이어받을 수 있는지
  // 알 방법이 없었다. 그래서 매번 처음부터 다시 실행하거나 수정분만 조각 보고서로 냈다.
  // 넘기기 문서에는 판정이 없다. 다른 사람이 실행할 절차이지 내가 확인한 결과가 아니다. 그런데
  // 렌더러의 기본값이 pass라서 그대로 적으면 판정한 적 없는 단계가 통과로 기록되고, 다음
  // review가 그것을 이어받아 "확인됐다"고 말하게 된다.
  const stepBook = allSteps.map((st, i) => ({
    name: String(st.name || ""), verdict: handoff ? "info" : built[i].v,
    at: st.at || null, expected: st.expected || null,
    basis: st.basis || null, basisNote: st.basisNote || null,
    receipt: st.receipt || (Array.isArray(st.receipts) ? st.receipts[0] : null) || null,
    from: st.from || null, fromAt: st.fromAt || null,
    before: kept[i].before || null, after: kept[i].after || null, diff: kept[i].diff || null,
  }));
  fs.writeFileSync(mf, JSON.stringify({ ...prev, runId: rid, title: title || "", target: target || null,
    kind: String(kind || "review"), agreed: agreedList,
    resumedFrom: res.from || null, carried: res.carried.length,
    discarded: discardList,
    at: new Date().toISOString(), [handoff ? "handoff" : "report"]: p, steps: stepBook, shots: kept, receipts }, null, 2));
  // 안내서는 내 확인의 기록이 아니라 다른 사람이 실행할 절차다. 내 판정 건수를 세어 보고하지 않는다.
  // 원장 회차는 단계를 직접 쓰지 않으므로 steps가 0이다. 그 수만 돌려주면 부르는 쪽이
  // "0단계 · 확인 0건"이라 말해 빈손 회차와 구별되지 않는다. 화면에는 줄 셋이 있는데도 그렇다.
  const ledTally = led && led.rows.length
    ? led.rows.reduce((acc, r) => {
        const c = rowColor(r);
        acc.rows += 1; acc[c] = (acc[c] || 0) + 1;
        return acc;
      }, { rows: 0 })
    : null;
  return { ok: true, path: p, ...(devPath ? { devPath } : {}), runId: rid, store: dir, steps: n,
    ...(ledTally ? { ledger: ledTally } : {}),
    ...(handoff ? {} : { checks: checks.length, failed: checkBad, failedSteps: bad,
      unverified: unver.length, unreported: missing.length }) };
}

export { buildReport, addReceipt, receiptById, receiptsOfRun, coverGaps, pairProblems, unshotClaims,
  unverifiedOutsideLedger,
  writeMarks, readMarks, BASIS };
