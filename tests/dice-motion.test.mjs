import test from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { BOARD_SURFACE_Y, DICE_NORMALS, DICE_ROLL_DURATION_MS, DICE_RELEASE_MS, DICE_FIRST_IMPACT_MS, HAND_SHAKE_START_MS, HAND_SHAKE_DURATION_MS, HAND_EXIT_MS, HAND_SCALE, HAND_THROW_START_MS, PALM_SURFACE_Y, DICE_GRIP_OFFSET, DICE_SIZE, dicePose, throwHandPose } from "../src/game/dice-motion.ts";

test("all six server results finish face-up and resting on the board", () => {
  for (let value = 1; value <= 6; value++) {
    const pose = dicePose(DICE_ROLL_DURATION_MS, value);
    const normal = DICE_NORMALS[value - 1].clone().applyQuaternion(pose.rotation);
    assert.ok(normal.distanceTo(new Vector3(0, 1, 0)) < 1e-9);
    assert.ok(Math.abs(pose.position.y - DICE_SIZE / 2 - BOARD_SURFACE_Y) < 1e-9);
    assert.equal(pose.settled, true);
  }
});

test("the tumbling die never passes through the board", () => {
  for (let value = 1; value <= 6; value++) {
    for (let time = 0; time <= DICE_ROLL_DURATION_MS; time += 20) {
      const pose = dicePose(time, value);
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        const corner = new Vector3(x, y, z).multiplyScalar(DICE_SIZE / 2 * pose.scale).applyQuaternion(pose.rotation).add(pose.position);
        assert.ok(corner.y >= BOARD_SURFACE_Y - 1e-9, `value ${value}, time ${time}`);
      }
    }
  }
});

test("a new roll of the same value replays the toss and diminishing bounces", () => {
  assert.equal(dicePose(0, 3).settled, false);
  assert.ok(dicePose(DICE_RELEASE_MS, 3).altitude > 2);
  for (const impact of [0, 420, 700, 880].map(offset => DICE_FIRST_IMPACT_MS + offset)) {
    assert.equal(dicePose(impact, 3).altitude, 0);
  }
  const bounces = [210, 560, 790].map(offset => dicePose(DICE_FIRST_IMPACT_MS + offset, 3).altitude);
  assert.ok(bounces[0] > bounces[1] && bounces[1] > bounces[2] && bounces[2] > 0);
  assert.equal(dicePose(DICE_ROLL_DURATION_MS, 3).settled, true);
});

test("the die stays in the palm until release without a position or rotation jump", () => {
  for (let time = 0; time < DICE_RELEASE_MS; time += 10) {
    const hand = throwHandPose(time);
    const die = dicePose(time, 5);
    const localPosition = die.position.clone().sub(hand.position).applyQuaternion(hand.rotation.clone().invert());
    const localRotation = hand.rotation.clone().invert().multiply(die.rotation);
    assert.equal(die.scale, hand.scale / HAND_SCALE);
    assert.ok(Math.abs(localPosition.x) <= 0.05);
    assert.ok(Math.abs(localPosition.z - DICE_GRIP_OFFSET.z * die.scale) < 1e-9);
    let lowestCorner = Infinity;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const corner = new Vector3(x, y, z).multiplyScalar(DICE_SIZE / 2 * die.scale).applyQuaternion(localRotation).add(localPosition);
      lowestCorner = Math.min(lowestCorner, corner.y);
    }
    assert.ok(lowestCorner >= PALM_SURFACE_Y * die.scale - 1e-9);
    assert.ok(lowestCorner - PALM_SURFACE_Y * die.scale < 0.03);

  }
  for (let value = 1; value <= 6; value++) {
    const before = dicePose(DICE_RELEASE_MS - 0.001, value);
    const release = dicePose(DICE_RELEASE_MS, value);
    const after = dicePose(DICE_RELEASE_MS + 0.001, value);
    assert.ok(before.position.distanceTo(release.position) < 0.001);
    assert.ok(after.position.distanceTo(release.position) < 0.001);
    assert.ok(before.rotation.angleTo(release.rotation) < 0.001);
    assert.ok(after.rotation.angleTo(release.rotation) < 0.001);
  }
});

test("the hand opens and leaves before impact, and does not return after a delayed frame", () => {
  assert.equal(throwHandPose(400).grip, 1);
  assert.equal(throwHandPose(DICE_RELEASE_MS + 90).grip, 0);
  assert.ok(HAND_EXIT_MS < DICE_FIRST_IMPACT_MS);
  assert.equal(throwHandPose(HAND_EXIT_MS).visible, false);
  assert.equal(throwHandPose(60000).visible, false);
  assert.equal(dicePose(60000, 6).settled, true);
});

test("the shake remains visible for three distinct swings before the throw", () => {
  assert.ok(HAND_SHAKE_DURATION_MS >= 1200);
  const center = throwHandPose(HAND_SHAKE_START_MS).position.x;
  const peaks = Array.from({ length: 6 }, (_, i) => throwHandPose(HAND_SHAKE_START_MS + HAND_SHAKE_DURATION_MS * (i + 0.5) / 6));
  for (let i = 0; i < peaks.length; i++) {
    assert.equal(peaks[i].visible, true);
    assert.ok(peaks[i].grip >= 0.9);
    assert.equal(peaks[i].scale, HAND_SCALE);
    assert.ok((peaks[i].position.x - center) * (i % 2 ? -1 : 1) > 0.25);
  }
  assert.ok(peaks[2].position.distanceTo(peaks[3].position) > 1.2);
  assert.ok(peaks[2].rotation.angleTo(peaks[3].rotation) > 0.5);
});

test("the larger hand holds a normal-sized die and pauses before release", () => {
  assert.ok(HAND_SCALE >= 1.6);
  assert.equal(dicePose(HAND_SHAKE_START_MS, 4).scale, 1);
  assert.ok(HAND_THROW_START_MS - HAND_SHAKE_START_MS - HAND_SHAKE_DURATION_MS >= 400);
  const pause = HAND_THROW_START_MS - 75;
  assert.ok(throwHandPose(pause).position.distanceTo(throwHandPose(pause + 50).position) < 1e-9);
  assert.equal(dicePose(pause, 4).settled, false);
  assert.equal(throwHandPose(pause).visible, true);
});
