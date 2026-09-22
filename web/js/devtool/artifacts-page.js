// 설정의 「부산물」 분류 연결: 목록을 받아 들고, 사람이 누른 것을 열거나 휴지통으로 보낸다.
//
// 소유 범위
//   이 분류가 화면에 들고 있는 것: 종류별 개수·크기, 펼친 종류와 그 날짜 요약, 펼친 날짜와
//   그 항목 목록, 지금 미리보는 항목, 지우는 동안의 잠금. 그리고 무엇을 눌렀을 때 무엇이
//   일어나는지.
//
// 제공 API
//   initArtifacts(deps) · artifactsModel() · artifactsClick(e) · artifactsMessage(m) ·
//   enterArtifacts().
//
// 의존 대상
//   서버가 주는 artifacts · artifacts-entries · artifacts-day · artifacts-preview 네 메시지와
//   창의 휴지통 통로(acHost.trashItem · acHost.trashItems).
//   화면은 artifacts-view.js 가 그린다. 여기서 HTML 을 만들지 않는다.
//
// 유지 조건
//   지우는 것은 언제나 휴지통이다. 사람이 되돌릴 수 있어야 하므로 영구 삭제 통로를 만들지 않는다.
//   지운 뒤에는 반드시 다시 계산한다. 화면에 남은 이전 개수는 삭제되지 않은 것으로 읽힌다.
//   서버가 준 경로만 지운다. 화면에서 만든 경로를 휴지통으로 보내면 임의 경로 삭제가 가능해진다.
//   날짜를 비울 때는 그 날짜의 경로를 먼저 받아 온다. 화면에 표시된 줄만 지우면 비운 뒤에도
//   파일이 남는다.
//   알림 문구의 수는 실제로 보낸 수다. 요청한 수를 적으면 실패한 경우가 성공으로 읽힌다.
//
// 영향 범위
//   devtool/keymap-page.js 의 click 위임과 렌더, devtool/artifacts-view.js 의 이름,
//   main.js 의 WS 분배표(artifacts · artifacts-entries · artifacts-day · artifacts-preview),
//   server/artifacts-handlers.js 의 계약.
//   현재 목록 확인: node bin/importers.mjs web/js/devtool/artifacts-page.js

let wsSend = null, showToast = null, rerender = () => {};
let kinds = [];
let total = { count: 0, bytes: 0 };
let home = "";
let openKind = null;      // 펼친 종류 id
let days = null;          // { kind, dir, days }
let openDay = null;       // 펼친 날짜 (YYYY-MM-DD)
let day = null;           // { kind, date, dir, entries, paths, more }
let preview = null;       // { path, ... }: 서버가 준 그대로
let dirPreview = null;    // 지금 보는 것이 어느 폴더 안이면 그 폴더의 목록
let pendingEmptyDay = null; // 목록을 받는 대로 비울 날짜
let busy = false;

export function initArtifacts(deps) {
  ({ wsSend, showToast, rerender } = deps);
}

function trash() {
  return typeof window !== "undefined" && window.acHost && window.acHost.trashItem
    ? window.acHost
    : null;
}

export function artifactsModel() {
  return { kinds, total, home, open: openKind, days, openDay, day, preview, dirPreview, busy, canTrash: !!trash() };
}

// 화면에 들어올 때마다 다시 계산한다. 이전에 본 개수는 그 사이 달라진다.
export function enterArtifacts() {
  if (!wsSend) return;
  wsSend({ type: "artifacts.list" });
  if (openKind) wsSend({ type: "artifacts.entries", kind: openKind });
  if (openKind && openDay) wsSend({ type: "artifacts.day", kind: openKind, date: openDay });
}

export function artifactsMessage(m) {
  if (!m) return false;
  if (m.type === "artifacts") {
    kinds = Array.isArray(m.kinds) ? m.kinds : [];
    total = m.total || { count: 0, bytes: 0 };
    home = m.home || "";
    rerender();
    return true;
  }
  if (m.type === "artifacts-entries") {
    days = { kind: m.kind, dir: m.dir, days: m.days || [] };
    rerender();
    return true;
  }
  if (m.type === "artifacts-day") {
    day = { kind: m.kind, date: m.date, dir: m.dir, entries: m.entries || [], paths: m.paths || [], more: m.more || 0 };
    // 비우려고 부른 목록이면 받는 즉시 보낸다.
    if (pendingEmptyDay && pendingEmptyDay === m.date) {
      const paths = day.paths.slice();
      const date = pendingEmptyDay;
      pendingEmptyDay = null;
      if (paths.length) void sendToTrash(paths, (n) => `${date} 의 ${n}개를 휴지통으로 보냈습니다`);
      else rerender();
      return true;
    }
    rerender();
    return true;
  }
  if (m.type === "artifacts-preview") {
    preview = m;
    // 폴더를 열었으면 그 목록을 유지한다. 안의 파일을 열어도 옆 파일로 넘어갈 수 있어야 한다.
    if (m.what === "dir") dirPreview = m;
    else if (!dirPreview || !String(m.path || "").startsWith(`${dirPreview.path}/`)) dirPreview = null;
    rerender();
    return true;
  }
  return false;
}

// 누른 것이 이 분류의 것이면 처리하고 true 를 돌려준다. 아니면 아무것도 안 하고 false 다.
export function artifactsClick(e) {
  const head = e.target.closest("[data-art-kind]");
  if (head) {
    const id = head.dataset.artKind;
    openKind = openKind === id ? null : id;
    days = null; openDay = null; day = null; preview = null; dirPreview = null;
    if (openKind && wsSend) wsSend({ type: "artifacts.entries", kind: openKind });
    rerender();
    return true;
  }
  const dayHead = e.target.closest("[data-art-day]");
  if (dayHead) {
    const date = dayHead.dataset.artDay;
    openDay = openDay === date ? null : date;
    day = null; preview = null; dirPreview = null;
    if (openDay && wsSend) wsSend({ type: "artifacts.day", kind: openKind, date: openDay });
    rerender();
    return true;
  }
  const dayEmpty = e.target.closest("[data-art-day-empty]");
  if (dayEmpty) {
    const date = dayEmpty.dataset.artDayEmpty;
    // 그 날짜의 경로가 이미 있으면 바로, 없으면 받아 온 뒤에 보낸다.
    if (day && day.date === date && day.paths.length) {
      void sendToTrash(day.paths.slice(), (n) => `${date} 의 ${n}개를 휴지통으로 보냈습니다`);
    } else if (wsSend) {
      pendingEmptyDay = date;
      wsSend({ type: "artifacts.day", kind: openKind, date });
    }
    return true;
  }
  const emptyKind = e.target.closest("[data-art-empty]");
  if (emptyKind) {
    const kind = kinds.find((k) => k.id === emptyKind.dataset.artEmpty);
    // 종류는 폴더째 보낸다. 안에 든 파일 수가 아니라 폴더 하나가 옮겨진다.
    if (kind) void sendToTrash([kind.dir], () => `${kind.label} 폴더를 휴지통으로 보냈습니다`);
    return true;
  }
  const open = e.target.closest("[data-art-open]");
  if (open) {
    const p = open.dataset.artOpen;
    if (knownPath(p) && wsSend) {
      preview = { path: p, name: p.split("/").pop() };
      wsSend({ type: "artifacts.preview", path: p });
      rerender();
    }
    return true;
  }
  const del = e.target.closest("[data-art-del]");
  if (del) {
    // 서버가 준 목록에 있는 경로만 지운다. 화면에서 만든 경로는 여기까지 오지 않는다.
    if (knownPath(del.dataset.artDel)) void sendToTrash([del.dataset.artDel], () => "휴지통으로 보냈습니다");
    return true;
  }
  if (e.target.closest("#art-preview-close")) {
    preview = null;
    dirPreview = null;
    rerender();
    return true;
  }
  if (e.target.closest("#art-empty-all")) {
    const dirs = kinds.filter((k) => k.count).map((k) => k.dir);
    if (dirs.length) void sendToTrash(dirs, (n) => `부산물 폴더 ${n}개를 휴지통으로 보냈습니다`);
    return true;
  }
  if (e.target.closest("#art-refresh")) {
    enterArtifacts();
    return true;
  }
  return false;
}

// 서버가 준 목록에 있는 경로인지 확인한다. 지우기와 열기 모두 이 검사를 통과한 것만 처리한다.
function knownPath(p) {
  if (!p) return false;
  if (day && (day.entries || []).some((row) => row.path === p)) return true;
  if (dirPreview && (dirPreview.entries || []).some((row) => row.path === p)) return true;
  return false;
}

// done(moved) 이 알림 문구를 만든다. 부르는 쪽마다 옮겨진 것이 파일인지 폴더인지 다르다.
async function sendToTrash(paths, done) {
  const host = trash();
  if (!host) { showToast && showToast("이 창에서는 휴지통으로 보낼 수 없습니다"); return; }
  if (busy) return;
  busy = true;
  rerender();
  let moved = 0;
  const failed = [];
  if (paths.length > 1 && host.trashItems) {
    try {
      const res = await host.trashItems(paths);
      moved = (res && res.moved) || 0;
      for (const f of (res && res.failed) || []) failed.push(f.error || "이유 없음");
    } catch (err) { failed.push(String(err && err.message || err)); }
  } else {
    for (const p of paths) {
      try {
        const res = await host.trashItem(p);
        if (res && res.ok) moved += 1;
        else failed.push(res && res.error ? res.error : "이유 없음");
      } catch (err) { failed.push(String(err && err.message || err)); }
    }
  }
  busy = false;
  // 지운 것이 지금 보고 있는 것이면 그 화면을 닫는다. 없는 파일을 계속 보여 줄 수 없다.
  if (preview && paths.includes(preview.path)) { preview = null; dirPreview = null; }
  // 실제로 남은 것은 다시 계산해야 알 수 있으므로, 화면의 수를 여기서 고치지 않는다.
  enterArtifacts();
  // 못 보낸 수는 사유 수가 아니라 실제로 옮겨지지 않은 수다. 한 번에 보내다 통째로 실패하면
  // 사유는 하나여도 남아 있는 것은 전부다.
  const shortfall = paths.length - moved;
  showToast && showToast(shortfall
    ? `${moved}개를 보내고 ${shortfall}개를 못 보냈습니다. ${failed[0] || "이유 없음"}`
    : done(moved));
}
