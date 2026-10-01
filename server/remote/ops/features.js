import { projectError, projectFeature } from "../projection.js";

const action = (rid, result = "done", extra = {}) => projectFeature({ type: "remote.action.result", rid, result, ...extra });
const failed = (result, rid) => projectError(result?.code || "unavailable", rid);

export function installFeatureOperations(table, features) {
  const terminal = features.terminal;
  table.set("terminal.watch", async (entry, message) => {
    const frame = await terminal.watch(entry, message.agent);
    return frame ? projectFeature({ type: "terminal.watch.result", rid: message.rid, agent: message.agent, ...frame })
      : projectError("forbidden", message.rid);
  });
  table.set("terminal.input", async (entry, message) => await terminal.submit(entry, message.agent, message.text)
    ? action(message.rid, "sent") : projectError("forbidden", message.rid));
  table.set("terminal.key", async (_entry, message) => await terminal.key(message.agent, message.key, message.modifiers)
    ? action(message.rid, "sent") : projectError("forbidden", message.rid));
  for (const method of ["select", "mouse"]) {
    table.set(`terminal.${method}`, async (entry, message) => {
      const result = await terminal[method](entry, message);
      return result?.ok ? action(message.rid, "sent") : failed(result, message.rid);
    });
  }
  table.set("terminal.scrollback", async (_entry, message) => {
    const result = await terminal.scrollback(message.agent);
    return result?.ok ? projectFeature({ type: "terminal.scrollback.result", rid: message.rid, agent: message.agent,
      text: result.text, columns: result.columns, lineCount: result.lineCount }) : failed(result, message.rid);
  });
  table.set("terminal.keys.get", async (_entry, message) => projectFeature({ type: "terminal.keys", rid: message.rid, ...terminal.keys() }));
  table.set("terminal.keys.set", async (_entry, message) => projectFeature({ type: "terminal.keys", rid: message.rid,
    ...terminal.setKeys(message.keys) }));

  const browser = features.browser;
  table.set("browser.tabs", async (_entry, message) => projectFeature({ type: "browser.tabs.result", rid: message.rid,
    ...browser.catalog() }));
  table.set("browser.frame.watch", async (entry, message) => {
    const result = await browser.watchFrame(entry, message);
    return result === true || result?.ok
      ? projectFeature({ type: "browser.frame.watch.result", rid: message.rid, tab: message.tab, watching: true })
      : failed(result, message.rid);
  });
  for (const [name, method] of [["browser.pointer", "pointer"], ["browser.mouse", "mouse"], ["browser.type", "type"], ["browser.key", "key"],
    ["browser.scroll", "scroll"], ["browser.history", "history"], ["browser.navigate", "navigate"]]) {
    table.set(name, async (entry, message) => { const result = await browser[method](entry, message);
      return result.ok ? action(message.rid) : failed(result, message.rid); });
  }
  table.set("browser.tab.new", async (_entry, message) => { const result = await browser.newTab(message);
    return result.ok ? action(message.rid, "done", result.tab ? { tab: result.tab } : {}) : failed(result, message.rid); });
  table.set("browser.element", async (_entry, message) => { const result = await browser.locate(message.tab, message);
    return result.ok ? projectFeature({ type: "browser.element.result", rid: message.rid, element: result.element })
      : failed(result, message.rid); });
  table.set("browser.element.hover", async (_entry, message) => { const result = await browser.hoverElement(message.tab, message);
    return result.ok ? projectFeature({ type: "browser.element.hover.result", rid: message.rid,
      viewport: result.viewport, element: result.element }) : failed(result, message.rid); });
  const draft = (rid, value) => projectFeature({ type: "browser.draft.result", rid,
    ref: value.ref, kind: value.kind, summary: value.summary, content: value.display });
  table.set("browser.element.pick", async (entry, message) => { const result = await browser.pickElement(entry, message);
    return result.ok ? draft(message.rid, result.draft) : failed(result, message.rid); });
  table.set("browser.element.send", async (entry, message) => { const result = await browser.sendElement(entry, message);
    return result.ok ? draft(message.rid, result.draft) : failed(result, message.rid); });
  table.set("browser.focus", async (_entry, message) => { const result = await browser.focus(message.tab);
    return result.ok ? projectFeature({ type: "browser.focus.result", rid: message.rid, ...result.focus })
      : failed(result, message.rid); });
  table.set("browser.dialog", async (_entry, message) => { const result = await browser.dialog(message);
    return result.ok ? projectFeature({ type: "browser.dialog.result", rid: message.rid, dialog: result.dialog })
      : failed(result, message.rid); });
  table.set("browser.record.start", async (entry, message) => {
    const record = browser.recordStart(entry, message.tab);
    return record ? projectFeature({ type: "browser.record.result", rid: message.rid, state: "recording", steps: record.steps,
      elapsedMs: record.elapsedMs })
      : projectError("forbidden", message.rid);
  });
  table.set("browser.record.pause", async (entry, message) => {
    const record = browser.recordPause(entry, message.paused);
    return record ? projectFeature({ type: "browser.record.result", rid: message.rid,
      state: message.paused ? "paused" : "recording", steps: record.steps, elapsedMs: record.elapsedMs }) : projectError("invalid-request", message.rid);
  });
  table.set("browser.record.finish", async (entry, message) => {
    const record = await browser.recordFinish(entry, message.agent, message.note);
    return record?.ok ? draft(message.rid, record.draft)
      : projectError(record?.code || (record ? "unavailable" : "invalid-request"), message.rid);
  });
  table.set("browser.sketch.send", async (entry, message) => { const result = await browser.sendSketch(entry, message);
    return result.ok ? draft(message.rid, result.draft) : failed(result, message.rid); });
  table.set("browser.draft.remove", async (entry, message) => { const result = browser.removeDraft(entry, message);
    return result.ok ? action(message.rid) : failed(result, message.rid); });
  table.set("browser.profiles", async (_entry, message) => projectFeature({ type: "browser.profiles.result",
    rid: message.rid, profiles: browser.profiles() }));
  table.set("browser.profile.set", async (_entry, message) => { const result = browser.setProfile(message);
    return result.ok ? action(message.rid, result.changed ? "done" : "unchanged") : failed(result, message.rid); });
  table.set("browser.desktop", async (_entry, message) => { const result = await browser.desktop(message);
    return result.ok ? action(message.rid) : failed(result, message.rid); });
  table.set("browser.translate", async (_entry, message) => { const result = await browser.translate(message);
    return result.ok ? action(message.rid) : failed(result, message.rid); });
  table.set("browser.bookmarks", async (_entry, message) => {
    const bookmarks = browser.bookmarks(message.space);
    return bookmarks ? projectFeature({ type: "browser.bookmarks.result", rid: message.rid, bookmarks })
      : projectError("forbidden", message.rid);
  });
  table.set("browser.bookmark.set", async (_entry, message) => { const result = browser.setBookmark(message);
    return result.ok ? action(message.rid, result.changed ? "done" : "unchanged") : failed(result, message.rid); });
  table.set("browser.direct", async (_entry, message) => { const result = browser.direct(message);
    return result.ok ? action(message.rid, result.changed ? "done" : "unchanged") : failed(result, message.rid); });

  const source = features.source;
  table.set("git.changes", async (_entry, message) => { const result = await source.status(message.agent);
    return result.ok ? projectFeature({ type: "git.changes.result", rid: message.rid, ...result.data }) : failed(result, message.rid); });
  table.set("git.diff", async (_entry, message) => { const result = await source.diff(message);
    return result.ok ? projectFeature({ type: "git.diff.result", rid: message.rid, file: message.file,
      patch: result.patch.text, truncated: result.patch.truncated }) : failed(result, message.rid); });
  table.set("git.diff.draft", async (_entry, message) => { const result = await source.diffDraft(message);
    return result.ok ? action(message.rid, "sent") : failed(result, message.rid); });
  table.set("github.pr", async (_entry, message) => { const result = await source.pr(message.agent);
    return result.ok ? projectFeature({ type: "github.pr.result", rid: message.rid, pr: result.pr }) : failed(result, message.rid); });
  table.set("github.check.log", async (_entry, message) => { const result = await source.checkLog(message.agent, message.run);
    return result.ok ? projectFeature({ type: "github.check.log.result", rid: message.rid, run: message.run,
      log: result.log.text, truncated: result.log.truncated }) : failed(result, message.rid); });
  table.set("github.check.draft", async (_entry, message) => { const result = await source.checkDraft(message);
    return result.ok ? action(message.rid, "sent") : failed(result, message.rid); });
}
