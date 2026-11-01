"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeApiBase,
  normalizeUpdateManifestUrl,
  requireHttpsResource
} = require("../src/main/url-rules.cjs");

test("API base accepts HTTPS and loopback HTTP, strips suffixes", () => {
  assert.equal(
    normalizeApiBase("https://api.example.com/v1/chat/completions/"),
    "https://api.example.com/v1"
  );
  assert.equal(
    normalizeApiBase("https://api.example.com/v1/models"),
    "https://api.example.com/v1"
  );
  assert.equal(normalizeApiBase("http://localhost:11434/v1/"), "http://localhost:11434/v1");
  assert.equal(normalizeApiBase("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
});

test("non-loopback HTTP, credentials, query, fragment, and traversal are rejected", () => {
  for (const value of [
    "http://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://api.example.com/v1?token=x",
    "https://api.example.com/v1#x",
    "ftp://api.example.com/v1",
    "https://api.example.com/v1/../secret",
    "not a url"
  ]) {
    assert.throws(() => normalizeApiBase(value), undefined, value);
  }
});

test("update URLs are HTTPS only; empty disables custom source", () => {
  assert.equal(normalizeUpdateManifestUrl(""), "");
  assert.equal(
    normalizeUpdateManifestUrl("https://example.com/update.json"),
    "https://example.com/update.json"
  );
  assert.throws(() => normalizeUpdateManifestUrl("http://example.com/update.json"), /HTTPS/);
  assert.throws(
    () => normalizeUpdateManifestUrl("https://user:pass@example.com/update.json"),
    /用户名或密码/
  );
  assert.throws(
    () => normalizeUpdateManifestUrl("https://example.com/update.json#x"),
    /片段/
  );
  assert.equal(requireHttpsResource("https://example.com/a.json"), "https://example.com/a.json");
});
