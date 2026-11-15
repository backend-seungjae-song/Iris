import { projectError, projectMediaImage, projectTranscript } from "../projection.js";

export function createTranscriptOperations(options) {
  const transcripts = options.transcripts;
  const send = options.send;

  function page(entry, message) {
    const result = transcripts.page(entry.connId, message.agent, message.before);
    if (!result.ok) return projectError(result.error, message.rid);
    return projectTranscript({ rid: message.rid, agent: message.agent, items: result.items, before: result.before });
  }

  function watch(entry, message) {
    const result = transcripts.watch(entry.connId, message.agent, (projected) => send(entry.connId, projected));
    return result.ok ? null : projectError(result.error, message.rid);
  }

  function image(_entry, message) {
    const result = transcripts.image(message.media, message.offset);
    if (!result.ok) return projectError(result.error, message.rid);
    return projectMediaImage({ rid: message.rid, mime: result.mime, size: result.size, offset: result.offset, data: result.data });
  }

  return { page, watch, image };
}
