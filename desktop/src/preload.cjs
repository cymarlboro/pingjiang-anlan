"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/*
 * The only renderer-facing native surface. No ipcRenderer, fs, path, shell,
 * clipboard, or arbitrary channel is exposed. Both functions are frozen and
 * the main process independently re-validates the sender on every call.
 */
const AndroidBridge = Object.freeze({
  platform: "windows",
  getBootstrap() {
    try {
      const value = ipcRenderer.sendSync("bridge:get-bootstrap");
      return typeof value === "string" ? value : "{}";
    } catch {
      return "{}";
    }
  },

  request(id, method, payloadJson) {
    if (typeof id !== "string" || id.length < 1 || id.length > 200) {
      return;
    }
    if (typeof method !== "string" || method.length < 1 || method.length > 80) {
      return;
    }
    if (typeof payloadJson !== "string" || payloadJson.length > 24 * 1024 * 1024) {
      return;
    }
    // Method names (including cloudVerifyOtp/cloudResendSignup) are validated
    // against the main-process BridgeService allowlist. This preload only
    // enforces the transport shape and never forwards arbitrary IPC channels.
    ipcRenderer.send("bridge:request", id, method, payloadJson);
  }
});

contextBridge.exposeInMainWorld("AndroidBridge", AndroidBridge);
