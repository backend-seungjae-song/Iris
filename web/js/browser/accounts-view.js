// 계정 화면의 렌더. 자료를 받아 HTML 문자열 하나를 돌려준다.
//
// 소유 범위
//   프로필·스페이스 기본 계정·Chrome 가져오기 세 그룹의 배치와, 연결이 참조하는 이름들
//   (data-space-def · data-prof · data-rename · data-del-prof · data-creds · data-imp-cid ·
//   #acct-new-name · #acct-new-add · #acct-chrome · #acct-with-pw).
//
// 제공 API
//   accountsMarkup(model) 과 escapeHtml. 그 밖의 것은 내주지 않는다.
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 도 window 도 보지 않으므로 Node 에서 그대로 부를 수
//   있고, 앱을 켜지 않는 사본과 검사가 같은 함수를 쓴다. 마크업을 두 벌로 적지 않기 위한 것이다.
//
// 유지 조건
//   위에 적은 이름들은 profiles.js 의 위임 연결이 참조하는 대상이다. 하나만 빠져도 그 버튼은
//   눌러도 아무 일이 없고, 화면은 멀쩡해 보인다.
//   이 화면은 언제나 뷰어를 덮는 넓은 폭으로 표시된다(rail 의 RAIL_FULL). 좁은 패널용 한 줄 배치를
//   그대로 늘이면 이름은 왼쪽 끝, 조작은 오른쪽 끝에 붙어 사이가 통째로 빈다.
//
// 영향 범위
//   browser/profiles.js 의 acctRefresh 와 wireAccounts, web/css/06-accounts.css 의 acct-* 규칙,
//   .working 의 UI 사본(build.mjs 가 이 함수를 그대로 불러 렌더한다).
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/accounts-view.js

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Chrome 프로필 칸은 두 번 렌더된다. 처음 한 번과, 목록이 실제로 도착하면 다시 한 번. 그 둘이
// 갈라지지 않게 여기 하나만 둔다. null 은 "아직 모른다", 빈 배열은 "없다" 로 서로 다른 사실이다.
export function accountsChromeBox(list) {
  const esc = escapeHtml;
  if (list == null) return `<div class="acct-note">불러오는 중…</div>`;
  if (!list.length) return `<div class="acct-note">설치된 Chrome 프로필 없음(macOS만 지원)</div>`;
  return `<div class="acct-grid">${list.map((cp) => `
    <div class="acct-card acct-imp">
      <div class="acct-card-h"><span class="an">${esc(cp.label)}</span></div>
      <div class="acct-card-f">
        <button class="acct-btn" data-imp-cid="${esc(cp.id)}" data-imp-label="${esc(cp.label)}">가져오기</button>
      </div>
    </div>`).join("")}</div>`;
}

// model = { spaces, profiles, defaults, defaultProfileId, creds, chromeProfiles, withPasswords }
//   creds: { [profileId]: { count, accounts[] } }. 아직 모르면 그 키가 없다(비번은 여기 오지 않는다).
//   chromeProfiles: null 이면 "불러오는 중", [] 이면 없는 것으로, 둘은 다른 사실이다.
export function accountsMarkup(model) {
  const m = model || {};
  const esc = escapeHtml;
  const spaces = m.spaces || [];
  const profiles = m.profiles || [];
  const defaults = m.defaults || {};
  const creds = m.creds || {};
  const defId = m.defaultProfileId == null ? "" : m.defaultProfileId;

  const total = profiles.reduce((a, p) => a + ((creds[p.id] && creds[p.id].count) || 0), 0);
  // 어느 스페이스가 이 프로필을 기본으로 쓰는지 표시한다. 프로필 쪽에 없으면 삭제해도 되는지를
  // 판단하려고 아래 표까지 내려가 확인해야 한다.
  const usedBy = new Map();
  for (const s of spaces) {
    const pid = defaults[s.id] || defId;
    if (!usedBy.has(pid)) usedBy.set(pid, []);
    usedBy.get(pid).push(s.label || s.id);
  }

  const opts = (sel) => profiles.map((p) =>
    `<option value="${esc(p.id)}"${p.id === sel ? " selected" : ""}>${esc(p.name)}</option>`).join("");

  const profileCard = (p) => {
    const c = creds[p.id];
    const sub = c == null ? "자격증명 확인 중…"
      : c.count ? `저장된 로그인 ${c.count}개` : "저장된 로그인 없음";
    const who = (usedBy.get(p.id) || []);
    return `<div class="acct-card" data-prof="${esc(p.id)}">
      <div class="acct-card-h">
        <span class="an">${esc(p.name)}</span>
        ${c && c.count ? `<span class="acct-count">${c.count}</span>` : ""}
      </div>
      <div class="acct-card-b">
        <div class="asub" data-creds="${esc(p.id)}">${esc(sub)}</div>
        ${c && c.accounts && c.accounts.length
          ? `<div class="acct-accs">${c.accounts.slice(0, 3).map((a) => esc(a)).join(" · ")}</div>` : ""}
        ${who.length
          ? `<div class="acct-used">${who.map((n) => `<span class="acct-chip">${esc(n)}</span>`).join("")}</div>`
          : `<div class="acct-used none">쓰는 스페이스 없음</div>`}
      </div>
      <div class="acct-card-f">
        ${p.id
          ? `<button class="acct-btn" data-rename="${esc(p.id)}">이름변경</button>`
            + `<button class="acct-btn danger" data-del-prof="${esc(p.id)}">삭제</button>`
          : `<span class="acct-locked">기본 프로필은 지울 수 없습니다</span>`}
      </div>
    </div>`;
  };

  const chromeBox = accountsChromeBox(m.chromeProfiles);

  return `
    <div class="acct-hero">
      <div class="acct-sum"><b>${profiles.length}</b> 프로필<span>${
        total ? ` · 저장된 로그인 ${total}개` : ""}</span></div>
      <div class="acct-why">프로필은 로그인 칸입니다. 탭마다 다른 프로필을 주면 같은 사이트에 다른 계정으로 동시에 로그인해 둘 수 있고, 쿠키와 저장된 로그인은 칸 밖으로 새지 않습니다.</div>
    </div>

    <div class="acct-sec">
      <div class="acct-sec-h">프로필 <span class="acct-sec-c">${profiles.length}</span>
        <div class="acct-tools">
          <input id="acct-new-name" placeholder="새 빈 프로필 이름" />
          <button class="acct-btn" id="acct-new-add">＋ 추가</button>
        </div>
      </div>
      <div class="acct-grid" id="acct-prof-list">${profiles.map(profileCard).join("")}</div>
    </div>

    <div class="acct-sec">
      <div class="acct-sec-h">스페이스 기본 계정 <span class="acct-sec-c">${spaces.length}</span></div>
      ${spaces.length
        ? `<div class="acct-grid acct-grid-sm">${spaces.map((s) => `
            <div class="acct-row">
              <span class="an">${esc(s.label)}</span>
              <select data-space-def="${esc(s.id)}">${opts(defaults[s.id] || defId)}</select>
            </div>`).join("")}</div>`
        : `<div class="acct-note">스페이스 없음</div>`}
    </div>

    <div class="acct-sec">
      <div class="acct-sec-h">Chrome 에서 가져오기
        <label class="acct-tools acct-pw">
          <input type="checkbox" id="acct-with-pw"${m.withPasswords ? " checked" : ""} /> 저장된 아이디·비밀번호도 함께
        </label>
      </div>
      <div id="acct-chrome">${chromeBox}</div>
      <div class="acct-note">가져오기는 그 Chrome 프로필의 로그인 세션(쿠키)을 이 프로필에 넣습니다. 위 칸을 켜야 저장된 아이디·비밀번호까지 함께 가져옵니다. 그때만 Chrome의 로그인 DB를 복호화합니다. 가져온 비밀번호는 이 기기 Keychain으로 암호화해 두고, 로그인 페이지에서 그 계정을 고른 순간에만 한 개씩 꺼내 채웁니다. Chrome 쪽 저장소는 읽기만 합니다.</div>
    </div>`;
}
