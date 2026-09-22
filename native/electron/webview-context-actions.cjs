// webview 우클릭 메뉴에 기능이 보탤 범용 action registry.
//
// 소유 범위
//   host webContents id별 { name, label } 목록과 host 수명에 맞춘 정리.
//
// 제공 API
//   createWebviewContextActions()가 register(host, action) · get(host)를 제공한다.
//
// 의존 대상
//   Electron을 직접 require하지 않는다. host는 id·isDestroyed()·once()를 가진 webContents다.
//
// 유지 조건
//   임의 guest가 action을 등록하면 안 된다. 신뢰 판정은 main IPC 경계가 하고, 이 registry는
//   값 모양과 host 수명만 맡는다. 같은 host/name 재등록은 listener나 메뉴 행을 늘리지 않는다.
//   이 파일은 action 이름의 뜻도, click 뒤 일어날 page mutation도 모른다.
//
// 영향 범위
//   main.cjs의 등록 IPC와 webview-context-menu.cjs의 조회 dependency.

const ACTION_NAME_RE = /^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9.-]*$/;

function normalizeAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const name = typeof action.name === "string" ? action.name.trim() : "";
  const label = typeof action.label === "string" ? action.label.trim() : "";
  if (!name || name.length > 100 || !ACTION_NAME_RE.test(name)) return null;
  if (!label || label.length > 80 || /[\r\n]/.test(label)) return null;
  return { name, label };
}

function createWebviewContextActions() {
  const hosts = new Map();

  function liveHost(host) {
    try {
      return !!host && Number.isInteger(host.id) && host.id > 0 && !host.isDestroyed();
    } catch {
      return false;
    }
  }

  function register(host, action) {
    const normalized = normalizeAction(action);
    if (!liveHost(host) || !normalized) return false;
    let entry = hosts.get(host.id);
    if (!entry) {
      entry = { host, actions: new Map() };
      hosts.set(host.id, entry);
      // renderer reload 뒤 capability가 꺼졌으면 다시 등록하는 주체가 없다. 이전 문서의 action을
      // 그대로 두면 꺼진 기능이 메뉴에 남으므로, 새 document load 시작 때 목록만 비운다.
      host.on("did-start-loading", () => {
        const current = hosts.get(host.id);
        if (current?.host === host) current.actions.clear();
      });
      host.once("destroyed", () => {
        if (hosts.get(host.id)?.host === host) hosts.delete(host.id);
      });
    } else if (entry.host !== host) {
      return false;
    }
    entry.actions.set(normalized.name, normalized);
    return true;
  }

  function get(host) {
    if (!liveHost(host)) return [];
    const entry = hosts.get(host.id);
    if (!entry || entry.host !== host) return [];
    return [...entry.actions.values()].map((action) => ({ ...action }));
  }

  return { register, get };
}

module.exports = { createWebviewContextActions, normalizeAction };
