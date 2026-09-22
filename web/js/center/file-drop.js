// 밖에서 끌어온 파일을 가운데·브라우저 탭 띠와 본문에서 연다.
//
// 소유 범위
//   외부 파일 드롭 경계, 폴더 거절, 놓을 위치 표시의 판정과 유휴 타이머.
// 제공 API
//   initCenterFileDrop(deps), openDroppedEntries, centerFileDragHotNext, CENTER_DROP_IDLE_MS.
// 의존 대상
//   main이 주는 탭·본문·브라우저 DOM과 모드, acHost·열기·notice·hook.
// 유지 조건
//   종류별 열기·탭 활성화는 file-routing이 맡는다. 내부 드래그는 건드리지 않는다.
//   entry는 drop 안에서 읽는다. 확장자·빈 MIME·0바이트로 폴더를 추측하지 않는다.
//   표시는 dragover만 켠다. OS 드래그가 밖에서 끝나면 종료 이벤트가 오지 않으므로 타이머로도 끈다.
// 영향 범위
//   main 조립부, 11-center-tabs.css의 center-drop-hot, chatcopy.dragHint 훅과 smoke 검사.

export const CENTER_DROP_IDLE_MS = 1200;

export function centerFileDragHotNext(kind, overCenter) {
  return kind === "dragover" ? !!overCenter : false;
}

export function openDroppedEntries(entries, openFile, showToast) {
  if (!Array.isArray(entries) || !entries.length) { showToast("드롭한 파일 종류를 확인하지 못했습니다"); return; }
  for (const entry of entries) {
    if (entry?.error === "directory") { showToast("폴더는 열 수 없습니다. 파일을 놓아 주세요"); continue; }
    if (entry?.error === "entry") { showToast("드롭한 파일 종류를 확인하지 못했습니다"); continue; }
    if (typeof entry?.path !== "string" || !entry.path.startsWith("/") || entry.path.includes("\0")) {
      showToast("드롭한 파일 경로를 읽지 못했습니다"); continue;
    }
    try { openFile(entry.path); } catch { showToast("드롭한 파일을 열지 못했습니다"); }
  }
}

export function initCenterFileDrop({ tabstrip, centerBody, browserview, browserWindow = false,
  document, window, acHost, openFile, openDroppedLocal, isBrowserTab, showToast, callHook }) {
  const zones = [browserWindow && document.body, browserview, tabstrip, centerBody].filter(Boolean);
  let hotTimer = null, internalDrag = false;
  const hasFiles = (transfer) => !!transfer && Array.from(transfer.types || []).includes("Files");
  const zoneAt = (target) => target && zones.find((zone) => zone.contains(target));
  const setHot = (zone) => {
    if (hotTimer !== null) { window.clearTimeout(hotTimer); hotTimer = null; }
    for (const candidate of zones) candidate.classList.toggle("center-drop-hot", candidate === zone);
    if (zone) hotTimer = window.setTimeout(() => setHot(null), CENTER_DROP_IDLE_MS);
  };
  const clear = () => setHot(null);
  const end = () => { internalDrag = false; clear(); };
  const start = () => { internalDrag = true; clear(); };
  const over = (event) => {
    const zone = !internalDrag && hasFiles(event.dataTransfer) && zoneAt(event.target);
    setHot(centerFileDragHotNext(event.type, zone) ? zone : null);
    if (!zone) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const leave = (event) => { if (!event.relatedTarget) clear(); };
  const drop = (event) => {
    const accepted = !internalDrag && hasFiles(event.dataTransfer) && zoneAt(event.target);
    end();
    if (!accepted) return;
    event.preventDefault();
    event.stopPropagation();
    callHook("chatcopy.dragHint", "drop", false);
    const items = Array.from(event.dataTransfer.items || []).filter((item) => item.kind === "file");
    if (!items.length) { showToast("드롭한 파일 종류를 확인하지 못했습니다"); return; }
    const entries = items.map((item) => {
      try {
        const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
        if (entry?.isDirectory) return { error: "directory" };
        if (!entry?.isFile) return { error: "entry" };
        const file = item.getAsFile();
        const path = file && acHost?.getDroppedPath?.(file);
        return { path };
      } catch {
        return { error: "path" };
      }
    });
    const tabId = accepted === tabstrip && event.target.closest?.("[data-tab]")?.dataset.tab;
    const inBrowser = browserWindow || accepted === browserview || accepted === tabstrip &&
      (tabId ? isBrowserTab?.(tabId) : browserview && !browserview.hidden);
    openDroppedEntries(entries, inBrowser ? openDroppedLocal : openFile, showToast);
  };
  const listeners = { dragstart: start, dragover: over, dragleave: leave, dragend: end, drop };
  for (const [kind, handler] of Object.entries(listeners)) document.addEventListener(kind, handler, true);
  window.addEventListener("blur", end);
  return () => {
    end();
    for (const [kind, handler] of Object.entries(listeners)) document.removeEventListener(kind, handler, true);
    window.removeEventListener("blur", end);
  };
}
