// 구독 사용량: 하단 상태바 세그먼트와 그 위로 열리는 로스터 화면.
//
// 소유 범위
//   상태바에 표시되는 제공자 세그먼트, 로스터 화면, 표시 설정(사용/남음 · 상세/간결)의 화면 쪽,
//   그리고 남은 시간 표시를 갱신하는 타이머 하나.
//
// 제공 API
//   initCapability(ctx) 는 연결하고 { screen, ws } 를 돌려준다. panelHtml 은 화면 모듈 것을
//   그대로 넘긴다. 이 기능은 영역 둘을 갖는다. 아래 띠(statusbar)와 rail 화면 하나다.
//
// 의존 대상
//   ctx 의 $ · wsSend, 앱 셸이 만든 #statusbar 영역, 그리고 같은 기능의 화면 모듈
//   (usagestats/page.js). 다른 기능은 import 하지 않는다.
//   값은 전부 서버가 준다. 이 파일은 자격증명도 엔드포인트도 모른다.
//
// 유지 조건
//   영역(#statusbar)이 비어 있으면 앱 셸이 그 띠를 내린다. 그러니 값이 없다고 영역을 비우지
//   않는다. 비우면 기능을 켠 사용자에게도 띠가 사라졌다 다시 나타난다.
//   바 색은 쓴 양이 정하고, 바 길이는 사람이 고른 표시(사용/남음)가 정한다. 둘을 같은 값으로
//   묶으면 "남은 양" 으로 보는 사용자에게 90% 남은 칸이 경고색으로 표시된다.
//   제공자가 준 글자(플랜 이름·모델 이름)는 textContent 로만 넣는다.
//
// 영향 범위
//   server/usage-handlers.js 가 보내는 usage.state·usage.prefs 계약,
//   web/css/28-usage.css 의 이름들, web/css/01-base.css 의 .statusbar 영역,
//   web/js/usagestats/page.js 가 그리는 rail 화면.
//   현재 목록 확인: node bin/importers.mjs web/js/statusbar/usage.js

import {
  initUsagePage, openUsagePage, panelHtml as pagePanelHtml,
  setHistory, setPrefsFlags, setProviders,
} from "../usagestats/page.js";

// 영역(패널 마크업)은 화면 모듈이 갖는다. 부팅은 이 이름만 본다.
export const panelHtml = pagePanelHtml;

const NAMES = {
  "claude": "Claude", "codex": "Codex", "gemini": "Gemini", "antigravity": "Antigravity",
  "opencode-go": "opencode Go", "kimi": "Kimi", "minimax": "MiniMax", "grok": "Grok",
};
const MARKS = {
  "claude": "C", "codex": "Cx", "gemini": "G", "antigravity": "Ag",
  "opencode-go": "oc", "kimi": "K", "minimax": "Mm", "grok": "Gk",
};
// 표시할 수 없는 이유를 사용자 문구로 적는다. 필요한 조치가 그 문구 안에 있어야 한다.
const REASONS = {
  "missing-credentials": "로그인 필요",
  "needs-cookie": "쿠키 필요",
  "stale-token": "토큰 만료",
  "rate-limited": "요청 과다",
  "bad-setting": "설정 오류",
  "usage-unavailable": "사용량 없음",
  "server": "연결 실패",
  "network": "연결 실패",
};

// 초기화권을 제공하는 제공자별 계약. 결과 문구는 실제로 일어난 일을 그대로 적는다. 차감된
// 경우와 차감되지 않은 경우가 화면에서 같아 보이면 사용자가 다시 누르게 된다.
const COMMON_OUTCOMES = {
  reset: "초기화됨",
  "missing-credentials": "로그인 필요",
  "stale-token": "토큰 만료",
  network: "연결 실패",
};
const RESETS = {
  codex: {
    message: "usage.codexReset",
    outcomes: {
      ...COMMON_OUTCOMES,
      nothing_to_reset: "초기화할 한도가 없어 차감 안 됨",
      no_credit: "남은 초기화권 없음",
      already_redeemed: "이미 처리된 요청",
    },
    ask: (have) => `초기화권 1개를 사용합니다. 사용 후 ${Math.max(0, have - 1)}개 남습니다.\n`
      + "초기화할 한도가 없으면 차감되지 않습니다.\n"
      + "사용한 초기화권은 되돌릴 수 없습니다. 계속할까요?",
  },
  claude: {
    message: "usage.claudeReset",
    outcomes: {
      ...COMMON_OUTCOMES,
      already_used: "이미 처리된 요청",
      not_limited: "한도에 걸리지 않아 차감 안 됨",
      cooldown: "잠시 뒤 다시 시도",
      ineligible: "이 계정은 사용할 수 없음",
      unavailable: "지금 사용할 수 없음",
      rate_limited: "요청 과다",
    },
    ask: (have) => `초기화권 1개를 사용합니다. 사용 후 ${Math.max(0, have - 1)}개 남습니다.\n`
      + "사용한 초기화권은 되돌릴 수 없습니다. 계속할까요?",
  },
};
// 서버가 버튼을 잠근 이유(resetBlocked). Claude 초기화권은 한도에 걸린 동안에만 쓸 수 있는
// 경우가 있어 그때는 누를 수 없게 한다.
const RESET_BLOCKED = {
  "needs-limit": "한도 도달 시 사용 가능",
  cooldown: "잠시 뒤 사용 가능",
  paused: "일시정지됨",
  ineligible: "이 계정은 사용할 수 없음",
  none: "지금 사용할 수 없음",
};

const TICK_MS = 30000;        // 남은 시간 표시를 갱신하는 간격
const RESET_WAIT_MS = 20000;  // 초기화권 응답을 기다리는 상한. 서버가 10초에 끊는다
const STALE_ASK_MS = 60000;   // 화면을 열 때 값이 이보다 오래됐으면 한 번 물어본다

let $ = null;
let wsSend = () => {};
let mounted = null;      // { bar, trigger, panel }
let providers = [];
let updatedAt = 0;
let fetching = false;
let prefs = { display: "used", mode: "verbose" };
let panelOpen = false;
let tick = null;
// 초기화권을 쓰는 동안의 상태. 제공자마다 따로 갖는다. armed = 한 번 눌러 확인을 기다리는 중,
// busy = 보내고 답 기다리는 중, pending = 보냈는데 답을 받지 못한 요청.
// requestId(Claude 는 grantId 도)는 무장하는 순간 한 번 정하고 답을 받을 때까지 유지한다. 답이
// 유실돼 다시 보낼 때 새 id 를 만들면 제공자가 별개 요청으로 계산해 초기화권이 두 개 차감된다.
// 같은 id 면 이미 처리된 요청으로 돌아온다.
const resetStates = {};
function resetState(provider) {
  if (!resetStates[provider]) {
    resetStates[provider] = { armed: false, busy: false, pending: false, requestId: "", grantId: "", wait: null, note: "", noteTimer: null, hint: "" };
  }
  return resetStates[provider];
}

// ── 값 다루기 ────────────────────────────────────────────────────────────────

function clampUsed(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// 자르고 반올림한 뒤에 뺀다. 뺀 다음에 반올림하면 20.5% 가 79 와 80 으로 나뉜다.
function shownPercent(used) {
  return prefs.display === "used" ? used : 100 - used;
}

function heatClass(used) {
  if (used >= 80) return "hot";
  if (used >= 60) return "warn";
  return "";
}

function windowLabel(minutes) {
  if (minutes === 10080) return "wk";
  if (minutes === 300) return "5h";
  if (minutes === 43200) return "30d";
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// 하루가 넘어도 시간을 버리지 않는다. "6일" 만으로는 6일 1시간인지 6일 23시간인지
// 알 수 없어, 오늘 안에 풀리는지 내일인지를 판단할 수 없다.
function remainLabel(resetsAt) {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const left = resetsAt - Date.now();
  if (left <= 0) return "곧";
  const minutes = Math.floor(left / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}일 ${rest}시간` : `${days}일`;
}

function planLabel(planType) {
  const text = String(planType || "").trim();
  if (!text) return "";
  return text.split(/[\s_-]+/)
    .map((word) => (word.toLowerCase() === "chatgpt" ? "ChatGPT" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

// 한 제공자가 가진 창 전부. 모델별 그룹(gemini·minimax)은 자기 이름을 라벨로 쓴다.
function sectionsOf(provider) {
  const out = [];
  const add = (label, window) => { if (window) out.push({ label, window }); };
  if (Array.isArray(provider.buckets) && provider.buckets.length) {
    for (const bucket of provider.buckets) add(bucket.name, bucket);
    add(windowLabel(10080), provider.weekly);
    return out;
  }
  add(windowLabel(300), provider.session);
  add(windowLabel(10080), provider.weekly);
  if (provider.monthly) add(windowLabel(43200), provider.monthly);
  for (const one of Array.isArray(provider.scoped) ? provider.scoped : []) add(one.label, one.window);
  return out;
}

// 가장 많이 쓴 창. 급한 항목을 고르는 것이라 "남은 양" 으로 보고 있어도 기준은 쓴 양이다.
function tightestOf(sections) {
  if (!sections.length) return null;
  return sections.reduce((now, next) =>
    (clampUsed(next.window.usedPercent) > clampUsed(now.window.usedPercent) ? next : now));
}

function maxUsedOf(provider) {
  const sections = sectionsOf(provider);
  return sections.length ? Math.max(...sections.map((one) => clampUsed(one.window.usedPercent))) : -1;
}

function sortedProviders() {
  return [...providers].sort((a, b) => maxUsedOf(b) - maxUsedOf(a));
}

function withData() {
  return sortedProviders().filter((one) => sectionsOf(one).length > 0);
}

// ── 렌더 헬퍼 ───────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function badge(provider) {
  const node = el("span", "usg-badge", MARKS[provider] || "?");
  node.title = NAMES[provider] || provider;
  return node;
}

function bar(used, width) {
  const track = el("span", "usg-bar");
  if (width) track.style.width = `${width}px`;
  const fill = el("i", `usg-fill ${heatClass(used)}`.trim());
  fill.style.width = `${shownPercent(used)}%`;
  track.appendChild(fill);
  return track;
}

function metric(section, label, showBar, showReset) {
  const used = clampUsed(section.window.usedPercent);
  const wrap = el("span", "usg-win");
  wrap.appendChild(el("span", "usg-lbl", label));
  if (showBar) wrap.appendChild(bar(used, 28));
  wrap.appendChild(el("span", `usg-pct ${heatClass(used)}`.trim(), `${shownPercent(used)}%`));
  // 창마다 자기 초기화 시각을 갖는다. 가장 빠른 것 하나만 적으면 5시간이 언제 풀리는지는
  // 보이고 주간이 언제 풀리는지는 보이지 않는다. 둘은 서로 다른 판단에 쓰인다.
  if (showReset) {
    const until = remainLabel(section.window.resetsAt);
    if (until) wrap.appendChild(el("span", "usg-until", `${until} 뒤`));
  }
  return wrap;
}

function refreshIcon() {
  const button = el("button", "usg-refresh");
  button.type = "button";
  button.title = "지금 다시 확인";
  button.setAttribute("aria-label", "사용량 다시 확인");
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>';
  button.addEventListener("click", (event) => { event.stopPropagation(); wsSend({ type: "usage.refresh" }); });
  return button;
}

function segmented(options, current, onPick) {
  const wrap = el("span", "usg-switch");
  for (const one of options) {
    const button = el("button", `usg-switch-btn${one.value === current ? " on" : ""}`, one.label);
    button.type = "button";
    button.addEventListener("click", (event) => { event.stopPropagation(); onPick(one.value); });
    wrap.appendChild(button);
  }
  return wrap;
}

// ── 상태바 ───────────────────────────────────────────────────────────────────

function drawTrigger() {
  const trigger = mounted.trigger;
  trigger.textContent = "";
  trigger.classList.toggle("on", panelOpen);
  const shown = withData();

  if (!shown.length) {
    // 값이 하나도 없어도 영역은 남긴다. 이 영역이 사라지면 상태바 세그먼트도 함께 사라진다.
    trigger.appendChild(el("span", "usg-empty", fetching ? "사용량 확인 중" : "사용량"));
    return;
  }
  for (const provider of shown) {
    const seg = el("span", `usg-seg${fetching ? " loading" : ""}${provider.stale ? " stale" : ""}`);
    // 오래된 값은 흐리게 표시하고 그 이유를 툴팁으로 붙인다. 지우지는 않는다.
    if (provider.stale) {
      seg.title = `${NAMES[provider.provider] || provider.provider}: ${REASONS[provider.failureKind] || "확인 불가"}`
        + (provider.dataAt ? ` · ${remainSince(provider.dataAt)} 전 값` : "");
    }
    seg.appendChild(badge(provider.provider));
    const sections = sectionsOf(provider);
    const tightest = tightestOf(sections);
    if (prefs.mode === "compact") {
      const label = remainLabel(tightest.window.resetsAt) || windowLabel(tightest.window.windowMinutes);
      seg.appendChild(metric(tightest, label, false));
    } else {
      seg.appendChild(bar(clampUsed(tightest.window.usedPercent), 44));
      for (const section of sections) seg.appendChild(metric(section, section.label, false));
    }
    trigger.appendChild(seg);
  }
}

// ── 로스터 화면 ──────────────────────────────────────────────────────────────

function row(provider) {
  const line = el("div", `usg-row${provider.stale ? " stale" : ""}`);
  line.appendChild(badge(provider.provider));
  const body = el("div", "usg-body");

  const head = el("div", "usg-line");
  const name = el("span", "usg-name", NAMES[provider.provider] || provider.provider);
  const plan = planLabel(provider.planType);
  if (plan) name.appendChild(el("span", "usg-plan", ` · ${plan}`));
  head.appendChild(name);

  const sections = sectionsOf(provider);
  if (!sections.length) {
    head.appendChild(el("span", "usg-state", REASONS[provider.failureKind] || "확인 불가"));
  } else if (provider.stale) {
    // 값은 남기되 언제 것인지 밝힌다. 현재 값처럼 보이게 두는 것이 지우는 것보다 나쁘다.
    head.appendChild(el("span", "usg-state", `${REASONS[provider.failureKind] || "확인 불가"}`
      + (provider.dataAt ? ` · ${remainSince(provider.dataAt)} 전 값` : "")));
  } else if (prefs.mode === "compact") {
    const tightest = tightestOf(sections);
    const label = remainLabel(tightest.window.resetsAt) || windowLabel(tightest.window.windowMinutes);
    const chip = metric(tightest, label, false);
    chip.classList.add("usg-tight");
    head.appendChild(chip);
  }
  // 상세에서는 머리글에 시각을 적지 않는다. 바로 아래 창마다 자기 시각을 갖는다.
  body.appendChild(head);

  if (sections.length && prefs.mode === "verbose") {
    const wins = el("div", "usg-wins");
    for (const section of sections) wins.appendChild(metric(section, section.label, true, true));
    body.appendChild(wins);
  }
  const credits = creditRow(provider);
  if (credits) body.appendChild(credits);
  line.appendChild(body);
  return line;
}

// 한도를 즉시 푸는 초기화권(Codex·Claude).
//
// 개수는 하나만 표시한다. Codex 는 가진 수와 지금 적용되는 수를 따로 주는데, 둘을 나란히 적으면
// "3개인데 왜 0개" 가 된다. 가진 초기화권은 모두 유효하고 없는 것은 적용 대상인데, 두 수를 함께
// 표시하면 초기화권을 쓸 수 없는 것처럼 읽힌다.
//
// Codex 는 적용되는 수로 버튼을 잠그지 않는다. 쓸 대상이 없으면 제공자가 nothing_to_reset 을
// 돌려주고 차감하지 않아 눌러도 손해가 없고, 확인이 두 겹이라 실수로 나가지 않으며, 조회 값이
// 틀린 계정에서는 영영 못 쓰는 길이 생긴다. Claude 는 서버가 넘긴 resetBlocked 가 있으면
// 잠근다(사용자 결정: 한도에 걸리지 않았을 때는 누를 수 없게).
function creditRow(provider) {
  const spec = RESETS[provider.provider];
  if (!spec) return null;
  const have = provider.resetCredits;
  if (typeof have !== "number") return null;
  const state = resetState(provider.provider);

  const wrap = el("div", "usg-credit");
  wrap.appendChild(el("span", "usg-credit-t", `초기화권 ${have}개`));

  const expires = remainLabel(provider.resetCreditExpiresAt);
  if (expires) wrap.appendChild(el("span", "usg-credit-n", `${expires} 뒤 만료`));

  if (state.note) {
    wrap.appendChild(el("span", "usg-credit-n", state.note));
    return wrap;
  }
  if (have <= 0) return wrap;

  const blocked = provider.provider === "claude" ? provider.resetBlocked : null;
  if (blocked) {
    const button = el("button", "usg-credit-b", RESET_BLOCKED[blocked] || RESET_BLOCKED.none);
    button.type = "button";
    button.disabled = true;
    wrap.appendChild(button);
    return wrap;
  }

  if (state.hint) wrap.appendChild(el("span", "usg-credit-n", state.hint));

  // 초기화권 하나가 차감되는 조작이라 두 단계로 확인한다. 첫 누름은 무슨 일이 일어나는지 버튼에
  // 적고, 두 번째 누름에서 모달이 뜬다. 되돌릴 수 없는 것은 되물어야 한다.
  const button = el("button", `usg-credit-b${state.armed ? " armed" : ""}`,
    state.busy ? "사용 중" : state.armed ? "초기화권 1개 사용 · 한 번 더" : "지금 초기화");
  button.type = "button";
  button.dataset.provider = provider.provider;
  button.disabled = state.busy;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.busy) return;
    const hadFocus = document.activeElement === button;
    if (!state.armed) {
      state.armed = true;
      // 답을 받지 못한 요청이 있으면 그 id(와 grant)를 그대로 다시 쓴다.
      if (!state.pending || !state.requestId) {
        state.requestId = `iris-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        state.grantId = provider.resetGrantId || "";
      }
      draw();
      refocusCredit(provider.provider, hadFocus);
      return;
    }
    if (!confirm(spec.ask(have))) {
      state.armed = false;
      draw();
      refocusCredit(provider.provider, hadFocus);
      return;
    }
    state.armed = false;
    state.busy = true;
    state.pending = true;
    state.hint = "";
    draw();
    wsSend({ type: spec.message, requestId: state.requestId, grantId: state.grantId });
    // 답이 오지 않으면 버튼이 "사용 중" 으로 남는다. 상한을 두고 풀되 요청은 pending 으로
    // 남겨 둔다. 다시 누를 때 같은 id 로 나가야 이중 차감이 발생하지 않는다.
    clearTimeout(state.wait);
    state.wait = setTimeout(() => {
      if (!state.busy) return;
      state.busy = false;
      // 결과 문구(note)로 두면 버튼이 그려지지 않아 다시 누를 수 없다. 버튼 옆 안내로 둔다.
      state.hint = "답이 없음 · 다시 누르면 같은 요청으로 확인";
      draw();
    }, RESET_WAIT_MS);
  });
  wrap.appendChild(button);
  if (state.armed && !state.busy) {
    const cancel = el("button", "usg-credit-b ghost", "취소");
    cancel.type = "button";
    cancel.addEventListener("click", (event) => { event.stopPropagation(); state.armed = false; draw(); });
    wrap.appendChild(cancel);
  }
  return wrap;
}

// 다시 그리면 누르던 버튼이 사라진다. 키보드로 조작하던 사용자는 포커스를 잃는다.
function refocusCredit(provider, had) {
  if (!had || !mounted || !mounted.panel) return;
  const next = mounted.panel.querySelector(`.usg-credit-b[data-provider="${provider}"]:not([disabled])`);
  if (next) next.focus();
}

// 서버의 답. 답이 왔으므로 이 요청은 끝났고 다음 시도는 새 id 로 나가야 한다.
function onResetAnswer(provider, msg) {
  const state = resetState(provider);
  clearTimeout(state.wait);
  state.busy = false;
  state.armed = false;
  state.pending = false;
  state.requestId = "";
  state.grantId = "";
  state.hint = "";
  state.note = RESETS[provider].outcomes[msg.outcome] || (msg.ok ? "초기화됨" : "실패");
  draw();
  // 결과 문구는 잠깐만 표시한다. 계속 남아 있으면 다음에 열었을 때 방금 일어난 일로 읽힌다.
  clearTimeout(state.noteTimer);
  state.noteTimer = setTimeout(() => { state.note = ""; draw(); }, 8000);
}

function setPref(patch) {
  prefs = { ...prefs, ...patch };
  wsSend({ type: "usage.prefs", display: prefs.display, mode: prefs.mode });
  draw();
}

function drawPanel() {
  const panel = mounted.panel;
  panel.hidden = !panelOpen;
  if (!panelOpen) return;
  panel.textContent = "";

  const head = el("div", "usg-head");
  head.appendChild(el("span", "usg-title", "사용량"));
  const since = updatedAt ? remainSince(updatedAt) : null;
  const meta = el("span", "usg-meta", since === null ? "확인 전" : since === "방금" ? "방금 확인" : `${since} 전`);
  head.appendChild(meta);
  const spin = refreshIcon();
  if (fetching) spin.classList.add("spin");
  head.appendChild(spin);
  panel.appendChild(head);

  panel.appendChild(segmented(
    [{ value: "verbose", label: "상세" }, { value: "compact", label: "간결" }],
    prefs.mode, (mode) => setPref({ mode }),
  ));
  panel.appendChild(el("div", "usg-sep"));

  for (const provider of sortedProviders()) panel.appendChild(row(provider));

  panel.appendChild(el("div", "usg-sep"));
  const foot = el("div", "usg-foot");
  foot.appendChild(el("span", "usg-lbl", "% 표시"));
  foot.appendChild(segmented(
    [{ value: "used", label: "쓴 양" }, { value: "remaining", label: "남은 양" }],
    prefs.display, (display) => setPref({ display }),
  ));
  panel.appendChild(foot);

  // 여기까지가 "지금 얼마나 남았나" 다. 누적 사용량과 계정 상태는 화면 모듈이 갖는다.
  panel.appendChild(el("div", "usg-sep"));
  panel.appendChild(link("사용량 상세·이력", "overview"));
  panel.appendChild(link("계정 상태·쿠키", "accounts"));
}

// 화면을 여는 줄. 기능을 껐다면 rail 버튼이 없으므로 아무 일도 하지 않고, 그때는 줄도 그리지 않는다.
function link(label, startTab) {
  const row = el("button", "usg-link", label);
  row.type = "button";
  row.addEventListener("click", () => { setOpen(false); openUsagePage(startTab); });
  return row;
}

function remainSince(at) {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간` : `${Math.floor(hours / 24)}일`;
}

function draw() {
  if (!mounted) return;
  drawTrigger();
  drawPanel();
}

function setOpen(next) {
  panelOpen = next;
  // 닫으면 확인 대기를 푼다. 열어 둔 채 잊은 확인이 다음에 한 번만 눌러도 나가면 안 된다.
  // 답을 받지 못한 요청 id 는 남긴다. 다음 시도가 같은 id 로 나가야 권이 두 번 나가지 않는다.
  if (!panelOpen) {
    for (const state of Object.values(resetStates)) {
      state.armed = false;
      if (!state.busy && !state.pending) { state.requestId = ""; state.grantId = ""; }
    }
  }
  // 열 때 값이 묵었으면 한 번 물어본다. 열 때마다 부르면 제공자가 429 로 막고, 그러면
  // 그 뒤로 한동안 아무 값도 받지 못한다. 화면을 여는 행동 자체가 값을 지우는 셈이 된다.
  if (panelOpen && Date.now() - updatedAt > STALE_ASK_MS) wsSend({ type: "usage.refresh" });
  draw();
}

// ── 연결 ─────────────────────────────────────────────────────────────────────

function mount() {
  const slot = $("#statusbar");
  if (!slot) return null;
  const trigger = el("button", "usg-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-label", "사용량");
  trigger.addEventListener("click", (event) => { event.stopPropagation(); setOpen(!panelOpen); });
  slot.appendChild(trigger);

  const panel = el("div", "usg-panel");
  panel.hidden = true;
  // 화면 안을 누르는 것은 닫는 신호가 아니다. 여기서 막지 않으면 전환 버튼 한 번에 닫힌다.
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.body.appendChild(panel);

  document.addEventListener("click", () => { if (panelOpen) setOpen(false); });
  document.addEventListener("keydown", (event) => { if (panelOpen && event.key === "Escape") setOpen(false); });
  return { slot, trigger, panel };
}

export function initCapability(ctx) {
  $ = ctx.$;
  wsSend = ctx.wsSend;
  mounted = mount();
  const page = initUsagePage(ctx);
  draw();
  // 남은 시간은 값이 바뀌지 않아도 흐른다. 서버 응답을 기다리면 "2시간 뒤" 가 두 시간 동안 그대로다.
  clearInterval(tick);
  tick = setInterval(draw, TICK_MS);

  // 띠와 화면은 같은 기능이라 메시지를 한 번만 받고 나눠 준다. 둘이 따로 등록하면 나중 것이
  // 덮어써서 먼저 것은 그 메시지를 받지 못한다.
  return {
    screen: page.screen,
    ws: {
      "usage.state": (msg) => {
        providers = Array.isArray(msg.providers) ? msg.providers : [];
        updatedAt = typeof msg.updatedAt === "number" ? msg.updatedAt : 0;
        fetching = !!msg.fetching;
        setProviders(providers, updatedAt);
        draw();
      },
      "usage.prefs": (msg) => {
        if (msg.display === "used" || msg.display === "remaining") prefs.display = msg.display;
        if (msg.mode === "verbose" || msg.mode === "compact") prefs.mode = msg.mode;
        setPrefsFlags(msg);
        draw();
      },
      "usage.history": (msg) => setHistory(msg),
      "usage.codexReset": (msg) => onResetAnswer("codex", msg),
      "usage.claudeReset": (msg) => onResetAnswer("claude", msg),
    },
  };
}
