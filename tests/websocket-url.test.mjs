import test from "node:test";
import assert from "node:assert/strict";
import { resolveWebSocketUrl } from "../src/services/websocket-url.ts";

test("replaces configured localhost with page 127.0.0.1, preserving port and path", () => {
  assert.equal(resolveWebSocketUrl("ws://localhost:8081/ws", "http:", "127.0.0.1"), "ws://127.0.0.1:8081/ws");
});

test("replaces configured 127.0.0.1 with page localhost (reverse)", () => {
  assert.equal(resolveWebSocketUrl("ws://127.0.0.1:8081/ws", "http:", "localhost"), "ws://localhost:8081/ws");
});

test("handles IPv6 ::1 on either side with brackets", () => {
  assert.equal(resolveWebSocketUrl("ws://localhost:8081/ws", "http:", "::1"), "ws://[::1]:8081/ws");
  assert.equal(resolveWebSocketUrl("ws://[::1]:8081/ws", "http:", "localhost"), "ws://localhost:8081/ws");
  assert.equal(resolveWebSocketUrl("ws://localhost:8081/ws", "http:", "[::1]"), "ws://[::1]:8081/ws");
});

test("preserves query string when swapping loopback host", () => {
  assert.equal(resolveWebSocketUrl("ws://localhost:8081/ws?room=ABC", "http:", "127.0.0.1"), "ws://127.0.0.1:8081/ws?room=ABC");
});

test("leaves external configured hosts unchanged", () => {
  assert.equal(resolveWebSocketUrl("ws://example.com:8081/ws", "http:", "localhost"), "ws://example.com:8081/ws");
  assert.equal(resolveWebSocketUrl("wss://remote.example.com:9443/ws", "https:", "127.0.0.1"), "wss://remote.example.com:9443/ws");
});

test("keeps matching loopback hosts unchanged", () => {
  assert.equal(resolveWebSocketUrl("ws://localhost:8081/ws", "http:", "localhost"), "ws://localhost:8081/ws");
  assert.equal(resolveWebSocketUrl("ws://127.0.0.1:8081/ws", "http:", "127.0.0.1"), "ws://127.0.0.1:8081/ws");
});

test("fallback uses page hostname with port 8080 and ws scheme over http", () => {
  assert.equal(resolveWebSocketUrl(undefined, "http:", "localhost"), "ws://localhost:8080/ws");
  assert.equal(resolveWebSocketUrl("", "http:", "example.com"), "ws://example.com:8080/ws");
});

test("fallback upgrades to wss over https", () => {
  assert.equal(resolveWebSocketUrl(undefined, "https:", "example.com"), "wss://example.com:8080/ws");
  assert.equal(resolveWebSocketUrl("", "https:", "127.0.0.1"), "wss://127.0.0.1:8080/ws");
});

test("fallback brackets IPv6 page hostnames", () => {
  assert.equal(resolveWebSocketUrl(undefined, "http:", "::1"), "ws://[::1]:8080/ws");
  assert.equal(resolveWebSocketUrl(undefined, "https:", "[::1]"), "wss://[::1]:8080/ws");
});