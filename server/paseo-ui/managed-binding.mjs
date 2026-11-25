import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const bindingName = (terminalId) => createHash("sha256").update(terminalId).digest("hex");
export function paneStateId(root, paneId, terminalId) {
  const key = terminalId ? "terminal:" + terminalId : paneId;
  return createHash("sha256").update(root).update("\0").update(key).digest("hex").slice(0, 32);
}

const validId = /^[a-f0-9]{32}$/;

export function bindRestoredTerminal(stateDir, terminalId) {
  const panes = path.dirname(stateDir);
  const id = path.basename(stateDir);
  if (!terminalId || path.basename(panes) !== "panes" || !validId.test(id))
    throw new Error("복원할 세션의 저장 경로와 터미널 ID를 확인할 수 없습니다");
  const root = path.dirname(path.dirname(panes));
  const original = path.join(panes, paneStateId(root, null, terminalId));
  if (original !== stateDir && fs.existsSync(original)) throw new Error("이 터미널에 이미 다른 세션이 등록되어 있습니다");
  const bindings = path.join(path.dirname(panes), "bindings");
  fs.mkdirSync(bindings, { recursive: true, mode: 0o700 });
  const link = path.join(bindings, bindingName(terminalId));
  try { fs.symlinkSync(id, link); }
  catch (error) {
    if (error.code !== "EEXIST" || fs.readlinkSync(link) !== id) throw error;
  }
}

export function restoredPaneId(root, terminalId) {
  const link = path.join(root, "paseo-ui", "bindings", bindingName(terminalId));
  try {
    const id = fs.readlinkSync(link);
    if (!validId.test(id)) throw new Error("복원된 세션 ID가 잘못되었습니다");
    return id;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return null;
}
