export class HostApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "HostApiError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details && typeof options.details === "object" ? options.details : {};
  }
}

export function hostError(code, message, options) {
  return new HostApiError(code, message, options);
}

export function hostErrorShape(error) {
  if (error instanceof HostApiError) {
    return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  return {
    code: "INTERNAL",
    message: "host API 연산을 끝내지 못했습니다.",
    retryable: false,
    details: {},
  };
}
