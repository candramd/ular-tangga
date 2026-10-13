import test from "node:test";
import assert from "node:assert/strict";
import { readStoredSetting, resolveQuality, resolveReducedMotion } from "../src/services/settings.ts";

function mockStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
  };
}

test("readStoredSetting migrates legacy key to namespaced key", () => {
  const storage = mockStorage({ quality: "low" });
  const v = readStoredSetting("adventure-quality", "quality", storage);
  assert.equal(v, "low");
  assert.equal(storage.getItem("adventure-quality"), "low");
  assert.equal(storage.getItem("quality"), null);
});

test("readStoredSetting prefers namespaced key over legacy", () => {
  const storage = mockStorage({ "adventure-quality": "high", quality: "low" });
  const v = readStoredSetting("adventure-quality", "quality", storage);
  assert.equal(v, "high");
  assert.equal(storage.getItem("quality"), "low");
});

test("readStoredSetting returns null when no key exists", () => {
  const storage = mockStorage();
  const v = readStoredSetting("adventure-quality", "quality", storage);
  assert.equal(v, null);
});

test("readStoredSetting catches storage errors and returns null", () => {
  const badStorage = {
    getItem: () => { throw new Error("Storage unavailable"); },
    setItem: () => { throw new Error("Storage unavailable"); },
    removeItem: () => {},
  };
  const v = readStoredSetting("adventure-quality", "quality", badStorage);
  assert.equal(v, null);
});

test("resolveQuality returns saved value when valid", () => {
  assert.equal(resolveQuality("low", 1920), "low");
  assert.equal(resolveQuality("high", 1920), "high");
});

test("resolveQuality falls back to width-based default on invalid value", () => {
  assert.equal(resolveQuality("invalid", 1920), "high");
  assert.equal(resolveQuality("invalid", 500), "low");
});

test("resolveQuality falls back to width-based default when no stored value", () => {
  assert.equal(resolveQuality(null, 1920), "high");
  assert.equal(resolveQuality(null, 500), "low");
});

test("resolveReducedMotion returns saved boolean string", () => {
  assert.equal(resolveReducedMotion("true", false), true);
  assert.equal(resolveReducedMotion("false", true), false);
});

test("resolveReducedMotion falls back to OS preference on invalid value", () => {
  assert.equal(resolveReducedMotion("garbage", true), true);
  assert.equal(resolveReducedMotion("garbage", false), false);
});

test("resolveReducedMotion falls back to OS preference when no stored value", () => {
  assert.equal(resolveReducedMotion(null, true), true);
  assert.equal(resolveReducedMotion(null, false), false);
});
