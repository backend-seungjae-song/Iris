import { answerUserAsk, pendingUserNotices } from "../../browser-commands.js";
import { createBrowserFeature } from "./browser.js";
import { createSourceControlFeature } from "./source-control.js";
import { createTerminalFeature } from "./terminal.js";
import { redactPrivateText } from "../public-text.js";

const ASK_SYNC_MS = 250;

export function createRemoteFeatures(options) {
  const terminal = options.terminalFeature || createTerminalFeature(options);
  const browser = options.browserFeature || createBrowserFeature(options);
  const source = options.sourceControlFeature || createSourceControlFeature(options);
  const requests = options.requests;
  const agents = options.agents;
  const now = options.now || Date.now;
  const setTimer = options.askSetTimer || setTimeout;
  const clearTimer = options.askClearTimer || clearTimeout;
  const listUserNotices = options.pendingUserNotices || pendingUserNotices;
  const deliverUserAnswer = options.answerUserAsk || answerUserAsk;
  const asks = new Map();
  let askTimer = null;

  function syncAsks() {
    const active = new Set();
    try {
      for (const notice of listUserNotices()) {
        // 원격 계약은 완료 여부만 받으므로 승인과 지정 선택지는 데스크톱에서 답한다.
        if (notice.kind === "approve" || Array.isArray(notice.choices)) continue;
        const agent = agents.resolvePane(notice.session);
        if (!agent) continue;
        active.add(notice.id);
        const round = notice.round;
        const existing = asks.get(notice.id);
        // 만료는 AI의 새 호출이 아니다. 같은 round에서는 새 알림을 만들지 않는다.
        if (existing && existing.round === round) continue;
        if (existing) requests.cancel(existing.ref);
        const tab = notice.tabId ? browser.refForTabId(notice.tabId) : undefined;
        const identifiers = [notice.session, notice.tabId];
        const created = requests.add({ agent: agent.ref, kind: "browser-user", createdAt: now(),
          expiresAt: now() + Math.max(1_000, Math.min(240_000, Number(notice.wait || 1) * 1000)),
          body: { title: redactPrivateText(notice.title || "사람 차례", identifiers).slice(0, 60),
            text: redactPrivateText(notice.text || "브라우저에서 작업을 마쳐 주세요.", identifiers).slice(0, 500),
            choices: ["다 했음", "못 하겠음"], ...(tab ? { tab } : {}) } }, (answer) => {
          if (!listUserNotices().some((item) => item.id === notice.id && item.round === round)) return "failed";
          deliverUserAnswer(notice.id, answer.choice === "done" ? "다 했음" : "못 했음");
          return "delivered";
        });
        asks.set(notice.id, { ref: created.ref, round });
      }
      for (const [id, request] of asks) {
        if (active.has(id)) continue;
        requests.cancel(request.ref); asks.delete(id);
      }
    } catch {}
    askTimer = setTimer(syncAsks, ASK_SYNC_MS);
    askTimer?.unref?.();
  }
  syncAsks();

  const browserStateNames = ["browser.tabs", "browser.tab.new", "browser.profiles", "browser.profile.set",
    "browser.bookmarks", "browser.bookmark.set", "browser.sketch.send", "browser.draft.remove", "browser.direct"];
  const browserInteractiveNames = ["browser.frame.watch", "browser.pointer", "browser.mouse", "browser.type", "browser.key",
    "browser.scroll", "browser.history", "browser.navigate", "browser.element", "browser.element.hover",
    "browser.element.pick", "browser.element.send", "browser.focus", "browser.dialog",
    "browser.record.start", "browser.record.pause", "browser.record.finish", "browser.desktop", "browser.translate"];
  const terminalNames = ["terminal.watch", "terminal.input", "terminal.key", "terminal.select", "terminal.mouse", "terminal.scrollback", "terminal.keys.get", "terminal.keys.set"];
  const gitNames = ["git.changes", "git.diff", "git.diff.draft"];
  const githubNames = ["github.pr", "github.check.log", "github.check.draft"];

  return {
    terminal,
    browser,
    source,
    capabilities() {
      return [
        ...(terminal.available() ? terminalNames : []),
        ...browserStateNames,
        ...(browser.interactiveAvailable() ? browserInteractiveNames : []),
        ...(source.gitAvailable() ? gitNames : []),
        ...(source.githubAvailable() ? githubNames : []),
      ];
    },
    closeConnection(connId) { terminal.closeConnection(connId); browser.closeConnection(connId); },
    close() {
      if (askTimer) clearTimer(askTimer);
      askTimer = null;
      for (const request of asks.values()) requests.cancel(request.ref);
      asks.clear(); terminal.close(); browser.close();
    },
  };
}
