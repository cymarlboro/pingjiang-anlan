"use strict";

const { UserError } = require("./errors.cjs");
const { requestOnce } = require("./http-request.cjs");

const PROJECT_URL = "https://rzqzvhvydmqhtcuovcco.supabase.co";
const PROJECT_HOST = "rzqzvhvydmqhtcuovcco.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_dh3MpDvuiQFvq3aY7Z_N0A_7q-_Zch_";

const TOKEN_PASSWORD_PATH = "/auth/v1/token?grant_type=password";
const TOKEN_REFRESH_PATH = "/auth/v1/token?grant_type=refresh_token";
const SIGNUP_PATH = "/auth/v1/signup";
const VERIFY_PATH = "/auth/v1/verify";
const RESEND_PATH = "/auth/v1/resend";
const USER_PATH = "/auth/v1/user";
const LOGOUT_PATH = "/auth/v1/logout?scope=local";
const ALLOWED_PATHS = new Set([
  TOKEN_PASSWORD_PATH,
  TOKEN_REFRESH_PATH,
  SIGNUP_PATH,
  VERIFY_PATH,
  RESEND_PATH,
  USER_PATH,
  LOGOUT_PATH
]);

const CONNECT_TIMEOUT_MS = 15000;
const READ_TIMEOUT_MS = 20000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_EMAIL_CHARS = 254;
const MAX_PASSWORD_CHARS = 1024;
const MAX_TOKEN_CHARS = 16 * 1024;
const MIN_OTP_DIGITS = 6;
const MAX_OTP_DIGITS = 10;
const OTP_PATTERN = /^[0-9]{6,10}$/;
const REFRESH_SKEW_MS = 120000;
const DEFAULT_SESSION_MS = 3600000;
const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NETWORK_ERROR = "无法连接云端，请检查网络后重试";
const SERVICE_ERROR = "云端服务暂时不可用，请稍后再试";
const RESPONSE_ERROR = "云端响应异常，请稍后重试";
const INVALID_SESSION_ERROR = "登录已失效，请重新登录";
const KEEP_SESSION_NETWORK_ERROR = "无法连接云端，已保留本机登录信息";
const SIGNOUT_REVOKE_ERROR = "已退出本机登录，但云端会话撤销未完成，请稍后重试";
const STORAGE_ERROR = "系统安全存储不可用，云端会话无法保存或读取";

class NetworkFailure extends Error {}
class InvalidSession extends Error {}

/**
 * Fixed, renderer-safe authentication failures used by main-process cloud
 * services. They extend UserError so publicError() never exposes internals.
 */
class AuthRequiredError extends UserError {}
class AuthNetworkError extends UserError {}

function computeConfigured() {
  try {
    const url = new URL(PROJECT_URL);
    return PUBLISHABLE_KEY.startsWith("sb_publishable_") &&
      PUBLISHABLE_KEY.length > 30 &&
      url.protocol === "https:" &&
      url.hostname === PROJECT_HOST &&
      (url.port === "" || url.port === "443") &&
      !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === "" || url.pathname === "/");
  } catch {
    return false;
  }
}
const CONFIGURED = computeConfigured();

function isUsableToken(token) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS) {
    return false;
  }
  for (const character of token) {
    const code = character.codePointAt(0);
    if (code <= 0x20 || code === 0x7f || /\s/.test(character)) {
      return false;
    }
  }
  return true;
}

function tokenValue(value) {
  return typeof value === "string" ? value : "";
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function isPlausibleEmail(email) {
  return typeof email === "string" && email.length > 0 &&
    email.length <= MAX_EMAIL_CHARS && EMAIL_PATTERN.test(email);
}

function parseObject(body) {
  if (typeof body !== "string" || !body) {
    return null;
  }
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function errorCode(body) {
  const object = parseObject(body);
  if (!object) {
    return "";
  }
  for (const key of ["error_code", "error", "code", "msg", "message"]) {
    const value = object[key];
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized && normalized.length <= 200) {
        return normalized.replace(/ /g, "_").replace(/-/g, "_");
      }
    }
  }
  return "";
}

function isSuccess(status) {
  return status >= 200 && status < 300;
}

function expiresAt(source) {
  const now = Date.now();
  let value = Number(source.expires_at) || 0;
  if (value > 0) {
    if (value < 100_000_000_000) {
      value *= 1000;
    }
    if (value > now && value <= now + MAX_SESSION_MS) {
      return value;
    }
  }
  let expiresIn = Number(source.expires_in) || 0;
  if (expiresIn <= 0 || expiresIn > MAX_SESSION_MS / 1000) {
    expiresIn = DEFAULT_SESSION_MS / 1000;
  }
  return now + expiresIn * 1000;
}

class CloudAuth {
  constructor({ sessionStore, http = requestOnce }) {
    this.sessionStore = sessionStore;
    this.http = http;
  }

  baseStatus() {
    return {
      configured: CONFIGURED,
      loggedIn: false,
      userId: "",
      email: "",
      needsEmailConfirmation: false
    };
  }

  pendingStatus(email) {
    const result = this.baseStatus();
    result.email = isPlausibleEmail(email) ? email : "";
    result.needsEmailConfirmation = true;
    return result;
  }

  statusFromState(state) {
    const result = this.baseStatus();
    if (!isUsableToken(state.access_token)) {
      return result;
    }
    result.loggedIn = true;
    result.userId = stringValue(state.user_id);
    result.email = isPlausibleEmail(state.email) ? state.email : "";
    result.needsEmailConfirmation = false;
    return result;
  }

  cachedStatus(state, error) {
    const result = this.statusFromState(state);
    if (error) {
      result.error = error;
    }
    return result;
  }

  failureStatus(error) {
    const result = this.baseStatus();
    if (error) {
      result.error = error;
    }
    return result;
  }

  async loadSession() {
    try {
      return await this.sessionStore.load();
    } catch {
      throw new UserError(STORAGE_ERROR);
    }
  }

  async saveSession(state) {
    if (state.password !== undefined || state.new_password !== undefined) {
      throw new UserError("云端会话不能保存密码");
    }
    try {
      await this.sessionStore.save(JSON.stringify(state));
    } catch (error) {
      throw error instanceof UserError ? error : new UserError(STORAGE_ERROR);
    }
  }

  async clearSession() {
    try {
      await this.sessionStore.clear();
    } catch {
      // A failed clear must not be reported as a successful local logout.
      throw new UserError("本机云端会话清除失败");
    }
  }

  pinnedEndpoint(pathAndQuery) {
    if (!ALLOWED_PATHS.has(pathAndQuery)) {
      throw new UserError("云端账户请求不合法");
    }
    let url;
    try {
      url = new URL(`${PROJECT_URL}${pathAndQuery}`);
    } catch {
      throw new UserError("云端账户地址无效");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== PROJECT_HOST ||
      (url.port !== "" && url.port !== "443") ||
      url.username || url.password || url.hash
    ) {
      throw new UserError("云端账户地址不安全");
    }
    return url.href;
  }

  async request(method, pathAndQuery, body, accessToken) {
    if (!CONFIGURED) {
      throw new UserError("云端账户尚未配置");
    }
    const url = this.pinnedEndpoint(pathAndQuery);
    let serialized = null;
    if (body !== null && body !== undefined) {
      serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
        throw new UserError("云端请求内容过大");
      }
    }
    const headers = {
      Accept: "application/json",
      apikey: PUBLISHABLE_KEY
    };
    if (serialized !== null) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    if (accessToken !== null && accessToken !== undefined) {
      if (!isUsableToken(accessToken)) {
        throw new UserError(INVALID_SESSION_ERROR);
      }
      // Only /user and /logout are called with an access token.
      if (pathAndQuery !== USER_PATH && pathAndQuery !== LOGOUT_PATH) {
        throw new UserError("云端账户请求不合法");
      }
      headers.Authorization = `Bearer ${accessToken}`;
    }
    let response;
    try {
      response = await this.http({
        method,
        url,
        headers,
        body: serialized,
        timeoutMs: Math.max(CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS),
        maxBytes: MAX_RESPONSE_BYTES
      });
    } catch {
      throw new NetworkFailure();
    }
    if (response.status >= 300 && response.status < 400) {
      throw new NetworkFailure();
    }
    return response;
  }

  sessionFromTokenResponse(body, fallbackEmail, fallbackUserId, fallbackRefreshToken) {
    const root = parseObject(body);
    if (!root) {
      return null;
    }
    const nested = root.session && typeof root.session === "object" ? root.session : null;
    const source = nested && isUsableToken(nested.access_token) ? nested : root;
    const accessToken = tokenValue(source.access_token);
    if (!isUsableToken(accessToken)) {
      return null;
    }
    let refreshToken = tokenValue(source.refresh_token);
    if (!isUsableToken(refreshToken)) {
      refreshToken = isUsableToken(fallbackRefreshToken) ? fallbackRefreshToken : "";
    }
    const sourceUser = source.user && typeof source.user === "object" ? source.user : null;
    const rootUser = root.user && typeof root.user === "object" ? root.user : null;
    const user = sourceUser || rootUser;
    let userId = user ? stringValue(user.id).trim() : "";
    if (!userId) {
      userId = fallbackUserId;
    }
    let email = user ? stringValue(user.email).trim() : "";
    if (!email) {
      email = fallbackEmail;
    }
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt(source),
      user_id: userId.length <= 128 ? userId : "",
      email: isPlausibleEmail(email) ? email : (isPlausibleEmail(fallbackEmail) ? fallbackEmail : ""),
      needs_email_confirmation: false,
      pending_email: "",
      had_session: true
    };
  }

  async refreshSession(oldState) {
    const refreshToken = tokenValue(oldState.refresh_token);
    if (!isUsableToken(refreshToken)) {
      throw new InvalidSession();
    }
    let response;
    try {
      response = await this.request("POST", TOKEN_REFRESH_PATH, { refresh_token: refreshToken }, null);
    } catch (error) {
      if (error instanceof NetworkFailure) {
        throw error;
      }
      throw new UserError(error instanceof UserError ? error.publicMessage : RESPONSE_ERROR);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new InvalidSession();
    }
    if (response.status === 429) {
      throw new UserError("操作过于频繁，请稍后再试");
    }
    if (!isSuccess(response.status)) {
      throw new UserError(SERVICE_ERROR);
    }
    const state = this.sessionFromTokenResponse(
      response.body,
      oldState.email,
      oldState.user_id,
      refreshToken
    );
    if (!state) {
      throw new UserError(RESPONSE_ERROR);
    }
    return state;
  }

  async fetchUser(accessToken) {
    let response;
    try {
      response = await this.request("GET", USER_PATH, null, accessToken);
    } catch (error) {
      if (error instanceof NetworkFailure) {
        throw error;
      }
      throw new UserError(error instanceof UserError ? error.publicMessage : RESPONSE_ERROR);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new InvalidSession();
    }
    if (response.status === 429) {
      throw new UserError("请求过于频繁，请稍后再试");
    }
    if (!isSuccess(response.status)) {
      throw new UserError(SERVICE_ERROR);
    }
    const user = parseObject(response.body);
    if (!user) {
      throw new UserError(RESPONSE_ERROR);
    }
    const id = stringValue(user.id).trim();
    if (!id || id.length > 128) {
      throw new UserError(RESPONSE_ERROR);
    }
    return user;
  }

  applyServerUser(state, user) {
    const userId = stringValue(user.id).trim();
    const email = stringValue(user.email).trim();
    if (userId && userId.length <= 128) {
      state.user_id = userId;
    }
    if (isPlausibleEmail(email)) {
      state.email = email;
    }
    state.needs_email_confirmation = false;
    state.pending_email = "";
  }

  async status() {
    if (!CONFIGURED) {
      return this.baseStatus();
    }
    let state;
    try {
      state = await this.loadSession();
    } catch (error) {
      return this.failureStatus(error instanceof UserError ? error.publicMessage : STORAGE_ERROR);
    }
    if (!state) {
      return this.baseStatus();
    }
    if (state.needs_email_confirmation === true && !isUsableToken(state.access_token)) {
      return this.pendingStatus(state.pending_email || state.email);
    }
    if (!isUsableToken(state.access_token)) {
      try {
        await this.clearSession();
      } catch {
        // Report the session as invalid even if clearing is retried next time.
      }
      return this.failureStatus(INVALID_SESSION_ERROR);
    }
    let refreshToken = tokenValue(state.refresh_token);
    if ((Number(state.expires_at) || 0) <= Date.now() + REFRESH_SKEW_MS) {
      if (!isUsableToken(refreshToken)) {
        try { await this.clearSession(); } catch { /* best effort */ }
        return this.failureStatus(INVALID_SESSION_ERROR);
      }
      try {
        state = await this.refreshSession(state);
        await this.saveSession(state);
        refreshToken = tokenValue(state.refresh_token);
      } catch (error) {
        if (error instanceof NetworkFailure) {
          return this.cachedStatus(state, KEEP_SESSION_NETWORK_ERROR);
        }
        if (error instanceof InvalidSession) {
          try { await this.clearSession(); } catch { /* best effort */ }
          return this.failureStatus(INVALID_SESSION_ERROR);
        }
        return this.cachedStatus(state, error instanceof UserError ? error.publicMessage : RESPONSE_ERROR);
      }
    }
    try {
      const user = await this.fetchUser(tokenValue(state.access_token));
      this.applyServerUser(state, user);
      await this.saveSession(state);
      return this.statusFromState(state);
    } catch (error) {
      if (error instanceof InvalidSession) {
        if (!isUsableToken(refreshToken)) {
          try { await this.clearSession(); } catch { /* best effort */ }
          return this.failureStatus(INVALID_SESSION_ERROR);
        }
        try {
          state = await this.refreshSession(state);
          await this.saveSession(state);
          const user = await this.fetchUser(tokenValue(state.access_token));
          this.applyServerUser(state, user);
          await this.saveSession(state);
          return this.statusFromState(state);
        } catch (refreshError) {
          if (refreshError instanceof NetworkFailure) {
            return this.cachedStatus(state, KEEP_SESSION_NETWORK_ERROR);
          }
          if (refreshError instanceof InvalidSession) {
            try { await this.clearSession(); } catch { /* best effort */ }
            return this.failureStatus(INVALID_SESSION_ERROR);
          }
          return this.cachedStatus(
            state,
            refreshError instanceof UserError ? refreshError.publicMessage : RESPONSE_ERROR
          );
        }
      }
      if (error instanceof NetworkFailure) {
        return this.cachedStatus(state, KEEP_SESSION_NETWORK_ERROR);
      }
      return this.cachedStatus(state, error instanceof UserError ? error.publicMessage : RESPONSE_ERROR);
    }
  }

  /**
   * Main-process only credential access for cloud sync. Unlike status(), a
   * network failure never falls back to a cached identity: callers must stop.
   * The access token is returned only to trusted main-process services and must
   * never be placed in a bridge/preload result.
   */
  async verifiedCredentials() {
    if (!CONFIGURED) {
      throw new AuthRequiredError("云端账户尚未配置");
    }
    let state;
    try {
      state = await this.loadSession();
    } catch (error) {
      throw new UserError(error instanceof UserError ? error.publicMessage : STORAGE_ERROR);
    }
    if (!state) {
      throw new AuthRequiredError(INVALID_SESSION_ERROR);
    }
    if (state.needs_email_confirmation === true && !isUsableToken(state.access_token)) {
      // Keep the pending-email marker so the normal account UI can still show
      // "check your inbox"; sync simply cannot start before verification.
      throw new AuthRequiredError(INVALID_SESSION_ERROR);
    }
    if (!isUsableToken(state.access_token)) {
      try { await this.clearSession(); } catch { /* best effort */ }
      throw new AuthRequiredError(INVALID_SESSION_ERROR);
    }
    let refreshToken = tokenValue(state.refresh_token);
    if ((Number(state.expires_at) || 0) <= Date.now() + REFRESH_SKEW_MS) {
      if (!isUsableToken(refreshToken)) {
        try { await this.clearSession(); } catch { /* best effort */ }
        throw new AuthRequiredError(INVALID_SESSION_ERROR);
      }
      try {
        state = await this.refreshSession(state);
        await this.saveSession(state);
        refreshToken = tokenValue(state.refresh_token);
      } catch (error) {
        if (error instanceof NetworkFailure) {
          throw new AuthNetworkError(NETWORK_ERROR);
        }
        if (error instanceof InvalidSession) {
          try { await this.clearSession(); } catch { /* best effort */ }
          throw new AuthRequiredError(INVALID_SESSION_ERROR);
        }
        throw new UserError(error instanceof UserError ? error.publicMessage : RESPONSE_ERROR);
      }
    }
    try {
      return await this.verifySessionUser(state);
    } catch (error) {
      if (error instanceof InvalidSession) {
        if (!isUsableToken(refreshToken)) {
          try { await this.clearSession(); } catch { /* best effort */ }
          throw new AuthRequiredError(INVALID_SESSION_ERROR);
        }
        try {
          state = await this.refreshSession(state);
          await this.saveSession(state);
          return await this.verifySessionUser(state);
        } catch (refreshError) {
          if (refreshError instanceof NetworkFailure) {
            throw new AuthNetworkError(NETWORK_ERROR);
          }
          if (refreshError instanceof InvalidSession) {
            try { await this.clearSession(); } catch { /* best effort */ }
            throw new AuthRequiredError(INVALID_SESSION_ERROR);
          }
          throw new UserError(
            refreshError instanceof UserError ? refreshError.publicMessage : RESPONSE_ERROR
          );
        }
      }
      if (error instanceof NetworkFailure) {
        throw new AuthNetworkError(NETWORK_ERROR);
      }
      throw new UserError(error instanceof UserError ? error.publicMessage : RESPONSE_ERROR);
    }
  }

  async verifySessionUser(state) {
    const user = await this.fetchUser(tokenValue(state.access_token));
    this.applyServerUser(state, user);
    await this.saveSession(state);
    const userId = stringValue(state.user_id).trim();
    const accessToken = tokenValue(state.access_token);
    if (!userId || !isUsableToken(accessToken)) {
      throw new UserError(RESPONSE_ERROR);
    }
    return { accessToken, userId };
  }

  readCredentials(payload, forSignUp) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new UserError("请求参数格式错误");
    }
    if (typeof payload.email !== "string" || typeof payload.password !== "string") {
      throw new UserError("邮箱或密码格式不正确");
    }
    const email = payload.email.trim();
    const password = payload.password;
    if (!email) {
      throw new UserError("请输入邮箱");
    }
    if (email.length > MAX_EMAIL_CHARS || !EMAIL_PATTERN.test(email)) {
      throw new UserError("邮箱格式不正确");
    }
    if (!password) {
      throw new UserError("请输入密码");
    }
    if (password.length > MAX_PASSWORD_CHARS) {
      throw new UserError("密码过长");
    }
    if (forSignUp && password.length < 6) {
      throw new UserError("密码至少需要 6 位");
    }
    return { email, password };
  }

  readEmail(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new UserError("请求参数格式错误");
    }
    if (typeof payload.email !== "string") {
      throw new UserError("请输入邮箱");
    }
    const email = payload.email.trim();
    if (!email) {
      throw new UserError("请输入邮箱");
    }
    if (email.length > MAX_EMAIL_CHARS || !EMAIL_PATTERN.test(email)) {
      throw new UserError("邮箱格式不正确");
    }
    return email;
  }

  readEmailOtp(payload) {
    const email = this.readEmail(payload);
    if (typeof payload.token !== "string") {
      throw new UserError("请输入邮件中的验证码");
    }
    const token = payload.token.trim();
    if (!token) {
      throw new UserError("请输入邮件中的验证码");
    }
    if (!OTP_PATTERN.test(token)) {
      throw new UserError(`验证码应为 ${MIN_OTP_DIGITS}-${MAX_OTP_DIGITS} 位数字`);
    }
    return { email, token };
  }

  /*
   * Fixed operator guidance for the two GoTrue sending failures that users
   * actually hit while custom SMTP is disabled. Only the numeric HTTP status and
   * an explicitly allowlisted error code are included; the upstream body and
   * unknown codes are never reflected.
   */
  mailConfigurationError(status, code) {
    if (code.includes("email_address_not_authorized")) {
      return `确认邮件无法发送（HTTP ${status} / email_address_not_authorized）：` +
        "请管理员在 Supabase 配置自定义 SMTP，并检查确认邮件模板";
    }
    if (code.includes("email_send_failed")) {
      return `确认邮件发送失败（HTTP ${status} / email_send_failed）：` +
        "请管理员检查 Supabase 自定义 SMTP 和邮件服务配置";
    }
    if (status === 500 && code.includes("unexpected_failure")) {
      return "确认邮件发送异常（HTTP 500 / unexpected_failure）：" +
        "请管理员检查 Supabase 自定义 SMTP 和邮件服务配置";
    }
    return "";
  }

  signInError(status, code) {
    if (status === 429 || this.isRateLimitCode(code)) {
      return "尝试过于频繁，请稍后再试";
    }
    if (status >= 500) {
      return SERVICE_ERROR;
    }
    if (status === 400 || status === 401 || status === 403) {
      return "邮箱或密码不正确";
    }
    return "登录未完成，请稍后重试";
  }

  signUpError(status, code) {
    if (status === 429 || this.isRateLimitCode(code)) {
      return "操作过于频繁，请稍后再试";
    }
    if (this.isAlreadyRegistered(code)) {
      return "该邮箱已注册，请直接登录";
    }
    if (code.includes("weak_password")) {
      return "密码强度不足，请使用至少 6 位密码";
    }
    if (code.includes("email_address_invalid") || code.includes("validation_failed") ||
        code.includes("invalid_email")) {
      return "邮箱格式不正确";
    }
    if (code.includes("signup_disabled")) {
      return "云端注册暂未开放";
    }
    const mailError = this.mailConfigurationError(status, code);
    if (mailError) {
      return mailError;
    }
    if (status >= 500) {
      // A generic Auth/DB 500 is not evidence of a mail configuration problem.
      return SERVICE_ERROR;
    }
    return "注册信息不符合要求，请检查邮箱和密码";
  }

  verifyError(status, code) {
    if (status === 429 || this.isRateLimitCode(code)) {
      return "尝试过于频繁，请稍后再试";
    }
    if (code.includes("otp_expired") || code.includes("token_has_expired") ||
        code.includes("expired")) {
      return "验证码已过期，请重新发送确认邮件";
    }
    if (status === 400 || status === 401 || status === 403) {
      return "验证码无效或已过期，请重新发送确认邮件";
    }
    if (status >= 500) {
      return SERVICE_ERROR;
    }
    return "邮箱确认未完成，请稍后重试";
  }

  resendError(status, code) {
    if (status === 429 || this.isRateLimitCode(code)) {
      return "发送过于频繁，请稍后再试";
    }
    if (code.includes("email_address_invalid") || code.includes("invalid_email")) {
      return "邮箱格式不正确";
    }
    const mailError = this.mailConfigurationError(status, code);
    if (mailError) {
      return mailError;
    }
    if (status >= 500) {
      return SERVICE_ERROR;
    }
    return "确认邮件发送未完成，请稍后重试";
  }

  isRateLimitCode(code) {
    return code.includes("over_request_rate_limit") ||
      code.includes("over_email_send_rate_limit") ||
      code.includes("too_many_requests") ||
      code.includes("rate_limit");
  }

  isAlreadyRegistered(code) {
    return code.includes("user_already_exists") ||
      code.includes("email_exists") ||
      code.includes("already_registered");
  }

  isEmailNotConfirmed(status, code) {
    return (status === 400 || status === 401 || status === 403) &&
      (code.includes("email_not_confirmed") || code.includes("not_confirmed"));
  }

  async rememberPendingEmail(email) {
    const pending = {
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      user_id: "",
      email,
      needs_email_confirmation: true,
      pending_email: email,
      had_session: false
    };
    try {
      await this.saveSession(pending);
    } catch {
      // A non-secret pending marker failing to persist is harmless.
    }
  }

  async signIn(payload) {
    if (!CONFIGURED) {
      throw new UserError("云端账户尚未配置");
    }
    const credentials = this.readCredentials(payload, false);
    let response;
    try {
      response = await this.request("POST", TOKEN_PASSWORD_PATH, {
        email: credentials.email,
        password: credentials.password
      }, null);
    } catch (error) {
      if (error instanceof NetworkFailure) {
        throw new UserError(NETWORK_ERROR);
      }
      throw error;
    }
    const code = errorCode(response.body);
    if (!isSuccess(response.status)) {
      if (this.isEmailNotConfirmed(response.status, code)) {
        await this.rememberPendingEmail(credentials.email);
        throw new UserError("邮箱尚未确认，请查收确认邮件，或输入邮件中的验证码完成确认");
      }
      throw new UserError(this.signInError(response.status, code));
    }
    const state = this.sessionFromTokenResponse(response.body, credentials.email, "", "");
    if (!state) {
      throw new UserError(RESPONSE_ERROR);
    }
    await this.saveSession(state);
    return this.statusFromState(state);
  }

  async signUp(payload) {
    if (!CONFIGURED) {
      throw new UserError("云端账户尚未配置");
    }
    const credentials = this.readCredentials(payload, true);
    let response;
    try {
      response = await this.request("POST", SIGNUP_PATH, {
        email: credentials.email,
        password: credentials.password
      }, null);
    } catch (error) {
      if (error instanceof NetworkFailure) {
        throw new UserError(NETWORK_ERROR);
      }
      throw error;
    }
    const code = errorCode(response.body);
    if (!isSuccess(response.status)) {
      throw new UserError(this.signUpError(response.status, code));
    }
    const state = this.sessionFromTokenResponse(response.body, credentials.email, "", "");
    if (state) {
      await this.saveSession(state);
      return this.statusFromState(state);
    }
    const parsed = parseObject(response.body);
    // GoTrue REST /signup returns the user object directly when confirmation is
    // required. SDK-style wrappers are accepted for compatible deployments too.
    const pendingUser = parsed && (parsed.user || parsed);
    if (!pendingUser || typeof pendingUser !== "object" ||
        typeof pendingUser.id !== "string" || !pendingUser.id ||
        typeof pendingUser.email !== "string" ||
        pendingUser.email.toLowerCase() !== credentials.email.toLowerCase()) {
      throw new UserError(RESPONSE_ERROR);
    }
    await this.rememberPendingEmail(credentials.email);
    return this.pendingStatus(credentials.email);
  }

  /*
   * Confirms a signup OTP entered manually from the confirmation email. The
   * server-returned session is parsed with the same token-response validation as
   * sign-in; the pending marker is only replaced after a usable session exists.
   * Nothing is marked confirmed locally and no sync is started here.
   */
  async verifyOtp(payload) {
    if (!CONFIGURED) {
      throw new UserError("云端账户尚未配置");
    }
    const input = this.readEmailOtp(payload);
    let response;
    try {
      response = await this.request("POST", VERIFY_PATH, {
        email: input.email,
        token: input.token,
        type: "signup"
      }, null);
    } catch (error) {
      if (error instanceof NetworkFailure) {
        throw new UserError(NETWORK_ERROR);
      }
      throw error;
    }
    const code = errorCode(response.body);
    if (!isSuccess(response.status)) {
      throw new UserError(this.verifyError(response.status, code));
    }
    const state = this.sessionFromTokenResponse(response.body, input.email, "", "");
    if (!state) {
      throw new UserError(RESPONSE_ERROR);
    }
    await this.saveSession(state);
    return this.statusFromState(state);
  }

  /*
   * Resends the signup confirmation email. This deliberately leaves the
   * encrypted session untouched and returns only the pending email marker, so a
   * resend can never mark the account confirmed or expose a token.
   */
  async resendSignup(payload) {
    if (!CONFIGURED) {
      throw new UserError("云端账户尚未配置");
    }
    const email = this.readEmail(payload);
    let response;
    try {
      response = await this.request("POST", RESEND_PATH, {
        type: "signup",
        email
      }, null);
    } catch (error) {
      if (error instanceof NetworkFailure) {
        throw new UserError(NETWORK_ERROR);
      }
      throw error;
    }
    const code = errorCode(response.body);
    if (!isSuccess(response.status)) {
      throw new UserError(this.resendError(response.status, code));
    }
    return this.pendingStatus(email);
  }

  async signOut() {
    let revokeFailed = false;
    try {
      const state = await this.loadSession();
      if (state) {
        const accessToken = tokenValue(state.access_token);
        if (isUsableToken(accessToken)) {
          try {
            const response = await this.request("POST", LOGOUT_PATH, null, accessToken);
            if (!isSuccess(response.status) && response.status !== 401 && response.status !== 403) {
              revokeFailed = true;
            }
          } catch {
            revokeFailed = true;
          }
        }
      }
    } catch {
      revokeFailed = true;
    }
    try {
      await this.clearSession();
    } catch {
      throw new UserError("本机云端会话清除失败");
    }
    const result = this.baseStatus();
    if (revokeFailed) {
      result.error = SIGNOUT_REVOKE_ERROR;
    }
    return result;
  }
}

module.exports = {
  CloudAuth,
  AuthRequiredError,
  AuthNetworkError,
  PROJECT_URL,
  PROJECT_HOST,
  PUBLISHABLE_KEY,
  CONFIGURED,
  ALLOWED_PATHS,
  VERIFY_PATH,
  RESEND_PATH,
  isUsableToken,
  isPlausibleEmail
};
