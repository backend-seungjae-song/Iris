// QA 회차의 서버 메모리 소유권
const owners = new Map();
export const qaOwner = (tab) => owners.get(String(tab)) || null;
export function claimQaTabIfFree(tab, runId) {
  const target = String(tab);
  const owner = owners.get(target) || null;
  if (owner) return { target, owner, claimed: false };
  const claimedBy = String(runId);
  owners.set(target, claimedBy);
  return { target, owner: claimedBy, claimed: true };
}
export function claimQaTab(tab, runId) {
  const result = claimQaTabIfFree(tab, runId);
  if (!result.claimed) throw new Error("이미 QA 회차가 소유한 탭입니다.");
}
export function releaseQaTabIfOwner(tab, runId) {
  const target = String(tab);
  const owner = owners.get(target) || null;
  if (owner !== runId) return { target, owner, released: false };
  owners.delete(target);
  return { target, owner: null, released: true };
}
export function releaseQaTab(tab, runId) {
  const result = releaseQaTabIfOwner(tab, runId);
  if (!result.released) throw new Error("QA 탭 소유권이 다릅니다.");
}
export { sanitizeBrowserArgs } from "./qa-command-contract.js";
