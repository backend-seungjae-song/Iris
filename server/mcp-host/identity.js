import crypto from "node:crypto";

import { hostError } from "./errors.js";

const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096;
const digest = (value) => crypto.createHash("sha256").update(value).digest();
const sameDigest = (left, value) => {
  const right = digest(value);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export function createHostIdentityAuthority() {
  const sessions = new Set();
  const runs = new Map();
  const candidates = new Map();

  function allowSession(session) {
    if (!text(session)) throw hostError("INVALID_REQUEST", "세션 식별자가 올바르지 않습니다.");
    sessions.add(session);
    return session;
  }

  function denySession(session) {
    sessions.delete(String(session));
    for (const [run, binding] of runs) if (binding.session === session) runs.delete(run);
  }

  function bindRun({ session, run, key }) {
    if (!sessions.has(session)) throw hostError("SESSION_DENIED", "허용된 세션이 아닙니다.");
    if (!text(run) || !text(key)) throw hostError("INVALID_REQUEST", "회차 식별값과 key가 필요합니다.");
    const previous = runs.get(run);
    if (previous && previous.session !== session) {
      throw hostError("RUN_DENIED", "다른 세션에 결속된 QA 회차입니다.");
    }
    const revision = (previous?.revision || 0) + 1;
    runs.set(run, { session, keyDigest: digest(key), revision });
    return { session, run, revision };
  }

  function releaseRun({ session, run }) {
    const binding = runs.get(String(run));
    if (!binding || binding.session !== session) return false;
    runs.delete(String(run));
    return true;
  }

  function bindingFor(run) {
    const binding = runs.get(String(run));
    return binding ? { session: binding.session, revision: binding.revision } : null;
  }

  function allowCandidate({ commandId, session, run, key }) {
    if (!text(commandId) || !sessions.has(session) || !text(run) || !text(key)) {
      throw hostError("INVALID_REQUEST", "회차 이어받기 후보 식별값이 올바르지 않습니다.");
    }
    candidates.set(commandId, { session, run, keyDigest: digest(key) });
  }

  function clearCandidate(commandId) {
    return candidates.delete(String(commandId));
  }

  function authorize(identity, requirements = [], context = {}) {
    const id = identity && typeof identity === "object" && !Array.isArray(identity) ? identity : {};
    if (requirements.includes("session")) {
      if (!text(id.session) || !sessions.has(id.session)) {
        throw hostError("SESSION_DENIED", "이 세션의 host API 요청이 아닙니다.");
      }
    }
    if (requirements.includes("run") || requirements.includes("key")) {
      const binding = text(id.run) ? runs.get(id.run) : null;
      const candidate = candidates.get(context.commandId);
      const candidateMatches = candidate?.session === id.session && candidate?.run === id.run
        && text(id.key) && sameDigest(candidate.keyDigest, id.key);
      if ((!binding || binding.session !== id.session) && !candidateMatches) {
        throw hostError("RUN_DENIED", "이 세션의 QA 회차가 아닙니다.");
      }
      if (requirements.includes("key") && (!text(id.key) || (!(binding && sameDigest(binding.keyDigest, id.key)) && !candidateMatches))) {
        throw hostError("KEY_DENIED", "현재 QA 도구 연결의 key가 아닙니다.");
      }
    }
    return { session: id.session, run: id.run, ...(id.lifecycle === true ? { lifecycle: true } : {}) };
  }

  return { allowSession, denySession, bindRun, rotateRunKey: bindRun, releaseRun, bindingFor,
    allowCandidate, clearCandidate, authorize };
}
