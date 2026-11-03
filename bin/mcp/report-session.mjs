import { effectText } from "../../server/qa-action-report.js";
const labels = {
  question:"확인할 질문", scope:"확인 범위", exclusions:"제외 범위", environment:"환경",
  sharedEnvironment:"공유 환경", unattended:"무인 진행", approvals:"미리 승인", investigationLimitMin:"항목별 조사 상한(분)", logins:"계정", bulkFill:"대량 기입", timebox:"주어진 시간", people:"물어볼 사람", documents:"참고 문서",
  work:"한 일", defects:"결함", curios:"이상한 동작", checked:"확인한 것", unverified:"미확인 항목과 이유",
  blockers:"막힌 문제", outOfScope:"범위 밖 발견", risks:"남은 위험", stopCriterion:"종료 기준", remainingQuestions:"남은 질문",
};
const stops = {
  questions_answered:"질문에 대한 답과 남은 질문 기록", time_or_user_stop:"시간 종료 또는 사용자 중단 요청",
  serious_defect:"심각한 결함 발견", too_many_defects:"결함 수정 후 재확인 필요", flatline:"같은 결과 반복",
  blocked:"진행 불가", low_value:"남은 확인의 가치가 비용보다 작음",
};

// plain: 사람용 보고서(renderPlainSessionRecords). 결함의 기록 원문(대상·환경·당시 관찰 JSON)은 개발자용 보고서에만. 사람용에 이벤트 JSON 이 2,600줄 넘게 나온 사례
// build: 회차 시작·끝 코드 상태. Charter 바로 앞 절. show(칸 이름)(원문): 사람용의 확인자 글 고치기·Iris 낱말 바꾸기, lastRun: 합친 보고서의 Charter·세션 기록 회차
export function renderSessionRecords(charter, session, esc, analysis, scene, { plain = false, build = null, show = null, lastRun = "" } = {}) {
  if (plain) return renderPlainSessionRecords(charter, session, esc, analysis, scene, { build, show, lastRun });
  const json = value => esc(JSON.stringify(value, null, 2));
  // 조작 기대(effects)는 사람이 읽는 줄로. JSON 그대로 나와 결함 절이 안 읽힌 사례
  const valueText = value => Array.isArray(value?.effects) ? value.effects.map(effectText).join("\n")
    : typeof value === "object" ? JSON.stringify(value, null, 2) : value;
  const renderScene = typeof scene === "function" ? scene : () => "";
  const at = value => typeof value === "number" ? new Date(value).toISOString() : value;
  const fields = record => `<dl>${Object.entries(record).filter(([key]) => key !== "defects" || !analysis).map(([key,value]) => {
    const text = key === "stopCriterion" ? stops[value] || value
      : key === "sharedEnvironment" ? value ? "공유" : "단독"
      : typeof value === "boolean" ? value ? "예" : "아니오"
      : value && typeof value === "object" && "items" in value ? `${value.items} — ${value.reason}`
      : value && typeof value === "object" ? Object.entries(value).map(([name, item]) => `${labels[name] || name}: ${Array.isArray(item) ? item.join(", ") || "없음" : typeof item === "boolean" ? item ? "예" : "아니오" : item}`).join(" · ") || "없음"
      : value;
    return `<dt>${esc(labels[key] || key)}</dt><dd>${esc(text)}</dd>`;
  }).join("")}</dl>`;
  const section = (title, body) => `<section class="req"><h2>${title}</h2>${body}</section>`;
  const history = analysis?.charterChanges.length ? `<h3>Charter 수정 이력</h3><ol>${analysis.charterChanges.map(change =>
    `<li><p>${esc(at(change.at))} · ${esc(change.reason)}</p><h4>수정 전</h4>${fields(change.oldCharter)}<h4>수정 후</h4>${fields(change.newCharter)}</li>`).join("")}</ol>` : "";
  const buildRow = ([label, value]) => `<dt>${label}</dt><dd>${value ? `${esc(value.repo)}<br>HEAD ${esc(value.head)} · branch ${esc(value.branch ?? "(detached HEAD)")} · dirty ${value.dirty ? "true" : "false"}` : "미기록"}</dd>`;
  let html = build ? section("빌드", `<dl>${[["시작", build.begin], ["종료", build.end]].map(buildRow).join("")}</dl>`) : "";
  html += charter ? section("Charter", fields(charter) + history) : "";
  if (session) html += section("세션 기록", fields(session));
  if (!analysis) return html;

  const defectHtml = defect => {
    const results = [["기대 결과",defect.expected],["실제 결과",defect.actual]].filter(([,value]) => value !== undefined)
      .map(([label,value]) => `<dt>${label}</dt><dd>${esc(valueText(value))}</dd>`).join("");
    const steps = (defect.steps || []).map(step => `<li>${esc(step.cmd)}${step.url ? ` · ${esc(step.url)}` : ""}
      ${step.target ? `<pre>${json(step.target)}</pre>` : ""}${step.input ? `<pre>${json(step.input)}</pre>` : ""}</li>`).join("");
    const frames = (defect.frames || []).map(frame => renderScene(frame.shot, `결함 ${defect.seq} · ${frame.phase || "장면"}`)).join("");
    const failures = (defect.failures || []).map(failure => `<details>
      <summary>실패 당시 기록 ${esc(failure.detail?.failureSeq ?? failure.seq)}</summary>
      ${failure.shot ? renderScene(failure.shot, "실패 당시 화면") : ""}<pre>${json(failure.detail)}</pre></details>`).join("");
    return `<li><h3>${esc(defect.problem)}</h3><dl>
      <dt>판단 기준</dt><dd>${esc(defect.oracle)} · ${esc(defect.oracleNote)}</dd>
      <dt>영향</dt><dd>${esc(defect.importance)}</dd><dt>재현 여부</dt><dd>${esc(defect.reproducible)}</dd>
      <dt>시도한 것</dt><dd>${esc(defect.tried)}</dd>${defect.remedy ? `<dt>수정과 재확인</dt><dd style="white-space:pre-line">${esc(defect.remedy)}</dd>` : ""}<dt>범위</dt><dd>${defect.outOfCharter ? "Charter 밖" : "Charter 안"}</dd>
      ${results}</dl><h4>재현 절차</h4><ol>${steps}</ol><h4>환경</h4><pre>${json(defect.environment || {})}</pre>
      <h4>당시 관찰</h4><pre>${json(defect.observations || [])}</pre>${frames}${failures}</li>`;
  };
  html += section("결함 목록", analysis.defects.length ? `<ol>${analysis.defects.map(defectHtml).join("")}</ol>` : "<p>기록된 결함 없음</p>");
  html += section("세션 메모", analysis.notes.length ? `<ol>${analysis.notes.map(note =>
    `<li><b>${esc(note.kind)}</b> · ${esc(at(note.at))}<p>${esc(note.text)}</p></li>`).join("")}</ol>` : "<p>기록된 메모 없음</p>");

  const t = analysis.time;
  const duration = ms => `${(ms / 1000).toFixed(1)}초`;
  const proportion = ms => t.totalMs ? `${(100 * ms / t.totalMs).toFixed(1)}%` : "산출 불가";
  const table = values => `<table class="walk sum"><thead><tr><th>분류</th><th>시간</th><th>비율</th></tr></thead><tbody>${values.map(([label,ms]) =>
    `<tr><td>${label}</td><td>${duration(ms)}</td><td>${proportion(ms)}</td></tr>`).join("")}</tbody></table>`;
  html += section("시간 분류", `<p>기록된 간격 합계 ${duration(t.totalMs)}</p>
    ${table([["준비",t.setupMs],["결함 조사·보고",t.investigationMs],["테스트 설계·실행",t.testMs]])}
    <h3>Charter 안팎 시간</h3>${table([["Charter 안",t.insideMs],["Charter 밖",t.outsideMs],["범위 미배정",t.unassignedMs]])}
    <p>서버 이벤트 시각 사이의 간격을 추정했습니다. 준비·경로 재생은 준비로, 첫 실패부터 연결된 결함 기록까지는 조사로,
    나머지는 테스트로 분류했습니다. 테스트와 준비·조사가 겹친 기록은 테스트에 포함했습니다.
    열린 경로가 모두 범위 밖이면 Charter 밖으로 분류하고, 범위 안 경로가 하나라도 열려 있으면 Charter 안으로 분류했습니다.
    열린 경로가 없으면 범위 미배정입니다.</p>
    <p>이 비율은 세션을 검토할 때 질문을 돕는 inquiry metrics입니다. 종료 여부나 품질을 결정하는 기준으로 쓰지 않습니다.
    이벤트 사이에 기록되지 않은 활동과 실제 동시 작업은 구분할 수 없습니다.${t.invalidIntervals ? ` 시각이 없거나 역전된 간격 ${t.invalidIntervals}개는 계산에서 제외했습니다.` : ""}</p>`);
  html += section("Charter 밖 확인 항목", `<p>범위 안 ${analysis.rowCounts.inside}개 · 범위 밖 ${analysis.rowCounts.outside}개</p>
    ${analysis.outsideRows.length ? `<ul>${analysis.outsideRows.map(row => `<li>${esc(row.what)}${row.given ? ` · ${esc(row.given)}` : ""}</li>`).join("")}</ul>` : "<p>기록된 항목 없음</p>"}`);
  return html;
}

// 실패 당시 진단: 콘솔·예외·실패한 요청만 한 줄씩
function failureLines(detail, esc) {
  if (!detail || typeof detail !== "object") return "";
  const text = v => typeof v === "string" ? v : v && typeof v === "object" ? v.text || v.message || JSON.stringify(v) : String(v);
  const lines = [
    ...(detail.console || []).map(v => `콘솔: ${text(v)}`),
    ...(detail.exceptions || []).map(v => `예외: ${text(v)}`),
    ...(detail.network || []).filter(n => n && (n.status >= 400 || n.failed || n.error)).map(n => `요청 실패: ${[n.status, n.method, n.url, n.error].filter(Boolean).join(" ")}`),
  ];
  return lines.length ? `<ul>${lines.slice(0, 20).map(line => `<li>${esc(line.slice(0, 300))}</li>`).join("")}${lines.length > 20 ? `<li>그 밖 ${lines.length - 20}줄은 개발자용 보고서에 있음</li>` : ""}</ul>` : "";
}

// ── 사람용 보고서의 세션 기록. 긴 글은 첫 줄만 보이고 나머지는 접음, 이름과 값은 두 칸, 재현 절차는 단계 표
const lineList = text => String(text ?? "").split(/\n|\\n/).map(x => x.trim()).filter(Boolean);
const short = (text, n) => text.length > n ? text.slice(0, n - 1) + "…" : text;
// 140자 넘거나 네 줄 이상이면 첫 줄만 보이고 나머지는 펼쳐서 봄
function foldText(text, esc) {
  const xs = lineList(text);
  if (!xs.length) return `<span class="none">없음</span>`;
  const body = xs.length > 1 ? `<ul class="lines">${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p>${esc(xs[0])}</p>`;
  if (xs.join("").length <= 120 && xs.length <= 3) return body;
  return `<details class="more"><summary>${esc(short(xs[0], 90))}${xs.length > 1 ? ` <small>외 ${xs.length - 1}줄</small>` : ""}</summary>${body}</details>`;
}
const fieldValue = (key, value) => key === "stopCriterion" ? stops[value] || value
  : key === "sharedEnvironment" ? value ? "공유" : "단독"
  : typeof value === "boolean" ? value ? "예" : "아니오"
  : value && typeof value === "object" && "items" in value ? `${value.items}\n이유: ${value.reason}`
  : value && typeof value === "object" ? Object.entries(value).map(([name, item]) => `${labels[name] || name}: ${Array.isArray(item) ? item.join(", ") || "없음" : typeof item === "boolean" ? item ? "예" : "아니오" : item}`).join("\n") || "없음"
  : value;
const pairs = (record, esc, skip = [], say = v => v) => `<dl class="pairs">${Object.entries(record || {}).filter(([key]) => !skip.includes(key)).map(([key, value]) =>
  `<dt>${esc(labels[key] || key)}</dt><dd>${foldText(say(String(fieldValue(key, value) ?? "")), esc)}</dd>`).join("")}</dl>`;
const clockText = value => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const two = n => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

// 한 축 이동량이 다른 축의 2배 이상일 때만 방향을 적음. 대각·0 이동은 방향 없음. 확인 줄(report-plain)과 재현 절차가 같이 씀
export function direction(dx, dy) {
  const ax = Math.abs(dx || 0), ay = Math.abs(dy || 0);
  if (ay > 0 && ay >= 2 * ax) return dy < 0 ? "위로" : "아래로";
  if (ax > 0 && ax >= 2 * ay) return dx < 0 ? "왼쪽으로" : "오른쪽으로";
  return "";
}
// 재현 절차 한 단계: 화면 · 행동 · 결과. 명령 이름(app_tap 등)은 개발자용 보고서에만
const VERB = { click:"누름", tap:"누름", dblclick:"두 번 누름", type:"입력", fill:"입력", key:"키 누름", swipe:"밀기", scroll:"스크롤",
  select:"고름", hover:"포인터 올림", drag:"끌기", wait:"기다림", open_entry:"진입 화면 열기", goto:"주소 열기", history:"뒤로·앞으로", bulk_fill:"여러 칸 입력" };
// 주소·요청 경로는 사람용에 두지 않음
const effectPlain = e => {
  if (e.type === "navigate") return "다른 화면으로 이동";
  if (e.type === "request") return "서버 요청";
  const what = e.name || e.text || e.to || "";
  const verb = { appear:"보임", disappear:"사라짐", change:"바뀜", unchanged:"그대로", absent:"없음", navigate:"주소 이동", dialog:"대화상자", request:"요청", none:"변화 없음" }[e.type] || "";
  return [what && `'${short(String(what).replace(/\s*\n\s*/g, " "), 60)}'`, verb].filter(Boolean).join(" ");
};
// 결함의 기대·실제 값. 조작 기대(effects), 화면 확인(mode·label·want), 그 밖의 값 순
const MODE = { exists:"있음", absent:"없음", equals:"와 같음", contains:"포함" };
function expectedPlain(value) {
  if (Array.isArray(value?.effects)) return value.effects.map(effectPlain).join("\n");
  if (value && typeof value === "object" && value.mode) {
    const what = [value.label || value.element, value.type].filter(Boolean).join(" ");
    const want = value.want ?? value.text;
    return [what && `'${what}'`, want != null && want !== "" && `'${want}'`, MODE[value.mode] || value.mode].filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") return Object.entries(value).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
  return value;
}
export function plainStep(step) {
  const cmd = String(step.cmd || "").replace(/^app_/, "");
  const t = step.target && typeof step.target === "object" ? step.target : {};
  const i = step.input && typeof step.input === "object" ? step.input : {};
  const name = t.name || t.label || t.text;
  // 이름 없는 좌표 조작은 확인 줄과 같은 말로. 좌표 숫자는 읽는 사람이 화면에서 대조할 수 없음
  const num = n => Number(n);
  const moved = (t.x1 ?? i.x1) != null ? direction(num(t.x2 ?? i.x2) - num(t.x1 ?? i.x1), num(t.y2 ?? i.y2) - num(t.y1 ?? i.y1)) : "";
  const where = name ? `'${short(String(name).replace(/\s*\n\s*/g, " "), 50)}'`
    : (t.x1 ?? i.x1) != null ? `화면${moved ? ` ${moved}` : ""}`
    : (t.x ?? i.x) != null ? "화면 한 곳" : "";
  const typed = typeof step.input === "string" ? step.input : i.text ?? i.value ?? (cmd === "key" ? i.key : undefined);
  const action = [where, VERB[cmd] || "조작", typed != null && typed !== "" && `'${short(String(typed), 40)}'`].filter(Boolean).join(" ");
  const result = (step.expected?.effects || []).map(effectPlain).filter(Boolean).join(" · ");
  return { action, result, pass: step.pass };
}
function stepsHtml(steps, esc) {
  const rows = (steps || []).map(plainStep);
  if (!rows.length) return "";
  const row = (s, k) => `<tr class="${s.pass === false ? "no" : ""}"><td class="n">${k + 1}</td><td>${esc(s.action)}</td><td>${
    s.result ? esc(s.result) : `<span class="none">기대 기록 없음</span>`}</td><td class="ok">${s.pass === false ? "실패" : s.pass === true ? "통과" : ""}</td></tr>`;
  // 실패 직전 여섯 단계만 보이고 앞 단계는 접음. 이름 없는 누름이 수십 줄 이어져 읽히지 않던 사례
  const tail = 6, cut = Math.max(0, rows.length - tail);
  const head = `<thead><tr><th>#</th><th>행동</th><th>기대 결과</th><th>판정</th></tr></thead>`;
  return `<div class="hscroll"><table class="steps">${head}<tbody>${rows.slice(cut).map((s, k) => row(s, k + cut)).join("")}</tbody></table></div>${
    cut ? `<details class="more"><summary>앞 단계 ${cut}개</summary><div class="hscroll"><table class="steps">${head}<tbody>${rows.slice(0, cut).map(row).join("")}</tbody></table></div></details>` : ""}`;
}

// 사람용 빌드 칸: 시작·끝 커밋 앞 7자와 커밋하지 않은 변경 여부. 저장소 경로·branch 는 개발자용에만
function plainBuild(build, esc) {
  const head = v => (v?.head ? String(v.head).slice(0, 7) : "");
  const [a, b] = [head(build.begin), head(build.end)];
  const code = !a && !b ? "미기록" : a && b && a !== b ? `커밋 ${a} → ${b}` : `커밋 ${a || b}`;
  const dirty = build.begin?.dirty || build.end?.dirty;
  return `<dl class="pairs"><dt>확인한 코드</dt><dd><p>${esc(code)}${dirty ? " · 커밋하지 않은 변경 있음" : ""}</p></dd></dl>`;
}

function renderPlainSessionRecords(charter, session, esc, analysis, scene, { build = null, show = null, lastRun = "" } = {}) {
  const renderScene = typeof scene === "function" ? scene : () => "";
  const section = (title, body, extra = "") => `<section class="rec"><h2>${title}${extra}</h2>${body}</section>`;
  // 확인자 글은 칸 이름과 함께 고치기·Iris 낱말 바꾸기를 거침. 구조에서 만든 문장(기대·실제 결과, 재현 절차, 시간 분류)은 거치지 않음
  const say = field => (show ? show(field) : v => v);
  const whose = lastRun ? ` <small>마지막 회차 ${esc(lastRun.replace(/ 회차$/, ""))}</small>` : "";
  let html = build ? section("빌드", plainBuild(build, esc)) : "";
  if (charter) {
    const changes = analysis?.charterChanges || [];
    const c = say("Charter");
    html += section("Charter", `<p class="lead">${esc(charter.question ? c(charter.question) : "확인할 질문 미기록")}</p>
      <details class="more"><summary>범위·환경·시간 등 ${Object.keys(charter).length - (charter.question ? 1 : 0)}칸</summary>${pairs(charter, esc, ["question"], c)}</details>${
      changes.length ? `<details class="more"><summary>Charter 수정 ${changes.length}회</summary><ol class="cards">${changes.map(change =>
        `<li><p class="when">${esc(clockText(change.at))}</p>${foldText(c(change.reason), esc)}<div class="two"><div><h4>수정 전</h4>${pairs(change.oldCharter, esc, [], c)}</div><div><h4>수정 후</h4>${pairs(change.newCharter, esc, [], c)}</div></div></li>`).join("")}</ol></details>` : ""}`, whose);
  }
  if (session) html += section("세션 기록", pairs(session, esc, analysis ? ["defects"] : [], say("세션 기록")), whose);
  if (!analysis) return html;

  const d = say("결함 카드");
  const defectHtml = defect => {
    const [run, ...title] = String(defect.problem || "").split(" · ");
    const hasRun = title.length && /회차$/.test(run);
    const chips = [hasRun && run, defect.reproducible && `재현 ${defect.reproducible}`,
      defect.outOfCharter ? "Charter 밖" : "", lineList(defect.remedy ? d(defect.remedy) : "")[0]].filter(Boolean);
    const results = [["기대 결과", defect.expected], ["실제 결과", defect.actual]].filter(([, value]) => value !== undefined)
      .map(([label, value]) => `<dt>${label}</dt><dd>${foldText(expectedPlain(value), esc)}</dd>`).join("");
    const env = defect.environment && typeof defect.environment === "object" ? defect.environment : {};
    const device = env.device && typeof env.device === "object" ? env.device.platform : env.device;
    const envChips = [device, env.viewport?.width && `${env.viewport.width}×${env.viewport.height}`, env.url && !String(env.url).startsWith("app://") && String(env.url).replace(/^https?:\/\/[^/]+/, "")].filter(Boolean);
    const frames = (defect.frames || []).map((frame, k) => renderScene(frame.shot, `장면 ${k + 1}`)).join("");
    const failureShots = (defect.failures || []).map(failure => failure.shot ? renderScene(failure.shot, "실패 당시 화면") : "").join("");
    const failures = (defect.failures || []).map(failure => failureLines(failure.detail, esc)).join("");
    // 제목은 첫 문장만. 나머지는 '문제' 칸에서 펼쳐 봄
    const full = d(hasRun ? title.join(" · ") : String(defect.problem || ""));
    const head = full.split(/(?<=[.다])\s+/)[0];
    const brief = short(head, 80);
    return `<li class="dcard"><h3>${esc(brief)}</h3>
      <p class="chips">${chips.map(c => `<span class="tag">${esc(short(String(c), 40))}</span>`).join("")}${envChips.map(c => `<span class="tag env">${esc(short(String(c), 60))}</span>`).join("")}</p>
      <dl class="pairs">${brief !== full ? `<dt>문제</dt><dd>${foldText(full, esc)}</dd>` : ""}<dt>판단 기준</dt><dd>${foldText(d([defect.oracle, defect.oracleNote].filter(Boolean).join("\n")), esc)}</dd>${
        defect.importance ? `<dt>영향</dt><dd>${foldText(d(defect.importance), esc)}</dd>` : ""}${results}
      <dt>시도한 것</dt><dd>${foldText(d(defect.tried ?? ""), esc)}</dd>${defect.remedy ? `<dt>수정과 재확인</dt><dd>${foldText(d(defect.remedy), esc)}</dd>` : ""}</dl>
      ${defect.steps?.length ? `<h4>재현 절차</h4>${stepsHtml(defect.steps, esc)}` : ""}${frames || failureShots ? `<h4>장면</h4><div class="dshots">${frames}${failureShots}</div>` : ""}${failures}</li>`;
  };
  html += section("결함 목록", analysis.defects.length ? `<ol class="cards">${analysis.defects.map(defectHtml).join("")}</ol>` : `<p class="none">기록된 결함 없음</p>`, ` <small>${analysis.defects.length}</small>`);
  const kinds = [...new Set(analysis.notes.map(note => note.kind).filter(Boolean))];
  html += section("세션 메모", analysis.notes.length ? `<p class="chips">${kinds.map(k => `<span class="tag">${esc(k)} ${analysis.notes.filter(n => n.kind === k).length}</span>`).join("")}</p>
    <ol class="memo">${analysis.notes.map(note => `<li><span class="when">${esc(clockText(note.at))}</span><span class="tag">${esc(note.kind || "메모")}</span><div>${foldText(say("세션 메모")(note.text ?? ""), esc)}</div></li>`).join("")}</ol>`
    : `<p class="none">기록된 메모 없음</p>`, ` <small>${analysis.notes.length}</small>`);

  const t = analysis.time;
  const duration = ms => ms >= 60000 ? `${Math.floor(ms / 60000)}분 ${Math.round(ms % 60000 / 1000)}초` : `${(ms / 1000).toFixed(1)}초`;
  const proportion = ms => t.totalMs ? `${(100 * ms / t.totalMs).toFixed(1)}%` : "산출 불가";
  const table = values => `<table class="steps"><thead><tr><th>분류</th><th>시간</th><th>비율</th></tr></thead><tbody>${values.map(([label, ms]) =>
    `<tr><td>${label}</td><td>${duration(ms)}</td><td>${proportion(ms)}</td></tr>`).join("")}</tbody></table>`;
  html += section("시간 분류", `<div class="two">${table([["준비", t.setupMs], ["결함 조사·보고", t.investigationMs], ["테스트 설계·실행", t.testMs]])}
    ${table([["Charter 안", t.insideMs], ["Charter 밖", t.outsideMs], ["범위 미배정", t.unassignedMs]])}</div>
    <details class="more"><summary>계산 방법</summary><ul class="lines"><li>서버 기록 시각 사이의 간격 합계 ${duration(t.totalMs)}</li>
    <li>준비·경로 재생은 준비, 첫 실패부터 결함 기록까지는 조사, 나머지는 테스트</li><li>테스트와 준비·조사가 겹친 간격은 테스트</li>
    <li>열린 경로가 모두 범위 밖이면 Charter 밖, 범위 안 경로가 하나라도 열려 있으면 Charter 안, 열린 경로가 없으면 범위 미배정</li>
    <li>세션을 검토할 때 질문을 돕는 지표(inquiry metrics)이며 종료 여부나 품질 판정 기준이 아님</li>${t.invalidIntervals ? `<li>시각이 없거나 역전된 간격 ${t.invalidIntervals}개 제외</li>` : ""}</ul></details>`, ` <small>${duration(t.totalMs)}</small>`);
  html += section("Charter 밖 확인 항목", `<p class="chips"><span class="tag">범위 안 ${analysis.rowCounts.inside}</span><span class="tag">범위 밖 ${analysis.rowCounts.outside}</span></p>
    ${analysis.outsideRows.length ? `<ul class="lines">${analysis.outsideRows.map(row => `<li>${esc(say("Charter 밖 항목")(row.what ?? ""))}${row.given ? ` · ${esc(say("Charter 밖 항목")(row.given))}` : ""}</li>`).join("")}</ul>` : ""}`);
  return html;
}
