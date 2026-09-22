function allBlocks(archives) {
  return Object.values(archives || {}).flatMap((entries) => Array.isArray(entries) ? entries : [])
    .flatMap((entry) => Array.isArray(entry?.blocks) ? entry.blocks : []);
}

export function appendMemoArchiveBlock(archives, {
  space, date, at, clock, text, name = "", requestId = "", id,
} = {}) {
  if (!archives || typeof archives !== "object") throw new TypeError("archives object required");
  space = String(space || ""); date = String(date || ""); text = String(text || "");
  if (!space || !date || !text.trim()) return { changed: false, empty: !text.trim() };
  if (requestId) {
    const existing = allBlocks(archives).find((block) => block.requestId === requestId);
    if (existing) return { changed: false, duplicate: true, block: existing };
  }
  const list = Array.isArray(archives[space]) ? archives[space] : (archives[space] = []);
  let entry = list.find((item) => item?.date === date);
  if (!entry) { entry = { date, blocks: [], at, rev: 0 }; list.push(entry); }
  if (!Array.isArray(entry.blocks)) {
    entry.blocks = [{ id: `legacy-${date}`, at: entry.at || at, clock: "", text: String(entry.text || "") }];
  }
  const block = {
    id: String(id || `b${Number(at || Date.now()).toString(36)}`),
    at: Number(at) || Date.now(),
    clock: String(clock || ""),
    text,
    ...(String(name || "").trim() ? { name: String(name).trim() } : {}),
    ...(requestId ? { requestId: String(requestId) } : {}),
  };
  entry.blocks.push(block);
  entry.at = block.at; entry.rev = entry.blocks.length;
  list.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { changed: true, entry, block };
}

