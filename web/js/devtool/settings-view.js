import { bindingOf, formatBinding } from "../core/keymap.js";
import { isHostWindows } from "../core/host-path.js";
// 설정 화면 렌더: 자료를 받아 HTML 문자열 하나를 돌려준다.
//
// 소유 범위
//   왼쪽 분류 목록과 오른쪽 내용의 배치, 그리고 이벤트 연결이 참조하는 이름들
//   (data-km-rec · data-km-reset · data-km-sec · #km-reset-all · #km-search · data-set-toggle
//    · data-set-screen · data-set-motion · data-sw-pick · data-sw-key · data-sw-move · data-sw-sel · data-sw-sel-group
//    · data-sw-sel-leave · data-sw-sel-clear · data-sw-ungroup · #sw-refresh · #sw-open-perm · data-set-clear).
//   부산물 분류의 이름은 artifacts-view.js 가 소유하고, 여기서는 그 함수를 부르기만 한다.
//
// 제공 API
//   settingsMarkup(model) · SETTINGS_SECTIONS. 그 밖의 것은 내주지 않는다.
//
// 의존 대상
//   같은 성질의 순수 모듈만 부른다(features 의 프리셋 표, artifacts-view 의 분류 렌더).
//   DOM 도 window 도 보지 않는다. Node 에서 그대로 호출되고, 앱을 켜지 않는 사본과 검사가 같은
//   함수를 쓴다. 배치를 두 벌로 적지 않기 위한 것이다.
//
// 유지 조건
//   이 화면은 항상 뷰어를 덮는 넓은 폭으로 표시된다(rail 의 RAIL_FULL). 좁은 패널용 한 줄 배치를
//   그대로 늘이면 이름은 왼쪽 끝·조합은 오른쪽 끝에 붙어 사이가 통째로 빈다.
//   최근 닫은 탭은 여기 없다. 브라우저에서 쓰는 것은 브라우저에 둔다.
//
// 영향 범위
//   devtool/keymap-page.js 의 렌더·연결과 창 선택 모델, web/css/20-keymap.css 의 이름,
//   .working 의 UI 사본(build.mjs 가 이 함수를 그대로 불러 그린다).
//   현재 목록 확인: node bin/importers.mjs web/js/devtool/settings-view.js

// 분류 표는 여기 하나뿐이고, 왼쪽 목록과 오른쪽 내용이 같은 표를 보고 그린다.
import { PRESETS, featureLockNote } from "../core/features.js";
import { artifactsPane } from "./artifacts-view.js";
import { describeLinkPattern, matchLinkRule, parseLinkPattern } from "../browser/link-rules.js";
import { ANYWHERE, MAIN_WINDOW, ON_BROWSER, ON_EDITOR } from "../core/keymap.js";

export const SETTINGS_SECTIONS = [
  { id: "keys", label: "단축키" },
  { id: "features", label: "편의 기능" },
  { id: "windows", label: "창 전환" },
  { id: "links", label: "링크 열기" },
  { id: "artifacts", label: "부산물" },
  { id: "security", label: "보안" },
];

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// model = { section, query, items, conflicts, changed, recording, toggles, screens, switcher }
//   items: resolvedKeymap() 결과 { id, label, where, keys, lock, changed, defKeys } + 기능 줄의 note·noteBad(등록 상태)
//   toggles: [{ id, name, desc, on, warn }]. 보안 분류의 스위치 목록
//   screens: [{ id, label, on, lock }]. 편의 기능(rail 도구 화면). 목록은 rail 버튼에서 읽어 온다.
//   switcher: { windows, picked, status, media }. 창 전환 분류의 창·선택·직접 읽은 아이콘과 권한
//   artifacts: { kinds, total, open, entries, canTrash }. 부산물 분류. 렌더는 artifacts-view 가 담당한다.
//   featureSections: [{ id, label, rows: [{ key, label, desc, value, options: [{ value, label }] } | { key, label, desc, frame, height }] }].
//     켜진 기능이 채우는 분류. 기능을 끄면 빠짐. frame 줄은 그 기능이 그리는 같은 출처 화면(iframe)
export function settingsMarkup(model) {
  const m = model || {};
  const esc = escapeHtml;
  const featureSections = (Array.isArray(m.featureSections) ? m.featureSections : [])
    .filter((f) => f && f.id && !SETTINGS_SECTIONS.some((s) => s.id === f.id));
  const sections = [...SETTINGS_SECTIONS, ...featureSections];
  const section = sections.some((s) => s.id === m.section) ? m.section : "keys";
  const featureSection = featureSections.find((f) => f.id === section);
  const items = m.items || [];
  const toggles = m.toggles || [];
  const screens = m.screens || [];
  // 창 전환은 개수를 적지 않는다. 열거 전에는 0으로 보이고, 열거 뒤에도 그 수로 할 일이
  // 없다. 나머지 분류는 그 수가 무엇을 고를지 정하는 데 쓰여 남긴다.
  const counts = {
    keys: items.length,
    features: screens.length,
    artifacts: (m.artifacts && m.artifacts.total && m.artifacts.total.count) || 0,
    security: toggles.length,
  };

  const nav = sections.map((s) => {
    const n = counts[s.id];
    const count = n === undefined ? "" : `<span class="km-nav-c">${esc(n)}</span>`;
    return `<button class="km-nav${s.id === section ? " on" : ""}" data-km-sec="${esc(s.id)}">${esc(s.label)}${count}</button>`;
  }).join("");

  // 단축키는 검색 줄을 고정하고 목록만 스크롤한다. 나머지 분류는 판 전체가 스크롤한다.
  const other = section === "features" ? screensPane(screens, model.presets || PRESETS, m.motion, m.presetView || "full", m.presetMembers)
    : section === "windows" ? switcherPane(m.switcher)
    : section === "links" ? linksPane(m.links) + linkRulesPane(m.linkRules)
    : section === "artifacts" ? artifactsPane(m.artifacts)
    : section === "security" ? securityPane(toggles)
    : featureSection ? featureSectionPane(featureSection)
    : "";
  return `<div class="km-split">
    <nav class="km-nav-col"><div class="km-nav-top"><span class="km-h2">설정</span></div><div class="km-nav-list">${nav}</div></nav>
    <div class="km-pane">${section === "keys"
      ? keysPane(m, items)
      : `<div class="km-scroll"><div class="km-spane">${other}</div></div>`}</div>
  </div>`;
}

// 단축키는 쓰는 곳으로 묶는다. 같은 조합이라도 쓰는 곳이 다르면 충돌하지 않으므로,
// 사람이 조합을 고를 때 먼저 보는 것이 쓰는 곳이다.
const KEY_GROUPS = [
  [ANYWHERE, "어디서나 쓰는 키"],
  [ON_BROWSER, "브라우저 탭에서"],
  [ON_EDITOR, "편집기에서"],
  [MAIN_WINDOW, "메인 창에서"],
];
const LOCK_ICON = `<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

// "⌘⇧Tab" 을 ⌘ · ⇧ · Tab 세 칸으로 나눈다. 수정키는 한 글자씩, 나머지는 한 칸이다.
function keyCaps(keys) {
  const esc = escapeHtml;
  const out = [];
  let rest = String(keys || "");
  if (isHostWindows()) {
    let match;
    while ((match = rest.match(/^(Ctrl|Alt|Shift|Win)\+/))) { out.push(match[1]); rest = rest.slice(match[0].length); }
  } else while (rest && "⌘⌥⇧⌃".includes(rest[0])) { out.push(rest[0]); rest = rest.slice(1); }
  if (rest) out.push(rest);
  return out.map((k) => `<span class="km-kc">${esc(k)}</span>`).join("");
}

function countWord(n) {
  return ({ 2: "두", 3: "세", 4: "네" })[n] || String(n);
}

function keysPane(m, items) {
  const esc = escapeHtml;
  const conflicts = m.conflicts || [];
  const shown = items.filter((x) => !m.query || matchOne(x, m.query));
  const byId = new Map(items.map((x) => [x.id, x]));
  const bad = new Set(conflicts.flatMap((c) => c.ids || []));
  const locked = items.filter((x) => x.lock).length;
  const parts = [];

  parts.push(`<div class="km-tool">
    <label class="km-search"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="km-search" type="search" placeholder="이름·조합으로 찾기" value="${esc(m.query || "")}" autocomplete="off" /></label>
    <span class="km-faint">바꾼 조합 ${esc(m.changed || 0)}개 · 잠긴 조합 ${esc(locked)}개</span><span class="km-sp"></span>
    ${m.changed ? `<button class="km-btn" id="km-reset-all">전부 기본값으로</button>` : ""}
  </div>`);

  parts.push('<div class="km-scroll"><div class="km-keys-in">');
  // 충돌은 id 가 아니라 사람이 보는 이름과 쓰는 곳으로 적는다. id 는 화면 어디에도 없는 글자다.
  if (conflicts.length) {
    const title = conflicts.length === 1
      ? `같은 조합이 ${countWord((conflicts[0].ids || []).length)} 곳에 걸렸습니다`
      : "같은 조합이 여러 곳에 걸렸습니다";
    parts.push(`<div class="km-warn"><i class="km-warn-d"></i><span>${title}</span>${conflicts.map((c) => `<b>${esc(c.keys)}</b><span>${
      (c.ids || []).map((id) => {
        const it = byId.get(id);
        return it ? `${esc(it.label)} (${esc(it.where)})` : esc(id);
      }).join(" · ")}</span>`).join("")}</div>`);
  }

  const known = new Set(KEY_GROUPS.map(([where]) => where));
  const groups = KEY_GROUPS.concat([...new Set(shown.map((x) => x.where))].filter((w) => !known.has(w)).map((w) => [w, `${w}에서`]))
    .map(([where, title]) => ({ title, list: shown.filter((x) => x.where === where) }))
    .filter((g) => g.list.length);
  const row = (item) => {
    const rec = m.recording === item.id;
    const lead = item.lock ? `<span class="km-lead" aria-hidden="true">${LOCK_ICON}</span>`
      : item.changed ? `<span class="km-lead"><i class="km-chg" title="바꾼 조합"></i></span>` : `<span class="km-lead"></span>`;
    return `<div class="km-row${item.lock ? " locked" : ""}${item.changed ? " changed" : ""}"${item.lock ? ` title="${esc(item.lock)}"` : ""}>
      ${lead}<span class="km-label">${esc(item.label)}</span>
      ${item.note ? `<span class="km-state${item.noteBad ? " bad" : ""}">${esc(item.note)}</span>` : ""}
      ${item.changed && !item.lock
        ? `<button class="km-undo" data-km-reset="${esc(item.id)}" title="기본값 ${esc(item.defKeys || "")} 으로">되돌리기</button>` : ""}
      ${item.lock
        ? `<span class="km-keys locked" title="${esc(item.lock)}">${keyCaps(item.keys)}</span>`
        : `<button class="km-keys${rec ? " rec" : ""}${bad.has(item.id) ? " bad" : ""}" data-km-rec="${esc(item.id)}" title="눌러서 새 조합 입력">${
            rec ? `<i class="km-rec-dot"></i>새 조합을 누르세요 · Esc 취소` : keyCaps(item.keys)}</button>`}
    </div>`;
  };
  const group = (g) => `<div class="km-grp"><div class="km-sh"><h3 class="km-sh-t">${esc(g.title)}</h3><span class="km-sh-n">${g.list.length}</span></div>${g.list.map(row).join("")}</div>`;
  // 두 단: 어디서나 쓰는 키가 가장 많아 왼쪽 한 단을 차지하고, 특정 화면에서만 쓰는 키는 오른쪽에 모은다.
  if (groups.length) {
    parts.push(`<div class="km-cols"><div>${group(groups[0])}</div><div>${groups.slice(1).map(group).join("")}</div></div>`);
  } else {
    parts.push('<div class="km-empty">찾는 단축키가 없습니다.</div>');
  }
  parts.push("</div></div>");
  return parts.join("");
}

// 안 쓰는 도구는 내려 둔다. 끈 화면은 rail 에서 사라지고 단축키로도 열리지 않는다. 버튼만
// 감추고 경로를 열어 두면 끈 상태와 화면이 어긋난다(rail.js 가 그 판정을 갖는다).
// 그룹 단추는 목록에 보일 기능만 거름(설정은 안 바꿈, 사용자 결정). 켜고 끄기는 줄마다의 스위치
function presetRow(presets, view) {
  const esc = escapeHtml;
  if (!presets || !presets.length) return "";
  return `<div class="km-seg" role="group" aria-label="보기">`
    + presets.map((p) => `<button data-set-preset="${esc(p.id)}" aria-pressed="${p.id === view ? "true" : "false"}"`
      + ` title="${esc(p.label)} 그룹의 기능만 보기">${esc(p.label)}</button>`).join("")
    + `</div>`;
}

// 기능이 채운 분류. 줄마다 고르는 값 하나(km-seg), 또는 기능이 그리는 화면(frame)
function featureSectionPane(f) {
  const esc = escapeHtml;
  const rows = Array.isArray(f.rows) ? f.rows : [];
  const frameRow = (r) => `<div class="km-frame-row">
      <div class="km-tx"><div class="km-tn">${esc(r.label)}</div>${r.desc ? `<div class="km-td">${esc(r.desc)}</div>` : ""}</div>
      <iframe class="km-frame" data-fs-frame="${esc(f.id)}:${esc(r.key)}" src="${esc(r.frame)}" title="${esc(r.label)}"
        style="height:${Number(r.height) > 0 ? Math.round(Number(r.height)) : 240}px"></iframe>
    </div>`;
  return `<div class="km-phead"><span class="km-h2">${esc(f.label)}</span></div><div>`
    + rows.map((r) => r.frame ? frameRow(r) : `<div class="km-toggle">
      <div class="km-tx">
        <div class="km-tn">${esc(r.label)}</div>
        ${r.desc ? `<div class="km-td">${esc(r.desc)}</div>` : ""}
      </div>
      <div class="km-seg" role="group" aria-label="${esc(r.label)}">${(r.options || []).map((o) =>
        `<button data-fs-sec="${esc(f.id)}" data-fs-key="${esc(r.key)}" data-fs-value="${esc(o.value)}" aria-pressed="${o.value === r.value ? "true" : "false"}">${esc(o.label)}</button>`).join("")}</div>
    </div>`).join("")
    + `</div>`;
}

// motion: 지금 모션이 켜져 있는가. localStorage 는 DOM 이 있어야 읽을 수 있어서 이 순수 함수가
// 직접 읽지 않고(파일 머리 "의존 대상" 참조) 호출하는 쪽(keymap-page.js)이 모델로 건넨다.
function motionToggleMarkup(motion) {
  return `<div class="km-toggle">
      <div class="km-tx">
        <div class="km-tn">모션</div>
        <div class="km-td">rail·탭·스위치의 전환 애니메이션. 시스템의 동작 줄이기 설정과 무관하게 기본 켜짐입니다.</div>
      </div>
      <button class="km-sw${motion ? " on" : ""}" data-set-motion=""
        role="switch" aria-checked="${motion ? "true" : "false"}" aria-label="모션"><i></i></button>
      <span class="km-sw-s">${motion ? "켜짐" : "꺼짐"}</span>
    </div>`;
}

function screensPane(allScreens, presets, motion, view, members) {
  const esc = escapeHtml;
  // 항상 켜진 기능은 어느 보기에서나 보임
  const screens = Array.isArray(members) ? allScreens.filter((t) => members.includes(t.id) || (t.lock && !t.readonly)) : allScreens;
  const motionRow = motionToggleMarkup(motion);
  const lockNote = featureLockNote();
  const onCount = screens.filter((t) => t.on || (t.lock && !t.readonly)).length;
  const head = `<div class="km-phead"><span class="km-h2">편의 기능</span>${
    screens.length ? `<span class="km-faint">${esc(screens.length)}개 중 ${esc(onCount)}개 켜짐</span>` : ""}<span class="km-sp"></span>${
    presetRow(presets, view)}</div>`;
  if (!screens.length) {
    return `${head}<div>${motionRow}</div><div class="km-empty">편의 기능 목록을 읽지 못했습니다.</div>`;
  }
  return head
    + `<div class="km-note">설정은 이 설치본에 저장됩니다. 서버·네이티브는 재시작 전까지 실행됩니다. 다른 창의 변경은 다음 부팅에 읽습니다.</div>`
    + (lockNote ? `<div class="km-note">${esc(lockNote)}</div>` : "")
    // 모션은 기능 하나가 아니라 앱 전체의 설정이라 목록 맨 위에 둔다.
    + `<div>${motionRow}`
    + screens.map((t) => `<div class="km-toggle${t.lock ? " locked" : ""}">
      <div class="km-tx">
        <div class="km-tn">${esc(t.label)}</div>
        ${t.lock ? `<div class="km-td">${esc(t.lock)}</div>` : ""}
        ${t.note ? `<div class="km-td">${esc(t.note)}</div>` : ""}
      </div>
      ${t.lock
        ? `<span class="km-sw-space"></span>`
        : `<button class="km-sw${t.on ? " on" : ""}" data-set-screen="${esc(t.id)}"
        role="switch" aria-checked="${t.on ? "true" : "false"}" aria-label="${esc(t.label)}"><i></i></button>`}
      <span class="km-sw-s">${t.lock && !t.readonly ? "항상 켜짐" : t.on ? "켜짐" : "꺼짐"}</span>
    </div>`).join("")
    + `</div>`;
}

// 기본 꺼짐 기능을 켜기 전에 보여 주는 확인 창. 문구는 기능 표(capabilities.js 의 optIn)에 코드로 적힌 것뿐이다.
export function optInConfirmMarkup(optIn) {
  const esc = escapeHtml;
  return `<div class="mdl" role="dialog" aria-modal="true">
      <div class="tt">${esc(optIn.title)}</div>
      <div class="target">${(optIn.items || []).map((item) => `<div>${esc(item)}</div>`).join("")}</div>
      ${optIn.after ? `<div class="tb">${esc(optIn.after)}</div>` : ""}
      <div class="mdl-row"><span class="hint"><span class="kc">esc</span>취소</span><button data-a="cancel">취소</button><button class="primary" data-a="ok">켜기</button></div>
    </div>`;
}

// 창 제목은 다른 앱이 만든 문자열이다. 화면에 넣는 모든 값은 이 순수 함수 안에서 반드시
// escapeHtml 을 거친다.
function switcherPane(model) {
  const esc = escapeHtml;
  if (!model || !Array.isArray(model.windows)) {
    return `<section class="km-switcher"><div class="km-phead"><span class="km-h2">창 전환</span></div><div class="km-empty">창 목록을 읽는 중</div></section>`;
  }

  const status = model.status || {};
  const media = model.media || null;
  const windows = status.permission === false
    ? model.windows.filter((w) => w && w.picked)
    : model.windows.filter(Boolean);
  const pickedRows = switcherPickedRows(windows, model.picked);
  const pickedSet = new Set(pickedRows);
  const restRows = switcherRows(windows.filter((window) => !pickedSet.has(window)));
  const rows = pickedRows.concat(restRows);
  const reasons = rows.map((window) => {
    const appKey = switcherAppKey(window);
    const icon = media && media.icons && media.icons[appKey];
    return replacementReason(window, media, validPngIcon(icon));
  });
  const sharedReason = reasons[0] && reasons.every((reason) => reason === reasons[0]) ? reasons[0] : "";

  const parts = [`<section class="km-switcher">
    <div class="km-phead"><span class="km-h2">창 전환</span><span class="km-sp"></span>
      <button class="km-btn" id="sw-refresh">다시 읽기</button></div>
    <div class="km-note km-sw-intro">체크한 창들 사이만 ${escapeHtml(formatBinding(bindingOf("screen-toggle")))}으로 오갑니다. 묶은 창들은 한 번에 함께 뜹니다. 하나도 없으면 콘솔과 브라우저를 토글합니다.</div>`,
    globalPriorityToggleMarkup(status)];

  const permissionUsesAppIcons = sharedReason === "화면 기록 권한 없음";
  const screenNotice = screenPermissionNotice(media && media.permission, permissionUsesAppIcons);
  const reasonCoveredByPermissionNotice = permissionUsesAppIcons && Boolean(screenNotice);
  if (screenNotice) parts.push(screenNotice);

  if (status.permission === false) {
    parts.push(`<div class="km-warn km-sw-message"><i class="km-warn-d"></i><span>창 목록을 읽으려면 손쉬운 사용 권한이 필요합니다</span><span class="km-sp"></span>
      <button class="km-btn" id="sw-open-accessibility">설정 열기</button></div>`);
  }
  const lastStep = status.lastStep && status.lastStep.failed
    ? `<div class="km-note km-sw-last-step">마지막 전환 실패<br>${esc(switchFailureText(status.lastStep.failed))}</div>`
    : "";
  const registrationWarning = switcherRegistrationWarning(status);
  if (registrationWarning) parts.push(`<div class="km-warn"><i class="km-warn-d"></i><span>${esc(registrationWarning)}</span></div>`);
  if (lastStep) parts.push(lastStep);
  const groupLeft = switcherGroupLeftText(status.lastStep);
  if (!lastStep && groupLeft) parts.push(`<div class="km-note km-sw-last-step">${esc(groupLeft)}</div>`);
  if (Number(status.droppedOnRestart) > 0) {
    parts.push(`<div class="km-note">재시작 뒤 못 찾아 뺀 창 ${esc(status.droppedOnRestart)}개</div>`);
  }

  if (!rows.length) {
    parts.push(`<div class="km-empty">고를 창이 없습니다</div>`);
  } else {
    if (sharedReason && !reasonCoveredByPermissionNotice) {
      parts.push(`<div class="km-note km-sw-list-note">${esc(sharedReason)}. 앱 아이콘으로 표시합니다.</div>`);
    }
    if (pickedRows.length) {
      parts.push(`<div class="km-sh"><h3 class="km-sh-t">${escapeHtml(formatBinding(bindingOf("screen-toggle")))} 이 도는 순서</h3><span class="km-sh-n">${esc(pickedRows.length)}</span></div>`);
      const groups = switcherPickedGroups(pickedRows, model.picked);
      const selected = new Set(Array.isArray(model.selected) ? model.selected : []);
      parts.push(`<div class="km-sw-list km-sw-picked-list">${switcherStopsMarkup(
        pickedRows, groups, status, media, reasons.slice(0, pickedRows.length), sharedReason, rows, selected,
      )}</div>`);
      parts.push(switcherSelectionBar(pickedRows, groups, selected));
    }
    if (restRows.length) {
      parts.push(`<div class="km-sh"><h3 class="km-sh-t">나머지 창</h3><span class="km-sh-n">${esc(restRows.length)}</span></div>`);
      parts.push(`<div class="km-sw-list km-sw-rest-list">${switcherRowsMarkup(
        restRows, status, media, reasons.slice(pickedRows.length), sharedReason,
        { allWindows: rows },
      )}</div>`);
    }
    if (windows.some((window) => window.switchBlocked === true)) {
      parts.push(`<div class="km-note km-sw-blocked-note">전환 안 됨<br>
        ${isHostWindows() ? "Windows가" : "macOS 가"} 그 데스크톱으로 안 넘어감<br>
        그 앱이 이 데스크톱에도 창을 갖고 있으면 그렇게 됨</div>`);
    }
  }
  parts.push("</section>");
  return parts.join("");
}

function switcherAppKey(window) {
  return typeof window.appKey === "string" && window.appKey
    ? window.appKey : `legacy:${String(window.displayApp || window.matchApp || "")}`;
}

function switcherDisplayApp(window) {
  return String(window.displayApp || window.matchApp || "알 수 없는 앱");
}

function switcherRows(windows) {
  return [...windows].sort((left, right) => {
    const appOrder = switcherDisplayApp(left).localeCompare(switcherDisplayApp(right), "ko")
      || switcherAppKey(left).localeCompare(switcherAppKey(right));
    return appOrder || compareSwitcherBounds(left, right);
  });
}

function switcherPickedRows(windows, picked) {
  const hasStoredOrder = Array.isArray(picked);
  const refs = hasStoredOrder ? picked : windows.filter((window) => window.picked);
  const rows = [];
  const used = new Set();
  for (const ref of refs) {
    const row = windows.find((window) => !used.has(window) && sameSwitcherPick(ref, window));
    if (!row) continue;
    used.add(row);
    rows.push(row);
  }
  if (!hasStoredOrder) {
    for (const row of windows) {
      if (row.picked && !used.has(row)) rows.push(row);
    }
  }
  return rows;
}

// 고른 줄마다 저장된 묶음 이름. 저장된 순서가 없으면 묶음 없음
function switcherPickedGroups(rows, picked) {
  const refs = Array.isArray(picked) ? picked : [];
  return rows.map((row) => {
    const ref = refs.find((item) => sameSwitcherPick(item, row));
    return ref && typeof ref.group === "string" ? ref.group : "";
  });
}

// 붙어 있는 같은 묶음 이름의 줄 = 한 차례. switcher-core 의 차례 규칙과 동일
function switcherStops(rows, groups) {
  const stops = [];
  rows.forEach((row, index) => {
    const last = stops[stops.length - 1];
    if (groups[index] && last && last.group === groups[index]) last.indexes.push(index);
    else stops.push({ group: groups[index], indexes: [index] });
  });
  return stops;
}

function switcherRowLabel(window) {
  return [switcherDisplayApp(window), String(window.displayTitle || "제목 없음")].filter(Boolean).join(" — ");
}

// 묶기·빼기·풀기·묶음 이동 단추의 대상 창. 줄의 스위치와 같은 규칙의 id 또는 저장 키
function switcherRefAttr(window, status) {
  const visible = status.permission === false ? false : window.visible !== false;
  return !visible && window.pickKey != null
    ? `data-ref-key="${escapeHtml(window.pickKey)}"`
    : window.id != null
      ? `data-ref-id="${escapeHtml(window.id)}"`
      : `data-ref-key="${escapeHtml(window.pickKey)}"`;
}

function switcherStopsMarkup(rows, groups, status, media, reasons, sharedReason, allWindows, selected) {
  const esc = escapeHtml;
  const stops = switcherStops(rows, groups);
  return stops.map((stop, stopIndex) => {
    const members = stop.indexes.map((index) => rows[index]);
    const memberReasons = stop.indexes.map((index) => reasons[index]);
    const rowOptions = { orderable: true, selectable: true, selected, allWindows };
    if (members.length < 2) {
      return switcherRowsMarkup(members, status, media, memberReasons, sharedReason, {
        ...rowOptions, firstStop: stopIndex === 0, lastStop: stopIndex === stops.length - 1,
      });
    }
    const ref = switcherRefAttr(members[0], status);
    const label = `묶음 ${members.length}개 창`;
    // 머리 줄도 줄과 같은 칸(선택·그림·글·순서·끝)을 써서 단추가 같은 열에 선다
    return `<div class="km-sw-group" role="group" aria-label="${esc(`${label} — ${members.map(switcherRowLabel).join(", ")}`)}">
      <div class="km-sw-row km-sw-group-head">
        <span class="km-sw-sel"></span><span class="km-sw-visual km-sw-blank"></span>
        <div class="km-sw-copy"><span class="km-sw-group-t">묶음 · ${esc(members.length)}개 창</span></div>
        <div class="km-sw-order" role="group" aria-label="${esc(`${label} 순서 바꾸기`)}">
          <button class="km-btn ghost" data-sw-move="-1" data-sw-unit="stop" ${ref}${stopIndex === 0 ? " disabled" : ""}
            aria-label="${esc(`묶음을 앞으로 옮기기 — ${label}`)}">위로</button>
          <button class="km-btn ghost" data-sw-move="1" data-sw-unit="stop" ${ref}${stopIndex === stops.length - 1 ? " disabled" : ""}
            aria-label="${esc(`묶음을 뒤로 옮기기 — ${label}`)}">아래로</button>
        </div>
        <span class="km-sw-end"><button class="km-btn ghost" data-sw-ungroup="" ${ref}
          aria-label="${esc(`묶음 풀기 — ${label}`)}">풀기</button></span>
      </div>
      ${switcherRowsMarkup(members, status, media, memberReasons, sharedReason, { ...rowOptions, grouped: true })}
    </div>`;
  }).join("");
}

// 고른 줄이 있을 때만 보이는 막대. 둘 이상이면 묶기, 묶인 창이 섞여 있으면 묶음에서 빼기
function switcherSelectionBar(rows, groups, selected) {
  const chosen = rows.map((row, index) => ({ row, group: groups[index] }))
    .filter((item) => typeof item.row.pickKey === "string" && selected.has(item.row.pickKey));
  if (!chosen.length) return "";
  const anyGrouped = chosen.some((item) => item.group);
  return `<div class="km-sw-selbar" role="region" aria-label="고른 창 묶기">
    <span class="km-sw-selbar-n">${escapeHtml(chosen.length)}개 선택됨</span>
    ${chosen.length < 2 ? '<span class="km-sw-selbar-hint">두 개 이상 고르면 묶을 수 있습니다</span>' : ""}
    <span class="km-sp"></span>
    ${anyGrouped ? '<button class="km-btn" data-sw-sel-leave="">묶음에서 빼기</button>' : ""}
    <button class="km-btn ghost" data-sw-sel-clear="">취소</button>
    <button class="cc-btn cc-btn-pri" data-sw-sel-group=""${chosen.length < 2 ? " disabled" : ""}>묶기</button>
  </div>`;
}

// 묶음 차례에서 같이 못 올린 창의 안내. 이유가 모두 같을 때만 그 이유 표시
function switcherGroupLeftText(lastStep) {
  const left = lastStep && Array.isArray(lastStep.left) ? lastStep.left : [];
  if (!left.length) return "";
  const why = left.every((reason) => reason === "other-desktop") ? "다른 데스크톱에 있어서" : "올리지 못해서";
  return `마지막 전환에서 묶음 중 ${left.length}개 창은 ${why} 같이 띄우지 못했습니다`;
}

function sameSwitcherPick(ref, window) {
  if (!ref || !window) return false;
  if (typeof ref.pickKey === "string" && typeof window.pickKey === "string") {
    return ref.pickKey === window.pickKey;
  }
  const refIds = [ref.id, ref.cgId].filter((value) => value !== null && value !== undefined);
  const rowIds = [window.id, window.cgId].filter((value) => value !== null && value !== undefined);
  return refIds.some((value) => rowIds.includes(value));
}

function compareSwitcherBounds(left, right) {
  const a = Array.isArray(left.bounds) && left.bounds.length === 4 ? left.bounds : [0, 0, 0, 0];
  const b = Array.isArray(right.bounds) && right.bounds.length === 4 ? right.bounds : [0, 0, 0, 0];
  for (let index = 0; index < 4; index += 1) {
    const av = Number.isFinite(Number(a[index])) ? Number(a[index]) : 0;
    const bv = Number.isFinite(Number(b[index])) ? Number(b[index]) : 0;
    if (av !== bv) return av - bv;
  }
  const leftId = Number.isInteger(Number(left.id)) ? Number(left.id) : Number(left.cgId) || 0;
  const rightId = Number.isInteger(Number(right.id)) ? Number(right.id) : Number(right.cgId) || 0;
  return leftId - rightId;
}

function validPngIcon(value) {
  return typeof value === "string" && value.startsWith("data:image/png;base64,");
}

function iconMarkup(icon, displayApp, className) {
  const esc = escapeHtml;
  if (validPngIcon(icon)) {
    return `<img class="${className}" src="${esc(icon)}" alt="">`;
  }
  const initial = Array.from(String(displayApp || "앱"))[0] || "앱";
  return `<span class="${className} km-sw-icon-fallback" aria-hidden="true">${esc(initial)}</span>`;
}

function replacementReason(window, media, hasIcon) {
  if (window.visible === false) return "안 보임";
  const thumb = media && media.thumbs && media.thumbs[window.id];
  if (validPngIcon(thumb)) return "";
  if (window.minimized) return "최소화";
  if (media && media.permission !== "granted") return "화면 기록 권한 없음";
  if (!hasIcon) return "아이콘 없음";
  const missing = media && Array.isArray(media.missing) ? media.missing : [];
  const item = missing.find((entry) => entry && entry.id != null && String(entry.id) === String(window.id));
  if (item && item.reason === "permission") return "화면 기록 권한 없음";
  if (item && item.reason === "too-large") return "창 그림이 너무 큼";
  if (item && item.reason === "empty-thumbnail") return "빈 창 그림";
  if (item && item.reason === "capture-failed") return "창 그림 읽기 실패";
  if (item && item.reason === "busy") return "창 그림 읽는 중";
  if (item && item.reason === "not-found") return "창 그림 없음";
  return media ? "창 그림 없음" : "아이콘 불러오는 중";
}

function switcherRowsMarkup(windows, status, media, reasons, sharedReason, options = {}) {
  const esc = escapeHtml;
  const titleCounts = new Map();
  for (const window of options.allWindows || windows) {
    const appKey = switcherAppKey(window);
    const title = String(window.displayTitle || "");
    if (!titleCounts.has(appKey)) titleCounts.set(appKey, new Map());
    const appTitles = titleCounts.get(appKey);
    appTitles.set(title, (appTitles.get(title) || 0) + 1);
  }
  return windows.map((window, index) => {
    const appKey = switcherAppKey(window);
    const displayApp = switcherDisplayApp(window);
    const icon = media && media.icons && media.icons[appKey];
    const visible = status.permission === false ? false : window.visible !== false;
    const pickAttr = !visible && window.pickKey != null
      ? `data-sw-key="${esc(window.pickKey)}"`
      : window.id != null
        ? `data-sw-pick="${esc(window.id)}"`
        : `data-sw-key="${esc(window.pickKey)}"`;
    const title = String(window.displayTitle || "제목 없음");
    const ordinal = Number(window.ordinal);
    const duplicateBadge = titleCounts.get(appKey).get(String(window.displayTitle || "")) > 1 && ordinal >= 2
      ? `<span class="km-sw-badge">#${esc(ordinal)}</span>` : "";
    const badges = `${window.minimized ? '<span class="km-sw-badge">최소화</span>' : ""}${
      window.reachable === "cg" ? '<span class="km-sw-badge">다른 데스크톱</span>' : ""}${
      window.switchBlocked === true ? '<span class="km-sw-badge">전환 안 됨</span>' : ""}${
      window.visible === false ? '<span class="km-sw-badge">안 보임</span>' : ""}${duplicateBadge}`;
    const label = [displayApp, title].filter(Boolean).join(" — ");
    const thumb = media && media.thumbs && media.thumbs[window.id];
    const visual = validPngIcon(thumb)
      ? `<img class="km-sw-thumb" src="${esc(thumb)}" alt="">`
      : iconMarkup(icon, displayApp, "km-sw-row-icon");
    // 혼자인 줄: 목록 전체의 처음·끝에서 비활성. 묶음 안 줄: 묶음의 처음·끝에서 비활성
    const atStart = options.grouped ? index === 0 : options.firstStop !== false && index === 0;
    const atEnd = options.grouped ? index === windows.length - 1 : options.lastStop !== false && index === windows.length - 1;
    const orderControls = options.orderable === true
      ? `<div class="km-sw-order" role="group" aria-label="${esc(`${label} 순서 바꾸기`)}">
        <button class="km-btn ghost" data-sw-move="-1"${atStart ? " disabled" : ""}
          aria-label="${esc(`앞으로 옮기기 — ${label}`)}">위로</button>
        <button class="km-btn ghost" data-sw-move="1"${atEnd ? " disabled" : ""}
          aria-label="${esc(`뒤로 옮기기 — ${label}`)}">아래로</button>
      </div>` : "";
    const selectable = options.selectable === true && typeof window.pickKey === "string";
    const isSelected = selectable && options.selected && options.selected.has(window.pickKey);
    const selectBox = selectable
      ? `<input type="checkbox" data-sw-sel="${esc(window.pickKey)}"${isSelected ? " checked" : ""}
          aria-label="${esc(`묶을 창으로 고르기 — ${label}`)}">` : "";
    return `<article class="km-sw-row${visible ? "" : " dim"}" data-sw-app="${esc(appKey)}">
      <span class="km-sw-sel">${selectBox}</span>
      <div class="km-sw-visual">${visual}</div>
      <div class="km-sw-copy">
        <div class="km-sw-title-line">
          <div class="km-sw-title${window.displayTitle ? "" : " empty"}" title="${esc(title)}">${esc(title)}</div>
          ${badges ? `<div class="km-sw-badges">${badges}</div>` : ""}
        </div>
        <div class="km-sw-meta">
          <div class="km-sw-app" title="${esc(displayApp)}">${esc(displayApp)}</div>
          ${sharedReason || !reasons[index] ? "" : `<div class="km-sw-reason">${esc(reasons[index])}</div>`}
          ${options.grouped && index === 0 ? '<div class="km-sw-reason" title="함께 뜬 뒤 이 창에 포커스가 갑니다">포커스</div>' : ""}
        </div>
      </div>
      ${orderControls}
      <span class="km-sw-end"><button class="km-sw${window.picked ? " on" : ""}" ${pickAttr}
        role="switch" aria-checked="${window.picked ? "true" : "false"}" aria-label="${esc(label)}"><i></i></button></span>
    </article>`;
  }).join("");
}

function screenPermissionNotice(permission, usesAppIcons = false) {
  if (!permission || permission === "granted") return "";
  const messages = {
    denied: "화면 기록 권한이 꺼져 있습니다. Iris를 허용한 뒤 앱을 다시 켜야 할 수 있습니다.",
    restricted: "기기 정책이 화면 기록을 막고 있습니다. 관리자에게 허용을 요청하세요.",
    "not-determined": "창 그림을 보려면 화면 기록 권한이 필요합니다. 허용한 뒤 앱을 다시 켜야 할 수 있습니다.",
    unknown: "화면 기록 권한 상태를 확인하지 못했습니다. 시스템 설정에서 상태를 확인하세요.",
  };
  const message = messages[permission] || messages.unknown;
  const fallback = usesAppIcons ? " 창 그림 대신 앱 아이콘으로 표시합니다." : "";
  return `<div class="km-warn y km-sw-message"><i class="km-warn-d"></i><span>${escapeHtml(message)}${fallback}</span><span class="km-sp"></span>
    <button class="km-btn" id="sw-open-perm">설정 열기</button></div>`;
}

// 사유를 그대로 보여주면 이해하기 어렵다. 쉬운 말로 바꾼다.
function switchFailureText(reason) {
  if (reason === "desktop-unknown") return "그 창이 몇 번 데스크톱인지 못 읽음";
  if (reason === "desktop-switch-failed") return "그 데스크톱으로 못 넘어감";
  if (reason === "window-out-of-reach") return "데스크톱은 넘어갔는데 그 창이 안 뜸";
  if (reason === "raise-did-not-land") return "불렀는데 안 올라옴";
  if (reason === "고른 창이 없다") return "고른 창이 없음";
  return String(reason);
}

// 고른 창이 있으면 이 옵션과 관계없이 전역으로 등록한다. 옵션은 고른 창이 없을 때의 다음 창 키만 바꾼다.
function globalPriorityToggleMarkup(status) {
  const on = !!(status && status.globalPriority);
  const key = escapeHtml(acceleratorLabel(status && status.accelerators?.next, formatBinding(bindingOf("screen-toggle"))));
  // 창 목록 줄처럼 켜짐·꺼짐 글자 없이 스위치를 오른쪽 끝에. 목록과 떨어진 설정 한 줄
  return `<div class="km-toggle top km-sw-global">
      <div class="km-tx">
        <div class="km-tn">전역 우선 사용</div>
        <div class="km-td">켜면 다른 앱이 앞에 있어도 ${key}를 Iris가 먼저 받아 Iris를 앞으로 가져옵니다. 체크한 창이 있으면 이 설정과 관계없이 전역으로 받습니다.</div>
      </div>
      <button class="km-sw${on ? " on" : ""}" data-sw-global=""
        role="switch" aria-checked="${on ? "true" : "false"}" aria-label="전역 우선 사용"><i></i></button>
    </div>`;
}

function switcherRegistrationWarning(status) {
  if (!status || !(status.pickedMode || status.globalPriority)) return "";
  const nextFailed = status.registered?.next === false;
  // 고른 창이 없으면 이전 창 키는 등록하지 않는다(실패가 아니다).
  const prevFailed = !!status.pickedMode && status.registered?.prev === false;
  if (!nextFailed && !prevFailed) return "";
  if (status.conflict === "internal:pick-mode") return "이 키는 요소 지목에 이미 쓰고 있습니다";
  if (status.conflict === "same-accelerator") return "다음 창 키와 이전 창 키가 같아 이전 창 키를 등록할 수 없습니다";

  const nextKey = acceleratorLabel(status.accelerators?.next, formatBinding(bindingOf("screen-toggle")));
  const prevKey = acceleratorLabel(status.accelerators?.prev, formatBinding(bindingOf("screen-toggle-back")));
  const failed = [
    nextFailed ? { name: `다음 창 키(${nextKey})`, reason: status.registerError?.next } : null,
    prevFailed ? { name: `이전 창 키(${prevKey})`, reason: status.registerError?.prev } : null,
  ].filter(Boolean);
  const unsupported = failed.filter((item) => item.reason === "unsupported");
  const errored = failed.filter((item) => item.reason === "register-error");
  const occupied = failed.filter((item) => item.reason !== "unsupported" && item.reason !== "register-error");

  if (unsupported.length || errored.length) {
    return unsupported.map((item) => `${item.name}는 전역 단축키로 쓸 수 없습니다`)
      .concat(errored.map((item) => `${item.name}를 전역 단축키로 등록하지 못했습니다`))
      .concat(occupied.map((item) => `${item.name}를 다른 앱이 쓰고 있습니다`))
      .join(" · ");
  }
  if (nextFailed && prevFailed) {
    return `다음 창 키(${nextKey})와 이전 창 키(${prevKey})를 다른 앱이 쓰고 있습니다`;
  }
  return nextFailed
    ? `다음 창 키(${nextKey})를 다른 앱이 쓰고 있습니다`
    : `이전 창 키(${prevKey})를 다른 앱이 쓰고 있습니다`;
}

function acceleratorLabel(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  const names = isHostWindows() ? {
    CommandOrControl: "Ctrl", Command: "Win", Control: "Ctrl", Ctrl: "Ctrl",
    Alt: "Alt", Option: "Alt", Shift: "Shift", Super: "Win", Meta: "Win",
  } : {
    CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Ctrl: "⌃",
    Alt: "⌥", Option: "⌥", Shift: "⇧",
  };
  return value.split("+").map((part) => names[part] || part).join(isHostWindows() ? "+" : "");
}

// 다른 앱에서 누른 웹 링크를 받을 앱. 값은 macOS 기본 브라우저이고 변경은 macOS 확인 창을 거침
function linksPane(model) {
  const esc = escapeHtml;
  const head = `<div class="km-phead"><span class="km-h2">링크 열기</span><span class="km-sp"></span>
    <button class="km-btn" id="lk-refresh">다시 읽기</button></div>
    <div class="km-note">다른 앱에서 누른 웹 링크를 어디서 열지 고릅니다. 고른 앱이 macOS 기본 브라우저가 됩니다.</div>`;
  if (!model || model.loading) return head + `<div class="km-empty">브라우저 목록을 읽는 중</div>`;
  if (!model.ok) return head + `<div class="km-warn"><i class="km-warn-d"></i><span>${esc(model.error || "브라우저 목록을 읽지 못했습니다.")}</span></div>`;
  const parts = [head];
  if (model.requested) {
    parts.push(`<div class="km-note">macOS 가 띄운 확인 창에서 고르면 적용됩니다.</div>`);
  }
  const session = model.target === "session";
  // Iris 줄 아래에서 Iris 안의 받을 창을 고름. 기본 브라우저가 다른 앱이어도 미리 고를 수 있음
  const targetSeg = `<div class="km-seg" role="group" aria-label="Iris 에서 열 창">`
    + [["shared", "공유 브라우저"], ["session", "세션 브라우저"]].map(([id, label]) =>
      `<button data-link-target="${id}" aria-pressed="${(id === "session") === session ? "true" : "false"}">${label}</button>`).join("")
    + `</div>`;
  const rows = (model.choices || []).map((c) => {
    const on = c.id === model.current;
    const desc = !c.self ? c.path
      : session ? "지금 보고 있는 스페이스의 브라우저에 새 탭으로 엽니다." : "공유 브라우저 창에 새 탭으로 엽니다.";
    const action = on
      ? `<span class="km-sw-s">사용 중</span>`
      : `<button class="km-btn" data-link-app="${esc(c.id)}">이 앱으로 열기</button>`;
    return `<div class="km-toggle top">
      <div class="km-tx"><div class="km-tn">${esc(c.name)}</div><div class="km-td">${esc(desc)}</div>
        ${c.self ? `<div class="km-link-target">${targetSeg}</div>` : ""}</div>
      ${action}
    </div>`;
  });
  if (!model.irisRegistered) {
    rows.unshift(`<div class="km-toggle top">
      <div class="km-tx"><div class="km-tn">Iris</div>
        <div class="km-td">설치한 Iris 가 아직 웹 링크를 받도록 등록되지 않았습니다. 앱을 다시 설치하면 고를 수 있습니다.</div></div>
    </div>`);
  }
  parts.push(`<div>${rows.join("")}</div>`);
  return parts.join("");
}

// ── 링크별 계정 규칙 ────────────────────────────────────────────────
// model: { rules: [{pattern, profile}], accounts: [{id, name}], draft, draftAccount, undo: {pattern} | null, fresh: pattern | null }
function accountName(accounts, id) {
  const a = (accounts || []).find((x) => x.id === id);
  return a ? a.name : "없는 계정";
}

// 입력칸 아래 안내: 입력한 주소의 범위, 열릴 계정, 이미 걸리는 규칙
export function linkHintMarkup({ draft, rules = [], accounts = [], draftAccount = "" } = {}) {
  const esc = escapeHtml;
  const text = String(draft || "").trim();
  if (!text) return `<span class="lk-hint-t">예: github.com · jira.acme.com · github.com/acme. 주소를 통째로 붙여 넣어도 됩니다.</span>`;
  const p = parseLinkPattern(text);
  if (!p.ok) return `<span class="lk-hint-t err">${esc(p.error)}</span>`;
  const same = rules.find((r) => r.pattern === p.pattern);
  const now = same ? null : matchLinkRule(`https://${p.pattern}`, rules);
  const parts = [`<span class="lk-hint-t"><b>${esc(describeLinkPattern(p.pattern))}</b> → ${esc(accountName(accounts, draftAccount))}</span>`];
  if (same) parts.push(`<span class="lk-hint-t">이미 있는 규칙입니다(지금 ${esc(accountName(accounts, same.profile))}). 바꾸면 계정만 바뀝니다.</span>`);
  else if (now) parts.push(`<span class="lk-hint-t">지금은 ${esc(now.pattern)} 규칙으로 ${esc(accountName(accounts, now.profile))}에서 열립니다. 더 구체적인 이 규칙이 우선합니다.</span>`);
  if (p.path) parts.push(`<button class="km-btn ghost" data-lk-whole="${esc(p.host)}">${esc(p.host)} 전체로</button>`);
  return parts.join("");
}

// 추가 버튼 글자와 사용 가능 여부(입력할 때마다 같은 판정으로 갱신)
export function linkAddState({ draft, rules = [] } = {}) {
  const p = parseLinkPattern(draft);
  return { disabled: !p.ok, label: p.ok && rules.some((r) => r.pattern === p.pattern) ? "바꾸기" : "추가" };
}

function linkRulesPane(model) {
  const esc = escapeHtml;
  const m = model || {};
  const rules = Array.isArray(m.rules) ? m.rules : [];
  const accounts = Array.isArray(m.accounts) ? m.accounts : [];
  const head = `<div class="km-phead lk-head"><span class="km-h2">계정별로 열기</span></div>
    <div class="km-note">링크·주소창·북마크·AI 도구로 연 주소가 아래 규칙에 맞으면 고른 계정으로 엽니다. 열린 탭이 다른 규칙의 주소로 이동하면 그 탭을 고른 계정으로 다시 엽니다.
      맞는 규칙이 여럿이면 가장 구체적인 규칙을 씁니다. 같은 규칙 안에서 이동하거나 새 탭을 열면 원래 탭의 계정을 그대로 씁니다.</div>`;
  if (accounts.length < 2) {
    return head + `<div class="km-empty">계정이 하나뿐이라 고를 계정이 없습니다. 브라우저의 계정 화면에서 계정을 추가하면 규칙을 만들 수 있습니다.</div>`;
  }
  const add = linkAddState({ draft: m.draft, rules });
  const form = `<div class="lk-add">
      <label class="km-search lk-input"><span class="lk-input-k">주소</span>
        <input id="lk-pattern" type="text" autocomplete="off" spellcheck="false" value="${esc(m.draft || "")}"
          placeholder="github.com 또는 주소 붙여 넣기" aria-describedby="lk-hint"></label>
      <span class="lk-acct" data-lk-acct="" aria-label="열 계정"></span>
      <button class="km-btn" id="lk-add"${add.disabled ? " disabled" : ""}>${add.label}</button>
    </div>
    <div class="lk-hint" id="lk-hint" aria-live="polite">${linkHintMarkup({ draft: m.draft, rules, accounts, draftAccount: m.draftAccount })}</div>`;
  const undo = m.undo ? `<div class="lk-undo"><span><b>${esc(m.undo.pattern)}</b> 규칙을 지웠습니다.</span>
      <button class="km-btn ghost" id="lk-undo">되돌리기</button></div>` : "";
  const sorted = [...rules].sort((a, b) => a.pattern.localeCompare(b.pattern));
  const list = sorted.length
    ? sorted.map((r) => `<div class="km-toggle lk-row${m.fresh === r.pattern ? " lk-fresh" : ""}" data-lk-row="${esc(r.pattern)}">
        <div class="km-tx"><div class="km-tn lk-pat">${esc(r.pattern)}</div><div class="km-td">${esc(describeLinkPattern(r.pattern))}</div></div>
        <span class="lk-acct" data-lk-acct="${esc(r.pattern)}" aria-label="${esc(r.pattern)} 를 열 계정"></span>
        <button class="km-btn ghost danger" data-lk-del="${esc(r.pattern)}" aria-label="${esc(r.pattern)} 규칙 지우기">지우기</button>
      </div>`).join("")
    : `<div class="km-empty">아직 규칙이 없습니다. 위에 주소를 넣고 계정을 고른 뒤 추가하세요.</div>`;
  return head + form + undo + `<div class="lk-list">${list}</div>`;
}

function securityPane(toggles) {
  const esc = escapeHtml;
  if (!toggles.length) return `<div class="km-empty">켜고 끌 것이 없습니다.</div>`;
  return `<div class="km-phead"><span class="km-h2">보안</span></div><div>`
    + toggles.map((t) => `<div class="km-toggle top">
      <div class="km-tx">
        <div class="km-tn">${esc(t.name)}</div>
        <div class="km-td">${esc(t.desc)}</div>
        ${t.warn ? `<div class="km-warn y km-warn-sm"><i class="km-warn-d"></i><span>${esc(t.warn)}</span></div>` : ""}
        ${t.clear ? `<button class="km-btn" data-set-clear="${esc(t.clear.id)}">${esc(t.clear.label)}</button>` : ""}
      </div>
      <button class="km-sw${t.on ? " on" : ""}" data-set-toggle="${esc(t.id)}"
        role="switch" aria-checked="${t.on ? "true" : "false"}" aria-label="${esc(t.name)}"><i></i></button>
      <span class="km-sw-s">${t.on ? "켜짐" : "꺼짐"}</span>
    </div>`).join("") + `</div>`;
}

// 사람은 "⌘F" 로도 찾고 "찾기" 로도 찾는다. 조합을 "cmd shift d" 처럼 글자로 치기도 한다.
export function matchOne(item, query) {
  const q = String(query || "").trim();
  if (!q) return true;
  if ([item.label, item.where, item.keys, item.id].join(" ").toLowerCase().indexOf(q) >= 0) return true;
  const combo = comboQuery(q);
  if (combo === null) return false;
  const keys = String(item.keys || "").toLowerCase();
  return combo.rest ? keys === combo.text : keys.startsWith(combo.text);
}

// 표의 mod 는 ⌘·⌃ 를 한 필드로 다루고 formatBinding 은 ⌘⌥⇧ 순서로 적으므로 같은 규칙으로 바꾼다.
const MOD_WORDS = { cmd: "⌘", command: "⌘", ctrl: "⌘", control: "⌘", "⌘": "⌘", "⌃": "⌘",
  opt: "⌥", option: "⌥", alt: "⌥", "⌥": "⌥", shift: "⇧", "⇧": "⇧" };
const KEY_WORDS = { left: "←", right: "→", up: "↑", down: "↓" };
function comboQuery(q) {
  const mods = new Set(), rest = [];
  for (const w of q.split(/[\s+]+/).filter(Boolean)) {
    if (MOD_WORDS[w]) mods.add(MOD_WORDS[w]); else rest.push(KEY_WORDS[w] || w);
  }
  if (!mods.size || rest.length > 1) return null;
  if (isHostWindows()) {
    const names = { "⌘": "ctrl", "⌥": "alt", "⇧": "shift" };
    return { rest: rest.length > 0, text: [...[..."⌘⌥⇧"].filter((m) => mods.has(m)).map((m) => names[m]), ...rest].join("+") };
  }
  return { rest: rest.length > 0, text: [..."⌘⌥⇧"].filter((m) => mods.has(m)).join("") + (rest[0] || "") };
}
