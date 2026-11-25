// Herdr가 실행 중인 CLI의 화면과 입력을 Paseo 대화 보기에 연결

const HERDR_SCROLLBACK_LINES = 400;
const watches = new WeakMap();

export async function watchHerdrChat({ agent, herdr, onFrame, onError }) {
  const { paneId, terminalId, sessionUuid } = agent;
  const expectedProvider = String(agent.agent ?? "").toLowerCase();
  const key = JSON.stringify([paneId, terminalId, sessionUuid, expectedProvider]);
  let entries = watches.get(herdr);
  if (!entries) watches.set(herdr, entries = new Map());
  let entry = entries.get(key);
  const subscriber = { onFrame, onError };
  async function current() {
    const pane = await herdr.paneGet(paneId);
    const provider = String(pane?.agent ?? "").toLowerCase();
    if (!terminalId || !sessionUuid || !expectedProvider || pane.terminal_id !== terminalId ||
        provider !== expectedProvider ||
        pane.agent_session?.value !== sessionUuid) throw new Error("터미널의 대화 세션이 변경되었습니다");
    return pane;
  }
  if (!entry) {
    entry = { views: new Set(), frame: null, timer: null };
    entries.set(key, entry);
    async function refresh() {
      const pane = await current();
      const { text } = await herdr.paneRead(paneId, "recent", "text", true, HERDR_SCROLLBACK_LINES);
      await current();
      if (entries.get(key) !== entry) return;
      const status = pane.agent_status === "working" ? "running" : "idle";
      if (entry.frame?.status !== status || entry.text !== text) {
        entry.text = text;
        entry.frame = { status, permissions: [], controls: [], availableModes: [],
          timeline: text ? [{ type: "notification", level: "info", message: text }] : [] };
        for (const view of entry.views) view.onFrame(entry.frame);
      }
      entry.timer = setTimeout(() => refresh().catch(fail), 1000);
      entry.timer.unref?.();
    }
    function fail(error) {
      if (entries.get(key) === entry) entries.delete(key);
      for (const view of entry.views) view.onError(error);
      entry.views.clear();
    }
    entry.ready = refresh().catch(error => { fail(error); throw error; });
  }
  await entry.ready;
  if (entries.get(key) !== entry) throw new Error("대화 연결이 닫혔습니다");
  entry.views.add(subscriber);
  onFrame(entry.frame);
  return {
    async action(msg) {
      if (!entry.views.has(subscriber)) throw new Error("대화 연결이 닫혔습니다");
      await current();
      if (!entry.views.has(subscriber)) throw new Error("대화 연결이 닫혔습니다");
      if (msg.type === "agentchat.commands") return [];
      if (msg.type === "agentchat.send") {
        if (typeof msg.text !== "string" || !msg.text.trim()) throw new Error("메시지가 비어 있습니다");
        return herdr.agentSend(paneId, msg.text);
      }
      throw new Error("이 작업은 터미널에서 실행하세요");
    },
    close() {
      entry.views.delete(subscriber);
      if (!entry.views.size && entries.get(key) === entry) {
        clearTimeout(entry.timer);
        entries.delete(key);
      }
    },
  };
}
