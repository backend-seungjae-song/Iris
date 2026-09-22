// 설정 화면 렌더: 자료를 받아 HTML 문자열 하나를 돌려준다.
//
// 소유 범위
//   왼쪽 분류 목록과 오른쪽 내용의 배치, 그리고 이벤트 연결이 참조하는 이름들
//   (data-km-rec · data-km-reset · data-km-sec · #km-reset-all · #km-search · data-set-toggle
//    · data-set-screen · data-sw-pick · data-sw-key · #sw-refresh · #sw-open-perm).
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

export const SETTINGS_SECTIONS = [
  { id: "keys", label: "단축키" },
  { id: "features", label: "편의 기능" },
  { id: "windows", label: "창 전환" },
  { id: "artifacts", label: "부산물" },
  { id: "security", label: "보안" },
];

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// model = { section, query, items, conflicts, changed, recording, toggles, screens, switcher }
//   items: resolvedKeymap() 결과 { id, label, where, keys, lock, changed, defKeys }
//   toggles: [{ id, name, desc, on, warn }]. 보안 분류의 스위치 목록
//   screens: [{ id, label, on, lock }]. 편의 기능(rail 도구 화면). 목록은 rail 버튼에서 읽어 온다.
//   switcher: { windows, picked, status, media }. 창 전환 분류의 창·선택·직접 읽은 아이콘과 권한
//   artifacts: { kinds, total, open, entries, canTrash }. 부산물 분류. 렌더는 artifacts-view 가 담당한다.
export function settingsMarkup(model) {
  const m = model || {};
  const esc = escapeHtml;
  const section = SETTINGS_SECTIONS.some((s) => s.id === m.section) ? m.section : "keys";
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

  const nav = SETTINGS_SECTIONS.map((s) => {
    const n = counts[s.id];
    const count = n === undefined ? "" : `<span class="km-nav-c">${esc(n)}</span>`;
    return `<button class="km-nav${s.id === section ? " on" : ""}" data-km-sec="${esc(s.id)}">
      <span class="km-nav-n">${esc(s.label)}</span>${count}</button>`;
  }).join("");

  return `<div class="km-split">
    <nav class="km-nav-col">${nav}</nav>
    <div class="km-pane">${
      section === "keys" ? keysPane(m, items)
      : section === "features" ? screensPane(screens, model.presets || PRESETS)
      : section === "windows" ? switcherPane(m.switcher)
      : section === "artifacts" ? artifactsPane(m.artifacts)
      : securityPane(toggles)}</div>
  </div>`;
}

function keysPane(m, items) {
  const esc = escapeHtml;
  const conflicts = m.conflicts || [];
  const shown = items.filter((x) => !m.query || matchOne(x, m.query));
  const parts = [];

  parts.push(`<div class="km-pane-h">
    <input id="km-search" type="search" placeholder="이름·조합으로 찾기" value="${esc(m.query || "")}" autocomplete="off" />
    ${m.changed ? `<button class="km-btn" id="km-reset-all">전부 기본값으로</button>` : ""}
  </div>`);

  if (conflicts.length) {
    parts.push(`<div class="km-warn">같은 자리에 둘 이상 걸렸습니다: ${conflicts
      .map((c) => `<b>${esc(c.keys)}</b> ${esc((c.ids || []).join(" · "))}`).join(" / ")}</div>`);
  }

  parts.push('<div class="km-list">');
  for (const item of shown) {
    const rec = m.recording === item.id;
    parts.push(`<div class="km-row${item.lock ? " locked" : ""}${item.changed ? " changed" : ""}">
      <div class="km-what"><span class="km-label">${esc(item.label)}</span><span class="km-where">${esc(item.where)}</span></div>
      ${item.lock
        ? `<span class="km-keys locked" title="${esc(item.lock)}">${esc(item.keys)}<span class="km-lock">잠김</span></span>`
        : `<button class="km-keys${rec ? " rec" : ""}" data-km-rec="${esc(item.id)}">${
            rec ? "새 조합을 누르세요 · Esc 취소" : esc(item.keys)}</button>`}
      ${item.changed && !item.lock
        ? `<button class="km-undo" data-km-reset="${esc(item.id)}" title="기본값 ${esc(item.defKeys || "")} 으로">되돌리기</button>`
        : '<span class="km-undo-space"></span>'}
    </div>`);
    if (item.lock) parts.push(`<div class="km-why">${esc(item.lock)}</div>`);
  }
  if (!shown.length) parts.push('<div class="km-empty">찾는 단축키가 없습니다.</div>');
  parts.push("</div>");
  return parts.join("");
}

// 안 쓰는 도구는 내려 둔다. 끈 화면은 rail 에서 사라지고 단축키로도 열리지 않는다. 버튼만
// 감추고 경로를 열어 두면 끈 상태와 화면이 어긋난다(rail.js 가 그 판정을 갖는다).
function presetRow(presets) {
  const esc = escapeHtml;
  if (!presets || !presets.length) return "";
  // 프리셋은 켤 id 목록이다. 여기서 그리는 문자열은 코드에 있는 것뿐이다.
  return `<div class="km-presets">`
    + presets.map((p) => `<button class="km-preset" data-set-preset="${esc(p.id)}" title="${esc(p.desc || "")}">${esc(p.label)}</button>`).join("")
    + `</div>`;
}

function screensPane(screens, presets) {
  const esc = escapeHtml;
  if (!screens.length) return `<div class="km-empty">편의 기능 목록을 읽지 못했습니다.</div>`;
  return `<div class="km-pane-h"><div class="km-pane-t">편의 기능</div></div>`
    + `<div class="km-note">설정은 이 설치본에 저장됩니다. 서버·네이티브는 재시작 전까지 실행됩니다. 다른 창의 변경은 다음 부팅에 읽습니다.</div>`
    + (featureLockNote() ? `<div class="km-note">${esc(featureLockNote())}</div>` : presetRow(presets))
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
    </div>`).join("");
}

// 창 제목은 다른 앱이 만든 문자열이다. 화면에 넣는 모든 값은 이 순수 함수 안에서 반드시
// escapeHtml 을 거친다.
function switcherPane(model) {
  const esc = escapeHtml;
  if (!model || !Array.isArray(model.windows)) {
    return `<section class="km-switcher"><div class="km-empty">창 목록을 읽는 중</div></section>`;
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
    <div class="km-pane-h km-switcher-h">
      <div>
        <div class="km-pane-t">창 전환</div>
        <div class="km-note km-sw-intro">체크한 창들 사이만 ⌥Tab으로 오갑니다.<br>하나도 없으면 콘솔과 브라우저를 토글합니다.</div>
      </div>
      <button class="km-btn" id="sw-refresh">다시 읽기</button>
    </div>`];

  const permissionUsesAppIcons = sharedReason === "화면 기록 권한 없음";
  const screenNotice = screenPermissionNotice(media && media.permission, permissionUsesAppIcons);
  const reasonCoveredByPermissionNotice = permissionUsesAppIcons && Boolean(screenNotice);
  if (screenNotice) parts.push(screenNotice);

  if (status.permission === false) {
    parts.push(`<div class="km-warn km-sw-message">창 목록을 읽으려면 손쉬운 사용 권한이 필요합니다
      <button class="km-btn" id="sw-open-accessibility">설정 열기</button></div>`);
  }
  const lastStep = status.lastStep && status.lastStep.failed
    ? `<div class="km-note km-sw-last-step">마지막 전환 실패<br>${esc(switchFailureText(status.lastStep.failed))}</div>`
    : "";
  const registrationWarning = switcherRegistrationWarning(status);
  if (registrationWarning) parts.push(`<div class="km-warn">${esc(registrationWarning)}</div>`);
  if (lastStep) parts.push(lastStep);
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
      parts.push(`<div class="km-note km-sw-order-label">⌥Tab 이 도는 순서</div>`);
      parts.push(`<div class="km-sw-list km-sw-picked-list">${switcherRowsMarkup(
        pickedRows, status, media, reasons.slice(0, pickedRows.length), sharedReason,
        { orderable: true, allWindows: rows },
      )}</div>`);
    }
    if (restRows.length) {
      parts.push(`<div class="km-sw-list km-sw-rest-list">${switcherRowsMarkup(
        restRows, status, media, reasons.slice(pickedRows.length), sharedReason,
        { allWindows: rows },
      )}</div>`);
    }
    if (windows.some((window) => window.switchBlocked === true)) {
      parts.push(`<div class="km-note km-sw-blocked-note">전환 안 됨<br>
        macOS 가 그 데스크톱으로 안 넘어감<br>
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
    const orderControls = options.orderable === true
      ? `<div class="km-sw-order" role="group" aria-label="${esc(`${label} 순서 바꾸기`)}">
        <button class="km-btn km-sw-move" data-sw-move="-1"${index === 0 ? " disabled" : ""}
          aria-label="${esc(`앞으로 옮기기 — ${label}`)}">위로</button>
        <button class="km-btn km-sw-move" data-sw-move="1"${index === windows.length - 1 ? " disabled" : ""}
          aria-label="${esc(`뒤로 옮기기 — ${label}`)}">아래로</button>
      </div>` : "";
    return `<article class="km-sw-row${visible ? "" : " dim"}" data-sw-app="${esc(appKey)}">
      <div class="km-sw-visual">${visual}</div>
      <div class="km-sw-copy">
        <div class="km-sw-title-line">
          <div class="km-sw-title${window.displayTitle ? "" : " empty"}" title="${esc(title)}">${esc(title)}</div>
          ${badges ? `<div class="km-sw-badges">${badges}</div>` : ""}
        </div>
        <div class="km-sw-meta">
          <div class="km-sw-app" title="${esc(displayApp)}">${esc(displayApp)}</div>
          ${sharedReason || !reasons[index] ? "" : `<div class="km-sw-reason">${esc(reasons[index])}</div>`}
        </div>
      </div>
      ${orderControls}
      <button class="km-sw${window.picked ? " on" : ""}" ${pickAttr}
        role="switch" aria-checked="${window.picked ? "true" : "false"}" aria-label="${esc(label)}"><i></i></button>
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
  return `<div class="km-warn km-sw-message">⚠ ${escapeHtml(message)}${fallback}
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

function switcherRegistrationWarning(status) {
  if (!status || !status.pickedMode) return "";
  const nextFailed = status.registered?.next === false;
  const prevFailed = status.registered?.prev === false;
  if (!nextFailed && !prevFailed) return "";
  if (status.conflict === "internal:pick-mode") return "이 키는 요소 지목에 이미 쓰고 있습니다";
  if (status.conflict === "same-accelerator") return "다음 창 키와 이전 창 키가 같아 이전 창 키를 등록할 수 없습니다";

  const nextKey = acceleratorLabel(status.accelerators?.next, "⌥Tab");
  const prevKey = acceleratorLabel(status.accelerators?.prev, "⌥⇧Tab");
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
  const names = {
    CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Ctrl: "⌃",
    Alt: "⌥", Option: "⌥", Shift: "⇧",
  };
  return value.split("+").map((part) => names[part] || part).join("");
}

function securityPane(toggles) {
  const esc = escapeHtml;
  if (!toggles.length) return `<div class="km-empty">켜고 끌 것이 없습니다.</div>`;
  return `<div class="km-pane-h"><div class="km-pane-t">보안</div></div>`
    + toggles.map((t) => `<div class="km-toggle">
      <div class="km-tx">
        <div class="km-tn">${esc(t.name)}</div>
        <div class="km-td">${esc(t.desc)}</div>
        ${t.warn ? `<div class="km-warn km-warn-sm">${esc(t.warn)}</div>` : ""}
      </div>
      <button class="km-sw${t.on ? " on" : ""}" data-set-toggle="${esc(t.id)}"
        role="switch" aria-checked="${t.on ? "true" : "false"}" aria-label="${esc(t.name)}"><i></i></button>
      <span class="km-sw-s">${t.on ? "켜짐" : "꺼짐"}</span>
    </div>`).join("");
}

// 사람은 "⌘F" 로도 찾고 "찾기" 로도 찾는다.
export function matchOne(item, q) {
  if (!q) return true;
  return [item.label, item.where, item.keys, item.id].join(" ").toLowerCase().indexOf(q) >= 0;
}
