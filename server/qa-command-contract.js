const QA_ONLY_COMMANDS = new Set(["run", "row", "journal", "expect", "report"]);

export function ordinaryCommandDenied(command) {
  const name = String(command || "");
  return name.startsWith("qa-") || QA_ONLY_COMMANDS.has(name);
}

export function sanitizeBrowserArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith("_") || ["entry", "qa", "qaRunId", "channel", "internal", "run", "runId"].includes(key)) continue;
    clean[key] = value;
  }
  return clean;
}
