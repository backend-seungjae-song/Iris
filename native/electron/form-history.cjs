// 입력 기록의 프로필 세션 preload, 저장소, 신뢰 렌더러 IPC
const { createFormHistoryStore } = require("./form-history-store.cjs");

function initCapability(ctx) {
  const store = createFormHistoryStore(ctx.openPartitionStore("form-history.enc"));

  const registered = new WeakSet();
  const preload = require.resolve("./form-history-preload.cjs");
  function register(partition) {
    if (!ctx.isProfilePartition(partition)) return;
    const session = ctx.sessionFromPartition(partition);
    if (registered.has(session)) return;
    session.registerPreloadScript({ type: "frame", filePath: preload });
    registered.add(session);
  }
  ctx.onSessionHardened(register);
  const ready = ctx.app.whenReady().then(() => ctx.forEachHardened(register));

  function acceptsGuest(event, partition, wcId) {
    if (!Number.isSafeInteger(wcId) || wcId <= 0) return false;
    const guest = ctx.webContents.fromId(wcId);
    return !!guest && !guest.isDestroyed() && guest.id === wcId && guest.getType() === "webview"
      && guest.hostWebContents === event.sender && guest.session === ctx.sessionFromPartition(partition)
      && !ctx.aiDriving(wcId);
  }

  function handle(channel, operation, rejected, requiresGuest = false) {
    ctx.ipcMain.handle(channel, (event, partition, ...args) => {
      if (!ctx.isTrustedSender(event)) return rejected;
      if (typeof partition !== "string" || !ctx.isProfilePartition(partition)) return rejected;
      if (requiresGuest && !acceptsGuest(event, partition, args.pop())) return rejected;
      return operation(partition, ...args);
    });
  }
  handle("ac-form-history-query", store.query, [], true);
  handle("ac-form-history-add", store.add, false, true);
  handle("ac-form-history-remove", store.remove, false);
  return { ready };
}

module.exports = { initCapability };
