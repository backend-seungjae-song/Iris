// 설정의 「부산물」 분류 렌더: 자료를 받아 HTML 문자열 하나를 돌려준다.
//
// 소유 범위
//   종류 → 날짜 → 항목의 3단 배치와 이벤트 연결이 참조하는 이름들
//   (data-art-kind · data-art-empty · data-art-day · data-art-day-empty · data-art-open ·
//    data-art-del · #art-empty-all · #art-refresh · #art-preview-close),
//   그리고 크기·개수·시각을 사람이 읽는 글자로 바꾸는 규칙.
//
// 제공 API
//   artifactsPane(model). 그 밖의 것은 내주지 않는다.
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 도 window 도 보지 않는다. Node 에서 그대로 호출되고,
//   앱을 켜지 않는 검사가 같은 함수를 쓴다.
//
// 유지 조건
//   지운다고 적지 않는다. 실제로 일어나는 일은 휴지통으로 보내는 것이고, 화면이 「지움」이라
//   말하면 사람은 되돌릴 수 있다는 것을 모른다.
//   휴지통 통로가 없는 창(원격·폰)에서는 버튼을 그리지 않는다. 눌러도 아무 일이 없으면
//   사람은 지운 줄 안다.
//   파일 이름은 사람이 만든 문자열이므로, 화면에 넣는 모든 값은 이 함수 안에서 escape 한다.
//   미리보기 이미지는 서버가 준 바이트로만 띄운다. file:// 경로를 넣으면 이 창에서는
//   빈 영역이 된다(창은 http://localhost 이고 webSecurity 가 켜져 있다).
//
// 영향 범위
//   devtool/settings-view.js 의 분류 표, devtool/artifacts-page.js 의 연결,
//   web/css/20-keymap.css 의 이름.
//   현재 목록 확인: node bin/importers.mjs web/js/devtool/artifacts-view.js

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 1024 로 나눈다. Finder 가 보여주는 수와 달라 같은 폴더를 두 값으로 읽게 되지만,
// 여기서는 크기 비교만 필요하므로 단위를 하나로 맞춘다.
export function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = v / 1024, i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i += 1; }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[i]}`;
}

function stamp(ms) {
  const t = Number(ms);
  if (!t) return "";
  const d = new Date(t);
  const two = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function clock(ms) {
  const t = Number(ms);
  if (!t) return "";
  const d = new Date(t);
  const two = (x) => String(x).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

// model = { kinds, total, home, open, days, openDay, day, preview, canTrash, busy }
//   kinds: [{ id, label, desc, dir, count, bytes }]
//   days:  { kind, dir, days: [{ date, count, bytes, items }] }
//   day:   { kind, date, dir, entries: [{ name, path, dir, count, bytes, mtime }], more }
//   preview: { path, what, name, ... }. 서버가 준 그대로
//   dirPreview: 지금 보는 것이 어느 폴더 안이면 그 폴더의 목록(없으면 null)
//   canTrash: 이 창에 휴지통 통로가 있는가(없으면 지우는 버튼을 안 그린다)
export function artifactsPane(model) {
  const m = model || {};
  const kinds = Array.isArray(m.kinds) ? m.kinds : [];
  const total = m.total || { count: 0, bytes: 0 };
  const canTrash = m.canTrash !== false;
  const parts = [];

  parts.push(`<div class="km-pane-h"><div class="km-pane-t">부산물</div>
    <button class="km-btn" id="art-refresh">다시 세기</button>
    ${canTrash && total.count
      ? `<button class="km-btn" id="art-empty-all">전부 비우기</button>`
      : ""}</div>`);
  parts.push(`<div class="km-note">Iris 가 만든 파일입니다. 비우면 휴지통으로 갑니다 — ${
    kinds.length ? `모두 ${esc(total.count)}개 · ${esc(humanBytes(total.bytes))}` : "세는 중"}</div>`);
  if (!canTrash) {
    parts.push(`<div class="km-note">이 창에서는 휴지통으로 보낼 수 없어 목록만 보여 줍니다.</div>`);
  }

  if (!kinds.length) {
    parts.push(`<div class="km-empty">부산물 목록을 읽는 중</div>`);
    return parts.join("");
  }

  parts.push('<div class="art-list">');
  for (const kind of kinds) {
    const open = m.open === kind.id;
    const empty = !kind.count;
    parts.push(`<div class="art-kind${open ? " open" : ""}">
      <button class="art-head" data-art-kind="${esc(kind.id)}" aria-expanded="${open ? "true" : "false"}">
        <span class="art-caret">${open ? "▾" : "▸"}</span>
        <span class="art-n">${esc(kind.label)}</span>
        <span class="art-d">${esc(kind.desc || "")}</span>
        <span class="art-c">${empty ? "비어 있음" : `${esc(kind.count)}개 · ${esc(humanBytes(kind.bytes))}`}</span>
      </button>
      ${canTrash && !empty
        ? `<button class="km-undo" data-art-empty="${esc(kind.id)}">비우기</button>`
        : '<span class="km-undo-space"></span>'}
    </div>`);
    if (open) parts.push(dayRows(m, kind, canTrash));
  }
  parts.push("</div>");
  return parts.join("");
}

function dayRows(m, kind, canTrash) {
  const found = m.days && m.days.kind === kind.id ? m.days : null;
  if (!found) return `<div class="art-days"><div class="km-empty">읽는 중</div></div>`;
  const days = Array.isArray(found.days) ? found.days : [];
  if (!days.length) return `<div class="art-days"><div class="km-empty">이 폴더는 비어 있습니다.</div></div>`;
  const out = ['<div class="art-days">'];
  for (const day of days) {
    const open = m.openDay === day.date;
    out.push(`<div class="art-day${open ? " open" : ""}">
      <button class="art-day-h" data-art-day="${esc(day.date)}" aria-expanded="${open ? "true" : "false"}">
        <span class="art-caret">${open ? "▾" : "▸"}</span>
        <span class="art-date">${esc(day.date)}</span>
        <span class="art-c">${esc(day.count)}개 · ${esc(humanBytes(day.bytes))}</span>
      </button>
      ${canTrash
        ? `<button class="km-undo" data-art-day-empty="${esc(day.date)}">비우기</button>`
        : '<span class="km-undo-space"></span>'}
    </div>`);
    if (open) out.push(entryRows(m, kind, day, canTrash));
  }
  out.push("</div>");
  return out.join("");
}

function entryRows(m, kind, day, canTrash) {
  const found = m.day && m.day.kind === kind.id && m.day.date === day.date ? m.day : null;
  if (!found) return `<div class="art-rows"><div class="km-empty">읽는 중</div></div>`;
  const rows = Array.isArray(found.entries) ? found.entries : [];
  if (!rows.length) return `<div class="art-rows"><div class="km-empty">이 날짜에 남은 것이 없습니다.</div></div>`;
  const out = ['<div class="art-rows">'];
  for (const row of rows) {
    // 폴더 안의 파일을 열었을 때도 그 폴더 줄 아래에 표시한다. 그렇지 않으면 미리보기를 놓을 위치가 없다.
    const picked = under(m.preview, row.path);
    out.push(`<div class="art-row${picked ? " on" : ""}">
      <button class="art-f" data-art-open="${esc(row.path)}" title="눌러서 봅니다">${esc(row.name)}${
        row.dir ? ` <span class="art-sub">${esc(row.count)}개</span>` : ""}</button>
      <span class="art-s">${esc(humanBytes(row.bytes))}</span>
      <span class="art-t">${esc(clock(row.mtime))}</span>
      ${canTrash ? `<button class="km-undo" data-art-del="${esc(row.path)}">지우기</button>` : ""}
    </div>`);
    if (!picked) continue;
    // 폴더 목록은 그대로 두고 그 아래에 고른 파일을 편다. 목록이 사라지면 옆 파일로 넘어갈 수 없다.
    if (m.dirPreview && m.dirPreview.path !== m.preview.path) out.push(previewBlock(m.dirPreview));
    out.push(previewBlock(m.preview));
  }
  if (found.more) out.push(`<div class="km-empty">그 밖에 ${esc(found.more)}개가 더 있습니다. 이 날짜 비우기는 안 보이는 것까지 함께 보냅니다.</div>`);
  out.push("</div>");
  return out.join("");
}

// 지금 보는 것이 이 줄이거나 이 줄(폴더) 안에 있는가.
function under(preview, dirPath) {
  if (!preview || !preview.path || !dirPath) return false;
  return preview.path === dirPath || preview.path.startsWith(`${dirPath}/`);
}

function previewBlock(p) {
  const head = `<div class="art-pv-h"><span class="art-pv-n">${esc(p.name || "")}</span>
    <button class="km-btn" id="art-preview-close">닫기</button></div>`;
  if (p.error) return `<div class="art-pv">${head}<div class="km-empty">${esc(p.error)}</div></div>`;
  if (p.what === "image") {
    return `<div class="art-pv">${head}<img class="art-pv-img" alt="${esc(p.name || "")}"
      src="data:${esc(p.mime)};base64,${esc(p.data)}"></div>`;
  }
  if (p.what === "text") {
    return `<div class="art-pv">${head}<pre class="art-pv-txt">${esc(p.text || "")}</pre>${
      p.truncated ? `<div class="km-empty">앞부분만 보여 줍니다 — 모두 ${esc(humanBytes(p.bytes))}</div>` : ""}</div>`;
  }
  if (p.what === "dir") {
    const rows = (p.entries || []).map((row) => `<div class="art-pv-row">
      <button class="art-f" data-art-open="${esc(row.path)}">${esc(row.name)}${row.dir ? " /" : ""}</button>
      <span class="art-s">${esc(humanBytes(row.bytes))}</span>
      <span class="art-t">${esc(stamp(row.mtime))}</span>
    </div>`).join("");
    return `<div class="art-pv">${head}<div class="art-pv-dir">${rows || '<div class="km-empty">빈 폴더입니다.</div>'}</div>${
      p.more ? `<div class="km-empty">그 밖에 ${esc(p.more)}개가 더 있습니다.</div>` : ""}</div>`;
  }
  if (p.what === "too-big") {
    return `<div class="art-pv">${head}<div class="km-empty">${esc(humanBytes(p.bytes))} — 여기서 열기에는 너무 큽니다.</div></div>`;
  }
  return `<div class="art-pv">${head}<div class="km-empty">이 종류는 여기서 못 보여 줍니다 — ${esc(humanBytes(p.bytes))}</div></div>`;
}
