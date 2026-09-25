// 로컬 데브: localdev 라우터의 라우트·프로젝트를 표로 보여 주고 시작·정지·종료를 보낸다.
//
// 소유 범위
//   <div class="ld-scr"> 이하 이 화면 전부. 상태 조회 주기, 진행 표시(busy), 접힌 프로젝트 펼침 여부.
//
// 제공 API
//   initCapability(ctx): 버튼을 연결하고 화면(enter·leave)과 서버 메시지 처리기를 돌려준다.
//
// 의존 대상
//   ctx 로 받은 $·esc·wsSend·copyText·askConfirm·openBrowserTab. core 나 browser 를 import 하지 않는다.
//   데이터는 서버의 localdev.* 메시지(server/localdev-bridge.js)로만 받는다. 렌더러는 라우터에 직접 닿지 못한다
//   (status.json 은 CORS 가 없고 컨트롤 서버는 Origin 을 http://localdev.test 로 고정한다).
//
// 유지 조건
//   화면이 보일 때만 3초마다 조회한다. 진행 표시는 다시 그려도 남도록 busy 표에 두고, 그 항목이 실제로
//   바뀐 것이 status.json 에 보이면 내린다. 소식이 없으면 20초 뒤 스스로 내린다.
//
// 영향 범위
//   rail 의 서버 화면 하나. 서버 쪽 짝은 server/localdev-bridge.js 이고, localdev 자체(라우터·컨트롤 서버)는 바꾸지 않는다.

const LD_URL = "http://localdev.test/";
const TICK_MS = 3000;
const CONFIRM_CAP = 20000;
const FAIL_SHOW = 2200;
const COPY_SHOW = 1100;
const ACTION_WAIT = 20000;
const STATUS_WAIT = 6000;   // 서버 쪽 제한 시간(4초)보다 길게 둔다

const ICON = {
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  play: '<path d="M7 5v14l12-7z" fill="currentColor" stroke="none"/>',
  svc: '<path d="M12 12c-2-2.7-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1.3 6-4zm0 0c2 2.7 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.3-6 4z"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// 이 기능의 영역. 셸(aside 의 id·class)은 rail 표가 정본이고 여기는 안쪽만 담는다.
export const panelHtml = `
  <div class="ld-scr">
    <div class="ld-head">
      <h1 class="ld-title">로컬 데브</h1>
      <div class="ld-sys" id="ld-sys"></div>
      <span class="ld-upd" id="ld-upd"></span>
      <span class="ld-sp"></span>
      <button class="ld-ibtn" id="ld-reload" title="새로고침">${icon("reload")}</button>
      <button class="ld-ibtn" id="ld-open" title="브라우저 탭으로 크게 열기">${icon("open")}</button>
    </div>
    <div class="ld-body" id="ld-body"></div>
    <div class="ld-err" id="ld-err" hidden></div>
  </div>
`;

let dom = null, esc = (s) => String(s);
let wsSend = () => {}, copyText = async () => false, askConfirm = null, openBrowserTab = () => {};
let browserMode = false;
let active = false, timer = null;
let lastData = null, lastSig = "", failed = null;
// 상태 요청마다 id 를 붙이고 서버가 그 id 를 응답에 돌려준다. 기다리는 요청은 마지막에 보낸 것 하나이고,
// 시간 초과로 끝난 요청의 늦은 응답이나 그보다 먼저 보낸 요청의 응답은 id 가 달라 버린다.
let statusSeq = 0;
let waiting = "";            // 응답을 기다리는 상태 요청의 id. 없으면 ""
let askTimer = null;
let retryId = "";            // "다시 연결"이 보낸 요청 id. 그 요청이 끝날 때까지 연결 중으로 보인다
let foldOpen = false;
let seq = 0;
const pending = new Map();   // 요청 id → resolve
const busy = new Map();      // "route:이름" | "proj:이름" → {label, fail, done, timer}
const copied = new Map();    // 복사 버튼 키 → { until: 표시를 내릴 시각, ok: 복사 결과 }

// force 가 아니면 응답을 기다리는 요청이 있을 때 건너뛴다(주기 조회). 타이머는 마지막 요청 것 하나만 두어,
// 이전 요청의 타이머가 새 요청을 끝내지 못하게 한다.
function requestStatus(force) {
  if (!force && waiting) return "";
  const id = `st${++statusSeq}`;
  waiting = id;
  wsSend({ type: "localdev.status", id });
  clearTimeout(askTimer);
  // 응답이 끝내 오지 않아도 다음 주기를 막지 않고, 다시 연결 버튼도 되살린다.
  askTimer = setTimeout(() => { askTimer = null; if (waiting === id) { waiting = ""; render(); } }, STATUS_WAIT);
  return id;
}

const retrying = () => !!retryId && waiting === retryId;

function onStatus(m) {
  if (!waiting || m.id !== waiting) return;
  waiting = "";
  clearTimeout(askTimer); askTimer = null;
  if (!m.ok) { failed = m.reason || "unreachable"; lastData = null; lastSig = ""; render(); return; }
  failed = null;
  lastData = m.data;
  render();
}

function onResult(m) {
  const done = pending.get(m.id);
  if (!done) return;
  pending.delete(m.id);
  done(m);
}

function sendAction(action, name, port) {
  const id = `ld${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) resolve({ ok: false, error: "timeout" }); }, ACTION_WAIT);
    wsSend({ type: "localdev.action", id, action, name, port });
  });
}

// 화면이 3초마다 다시 그려지므로 진행 표시는 여기에 둔다. 응답이 와도 status.json 이 아직 옛 상태라
// (데몬 주기 4초) 그 항목이 실제로 바뀐 것이 보일 때까지 들고 있는다.
function setBusy(key, label, done) {
  const prev = busy.get(key); if (prev?.timer) clearTimeout(prev.timer);
  const t = setTimeout(() => { busy.delete(key); render(true); }, CONFIRM_CAP);
  busy.set(key, { label, fail: false, done, timer: t });
  render(true);
}
function failBusy(key, label) {
  const prev = busy.get(key); if (prev?.timer) clearTimeout(prev.timer);
  const t = setTimeout(() => { busy.delete(key); render(true); }, FAIL_SHOW);
  busy.set(key, { label, fail: true, done: null, timer: t });
  render(true);
}
function readBusy(key, item) {
  const st = busy.get(key); if (!st) return null;
  if (st.done && item && st.done(item)) { clearTimeout(st.timer); busy.delete(key); return null; }
  return st;
}
function followUp(delays) { for (const ms of delays) setTimeout(() => { if (active) requestStatus(); }, ms); }

async function killRoute(r) {
  const key = "route:" + r.name;
  if (busy.has(key)) return;
  const ok = askConfirm ? await askConfirm(`${r.name} 서버를 종료할까요?`, `포트 ${r.port}`) : false;
  if (!ok) return;
  setBusy(key, "종료하는 중… 최대 8초", (x) => !x.up);
  const res = await sendAction("kill", r.name, r.port);
  if (!res.ok) { failBusy(key, res.error === "busy" ? "이미 처리 중" : "종료 실패"); return; }
  setBusy(key, "꺼짐 확인 중…", (x) => !x.up);
  requestStatus(); followUp([900, 2600, 5000]);
}

async function projectAction(p, action) {
  const key = "proj:" + p.name;
  if (busy.has(key)) return;
  const stopping = action === "stop";
  const settled = stopping ? (x) => !x.managed : (x) => x.running;
  setBusy(key, stopping ? "끄는 중… 최대 8초" : "켜는 중…", settled);
  const res = await sendAction(action, p.name);
  if (!res.ok) {
    failBusy(key, res.error === "busy" ? "이미 처리 중" : (stopping ? "끄기 실패" : "켜기 실패"));
    return;
  }
  setBusy(key, stopping ? "꺼짐 확인 중…" : "켜짐 확인 중…", settled);
  requestStatus(); followUp([stopping ? 900 : 1500, 3800, 6000]);
}

function copyBtn(key, label, text) {
  const c = copied.get(key);
  const shown = c && c.until > Date.now() ? (c.ok ? "ok" : "fail") : "";
  return `<button class="ld-cp${shown === "ok" ? " ld-done" : shown === "fail" ? " ld-cpfail" : ""}" data-copy="${esc(key)}" data-text="${esc(text)}" title="${esc(text)}">`
    + `${icon(shown === "ok" ? "check" : shown === "fail" ? "warn" : "copy")}${shown === "ok" ? "복사됨" : shown === "fail" ? "복사 실패" : label}</button>`;
}
const progress = (st) => `<span class="ld-prog${st.fail ? " ld-fail" : ""}">${st.fail ? "" : '<span class="ld-spin"></span>'}${esc(st.label)}</span>`;

function routeRow(r, ip) {
  const st = readBusy("route:" + r.name, r);
  const host = String(r.url || "").replace(/^https?:\/\//, "");
  const copies = [copyBtn(`d:${r.name}`, "데스크탑", r.url)];
  if (r.port) copies.push(copyBtn(`l:${r.name}`, "로컬", `http://localhost:${r.port}`));
  if (ip && r.port) copies.push(copyBtn(`e:${r.name}`, "외부", `http://${ip}:${r.port}`));
  let act = "";
  // 상시 서비스(launchd)는 종료해도 곧 되살아나고 그 사이 쓰던 연결만 끊기므로 종료 버튼을 두지 않는다.
  if (st) act = progress(st);
  else if (r.port && r.service) act = `<span class="ld-svc" title="launchd가 관리 — 종료해도 되살아납니다">${icon("svc")}상시 서비스</span>`;
  else if (r.port) act = `<button class="ld-btn ld-kill" data-kill="${esc(r.name)}">${icon("stop")}종료</button>`;
  return `<tr class="${st ? "ld-busy" : ""}${r.up ? "" : " ld-dn"}">`
    + `<td><span class="ld-stt ${r.up ? "ld-up" : "ld-down"}"><span class="ld-led ${r.up ? "ld-on" : "ld-off"}"></span>${r.up ? "UP" : "DOWN"}</span></td>`
    + `<td><a class="ld-lk" href="${esc(r.url)}" data-open="${esc(r.url)}">${esc(host)}</a></td>`
    + `<td class="ld-port">${r.port ? ":" + esc(r.port) : ""}</td>`
    + `<td><div class="ld-cps">${copies.join("")}</div></td>`
    + `<td class="ld-r">${act}</td></tr>`;
}

// 실행 중이 아니고 켤 수도 없는 프로젝트. 버튼도 링크도 없어 한 줄로 접는다.
const foldable = (p) => !p.running && !p.eligible && !busy.has("proj:" + p.name);

function projectRow(p) {
  const st = readBusy("proj:" + p.name, p);
  let act = "";
  if (st) act = progress(st);
  else if (p.eligible && p.managed) act = `<button class="ld-btn ld-kill" data-stop="${esc(p.name)}">${icon("stop")}Stop</button>`;
  else if (p.eligible && !p.running) act = `<button class="ld-btn ld-start" data-start="${esc(p.name)}">${icon("play")}Start</button>`;
  const url = `http://${p.name}.test`;
  const name = p.running ? `<a class="ld-lk" href="${esc(url)}" data-open="${esc(url)}">${esc(p.name)}</a>` : `<span class="ld-nm">${esc(p.name)}</span>`;
  const badge = p.running ? `<span class="ld-pb ld-run">${p.managed ? "MANAGED" : "RUNNING"}</span>` : '<span class="ld-pb ld-idle">idle</span>';
  return `<tr class="${st ? "ld-busy" : ""}"><td>${badge}</td><td>${name}</td>`
    + `<td class="ld-path">${esc(String(p.path || "").replace(/^.*\/Projects\//, "…/"))}</td><td class="ld-r">${act}</td></tr>`;
}

function renderSys(sys) {
  const box = dom("#ld-sys");
  if (!box) return;
  box.innerHTML = [["caddy", sys.caddy], ["dnsmasq", sys.dnsmasq], ["daemon", sys.daemon]]
    .map(([k, v]) => `<span class="ld-sysp" title="${k} ${v ? "실행 중" : "멈춤"}"><span class="ld-led ${v ? "ld-on" : "ld-off"}"></span>${k}</span>`).join("");
}

// 실패 종류가 같으면 본문을 다시 쓰지 않고 버튼 상태만 바꾼다. 다시 쓰면 다시 연결 버튼의 포커스가 사라진다.
// 연결 중에도 disabled 대신 aria-disabled 를 써서 포커스를 버튼에 남긴다.
let errKind = "";
function renderFailure() {
  const err = dom("#ld-err");
  const remote = failed === "remote";
  const kind = remote ? "remote" : "unreachable";
  if (errKind !== kind || !err.firstChild) {
    errKind = kind;
    err.innerHTML = `<div class="ld-em-ic">${icon("warn")}</div>`
      + (remote
        ? '<h2>이 창에서는 로컬 데브를 볼 수 없습니다</h2><p>localdev 상태는 이 Mac 에서 연 Iris 창에서만 조회합니다.</p>'
        : '<h2>localdev 라우터에 연결하지 못했습니다</h2><p>터미널에서 <code>localdev status</code> 로 상태를 보고, 필요하면 <code>sudo localdev setup</code> 을 실행하세요.</p>'
          + `<button class="ld-btn" id="ld-retry">${icon("reload")}<span class="ld-retry-t">다시 연결</span></button>`);
  }
  const btn = dom("#ld-retry"); if (!btn) return;
  const wait = retrying();
  btn.setAttribute("aria-disabled", String(wait));
  btn.setAttribute("aria-busy", String(wait));
  const t = btn.querySelector(".ld-retry-t"); if (t) t.textContent = wait ? "연결 중…" : "다시 연결";
}

// force 가 아니면 내용이 같을 때 표를 다시 만들지 않는다. 다시 만들면 누르던 버튼의 포커스와 hover 가 사라진다.
function render(force) {
  if (!dom) return;
  const body = dom("#ld-body"), err = dom("#ld-err"), sys = dom("#ld-sys"), upd = dom("#ld-upd");
  if (!body || !err) return;
  if (failed) {
    body.hidden = true; err.hidden = false; sys.hidden = true; upd.hidden = true;
    renderFailure();
    return;
  }
  err.hidden = true; body.hidden = false; sys.hidden = false; upd.hidden = false;
  if (!lastData) { upd.textContent = "불러오는 중…"; return; }
  const d = lastData;
  upd.textContent = `업데이트 ${d.updated || ""} · 3초마다 새로고침`;
  renderSys(d.system || {});
  const { updated, ...rest } = d;
  const sig = JSON.stringify(rest) + "|" + [...busy.entries()].map(([k, v]) => k + v.label + v.fail).join(",")
    + "|" + foldOpen + "|" + [...copied.keys()].join(",");
  if (!force && sig === lastSig) return;
  lastSig = sig;

  const ip = (d.system || {}).ip || "";
  const routes = [...(d.routes || [])].sort((a, b) => (b.up - a.up) || a.name.localeCompare(b.name));
  const projs = [...(d.projects || [])].sort((a, b) => (b.running - a.running) || a.name.localeCompare(b.name));
  const shown = projs.filter((p) => !foldable(p));
  const folded = projs.filter(foldable);
  const aliases = d.aliases || [];

  let h = `<div class="ld-shead"><h2>라우트</h2><span class="ld-cnt">${routes.length ? `${routes.filter((r) => r.up).length} 실행 / ${routes.length}` : ""}</span></div>`;
  h += routes.length
    ? `<table class="ld-t ld-routes"><colgroup><col class="ld-c-st"><col class="ld-c-nm"><col class="ld-c-port"><col><col class="ld-c-act"></colgroup>${routes.map((r) => routeRow(r, ip)).join("")}</table>`
    : '<div class="ld-empty">등록된 라우트가 없습니다. 프로젝트에서 <code>npm run dev</code> 를 실행하면 자동 등록됩니다.</div>';

  h += `<div class="ld-shead ld-gap"><h2>프로젝트</h2><span class="ld-cnt">${projs.length ? `${projs.filter((p) => p.running).length} 실행 / ${projs.length}` : ""}</span></div>`;
  if (!projs.length) h += '<div class="ld-empty">~/Projects 아래에 git 저장소가 없습니다.</div>';
  else {
    h += `<table class="ld-t ld-projects"><colgroup><col class="ld-c-st"><col class="ld-c-nm"><col><col class="ld-c-act"></colgroup>${shown.map(projectRow).join("")}`;
    if (folded.length) {
      h += `<tr class="ld-fold${foldOpen ? " ld-open" : ""}" id="ld-fold" tabindex="0" role="button" aria-expanded="${foldOpen}"><td></td>`
        + `<td colspan="3">${icon("chev")}실행 버튼이 없는 프로젝트 ${folded.length}개 ${foldOpen ? "접기" : "펼치기"}</td></tr>`;
      if (foldOpen) h += folded.map(projectRow).join("");
    }
    h += "</table>";
  }

  h += '<div class="ld-foot">';
  for (const a of aliases) h += `<div class="ld-al"><span class="ld-k">별칭</span><span class="ld-from">${esc(a.from)}</span><span class="ld-arr">→</span><span class="ld-to">${esc(a.to)}.test</span></div>`;
  h += '<div class="ld-hints"><code>npm run dev</code> 만 하면 자동 등록 · <code>localdev alias &lt;자동이름&gt; &lt;새이름&gt;</code> 로 이름 변경 · <code>localdev scan</code> 로 감지 확인</div></div>';
  body.innerHTML = h;
}

function findRoute(name) { return (lastData?.routes || []).find((r) => r.name === name); }
function findProject(name) { return (lastData?.projects || []).find((p) => p.name === name); }

function onBodyClick(e) {
  const t = e.target.closest("[data-copy],[data-open],[data-kill],[data-stop],[data-start],#ld-fold");
  if (!t) return;
  e.preventDefault();
  if (t.id === "ld-fold") { foldOpen = !foldOpen; render(true); return; }
  if (t.dataset.open) { openBrowserTab(t.dataset.open); return; }
  if (t.dataset.copy) {
    const key = t.dataset.copy;
    Promise.resolve(copyText(t.dataset.text)).then((ok) => {
      const mark = { until: Date.now() + COPY_SHOW, ok: ok === true };
      copied.set(key, mark);
      render(true);
      // 그 사이에 같은 단추를 다시 눌렀으면 새 표시를 지우지 않는다.
      setTimeout(() => { if (copied.get(key) === mark) { copied.delete(key); render(true); } }, COPY_SHOW);
    });
    return;
  }
  if (t.dataset.kill) { const r = findRoute(t.dataset.kill); if (r) killRoute(r); return; }
  if (t.dataset.stop) { const p = findProject(t.dataset.stop); if (p) projectAction(p, "stop"); return; }
  if (t.dataset.start) { const p = findProject(t.dataset.start); if (p) projectAction(p, "start"); }
}

function enter() {
  if (browserMode) return;
  active = true;
  render(true);
  requestStatus();
  if (!timer) timer = setInterval(() => { if (active) requestStatus(); }, TICK_MS);
}

function leave() {
  active = false;
  if (timer) { clearInterval(timer); timer = null; }
}

export function initCapability(ctx) {
  dom = ctx.$;
  // 앱 셸의 esc 는 문자열만 받는다. 포트처럼 숫자로 오는 값이 있어 여기서 글자로 바꾼다.
  if (ctx.esc) esc = (v) => ctx.esc(String(v ?? ""));
  wsSend = ctx.wsSend;
  copyText = ctx.copyText || copyText;
  askConfirm = ctx.askConfirm || null;
  openBrowserTab = ctx.openBrowserTab || openBrowserTab;
  browserMode = !!ctx.browserMode;
  const reload = dom("#ld-reload");
  if (reload) reload.onclick = () => { requestStatus(true); };
  const open = dom("#ld-open");
  if (open) open.onclick = () => openBrowserTab(LD_URL);
  const body = dom("#ld-body");
  if (body) {
    body.addEventListener("click", onBodyClick);
    body.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.id === "ld-fold") { e.preventDefault(); foldOpen = !foldOpen; render(true); dom("#ld-fold")?.focus(); }
    });
  }
  const err = dom("#ld-err");
  if (err) err.addEventListener("click", (e) => {
    const b = e.target.closest("#ld-retry"); if (!b || b.getAttribute("aria-disabled") === "true") return;
    retryId = requestStatus(true);
    render();
  });
  return {
    screen: { enter, leave },
    ws: { "localdev.status": onStatus, "localdev.result": onResult },
  };
}
