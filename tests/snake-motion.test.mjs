import test from "node:test";
import assert from "node:assert/strict";
import { snakeBodyMotion, snakeExpression } from "../src/game/snake-motion.ts";

test("idle snakes preserve tile endpoints and stay close to their route", () => {
  for (let index = 0; index < 4; index++) for (let time = 0; time < 15; time += 0.13) {
    assert.equal(snakeBodyMotion(0, time, index).sideways, 0);
    assert.ok(Math.abs(snakeBodyMotion(1, time, index).sideways) < 1e-9);
    assert.ok(Math.abs(snakeBodyMotion(1, time, index).lift + 0.2) < 1e-9);
    for (let u = 0; u <= 1; u += 0.02) {
      const pose = snakeBodyMotion(u, time, index);
      assert.ok(Math.abs(pose.sideways) <= 0.066);
      assert.ok(pose.lift >= -0.201 && pose.lift <= 0.23);
    }
  }
});

test("snakes blink and flick tongues at different times, with bounded expressions", () => {
  let blink = false, tongue = false, independent = false;
  for (let time = 0; time < 10; time += 0.05) {
    const a = snakeExpression(time, 0), b = snakeExpression(time, 1);
    assert.ok(a.blink >= 0.059 && a.blink <= 1);
    assert.ok(a.tongue >= 0 && a.tongue <= 1);
    blink ||= a.blink < 0.2;
    tongue ||= a.tongue > 0.8;
    independent ||= Math.abs(a.blink - b.blink) > 0.5;
  }
  assert.ok(blink && tongue && independent);
});

test("reduced motion keeps the friendly pose fully still", () => {
  for (const time of [0, 0.1, 2.4, 10, 100]) {
    assert.deepEqual(snakeExpression(time, 2, true), snakeExpression(0, 2, true));
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      assert.deepEqual(snakeBodyMotion(u, time, 2, true), snakeBodyMotion(u, 0, 2, true));
    }
  }
});
