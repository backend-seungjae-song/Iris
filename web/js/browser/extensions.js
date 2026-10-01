// 소유 범위: 브라우저 주소창의 확장 버튼과 네이티브 메뉴 호출.
// 제공 API: initCapability(ctx).
// 의존 대상: 기존 브라우저 도구모음, webview 목록, acHost의 확장 메뉴.
// 유지 조건: 현재 창의 활성 탭만 전달하고 메뉴 실패를 알린다.
// 영향 범위: browserextensions 등록과 ac-browser-extensions-menu IPC.
import { callHook } from "../core/hooks.js";
import { getBrowserState } from "./state.js";
import { profileOfTab } from "./profiles.js";
import { wakeTabHere } from "./ai-tabs.js";

export async function createExtensionTab(ctx, request) {
  if (ctx.boundTab) throw new Error("한 탭만 표시하는 창에서는 확장으로 새 탭을 열 수 없습니다.");
  const entries = [...ctx.getWebviewEntries()];
  const opener = entries.find(([, entry]) => {
    try { return entry.el.getWebContentsId() === request.openerWc; } catch { return false; }
  });
  if (!opener) throw new Error("새 탭을 요청한 브라우저 탭이 닫혔습니다.");
  const state = getBrowserState();
  const owner = Object.entries(state.tabsBySpace || {}).find(([, tabs]) => tabs.some((tab) => tab.id === opener[0]));
  if (!owner) throw new Error("브라우저 탭의 스페이스를 찾지 못했습니다.");
  if (!wakeTabHere(opener[0])) throw new Error("이 창에서 새 브라우저 탭을 표시할 수 없습니다.");
  const source = owner[1].find((tab) => tab.id === opener[0]);
  const id = ctx.openBrowserTab(request.url, { background: !request.active, profile: profileOfTab(opener[0]),
    space: owner[0], group: source.group || undefined });
  if (!id) throw new Error("새 브라우저 탭을 만들지 못했습니다.");
  // webview의 native ID는 attach 뒤에 생긴다. 다른 탭의 ID로 성공을 응답하지 않는다.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const tabs = getBrowserState().tabsBySpace?.[owner[0]] || [];
    const index = tabs.findIndex((tab) => tab.id === id);
    let entry = [...ctx.getWebviewEntries()].find(([tabId]) => tabId === id)?.[1];
    if (!entry && index >= 0) {
      if (!wakeTabHere(id)) throw new Error("이 창에서 새 브라우저 탭을 표시할 수 없습니다.");
      entry = [...ctx.getWebviewEntries()].find(([tabId]) => tabId === id)?.[1];
    }
    try {
      const webContentsId = entry?.el?.getWebContentsId();
      if (Number.isSafeInteger(webContentsId) && webContentsId > 0) {
        if (index >= 0) return { webContentsId, index };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("새 브라우저 탭이 연결되지 않았습니다.");
}

// 버튼을 누른 순간의 탭을 사용해야 다른 탭으로 전환한 뒤에도 이전 프로필을 바꾸지 않는다.
export function initCapability(ctx) {
  const host = ctx.acHost;
  if (!host) return {};
  if (typeof host.browserExtensionsMenu !== "function") {
    throw new Error("확장 프로그램 연결을 사용할 수 없습니다.");
  }
  const tools = document.querySelector(".urlbar .ub-tools");
  if (!tools || document.getElementById("wv-extensions")) return {};
  const unsubscribe = host.onExtensionCreateTab?.(async (request) => {
    try { host.extensionTabCreated({ requestId: request.requestId, ...await createExtensionTab(ctx, request) }); }
    catch (error) { host.extensionTabCreated({ requestId: request.requestId, error: error.message }); }
  });
  const button = document.createElement("button");
  button.id = "wv-extensions";
  button.type = "button";
  button.className = "chip";
  button.textContent = "확장";
  button.title = "이 프로필의 확장 프로그램";
  button.setAttribute("aria-label", "확장 프로그램");
  button.setAttribute("aria-haspopup", "menu");
  tools.insertBefore(button, tools.querySelector("#wv-closed"));
  button.addEventListener("click", async () => {
    const rec = [...ctx.getWebviewEntries()].map(([, entry]) => entry)
      .find((entry) => entry?.el?.classList.contains("active"));
    if (!rec) {
      ctx.showToast?.("브라우저 탭을 먼저 열어 주세요.");
      return;
    }
    if (callHook("mirror.tabUrl", rec.tabId)) {
      ctx.showToast?.("Chrome 미러를 끈 뒤 Iris 탭에서 확장을 관리해 주세요.");
      return;
    }
    button.disabled = true;
    try {
      const guestWebContentsId = rec.el.getWebContentsId();
      const result = await host.browserExtensionsMenu({ guestWebContentsId });
      if (!result?.ok) throw new Error(result?.error || "확장 프로그램 메뉴를 열지 못했습니다.");
    } catch (error) {
      ctx.showToast?.(error.message || "확장 프로그램 메뉴를 열지 못했습니다.", { level: "err" });
    } finally {
      button.disabled = false;
    }
  });
  return { dispose: () => { unsubscribe?.(); button.remove(); } };
}
