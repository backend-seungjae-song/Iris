// 소유 범위: 현재 등록된 편집기 호스트와 생성·변경·제거 통지.
// 제공 API: registerEditorHost, updateEditorHost, subscribeEditorHosts(fn(host, event)).
// 의존 대상: 호스트가 건네는 editor와 onDidDispose. DOM이나 Monaco 로더는 모른다.
// 유지 조건: 늦게 구독한 쪽에도 현재 호스트를 알리고, 이전 해제로 새 호스트를 지우지 않는다.
// 영향 범위: 파일·메모 생성/폐기와 선택 기능의 버튼·키 수명.

const hosts = new Map();
const subscribers = new Set();

function notify(host, event) {
  for (const subscriber of subscribers) subscriber(host, event);
}

export function registerEditorHost(host) {
  hosts.get(host.id)?.dispose();
  const record = { host: { ...host }, dispose: null };
  let disposal;
  record.dispose = () => {
    if (hosts.get(host.id) !== record) return;
    hosts.delete(host.id);
    disposal?.dispose();
    notify(record.host, "remove");
  };
  hosts.set(host.id, record);
  disposal = host.editor.onDidDispose(record.dispose);
  notify(record.host, "add");
  return record.dispose;
}

export function updateEditorHost(id, patch) {
  const record = hosts.get(id);
  if (!record) return;
  record.host = { ...record.host, ...patch, id, editor: record.host.editor };
  notify(record.host, "update");
}

export function subscribeEditorHosts(fn) {
  subscribers.add(fn);
  for (const { host } of hosts.values()) fn(host, "add");
  return () => subscribers.delete(fn);
}
