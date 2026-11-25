import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateHome } from "../state-home.cjs";
import { readEmbeddedHandoff } from "./embedded-handoff.mjs";
import { parseBuildName } from "./plan.js";

const source = "iris-embedded";
const paneStates = new Map();

export async function includeEmbeddedPanes(agents, herdr) {
  const bindings = path.join(stateHome(), "paseo-ui", "embedded-panes");
  if (!fs.existsSync(bindings)) return agents;
  const reported = new Map(agents.map(a => [a.terminal_id, a]));
  for (const pane of await herdr.paneList()) {
    const record = embeddedPane(pane.terminal_id);
    if (!record) continue;
    const agent = reported.get(pane.terminal_id);
    const ownership = record.native ? await readEmbeddedHandoff(record) : null;
    const detected = agent?.agent || pane.agent;
    if (detected && detected !== source && !ownership) continue;
    if (agent) Object.assign(agent, { agent: source, embeddedTerminalPhase: ownership?.phase });
    else agents.push({ ...pane, agent: source, agent_status: paneStates.get(pane.terminal_id) || "idle",
      embeddedTerminalPhase: ownership?.phase });
  }
  return agents;
}

function bindingFile(terminalId) {
  if (!terminalId || typeof terminalId !== "string") throw new Error("터미널 ID가 없습니다");
  const id = createHash("sha256").update(terminalId).digest("hex");
  return path.join(stateHome(), "paseo-ui", "embedded-panes", id + ".json");
}

export function embeddedPane(terminalId) {
  if (!terminalId) return null;
  try {
    const record = JSON.parse(fs.readFileSync(bindingFile(terminalId), "utf8"));
    if (record.terminalId !== terminalId || !parseBuildName(record.build)) throw new Error("대화와 터미널의 연결 정보를 확인하세요");
    return record;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function reportEmbeddedState(herdr, paneId, record, state) {
  const pane = await herdr.paneGet(paneId);
  if (pane.terminal_id !== record.terminalId) throw new Error("터미널이 변경되었습니다");
  if (await readEmbeddedHandoff(record)) return;
  paneStates.set(record.terminalId, state);
  await herdr.call("pane.report_agent", { pane_id: paneId, source, agent: source, state, agent_session_id: record.agentId });
}

export function liveEmbeddedPane(agent) {
  return agent.agent === source ? embeddedPane(agent.terminal_id) : null;
}
