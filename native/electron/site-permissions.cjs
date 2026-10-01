// 사이트 권한(위치·화면 공유·마이크·파일 쓰기와 폴더 선택)의 사용 여부와 사이트별 허용 기록.
//
// 소유 범위
//   기능별 사용 스위치, 기능별 사이트(origin) 허용·차단 기록, 사이트에 묻는 절차.
//
// 제공 API
//   createSitePermissions({ read, write, confirm }) 가 kindOf·featureOn·decision·ask·setFeature·clearSites·summary 를 준다.
//   kind 는 KINDS 의 id 다. 저장 형식은 호출자가 넘긴 read/write 뒤에 있다.
//
// 유지 조건
//   기능이 꺼져 있으면 묻지 않고 거절한다. 켜져 있으면 사이트마다 따로 묻고, 사람이 고른 허용·차단을 그 사이트에 기억한다.
//   같은 사이트·같은 기능의 물음은 하나만 띄운다. 묻는 창이 닫힌 뒤 기능이 꺼졌으면 허용하지 않는다.
//
// 영향 범위
//   profile-session-policy.cjs 의 권한 요청·확인 핸들러와 화면 공유 핸들러, main.cjs 의 확인 창·IPC,
//   설정 보안 분류(web/js/main.js·devtool/settings-view.js).

const KINDS = [
  { id: "geolocation", name: "위치", asks: "위치 정보를 사용하려고 합니다" },
  { id: "display", name: "화면 공유", asks: "화면을 공유하려고 합니다" },
  { id: "microphone", name: "마이크", asks: "마이크를 사용하려고 합니다" },
  { id: "fileWrite", name: "파일 쓰기·폴더 선택", asks: "내 파일에 쓰거나 폴더를 열려고 합니다" },
];
const KIND_IDS = new Set(KINDS.map((k) => k.id));

function createSitePermissions({ read, write, confirm }) {
  const asking = new Map();

  // 한 번 읽어 메모리에 둔다. 권한 확인은 페이지가 반복 호출할 수 있어 매번 파일을 읽지 않는다.
  let cache = null;
  const state = () => {
    if (!cache) {
      const raw = read() || {};
      cache = { on: raw.on && typeof raw.on === "object" ? raw.on : {}, sites: raw.sites && typeof raw.sites === "object" ? raw.sites : {} };
    }
    return cache;
  };
  const save = (next) => { cache = next; write({ sitePermissions: next }); };
  // scope(프로필)가 있으면 사이트 기록을 프로필별로 나눈다.
  const keyOf = (site, scope) => (scope ? scope + " " + site : site);

  const featureOn = (kind) => KIND_IDS.has(kind) && state().on[kind] === true;
  // true 허용, false 차단, undefined 아직 묻지 않음. 꺼진 기능은 사이트 기록과 상관없이 허용하지 않는다.
  function decision(kind, site, scope = "") {
    if (!featureOn(kind) || !site) return undefined;
    const v = (state().sites[kind] || {})[keyOf(site, scope)];
    return typeof v === "boolean" ? v : undefined;
  }

  async function ask(kind, site, scope = "") {
    if (!featureOn(kind) || !site) return false;
    const known = decision(kind, site, scope);
    if (known !== undefined) return known;
    const key = kind + "\n" + keyOf(site, scope);
    if (asking.has(key)) return asking.get(key);
    const pending = Promise.resolve()
      .then(() => confirm({ kind, site, ...KINDS.find((k) => k.id === kind) }))
      .catch(() => null)
      .then((answer) => {
        if (typeof answer !== "boolean") return false;
        if (!featureOn(kind)) return false;
        const cur = state();
        save({ on: cur.on, sites: { ...cur.sites, [kind]: { ...(cur.sites[kind] || {}), [keyOf(site, scope)]: answer } } });
        return answer;
      })
      .finally(() => asking.delete(key));
    asking.set(key, pending);
    return pending;
  }

  function setFeature(kind, on) {
    if (!KIND_IDS.has(kind) || typeof on !== "boolean") return;
    const cur = state();
    save({ on: { ...cur.on, [kind]: on }, sites: cur.sites });
  }

  function clearSites(kind) {
    if (!KIND_IDS.has(kind)) return;
    const cur = state();
    const sites = { ...cur.sites };
    delete sites[kind];
    save({ on: cur.on, sites });
  }

  function summary() {
    const cur = state();
    return KINDS.map((k) => {
      const list = Object.entries(cur.sites[k.id] || {});
      return { id: k.id, name: k.name, on: cur.on[k.id] === true,
        allowed: list.filter(([, v]) => v === true).length, blocked: list.filter(([, v]) => v === false).length };
    });
  }

  return { featureOn, decision, ask, setFeature, clearSites, summary };
}

module.exports = { createSitePermissions, KINDS };
