import crypto from "node:crypto";

import { createQaGrants } from "../qa-grants.js";
import { hostError } from "./errors.js";

const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const scopes = (value) => Array.isArray(value)
  ? [...new Set(value.filter((item) => typeof item === "string" && item.length > 0 && item.length <= 200))]
  : [];

export function createHostLeaseStore({ now = Date.now } = {}) {
  const leases = new Map();
  const qaGrants = createQaGrants({ now });

  function grant(identity, input = {}) {
    if (input.fixTree || input.repo) return qaGrants.approve(input, identity.session);
    if (!identity.run) throw hostError("RUN_DENIED", "실행기 lease에는 QA 회차가 필요합니다.");
    if (typeof input.executor !== "string" || !input.executor) {
      throw hostError("INVALID_REQUEST", "lease 실행기 식별자가 필요합니다.");
    }
    const allowed = scopes(input.scope);
    if (!allowed.length) throw hostError("INVALID_REQUEST", "lease 허용 범위가 필요합니다.");
    const requested = Number(input.expiresAt) || now() + Number(input.ttlMs || 0);
    if (!Number.isFinite(requested) || requested <= now()) {
      throw hostError("INVALID_REQUEST", "lease 만료 시각이 올바르지 않습니다.");
    }
    const expiresAt = Math.min(requested, now() + MAX_LEASE_MS);
    const id = `lease-${crypto.randomUUID()}`;
    leases.set(id, { id, session: identity.session, run: identity.run, executor: input.executor,
      scope: allowed, expiresAt });
    return { leaseId: id, executor: input.executor, scope: allowed, expiresAt };
  }

  function check(identity, input = {}) {
    if (input.renew === true) return qaGrants.renew(input, identity.session);
    if (input.forRun === true) return qaGrants.forRun(identity.session, input.repo, input.charter);
    if (input.active === true) return { active: qaGrants.active(identity.session) };
    if (!identity.run) throw hostError("RUN_DENIED", "실행기 lease에는 QA 회차가 필요합니다.");
    const lease = leases.get(String(input.leaseId || ""));
    if (!lease) throw hostError("NOT_FOUND", "lease를 찾지 못했습니다.");
    if (lease.expiresAt <= now()) {
      leases.delete(lease.id);
      throw hostError("NOT_FOUND", "lease가 만료되었습니다.");
    }
    if (lease.session !== identity.session || lease.run !== identity.run) {
      throw hostError("RUN_DENIED", "이 회차의 lease가 아닙니다.");
    }
    const needed = scopes(input.scope);
    if (needed.some((item) => !lease.scope.includes(item))) {
      throw hostError("RUN_DENIED", "lease 허용 범위를 벗어났습니다.");
    }
    return { leaseId: lease.id, executor: lease.executor, scope: lease.scope,
      allowed: needed.length ? needed : lease.scope, expiresAt: lease.expiresAt };
  }

  function revoke(identity, input = {}) {
    if (input.fixTree) return qaGrants.end(input, identity.session);
    if (!identity.run) throw hostError("RUN_DENIED", "실행기 lease에는 QA 회차가 필요합니다.");
    const lease = leases.get(String(input.leaseId || ""));
    if (!lease) return { revoked: false };
    if (lease.session !== identity.session || lease.run !== identity.run) {
      throw hostError("RUN_DENIED", "이 회차의 lease가 아닙니다.");
    }
    leases.delete(lease.id);
    return { revoked: true, leaseId: lease.id };
  }

  return { grant, check, revoke, size: () => leases.size };
}
