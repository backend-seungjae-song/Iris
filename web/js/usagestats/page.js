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

function card(label, value, note) {
  const box = el("div", "ust-card");
  box.appendChild(el("div", "ust-card-l", label));
  box.appendChild(el("div", "ust-card-v", value));
  if (note) box.appendChild(el("div", "ust-card-n", note));
  return box;
}

function cardRow(cards) {
  const row = el("div", "ust-cards");
  for (const c of cards) row.appendChild(c);
  return row;
}

function sectionTitle(text, note) {
  const head = el("div", "ust-sec");
  head.appendChild(el("span", "ust-sec-t", text));
  if (note) head.appendChild(el("span", "ust-sec-n", note));
  return head;
}

// 일별 막대. 두 제공자를 한 막대에 쌓아 어느 쪽이 그날을 채웠는지 한눈에 보이게 한다.
function dailyChart(series) {
  const byDay = new Map();
  for (const s of series) {
    for (const d of s.daily || []) {
      let cur = byDay.get(d.day);
      if (!cur) { cur = { day: d.day, parts: [] }; byDay.set(d.day, cur); }
      cur.parts.push({ key: s.key, color: s.color, tokens: s.totalOf(d) });
    }
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-CHART_DAYS);
  const wrap = el("div", "ust-chart");
  if (!days.length) {
    wrap.appendChild(el("div", "ust-empty", "아직 기록이 없습니다."));
    return wrap;
  }
  const totals = days.map((d) => d.parts.reduce((a, p) => a + p.tokens, 0));
  const peak = Math.max(...totals, 1);
  // 가장 높은 날에 맞추면 하루가 다른 날의 스무 배인 경우 나머지가 전부 바닥에 붙는다
  // (확인 결과: 어느 하루가 58B, 보통 날이 0.3B). 그래서 기준은 위에서 열째 날에 맞추고, 그보다
  // 높은 날은 꼭대기까지 그리되 잘렸다는 표시를 단다. 표시가 없으면 값이 잘못 읽힌다.
  const ranked = totals.filter((v) => v > 0).sort((a, b) => a - b);
  const base = ranked.length ? Math.max(ranked[Math.floor(ranked.length * 0.9)], 1) : 1;
  const bars = el("div", "ust-bars");
  for (const d of days) {
    const total = d.parts.reduce((a, p) => a + p.tokens, 0);
    const col = el("div", `ust-bar${total > base ? " clip" : ""}`);
    col.title = `${d.day} · ${full(total)} 토큰`;
    const stack = el("div", "ust-stack");
    stack.style.height = `${Math.min(Math.max((total / base) * 100, total > 0 ? 2 : 0), 100)}%`;
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
  wrap.appendChild(bars);
  const axis = el("div", "ust-axis");
  axis.appendChild(el("span", "", days[0].day));
  axis.appendChild(el("span", "", base < peak
    ? `자 높이 ${compact(base)} · 가장 많은 날 ${compact(peak)}`
    : `가장 많은 날 ${compact(peak)}`));
  axis.appendChild(el("span", "", days[days.length - 1].day));
  wrap.appendChild(axis);
  return wrap;
}

function legend(series) {
  const row = el("div", "ust-legend");
  for (const s of series) {
    const item = el("span", "ust-leg");
    const dot = el("span", "ust-dot");
    dot.style.background = s.color;
    item.appendChild(dot);
    item.appendChild(el("span", "", s.label));
    row.appendChild(item);
  }
  return row;
}

function rankTable(title, rows) {
  const box = el("div", "ust-rank");
  box.appendChild(el("div", "ust-rank-t", title));
  if (!rows.length) { box.appendChild(el("div", "ust-empty", "없음")); return box; }
  const peak = Math.max(...rows.map((r) => r.tokens), 1);
  for (const r of rows) {
    const line = el("div", "ust-rank-r");
    line.appendChild(el("span", "ust-rank-n", r.name));
    const track = el("span", "ust-rank-bar");
    const fill = el("span", "ust-rank-fill");
    fill.style.width = `${Math.round((r.tokens / peak) * 100)}%`;
    track.appendChild(fill);
    line.appendChild(track);
    line.appendChild(el("span", "ust-rank-v", compact(r.tokens)));
    box.appendChild(line);
  }
  return box;
}

function sessionTable(recent, columns) {
  const table = el("div", "ust-table");
  const head = el("div", "ust-tr ust-th");
  for (const c of columns) head.appendChild(el("span", `ust-td ${c.cls || ""}`, c.label));
  table.appendChild(head);
  if (!recent.length) { table.appendChild(el("div", "ust-empty", "아직 세션이 없습니다.")); return table; }
  for (const s of recent) {
    const line = el("div", "ust-tr");
    for (const c of columns) line.appendChild(el("span", `ust-td ${c.cls || ""}`, c.value(s)));
    table.appendChild(line);
  }
  return table;
}

// 스캔 상태
function scanBar() {
  const bar = el("div", "ust-scan");
  const left = el("div", "ust-scan-l");
  if (history.scanning) {
    const p = history.progress;
    const what = p && p.kind === "codex" ? "Codex" : "Claude";
    left.appendChild(el("span", "ust-scan-t", "기록을 훑는 중"));
    left.appendChild(el("span", "ust-scan-n", p ? `${what} ${p.done}/${p.total}` : "시작하는 중"));
  } else if (history.summary) {
    const files = (history.summary.claude.fileCount || 0) + (history.summary.codex.fileCount || 0);
    left.appendChild(el("span", "ust-scan-t", `마지막 훑기 ${since(history.summary.scannedAt) || "-"}`));
    left.appendChild(el("span", "ust-scan-n", `파일 ${full(files)}개 · ${Math.round((history.summary.durationMs || 0) / 1000)}초 걸림`));
  } else {
    left.appendChild(el("span", "ust-scan-t", "아직 훑지 않았습니다"));
    left.appendChild(el("span", "ust-scan-n", "기록이 크면 첫 훑기에 몇 분이 걸립니다"));
  }
  bar.appendChild(left);
  const btn = el("button", "ust-btn", history.scanning ? "훑는 중" : "새로고침");
  btn.type = "button";
  btn.disabled = history.scanning;
  btn.addEventListener("click", () => wsSend({ type: "usage.history.scan" }));
  bar.appendChild(btn);
  if (history.error) {
    const err = el("div", "ust-err", history.error);
    const holder = el("div", "ust-scan-wrap");
    holder.appendChild(bar);
    holder.appendChild(err);
    return holder;
  }
  return bar;
}

// 탭 내용
const CLAUDE_COLOR = "var(--pal-pink)";
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

function overviewPane() {
  const pane = el("div", "ust-pane");
  const s = history.summary;
  if (!s) {
    pane.appendChild(el("div", "ust-empty", "훑기를 마치면 여기에 집계가 섭니다."));
    return pane;
  }
  const tokens = s.claude.totalTokens + s.codex.totalTokens;
  const sessions = s.claude.sessionCount + s.codex.sessionCount;
  const days = new Set([...s.claude.daily.map((d) => d.day), ...s.codex.daily.map((d) => d.day)]).size;
  const first = [s.claude.firstDay, s.codex.firstDay].filter(Boolean).sort()[0] || null;

  pane.appendChild(cardRow([
    card("전체 토큰", compact(tokens), full(tokens)),
    card("세션", full(sessions), `Claude ${full(s.claude.sessionCount)} · Codex ${full(s.codex.sessionCount)}`),
    card("기록한 날", full(days), first ? `${first} 부터` : ""),
  ]));

  pane.appendChild(sectionTitle("날짜별 토큰", `최근 ${CHART_DAYS}일`));
  const series = [claudeSeries(s), codexSeries(s)];
  pane.appendChild(legend(series));
  pane.appendChild(dailyChart(series));

  pane.appendChild(sectionTitle("제공자"));
  pane.appendChild(cardRow([
    card("Claude", compact(s.claude.totalTokens), `세션 ${full(s.claude.sessionCount)} · ${full(s.claude.activeDays)}일`),
    card("Codex", compact(s.codex.totalTokens), `세션 ${full(s.codex.sessionCount)} · ${full(s.codex.activeDays)}일`),
  ]));
  return pane;
}

function claudePane() {
  const pane = el("div", "ust-pane");
  const s = history.summary && history.summary.claude;
  if (!s || !s.sessionCount) {
    pane.appendChild(el("div", "ust-empty", "Claude 기록이 없습니다. ~/.claude/projects 를 읽습니다."));
    return pane;
  }
  const t = s.totals;
  pane.appendChild(cardRow([
    card("전체 토큰", compact(s.totalTokens), full(s.totalTokens)),
    card("입력", compact(t.inp), "캐시 제외"),
    card("출력", compact(t.out), ""),
    card("캐시 읽기", compact(t.cr), `쓰기 ${compact(t.cw)}`),
  ]));
  pane.appendChild(cardRow([
    card("턴", full(t.turns), ""),
    card("세션", full(s.sessionCount), ""),
    card("활동한 날", full(s.activeDays), s.firstDay ? `${s.firstDay} ~ ${s.lastDay}` : ""),
  ]));

  pane.appendChild(sectionTitle("날짜별 토큰", `최근 ${CHART_DAYS}일`));
  pane.appendChild(dailyChart([claudeSeries(history.summary)]));

  const two = el("div", "ust-two");
  two.appendChild(rankTable("모델", s.models));
  two.appendChild(rankTable("프로젝트", s.projects));
  pane.appendChild(sectionTitle("많이 쓴 곳"));
  pane.appendChild(two);

  pane.appendChild(sectionTitle("최근 세션"));
  pane.appendChild(sessionTable(s.recent, [
    { label: "마지막", cls: "w-time", value: (x) => stamp(x.last) },
    { label: "프로젝트", cls: "w-proj", value: (x) => x.project },
    { label: "모델", cls: "w-model", value: (x) => x.model },
    { label: "턴", cls: "w-num", value: (x) => full(x.turns) },
    { label: "토큰", cls: "w-num", value: (x) => compact(x.tokens) },
  ]));
  return pane;
}

function codexPane() {
  const pane = el("div", "ust-pane");
  const s = history.summary && history.summary.codex;
  if (!s || !s.sessionCount) {
    pane.appendChild(el("div", "ust-empty", "Codex 기록이 없습니다. ~/.codex/sessions 를 읽습니다."));
    return pane;
  }
  const t = s.totals;
  pane.appendChild(cardRow([
    card("전체 토큰", compact(s.totalTokens), full(s.totalTokens)),
    card("입력", compact(t.inp), `캐시 적중 ${compact(t.cached)}`),
    card("출력", compact(t.out), ""),
    card("추론", compact(t.reasoning), "출력에 포함"),
  ]));
  pane.appendChild(cardRow([
    card("회차", full(t.events), ""),
    card("세션", full(s.sessionCount), ""),
    card("활동한 날", full(s.activeDays), s.firstDay ? `${s.firstDay} ~ ${s.lastDay}` : ""),
  ]));

  pane.appendChild(sectionTitle("날짜별 토큰", `최근 ${CHART_DAYS}일`));
  pane.appendChild(dailyChart([codexSeries(history.summary)]));

  const two = el("div", "ust-two");
  two.appendChild(rankTable("모델", s.models));
  two.appendChild(rankTable("프로젝트", s.projects));
  pane.appendChild(sectionTitle("많이 쓴 곳"));
  pane.appendChild(two);

  pane.appendChild(sectionTitle("최근 세션"));
  pane.appendChild(sessionTable(s.recent, [
    { label: "마지막", cls: "w-time", value: (x) => stamp(x.last) },
    { label: "프로젝트", cls: "w-proj", value: (x) => x.project },
    { label: "모델", cls: "w-model", value: (x) => x.model },
    { label: "회차", cls: "w-num", value: (x) => full(x.events) },
    { label: "토큰", cls: "w-num", value: (x) => compact(x.tokens) },
  ]));
  return pane;
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
  const pane = el("div", "ust-pane");
  pane.appendChild(sectionTitle("자격증명", since(providersAt) ? `${since(providersAt)} 확인` : "확인 전"));
  pane.appendChild(el("div", "ust-note", "Iris 는 읽기만 합니다. 토큰을 새로 발급하지 않으므로 로그인이 끊기지 않습니다."));

  const list = el("div", "ust-accounts");
  const byId = new Map(providers.map((p) => [p.provider, p]));
  for (const id of Object.keys(PROVIDER_NAMES)) {
    const p = byId.get(id);
    const st = statusOf(p);
    const line = el("div", "ust-acct");
    line.appendChild(el("span", "ust-acct-n", PROVIDER_NAMES[id]));
    line.appendChild(el("span", `ust-acct-s ${st.cls}`, st.text));
    line.appendChild(el("span", "ust-acct-p", PROVIDER_SOURCE[id]));
    list.appendChild(line);
  }
  pane.appendChild(list);

  pane.appendChild(sectionTitle("직접 넣는 값"));
  pane.appendChild(el("div", "ust-note", "opencode Go 와 MiniMax 는 로그인 쿠키가 있어야 잔량을 읽습니다. 넣은 값은 창으로 되돌아오지 않고 이 기계에만 남습니다."));
  const form = el("div", "ust-secrets");
  for (const f of SECRET_FIELDS) {
    const row = el("div", "ust-secret");
    const label = el("label", "ust-secret-l");
    label.appendChild(el("span", "ust-secret-n", f.label));
    const flag = prefsFlags[`has${f.field.charAt(0).toUpperCase()}${f.field.slice(1)}`];
    label.appendChild(el("span", `ust-secret-f ${flag ? "on" : ""}`, flag ? "들어 있음" : "비어 있음"));
    row.appendChild(label);
    const input = el("input", "ust-input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = f.hint;
    row.appendChild(input);
    const save = el("button", "ust-btn", "저장");
    save.type = "button";
    save.addEventListener("click", () => {
      wsSend({ type: "usage.secret", field: f.field, value: input.value });
      input.value = "";
    });
    row.appendChild(save);
    const clear = el("button", "ust-btn ghost", "지우기");
    clear.type = "button";
    clear.addEventListener("click", () => wsSend({ type: "usage.secret", field: f.field, value: "" }));
    row.appendChild(clear);
    form.appendChild(row);
  }
  pane.appendChild(form);
  return pane;
}

function draw() {
  if (!root) return;
  root.textContent = "";

  const head = el("div", "ust-head");
  head.appendChild(el("h2", "ust-h", "사용량 상세·이력"));
  const tabs = el("div", "ust-tabs");
  for (const t of TABS) {
    const btn = el("button", `ust-tab${t.id === tab ? " on" : ""}`, t.label);
    btn.type = "button";
    btn.addEventListener("click", () => { tab = t.id; draw(); });
    tabs.appendChild(btn);
  }
  head.appendChild(tabs);
  root.appendChild(head);

  if (tab !== "accounts") root.appendChild(scanBar());

  root.appendChild(
    tab === "claude" ? claudePane()
    : tab === "codex" ? codexPane()
    : tab === "accounts" ? accountsPane()
    : overviewPane(),
  );

  if (tab !== "accounts") {
    root.appendChild(el("div", "ust-foot",
      "이 집계는 이 기계에 남은 대화 기록에서 셉니다. 요금이 아니라 토큰 수이고, 지운 기록은 세지 않습니다."));
  }
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
