// 사용량 상세·이력 화면. 상태바 띠가 "지금 얼마나 남았나" 라면 이 화면은 "여태 얼마나 썼나" 다.
//
// 소유 범위
//   rail 화면 하나의 렌더: 넷으로 나뉜 탭(전체·Claude·Codex·계정), 일별 막대, 상위 목록,
//   최근 세션 표, 그리고 계정 탭의 자격증명 상태와 쿠키 입력.
//
// 제공 API
//   panelHtml · initUsagePage(ctx) · openUsagePage() · setHistory(msg) · setProviders(...) ·
//   setPrefsFlags(msg). 상태바 모듈이 자기가 받은 메시지를 이리로 넘긴다.
//
// 의존 대상
//   ctx.$ 와 ctx.wsSend 만. 앱 셸의 어떤 모듈도 import 하지 않는다. 화면을 여는 것도
//   rail 버튼을 사람처럼 누르는 것으로 한다.
//
// 유지 조건
//   서버가 준 글자를 innerHTML 로 넣지 않는다. 프로젝트 이름은 사람이 만든 폴더 이름이다.
//   쿠키를 화면에 되돌려 그리지 않는다. 서버는 "들어 있는가" 만 보내고, 입력칸은 언제나 빈
//   칸에서 시작한다. 값을 다시 그리면 그 입력칸이 비밀을 노출하는 경로가 된다.
//   스캔을 사람이 기다리게 두지 않는다. 처음 열 때는 몇 분이 걸리므로 진행률을 계속 그린다.
//
// 영향 범위
//   web/js/statusbar/usage.js(이 모듈을 부르는 곳) · web/css/29-usage-stats.css ·
//   core/rail-items.js 의 usage 줄 · server/usage-history-handlers.js 의 usage.history 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/usagestats/page.js

const TABS = [
  { id: "overview", label: "전체" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "accounts", label: "계정" },
];

// 계정 탭이 다루는 제공자. 상태바와 같은 여덟 개이고, 순서도 같게 둔다.
const PROVIDER_NAMES = {
  claude: "Claude", codex: "Codex", gemini: "Gemini", antigravity: "Antigravity",
  "opencode-go": "opencode Go", kimi: "Kimi", minimax: "MiniMax", grok: "Grok",
};
const PROVIDER_SOURCE = {
  claude: "키체인 Claude Code-credentials · ~/.claude/.credentials.json",
  codex: "~/.codex/auth.json",
  gemini: "~/.gemini/oauth_creds.json · opencode auth.json",
  antigravity: "Gemini 와 같은 자격증명",
  "opencode-go": "아래 쿠키 칸",
  kimi: "~/.kimi-code/credentials/kimi-code.json",
  minimax: "아래 쿠키 칸",
  grok: "~/.grok/auth.json",
};
const REASONS = {
  "missing-credentials": "로그인 필요",
  "needs-cookie": "쿠키 필요",
  "stale-token": "토큰 만료",
  "rate-limited": "요청 과다",
  "bad-setting": "설정 오류",
  "usage-unavailable": "사용량 없음",
  server: "연결 실패",
  network: "연결 실패",
};

// 사람이 직접 넣어야 하는 값들. 라벨과 안내는 여기 한 곳에만 적는다.
const SECRET_FIELDS = [
  { field: "opencodeCookie", label: "opencode 쿠키", hint: "opencode.ai 로그인 뒤 auth 쿠키" },
  { field: "opencodeWorkspace", label: "opencode 워크스페이스", hint: "비워 두면 첫 워크스페이스" },
  { field: "minimaxCookie", label: "MiniMax 쿠키", hint: "platform.minimax.io 로그인 쿠키 전체" },
  { field: "minimaxGroupId", label: "MiniMax 그룹 ID", hint: "쿠키에서 못 읽을 때만" },
];

const CHART_DAYS = 60;

// 영역의 안쪽만 만든다. 셸(aside 의 id·class)은 rail 표가 정본이다.
// 안을 그리는 것은 enter 이므로 여기에는 그때까지 표시할 안내문 하나만 적는다.
export const panelHtml = `<div class="ust-page">
  <div class="ust-boot">사용량 이력을 불러오는 중입니다.</div>
</div>`;

let $ = null;
let wsSend = () => {};
let root = null;
let entered = false;
let tab = "overview";

let history = { summary: null, scanning: false, progress: null, error: null };
let providers = [];
let providersAt = 0;
let prefsFlags = {};

// 렌더 헬퍼
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function full(n) { return (Number(n) || 0).toLocaleString("ko-KR"); }

function since(at) {
  if (!at) return null;
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}

function stamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 요약 한 줄의 칸 하나. 칸 사이는 선 하나로 나누고, 제공자 칸은 앞에 색 표시를 단다.
function cell(label, value, note, color) {
  const box = el("div", "ust-cell");
  const lab = el("span", "ust-cell-l");
  if (color) {
    const sw = el("i", "ust-sw");
    sw.style.background = color;
    lab.appendChild(sw);
  }
  lab.appendChild(document.createTextNode(label));
  box.appendChild(lab);
  box.appendChild(el("span", "ust-cell-v", value));
  box.appendChild(el("span", "ust-cell-n", note || " "));
  return box;
}

// 칸 수는 전체 탭 다섯, 제공자 탭 일곱이다.
function strip(cells) {
  const row = el("div", `ust-strip${cells.length > 5 ? " seven" : ""}`);
  for (const c of cells) row.appendChild(c);
  return row;
}

function sectionTitle(text, note, right) {
  const head = el("div", "ust-sec");
  head.appendChild(el("h3", "ust-sec-t", text));
  if (note) head.appendChild(el("span", "ust-sec-n", note));
  if (right) head.appendChild(el("span", "ust-sec-r", right));
  return head;
}

// 일별 막대. 두 제공자를 한 막대에 쌓아 어느 쪽이 그날을 채웠는지 한눈에 보이게 한다.
// 제목 줄(기간·기준·가장 많은 날)과 범례, 세로·가로 축을 함께 만든다.
function dailyChart(series, tall) {
  const byDay = new Map();
  for (const s of series) {
    for (const d of s.daily || []) {
      let cur = byDay.get(d.day);
      if (!cur) { cur = { day: d.day, parts: [] }; byDay.set(d.day, cur); }
      cur.parts.push({ key: s.key, color: s.color, tokens: s.totalOf(d) });
    }
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-CHART_DAYS);
  const box = el("div", tall ? "ust-grow" : "");
  if (!days.length) {
    box.appendChild(sectionTitle("날짜별 토큰", `최근 ${CHART_DAYS}일`));
    box.appendChild(el("div", "ust-empty", "아직 기록이 없습니다."));
    return box;
  }
  const totals = days.map((d) => d.parts.reduce((a, p) => a + p.tokens, 0));
  const peak = Math.max(...totals, 1);
  const peakDay = days[totals.indexOf(Math.max(...totals))].day;
  // 가장 높은 날에 맞추면 하루가 다른 날의 스무 배인 경우 나머지가 전부 바닥에 붙는다
  // (확인 결과: 어느 하루가 58B, 보통 날이 0.3B). 그래서 기준은 위에서 열째 날에 맞추고, 그보다
  // 높은 날은 꼭대기까지 그리되 잘렸다는 표시를 단다. 표시가 없으면 값이 잘못 읽힌다.
  const ranked = totals.filter((v) => v > 0).sort((a, b) => a - b);
  const base = ranked.length ? Math.max(ranked[Math.floor(ranked.length * 0.9)], 1) : 1;
  const md = (day) => day.slice(5);
  const range = `최근 ${CHART_DAYS}일 · ${md(days[0].day)} ~ ${md(days[days.length - 1].day)}`;
  box.appendChild(sectionTitle("날짜별 토큰",
    base < peak ? `${range} · 흰 선은 ${compact(base)} 를 넘은 날` : range,
    `가장 많은 날 ${compact(peak)} · ${md(peakDay)}`));
  if (series.length > 1) box.appendChild(legend(series));

  const chart = el("div", `ust-chart${tall ? " tall" : ""}`);
  const plot = el("div", "ust-plot");
  for (const top of ["0", "50%"]) {
    const line = el("div", "ust-grid");
    line.style.top = top;
    plot.appendChild(line);
  }
  const bars = el("div", "ust-bars");
  for (const d of days) {
    const total = d.parts.reduce((a, p) => a + p.tokens, 0);
    const col = el("div", `ust-bar${total > base ? " clip" : ""}`);
    col.title = `${d.day} · ${full(total)} 토큰`;
    const stack = el("div", "ust-stack");
    stack.style.height = `${Math.min(Math.max((total / base) * 100, total > 0 ? 1.5 : 0), 100)}%`;
    for (const p of d.parts) {
      if (p.tokens <= 0) continue;
      const seg = el("div", "ust-seg");
      seg.style.flexGrow = String(p.tokens);
      seg.style.background = p.color;
      stack.appendChild(seg);
    }
    col.appendChild(stack);
    bars.appendChild(col);
  }
  plot.appendChild(bars);
  chart.appendChild(plot);

  const yax = el("div", "ust-yax");
  for (const [top, text] of [["0", compact(base)], ["50%", compact(base / 2)], ["100%", "0"]]) {
    const tick = el("span", "", text);
    tick.style.top = top;
    yax.appendChild(tick);
  }
  chart.appendChild(yax);

  // 가로 축은 다섯 날짜. 막대 가운데에 맞추고, 양 끝은 칸 밖으로 넘치지 않게 안쪽으로 붙인다.
  const xax = el("div", "ust-xax");
  const picks = [...new Set([0, 1, 2, 3, 4].map((i) => Math.round((i * (days.length - 1)) / 4)))];
  for (const i of picks) {
    const tick = el("span", "", md(days[i].day));
    tick.style.left = `${((i + 0.5) / days.length) * 100}%`;
    xax.appendChild(tick);
  }
  chart.appendChild(xax);
  chart.appendChild(el("div", ""));
  box.appendChild(chart);
  return box;
}

function legend(series) {
  const row = el("div", "ust-legend");
  for (const s of series) {
    const item = el("span", "");
    const dot = el("i", "ust-sw");
    dot.style.background = s.color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(s.label));
    row.appendChild(item);
  }
  return row;
}

function rankTable(title, rows, color) {
  const box = el("div", "");
  box.appendChild(sectionTitle(title, "토큰 순"));
  if (!rows.length) { box.appendChild(el("div", "ust-empty", "없음")); return box; }
  const peak = Math.max(...rows.map((r) => r.tokens), 1);
  for (const r of rows) {
    const line = el("div", "ust-rank-r");
    line.appendChild(el("span", "ust-rank-n", r.name));
    const track = el("span", "ust-rank-bar");
    const fill = el("i", "ust-rank-fill");
    fill.style.width = `${Math.round((r.tokens / peak) * 100)}%`;
    fill.style.background = color;
    track.appendChild(fill);
    line.appendChild(track);
    line.appendChild(el("span", "ust-rank-v", compact(r.tokens)));
    box.appendChild(line);
  }
  return box;
}

// 머리 칸의 폭 클래스(w-*)가 열 폭을 정하고, 몸통 칸은 모양 클래스(td)만 받는다.
function table(columns, rows) {
  const t = el("table", "ust-tbl");
  const head = el("tr", "");
  for (const c of columns) head.appendChild(el("th", [c.w, c.num ? "ust-num" : ""].filter(Boolean).join(" "), c.label));
  t.appendChild(el("thead", "")).appendChild(head);
  const tbody = el("tbody", "");
  for (const r of rows) {
    const line = el("tr", "");
    for (const c of columns) {
      const v = c.value(r);
      const td = el("td", [c.td, c.num ? "ust-num" : ""].filter(Boolean).join(" "));
      if (v instanceof Node) td.appendChild(v); else td.textContent = String(v);
      line.appendChild(td);
    }
    tbody.appendChild(line);
  }
  t.appendChild(tbody);
  return t;
}

function sessionTable(recent, columns) {
  if (!recent.length) return el("div", "ust-empty", "아직 세션이 없습니다.");
  return table(columns, recent);
}

// 훑기 상태. 머리 줄 오른쪽에 둔다. 처음 여는 사람은 이것만 보고 몇 분을 기다리므로
// 무엇을 하는 중인지와 얼마나 왔는지를 적는다.
function scanBar() {
  const bar = el("span", "ust-scan");
  if (history.scanning) {
    const p = history.progress;
    const what = p && p.kind === "codex" ? "Codex" : "Claude";
    bar.appendChild(el("i", "ust-pulse"));
    bar.appendChild(el("b", "", "기록을 훑는 중"));
    bar.appendChild(el("span", "ust-scan-n", p ? `${what} ${full(p.done)} / ${full(p.total)}` : "시작하는 중"));
    const prog = el("span", "ust-prog");
    const fill = el("i", "");
    fill.style.width = p && p.total ? `${Math.round((p.done / p.total) * 100)}%` : "0%";
    prog.appendChild(fill);
    bar.appendChild(prog);
  } else if (history.summary) {
    const files = (history.summary.claude.fileCount || 0) + (history.summary.codex.fileCount || 0);
    const t = el("span", "", "마지막 훑기 ");
    t.appendChild(el("b", "", since(history.summary.scannedAt) || "-"));
    bar.appendChild(t);
    bar.appendChild(el("span", "ust-scan-n faint", `파일 ${full(files)}개 · ${Math.round((history.summary.durationMs || 0) / 1000)}초 걸림`));
  } else {
    bar.appendChild(el("b", "", "아직 훑지 않았습니다"));
    bar.appendChild(el("span", "ust-scan-n faint", "기록이 크면 첫 훑기에 몇 분이 걸립니다"));
  }
  const btn = el("button", "ust-btn", history.scanning ? "훑는 중" : "새로고침");
  btn.type = "button";
  btn.disabled = history.scanning;
  btn.addEventListener("click", () => wsSend({ type: "usage.history.scan" }));
  bar.appendChild(btn);
  return bar;
}

// 탭 내용
const CLAUDE_COLOR = "var(--ai)";
const CODEX_COLOR = "var(--pal-sky-pop)";

function claudeSeries(summary) {
  return {
    key: "claude", label: "Claude", color: CLAUDE_COLOR,
    daily: summary ? summary.claude.daily : [],
    totalOf: (d) => d.inp + d.out + d.cr + d.cw,
  };
}
function codexSeries(summary) {
  return {
    key: "codex", label: "Codex", color: CODEX_COLOR,
    daily: summary ? summary.codex.daily : [],
    totalOf: (d) => d.total || (d.inp + d.out + d.reasoning),
  };
}

function body() { return el("div", "ust-body"); }
function foot() {
  return el("div", "ust-foot",
    "이 집계는 이 기계에 남은 대화 기록에서 셉니다. 요금이 아니라 토큰 수이고, 지운 기록은 세지 않습니다.");
}

function overviewPane() {
  const pane = document.createDocumentFragment();
  const s = history.summary;
  if (!s) {
    const b = body();
    b.appendChild(el("div", "ust-empty", "훑기를 마치면 여기에 집계가 섭니다."));
    pane.appendChild(b);
    return pane;
  }
  const tokens = s.claude.totalTokens + s.codex.totalTokens;
  const sessions = s.claude.sessionCount + s.codex.sessionCount;
  const days = new Set([...s.claude.daily.map((d) => d.day), ...s.codex.daily.map((d) => d.day)]).size;
  const first = [s.claude.firstDay, s.codex.firstDay].filter(Boolean).sort()[0] || null;

  pane.appendChild(strip([
    cell("전체 토큰", compact(tokens), full(tokens)),
    cell("세션", full(sessions), `Claude ${full(s.claude.sessionCount)} · Codex ${full(s.codex.sessionCount)}`),
    cell("기록한 날", full(days), first ? `${first} 부터` : ""),
    cell("Claude", compact(s.claude.totalTokens), `세션 ${full(s.claude.sessionCount)} · ${full(s.claude.activeDays)}일`, CLAUDE_COLOR),
    cell("Codex", compact(s.codex.totalTokens), `세션 ${full(s.codex.sessionCount)} · ${full(s.codex.activeDays)}일`, CODEX_COLOR),
  ]));

  const b = body();
  b.appendChild(dailyChart([claudeSeries(s), codexSeries(s)], true));
  b.appendChild(foot());
  pane.appendChild(b);
  return pane;
}

// Claude·Codex 탭은 모양이 같고 칸 이름과 단위만 다르다.
function providerPane(s, cells, series, color, unit) {
  const pane = document.createDocumentFragment();
  pane.appendChild(strip(cells));
  const b = body();
  b.appendChild(dailyChart([series]));
  const two = el("div", "ust-two");
  two.appendChild(rankTable("모델", s.models, color));
  two.appendChild(rankTable("프로젝트", s.projects, color));
  b.appendChild(two);
  const recent = el("div", "");
  recent.appendChild(sectionTitle("최근 세션", "마지막 기록 순"));
  recent.appendChild(sessionTable(s.recent, [
    { label: "마지막", w: "w-time", td: "ust-mono", value: (x) => stamp(x.last) },
    { label: "프로젝트", value: (x) => x.project },
    { label: "모델", w: "w-model", td: "ust-mono", value: (x) => x.model },
    { label: unit.label, w: "w-num", num: true, value: unit.value },
    { label: "토큰", w: "w-num", num: true, value: (x) => compact(x.tokens) },
  ]));
  b.appendChild(recent);
  b.appendChild(foot());
  pane.appendChild(b);
  return pane;
}

function emptyPane(text) {
  const pane = document.createDocumentFragment();
  const b = body();
  b.appendChild(el("div", "ust-empty", text));
  pane.appendChild(b);
  return pane;
}

function claudePane() {
  const s = history.summary && history.summary.claude;
  if (!s || !s.sessionCount) return emptyPane("Claude 기록이 없습니다. ~/.claude/projects 를 읽습니다.");
  const t = s.totals;
  return providerPane(s, [
    cell("전체 토큰", compact(s.totalTokens), full(s.totalTokens)),
    cell("입력", compact(t.inp), "캐시 제외"),
    cell("출력", compact(t.out), ""),
    cell("캐시 읽기", compact(t.cr), `쓰기 ${compact(t.cw)}`),
    cell("턴", full(t.turns), ""),
    cell("세션", full(s.sessionCount), ""),
    cell("활동한 날", full(s.activeDays), dayRange(s.firstDay, s.lastDay)),
  ], claudeSeries(history.summary), CLAUDE_COLOR, { label: "턴", value: (x) => full(x.turns) });
}

function codexPane() {
  const s = history.summary && history.summary.codex;
  if (!s || !s.sessionCount) return emptyPane("Codex 기록이 없습니다. ~/.codex/sessions 를 읽습니다.");
  const t = s.totals;
  return providerPane(s, [
    cell("전체 토큰", compact(s.totalTokens), full(s.totalTokens)),
    cell("입력", compact(t.inp), `캐시 적중 ${compact(t.cached)}`),
    cell("출력", compact(t.out), ""),
    cell("추론", compact(t.reasoning), "출력에 포함"),
    cell("회차", full(t.events), ""),
    cell("세션", full(s.sessionCount), ""),
    cell("활동한 날", full(s.activeDays), dayRange(s.firstDay, s.lastDay)),
  ], codexSeries(history.summary), CODEX_COLOR, { label: "회차", value: (x) => full(x.events) });
}

// 같은 해 안이면 끝 날짜의 연도를 뺀다. 칸이 좁아 전체를 적으면 끝 날짜가 잘린다.
function dayRange(first, last) {
  if (!first) return "";
  return `${first} ~ ${last && last.slice(0, 4) === first.slice(0, 4) ? last.slice(5) : last}`;
}

function statusOf(provider) {
  if (!provider) return { text: "확인 전", cls: "" };
  const hasValue = provider.session || provider.weekly;
  if (provider.status === "ok" || hasValue) {
    const stale = provider.status === "error";
    return { text: stale ? `${REASONS[provider.failureKind] || "실패"} · 이전 값 있음` : "정상", cls: stale ? "warn" : "ok" };
  }
  return { text: REASONS[provider.failureKind] || provider.error || "확인 실패", cls: "bad" };
}

function accountsPane() {
  const pane = document.createDocumentFragment();
  const b = body();
  const creds = el("div", "");
  creds.appendChild(sectionTitle("자격증명", since(providersAt) ? `${since(providersAt)} 확인` : "확인 전"));
  creds.appendChild(el("p", "ust-note", "Iris 는 읽기만 합니다. 토큰을 새로 발급하지 않으므로 로그인이 끊기지 않습니다."));

  const byId = new Map(providers.map((p) => [p.provider, p]));
  creds.appendChild(table([
    { label: "제공자", w: "w-prov", td: "ust-name", value: (id) => PROVIDER_NAMES[id] },
    { label: "상태", w: "w-state", value: (id) => {
      const st = statusOf(byId.get(id));
      const tag = el("span", `ust-st${st.cls ? " " + st.cls : ""}`);
      tag.appendChild(el("i", ""));
      tag.appendChild(document.createTextNode(st.text));
      return tag;
    } },
    { label: "읽는 곳", td: "ust-mono", value: (id) => PROVIDER_SOURCE[id] },
  ], Object.keys(PROVIDER_NAMES)));
  b.appendChild(creds);

  const direct = el("div", "");
  direct.appendChild(sectionTitle("직접 넣는 값"));
  direct.appendChild(el("p", "ust-note", "opencode Go 와 MiniMax 는 로그인 쿠키가 있어야 잔량을 읽습니다. 넣은 값은 창으로 되돌아오지 않고 이 기계에만 남습니다."));
  const form = el("div", "");
  for (const f of SECRET_FIELDS) {
    const row = el("div", "ust-secret");
    row.appendChild(el("span", "", f.label));
    const flag = prefsFlags[`has${f.field.charAt(0).toUpperCase()}${f.field.slice(1)}`];
    row.appendChild(el("span", `ust-secret-f ${flag ? "on" : ""}`, flag ? "들어 있음" : "비어 있음"));
    const input = el("input", "ust-input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = f.hint;
    input.setAttribute("aria-label", f.label);
    row.appendChild(input);
    const save = el("button", "ust-btn", "저장");
    save.type = "button";
    save.addEventListener("click", () => {
      wsSend({ type: "usage.secret", field: f.field, value: input.value });
      input.value = "";
    });
    row.appendChild(save);
    const clear = el("button", "ust-btn ust-btn-ghost", "지우기");
    clear.type = "button";
    clear.addEventListener("click", () => wsSend({ type: "usage.secret", field: f.field, value: "" }));
    row.appendChild(clear);
    form.appendChild(row);
  }
  direct.appendChild(form);
  b.appendChild(direct);
  pane.appendChild(b);
  return pane;
}

function draw() {
  if (!root) return;
  root.textContent = "";

  const head = el("div", "ust-head");
  head.appendChild(el("h2", "ust-h", "사용량 상세·이력"));
  const tabs = el("nav", "ust-tabs");
  for (const t of TABS) {
    const btn = el("button", `ust-tab${t.id === tab ? " on" : ""}`, t.label);
    btn.type = "button";
    btn.addEventListener("click", () => { tab = t.id; draw(); });
    tabs.appendChild(btn);
  }
  head.appendChild(tabs);
  if (tab !== "accounts") head.appendChild(scanBar());
  root.appendChild(head);
  if (tab !== "accounts" && history.error) root.appendChild(el("div", "ust-err", history.error));

  const scroll = el("div", "ust-scroll");
  scroll.appendChild(
    tab === "claude" ? claudePane()
    : tab === "codex" ? codexPane()
    : tab === "accounts" ? accountsPane()
    : overviewPane(),
  );
  root.appendChild(scroll);
}

// 상태바가 넘겨 주는 것들
export function setHistory(msg) {
  history = {
    summary: msg.summary || history.summary,
    scanning: !!msg.scanning,
    progress: msg.progress || null,
    error: msg.error || null,
  };
  if (entered) draw();
}

export function setProviders(list, updatedAt) {
  providers = Array.isArray(list) ? list : [];
  providersAt = typeof updatedAt === "number" ? updatedAt : 0;
  if (entered && tab === "accounts") draw();
}

export function setPrefsFlags(msg) {
  prefsFlags = {
    hasOpencodeCookie: !!msg.hasOpencodeCookie,
    hasOpencodeWorkspace: !!msg.hasOpencodeWorkspace,
    hasMinimaxCookie: !!msg.hasMinimaxCookie,
    hasMinimaxGroupId: !!msg.hasMinimaxGroupId,
  };
  if (entered && tab === "accounts") draw();
}

// 화면으로 가는 진입점. rail 버튼을 사용자와 같은 방식으로 누른다. 앱 셸의 모듈을 import 하지 않기 위한 것이고,
// 그래서 사용자가 눌렀을 때와 같은 경로를 지난다.
export function openUsagePage(startTab) {
  if (startTab && TABS.some((t) => t.id === startTab)) tab = startTab;
  const button = document.querySelector('.rail-ico[data-rail="usage"]');
  if (!button || button.hidden) return false;
  button.click();
  return true;
}

export function initUsagePage(ctx) {
  $ = ctx.$;
  wsSend = ctx.wsSend;

  return {
    screen: {
      enter: () => {
        root = $("#usage-panel") ? $("#usage-panel").querySelector(".ust-page") : null;
        entered = true;
        draw();
        // 열 때 한 번 묻는다. 서버가 최근에 스캔했으면 즉시 돌려준다.
        wsSend({ type: "usage.history.get" });
      },
      leave: () => { entered = false; },
    },
  };
}
