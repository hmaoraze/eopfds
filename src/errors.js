/**
 * 统一错误类型。所有对外错误都带机器可读 code，便于验收脚本判定。
 * 原则：message 面向调用方，可安全外露；details 只放非敏感的结构化信息（字段名、状态码、计数）。
 */
export class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toPayload() {
    const error = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export const ErrorCodes = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  CONFIG_MISSING: 'CONFIG_MISSING',
  PROMPT_EMPTY: 'PROMPT_EMPTY',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EXISTS: 'SESSION_EXISTS',
  SESSION_ENDED: 'SESSION_ENDED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_BUSY: 'SESSION_BUSY',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_PARSE_ERROR: 'UPSTREAM_PARSE_ERROR',
  WECHAT_ERROR: 'WECHAT_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export function badRequest(message, details) {
  return new AppError(ErrorCodes.BAD_REQUEST, message, 400, details);
}

export function notFound(message, details) {
  return new AppError(ErrorCodes.NOT_FOUND, message, 404, details);
}
