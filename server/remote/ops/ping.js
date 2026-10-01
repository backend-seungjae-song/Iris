import { projectPong } from "../projection.js";

export function handlePing(_entry, message) {
  return projectPong(message.rid);
}
