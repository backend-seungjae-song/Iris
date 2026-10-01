const ERROR_CODES = Object.freeze([
  "invalid-request",
  "unsupported-request",
  "expired",
  "forbidden",
  "busy",
  "limit-exceeded",
  "unavailable",
  "terminal-frame-too-large",
  "terminal-layout-unavailable",
  "terminal-read-unavailable",
  "terminal-stale-screen",
  "terminal-selection-unavailable",
  "terminal-mouse-unavailable",
  "browser-controller-unavailable",
  "browser-tab-unavailable",
  "browser-frame-unavailable",
  "browser-command-unavailable",
]);

const ERROR_CODE_SET = new Set(ERROR_CODES);

export function isErrorCode(value) {
  return ERROR_CODE_SET.has(value);
}
