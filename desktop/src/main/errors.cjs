"use strict";

/** An error whose message is already a fixed, non-sensitive user-facing string. */
class UserError extends Error {
  constructor(message, options) {
    super(String(message || "操作失败，请稍后重试"), options);
    this.name = "UserError";
    this.publicMessage = String(message || "操作失败，请稍后重试");
  }
}

const GENERIC_ERROR = "操作失败，请稍后重试";

function publicError(error) {
  return error instanceof UserError ? error.publicMessage : GENERIC_ERROR;
}

function fail(message) {
  throw new UserError(message);
}

module.exports = { UserError, GENERIC_ERROR, publicError, fail };
