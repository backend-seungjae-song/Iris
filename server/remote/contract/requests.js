import { hasExactKeys, isHex, isString } from "./validate.js";
import { ADVANCED_REQUEST_TYPES, hasAdvancedRequestType, isAdvancedRequest } from "./advanced-requests.js";

const RID = /^[A-Za-z0-9_-]{1,32}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,128}$/;

export const REMOTE_REQUEST_TYPES = Object.freeze([
  "caps.get",
  "ping",
  "watch",
  "transcript.page",
  "transcript.watch",
  "agent.stop",
  "agent.message",
  "request.answer",
  ...ADVANCED_REQUEST_TYPES,
]);

export function isRequestId(value) {
  return typeof value === "string" && RID.test(value);
}

function isMessageText(value) {
  if (!isString(value, 1, 4000)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function isPermissionAnswer(value) {
  return hasExactKeys(value, ["behavior"])
    && (value.behavior === "allow" || value.behavior === "deny");
}

function isQuestionAnswer(value) {
  if (!hasExactKeys(value, ["answers"]) || !Array.isArray(value.answers) || value.answers.length === 0) return false;
  return value.answers.every((answer) => {
    if (hasExactKeys(answer, ["text"])) return isString(answer.text, 1, 2000);
    return hasExactKeys(answer, ["labels"])
      && Array.isArray(answer.labels) && answer.labels.length > 0
      && answer.labels.every((label) => isString(label));
  });
}

function isAnswer(value) {
  return isPermissionAnswer(value) || isQuestionAnswer(value)
    || (hasExactKeys(value, ["choice"]) && ["done", "unable"].includes(value.choice));
}

export function isAnswerForRequest(request, answer) {
  if (request?.kind === "claude-permission") return isPermissionAnswer(answer);
  if (request?.kind === "browser-user") {
    return hasExactKeys(answer, ["choice"]) && ["done", "unable"].includes(answer.choice);
  }
  if (request?.kind !== "claude-question" || !isQuestionAnswer(answer)) return false;
  const questions = request.body?.questions;
  if (!Array.isArray(questions) || answer.answers.length !== questions.length) return false;
  return answer.answers.every((given, index) => {
    const question = questions[index];
    if (Object.hasOwn(given, "text")) return true;
    if (!question.multiSelect && given.labels.length !== 1) return false;
    const offered = new Set(question.options.map((option) => option.label));
    return new Set(given.labels).size === given.labels.length
      && given.labels.every((label) => offered.has(label));
  });
}

const validators = new Map([
  ["caps.get", (value) => hasExactKeys(value, ["type"])],
  ["ping", (value) => hasExactKeys(value, ["type", "rid"], ["active"])
    && isRequestId(value.rid) && (value.active === undefined || typeof value.active === "boolean")],
  ["watch", (value) => hasExactKeys(value, ["type", "rid"]) && isRequestId(value.rid)],
  ["transcript.page", (value) => hasExactKeys(value, ["type", "rid", "agent"], ["before"])
    && isRequestId(value.rid) && isHex(value.agent, 16)
    && (value.before === undefined || (typeof value.before === "string" && CURSOR.test(value.before)))],
  ["transcript.watch", (value) => hasExactKeys(value, ["type", "rid", "agent"])
    && isRequestId(value.rid) && isHex(value.agent, 16)],
  ["agent.stop", (value) => hasExactKeys(value, ["type", "rid", "agent"])
    && isRequestId(value.rid) && isHex(value.agent, 16)],
  ["agent.message", (value) => hasExactKeys(value, ["type", "rid", "agent", "text"], ["drafts"])
    && isRequestId(value.rid) && isHex(value.agent, 16)
    && typeof value.text === "string" && (value.text === "" || isMessageText(value.text))
    && (value.drafts === undefined || Array.isArray(value.drafts) && value.drafts.length > 0
      && value.drafts.length <= 8 && new Set(value.drafts).size === value.drafts.length
      && value.drafts.every((ref) => isHex(ref, 16)))
    && (value.text.length > 0 || value.drafts?.length > 0)],
  ["request.answer", (value) => hasExactKeys(value, ["type", "rid", "request", "answer"])
    && isRequestId(value.rid) && isHex(value.request, 16) && isAnswer(value.answer)],
]);

export function hasRemoteRequestType(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && typeof value.type === "string" && (validators.has(value.type) || hasAdvancedRequestType(value));
}

export function isRemoteRequest(value) {
  return hasRemoteRequestType(value)
    && (validators.has(value.type) ? validators.get(value.type)(value) : isAdvancedRequest(value));
}
