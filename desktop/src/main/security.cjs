"use strict";

/*
 * Trust and navigation rules. Everything here is pure so the boundary can be
 * tested without booting Electron.
 */

const APP_SCHEME = "app";
const TRUSTED_MAIN_URL = "app://bundle/index.html";
const TRUSTED_ORIGIN = "app://bundle";
const APP_ID = "cn.pingjianganlan.study.desktop";

const RELEASE_DOWNLOAD_PREFIX =
  "https://github.com/cymarlboro/pingjiang-anlan/releases/download/";

// The renderer is served from the app:// bundle protocol with this header. It
// cannot load or connect to any remote origin; all networking stays in main.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

function isTrustedFrameUrl(url, isSubframe) {
  return isSubframe !== true && typeof url === "string" && url === TRUSTED_MAIN_URL;
}

function isTrustedWebContentsUrl(url) {
  return typeof url === "string" && url === TRUSTED_MAIN_URL;
}

function isHttpsUrl(raw) {
  if (typeof raw !== "string" || !raw || /[\u0000-\u0020\u007f]/.test(raw)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    Boolean(parsed.hostname) &&
    !parsed.username &&
    !parsed.password &&
    (parsed.port === "" || parsed.port === "443")
  );
}

/**
 * Only the public GitHub release download prefix may be handed to the OS
 * browser. No credentials, no other hosts, no redirects through query tricks.
 */
function isAllowedReleaseUrl(raw) {
  if (!isHttpsUrl(raw)) {
    return false;
  }
  const parsed = new URL(raw);
  if (parsed.hostname !== "github.com" || parsed.hash) {
    return false;
  }
  if (!parsed.pathname.startsWith(RELEASE_DOWNLOAD_PREFIX.slice("https://github.com".length))) {
    return false;
  }
  return parsed.href.startsWith(RELEASE_DOWNLOAD_PREFIX);
}

function classifyNavigation(raw) {
  if (typeof raw !== "string" || !raw) {
    return { action: "block" };
  }
  if (raw === TRUSTED_MAIN_URL) {
    return { action: "allow" };
  }
  if (isAllowedReleaseUrl(raw)) {
    return { action: "external", url: new URL(raw).href };
  }
  return { action: "block" };
}

/** Returns a fixed message for IPC/sender failures; never reflects event data. */
function senderRejectionReason(frame, sender, mainWebContents) {
  if (!frame) {
    return "missing-frame";
  }
  if (frame.parent !== null && frame.parent !== undefined) {
    return "subframe";
  }
  if (!isTrustedWebContentsUrl(frame.url)) {
    return "untrusted-url";
  }
  if (!mainWebContents || sender !== mainWebContents) {
    return "wrong-webcontents";
  }
  if (typeof sender.getURL === "function" && sender.getURL() !== TRUSTED_MAIN_URL) {
    return "wrong-webcontents-url";
  }
  return "";
}

module.exports = {
  APP_SCHEME,
  APP_ID,
  TRUSTED_MAIN_URL,
  TRUSTED_ORIGIN,
  RELEASE_DOWNLOAD_PREFIX,
  CONTENT_SECURITY_POLICY,
  isTrustedFrameUrl,
  isTrustedWebContentsUrl,
  isHttpsUrl,
  isAllowedReleaseUrl,
  classifyNavigation,
  senderRejectionReason
};
