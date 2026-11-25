import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export function createEmbeddedTimeline(dir, writeJsonFileAtomic) {
  const writes = new Map();
  const directory = (agentId) => join(dir, agentId);

  function write(agentId, action) {
    const next = (writes.get(agentId) ?? Promise.resolve()).catch(() => {}).then(action);
    writes.set(agentId, next);
    const release = () => { if (writes.get(agentId) === next) writes.delete(agentId); };
    void next.then(release, release);
    return next;
  }

  async function files(agentId) {
    await writes.get(agentId);
    const names = await readdir(directory(agentId)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    return names.filter((name) => /^\d+\.json$/.test(name)).sort((left, right) => parseInt(left, 10) - parseInt(right, 10));
  }

  const rowPath = (id, sequence) => join(directory(id), `${sequence}.json`);
  const read = (agentId, name) => readFile(join(directory(agentId), name), "utf8").then(JSON.parse);

  async function getCommittedRows(agentId) {
    const rows = [];
    for (const name of await files(agentId)) rows.push(await read(agentId, name));
    return rows;
  }

  return {
    getCommittedRows,
    async getLatestCommittedSeq(agentId) { return parseInt((await files(agentId)).at(-1) ?? "0", 10); },
    async getLastItem(agentId) {
      const name = (await files(agentId)).at(-1);
      return name ? (await read(agentId, name)).item : null;
    },
    async getLastAssistantMessage(agentId) {
      for (const name of (await files(agentId)).reverse()) {
        const { item } = await read(agentId, name);
        if (item.type === "assistant_message") return item.text;
      }
      return null;
    },
    bulkInsert(agentId, rows) {
      return write(agentId, async () => {
        for (const row of rows) await writeJsonFileAtomic(rowPath(agentId, row.seq), row);
      });
    },
    updateCommittedRow(agentId, row) {
      return write(agentId, () => writeJsonFileAtomic(rowPath(agentId, row.seq), row));
    },
    deleteAgent(agentId) {
      return write(agentId, () => rm(directory(agentId), { recursive: true, force: true }));
    },
  };
}
