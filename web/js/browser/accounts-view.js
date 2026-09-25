// 계정 화면의 렌더. 자료를 받아 HTML 문자열 하나를 돌려준다.
//
// 소유 범위
//   왼쪽 프로필 칸 격자와 오른쪽 설정 칸(스페이스 기본 계정·Chrome 가져오기)의 배치와, 연결이
//   참조하는 이름들(data-space-def · data-prof · data-rename · data-del-prof · data-creds ·
//   data-creds-n · data-imp-cid · #acct-new-name · #acct-new-add · #acct-chrome · #acct-with-pw).
//
// 제공 API
//   accountsMarkup(model) · accountsChromeBox(list) · accountsCredsLine(summary) · accountsHeadSum(...)
//   · accountsUsedBy(...) · accountsUsedHtml(names) 과 escapeHtml.
//
// 의존 대상
//   아무것도 import 하지 않는다. DOM 도 window 도 보지 않으므로 Node 에서 그대로 부를 수
//   있고, 앱을 켜지 않는 사본과 검사가 같은 함수를 쓴다. 마크업을 두 벌로 적지 않기 위한 것이다.
//
// 유지 조건
//   위에 적은 이름들은 accounts-screen.js 의 위임 연결이 참조하는 대상이다. 하나만 빠져도 그 버튼은
//   눌러도 아무 일이 없고, 화면은 멀쩡해 보인다.
//   스페이스 기본 계정 칸(data-space-def)은 빈 자리만 그린다. 드롭다운은 DOM 이 필요해서
//   accounts-screen.js 가 그 자리에 붙이고, 고르면 그 자리에서 change 를 낸다.
//
// 영향 범위
//   browser/accounts-screen.js 의 acctRefresh 와 wireAccounts, web/css/06-accounts.css 의 acct-* 규칙,
//   .working 의 UI 사본(build.mjs 가 이 함수를 그대로 불러 렌더한다).
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/accounts-view.js

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ICON = {
  lock: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  down: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  tick: '<svg class="i" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
};

// 칸의 계정 줄. 자격증명 요약은 늦게 오므로 처음 렌더와 도착 뒤 갱신이 같은 글자를 쓰게 여기 둔다.
// null 은 아직 모르는 것이고, count 0 은 없는 것이다.
export function accountsCredsLine(c) {
  if (c == null) return { text: "저장된 로그인 확인 중…", none: true };
  if (!c.count) return { text: "저장된 로그인 없음", none: true };
  const accs = (c.accounts || []).slice(0, 3);
  return { text: accs.length ? accs.join(" · ") : `저장된 로그인 ${c.count}개`, none: false };
}

// 머리 막대의 요약. 저장된 로그인 수는 모든 프로필의 요약이 도착한 뒤에만 붙인다.
export function accountsHeadSum(profileCount, totalLogins) {
  return `<b>${profileCount}</b> 프로필${totalLogins ? ` · 저장된 로그인 <b>${totalLogins}</b>` : ""}`;
}

// Chrome 프로필 칸은 두 번 렌더된다. 처음 한 번과, 목록이 실제로 도착하면 다시 한 번. 그 둘이
// 갈라지지 않게 여기 하나만 둔다. null 은 "아직 모른다", 빈 배열은 "없다" 로 서로 다른 사실이다.
// 항목의 target 은 가져오면 들어갈 프로필이다({ name, isNew }). 판정할 수 없으면 비워 둔다.
export function accountsChromeBox(list) {
  const esc = escapeHtml;
  if (list == null) return `<div class="acct-empty"><span class="acct-spin"></span>불러오는 중…</div>`;
  if (!list.length) return `<div class="acct-empty">설치된 Chrome 프로필 없음(macOS만 지원)</div>`;
  return list.map((cp) => {
    const t = cp.target;
    const to = !t ? ""
      : t.isNew ? `<span class="acct-imp-to">새 프로필 <b>${esc(t.name)}</b> 을 만듭니다</span>`
        : `<span class="acct-imp-to">가져갈 곳 <b>${esc(t.name)}</b></span>`;
    return `<div class="acct-imp">
      <span class="acct-imp-l">${esc(cp.label)}</span>${to}
      <button class="acct-btn" data-imp-cid="${esc(cp.id)}" data-imp-label="${esc(cp.label)}">${ICON.down}가져오기</button>
    </div>`;
  }).join("");
}

// 어느 스페이스가 이 프로필을 기본으로 쓰는지(프로필 id → 스페이스 이름 목록). 서버 상태가 바뀌었을 때
// 칩만 다시 그리는 쪽도 같은 판정을 쓰도록 여기 둔다.
export function accountsUsedBy(spaces, defaults, defaultProfileId) {
  const defId = defaultProfileId == null ? "" : defaultProfileId;
  const usedBy = new Map();
  for (const s of spaces || []) {
    const pid = (defaults || {})[s.id] || defId;
    if (!usedBy.has(pid)) usedBy.set(pid, []);
    usedBy.get(pid).push(s.label || s.id);
  }
  return usedBy;
}

// 칸의 "쓰는 스페이스" 줄 안쪽.
export function accountsUsedHtml(names) {
  const esc = escapeHtml;
  return names && names.length
    ? names.map((n) => `<span class="acct-chip">${esc(n)}</span>`).join("")
    : `<span class="none">쓰는 스페이스 없음</span>`;
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

  // 어느 스페이스가 이 프로필을 기본으로 쓰는지 표시한다. 프로필 쪽에 없으면 삭제해도 되는지를
  // 판단하려고 옆 칸까지 확인해야 한다.
  const usedBy = accountsUsedBy(spaces, defaults, defId);

  const tile = (p) => {
    const c = creds[p.id];
    const line = accountsCredsLine(c);
    const who = (usedBy.get(p.id) || []);
    return `<div class="acct-tile" data-prof="${esc(p.id)}">
      <div class="acct-nm"><span class="an">${esc(p.name)}</span><span class="acct-cnt" data-creds-n="${esc(p.id)}">${c && c.count ? c.count : ""}</span></div>
      <div class="acct-acc${line.none ? " none" : ""}" data-creds="${esc(p.id)}">${esc(line.text)}</div>
      <div class="acct-used">${accountsUsedHtml(who)}</div>
      <div class="acct-ft">
        ${p.id
          ? `<button class="acct-btn acct-btn-ghost" data-rename="${esc(p.id)}">이름변경</button>`
            + `<button class="acct-btn acct-btn-ghost" data-del-prof="${esc(p.id)}">삭제</button>`
          : `<span class="acct-lock">${ICON.lock}기본 프로필은 지울 수 없습니다</span>`}
      </div>
    </div>`;
  };

  const chromeCount = Array.isArray(m.chromeProfiles) ? m.chromeProfiles.length : "";

  return `<div class="acct-main">
      <p class="acct-why">프로필은 로그인 칸입니다. 탭마다 다른 프로필을 주면 같은 사이트에 다른 계정으로 동시에 로그인해 둘 수 있고, 쿠키와 저장된 로그인은 칸 밖으로 새지 않습니다.</p>
      <div class="acct-shead"><h2>프로필 ${profiles.length}개</h2></div>
      <div class="acct-tiles" id="acct-prof-list">${profiles.map(tile).join("")}
        <div class="acct-tile acct-add">
          <input id="acct-new-name" class="acct-inp" placeholder="새 빈 프로필 이름" />
          <div class="acct-add-row"><button class="acct-btn" id="acct-new-add">${ICON.plus}추가</button><span class="acct-hint">Enter 로도 추가</span></div>
        </div>
      </div>
    </div>
    <aside class="acct-side">
      <div class="acct-sec">
        <div class="acct-sec-h"><h3>스페이스마다 쓰는 기본 계정</h3><span class="acct-n">${spaces.length}</span></div>
        <div class="acct-sec-b">
          ${spaces.length ? spaces.map((s) => `
            <div class="acct-srow">
              <span class="acct-sn${s.id === "__shared__" ? " sans" : ""}" title="${esc(s.label)}">${esc(s.label)}</span>
              <div class="acct-dd" data-space-def="${esc(s.id)}" data-value="${esc(defaults[s.id] || defId)}" data-label="${esc(s.label)}"></div>
            </div>`).join("") : `<div class="acct-empty">스페이스 없음</div>`}
        </div>
      </div>
      <div class="acct-sec">
        <div class="acct-sec-h"><h3>Chrome 에서 가져오기</h3><span class="acct-n" id="acct-chrome-n">${chromeCount}</span></div>
        <div class="acct-sec-b">
          <label class="acct-lbl"><input type="checkbox" id="acct-with-pw"${m.withPasswords ? " checked" : ""} /><span class="acct-check">${ICON.tick}</span>저장된 아이디·비밀번호도 함께</label>
          <div class="acct-chrome" id="acct-chrome">${accountsChromeBox(m.chromeProfiles)}</div>
          <p class="acct-note">가져오기는 그 Chrome 프로필의 로그인 세션(쿠키)을 이 프로필에 넣습니다. 위 칸을 켜야 저장된 아이디·비밀번호까지 가져오고, 그때만 Chrome 의 로그인 DB 를 복호화합니다. 가져온 비밀번호는 이 기기 Keychain 으로 암호화해 두고, 로그인 페이지에서 그 계정을 고른 순간에만 한 개씩 꺼내 채웁니다. Chrome 쪽 저장소는 읽기만 합니다.</p>
        </div>
      </div>
    </aside>`;
}
