import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 무인 실행기 범위(계정·대량 기입·조사 상한). 사람이 실행을 지시한 순간 만들고 승인 창은 띄우지 않음(사용자 결정 P148)
// 실행기 수명 동안 같은 세션·수정 worktree 의 회차 시작에 재사용. 서버 메모리에만 보관
// 실행기가 비정상 종료해도 오래 남지 않도록 짧은 임대로 두고 실행기가 갱신
const MAX_HOURS = 24;
export const QA_GRANT_LEASE_MS = 30 * 60000;
const resolved = value => { const full = path.resolve(value); try { return fs.realpathSync(full); } catch { return full; } };
const names = value => Array.isArray(value) && value.every(item => typeof item === "string" && item.trim()) ? value.map(item => item.trim()) : null;

export function createQaGrants({ now = Date.now } = {}) {
  const grants = new Map();
  const live = grant => grant && grant.leaseUntil > now() && grant.expiresAt > now();
  const own = (args, session) => {
    const grant = grants.get(typeof args.fixTree === "string" ? resolved(args.fixTree) : "");
    // 승인 id 는 실행기만 받음. 세션 문자열만으로 남의 승인을 갱신·종료하지 못하게 필수
    return grant && grant.session === session && typeof args.grant === "string" && grant.id === args.grant ? grant : null;
  };
  return {
    async approve(args, session) {
      if (!session) throw new Error("세션 식별자가 필요합니다.");
      if (typeof args.fixTree !== "string" || !path.isAbsolute(args.fixTree)) throw new Error("fixTree: 수정 worktree 절대 경로가 필요합니다.");
      if (typeof args.repo !== "string" || !args.repo.trim()) throw new Error("repo: 제품 저장소 경로가 필요합니다.");
      const logins = names(args.logins ?? []);
      if (!logins) throw new Error("logins: 계정 이름 목록이 필요합니다.");
      if (args.bulkFill !== undefined && typeof args.bulkFill !== "boolean") throw new Error("bulkFill: true 또는 false");
      const limit = args.investigationLimitMin ?? 10, hours = args.hours ?? 12;
      if (!Number.isFinite(limit) || limit <= 0) throw new Error("investigationLimitMin: 0보다 큰 분");
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) throw new Error(`hours: 0보다 크고 ${MAX_HOURS} 이하`);
      const grant = { id: "grant-" + crypto.randomUUID(), session, fixTree: resolved(args.fixTree), repo: args.repo,
        logins, bulkFill: args.bulkFill === true, investigationLimitMin: limit, approvedAt: now(),
        leaseUntil: now() + QA_GRANT_LEASE_MS, expiresAt: now() + hours * 3600000 };
      grants.set(grant.fixTree, grant);
      return { grant: grant.id, expiresAt: new Date(grant.expiresAt).toISOString(), leaseMs: QA_GRANT_LEASE_MS };
    },
    renew(args, session) {
      const grant = own(args, session);
      if (!live(grant)) return { renewed: false };
      grant.leaseUntil = Math.min(grant.expiresAt, now() + QA_GRANT_LEASE_MS);
      return { renewed: true, leaseUntil: new Date(grant.leaseUntil).toISOString() };
    },
    end(args, session) {
      const grant = own(args, session);
      if (!grant) return { ended: false };
      grants.delete(grant.fixTree);
      return { ended: true };
    },
    // 회차 시작 요청이 승인 범위 안인지 확인. 승인이 없으면 null
    forRun(session, repo, charter) {
      const grant = grants.get(resolved(repo));
      if (!live(grant) || grant.session !== session) return null;
      const approvals = charter.approvals || { logins: [], bulkFill: false };
      const extra = (approvals.logins || []).filter(login => !grant.logins.includes(login));
      if (extra.length) throw new Error(`시작 승인에 없는 계정: ${extra.join(", ")}. 승인 계정: ${grant.logins.join(", ") || "없음"}`);
      if (approvals.bulkFill && !grant.bulkFill) throw new Error("시작 승인에서 대량 기입을 허용하지 않았습니다.");
      if (charter.investigationLimitMin !== undefined && charter.investigationLimitMin > grant.investigationLimitMin)
        throw new Error(`조사 상한은 시작 승인의 ${grant.investigationLimitMin}분 이하로 둡니다.`);
      return grant;
    },
    active(session) { return [...grants.values()].some(grant => live(grant) && grant.session === session); },
  };
}
