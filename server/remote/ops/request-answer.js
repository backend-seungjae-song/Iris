import { isAnswerForRequest } from "../contract/requests.js";
import { projectAnswerResult, projectError } from "../projection.js";

export function createRequestAnswerOperation(options) {
  const requests = options.requests;

  return async function handleRequestAnswer(_entry, message) {
    const request = requests.get(message.request);
    if (request?.status === "pending" && !isAnswerForRequest(request, message.answer)) {
      return projectError("invalid-request", message.rid);
    }
    const result = await requests.answer(message.request, message.answer);
    return projectAnswerResult(message.rid, result);
  };
}
