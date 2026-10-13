import { Euler, Matrix4, Quaternion, Vector3 } from "three";

export const HAND_SHAKE_START_MS = 600;
export const HAND_SHAKE_DURATION_MS = 2100;
export const HAND_THROW_START_MS = 3150;
export const DICE_RELEASE_MS = 3500;
export const HAND_EXIT_MS = DICE_RELEASE_MS + 400;
export const DICE_FIRST_IMPACT_MS = DICE_RELEASE_MS + 550;
export const DICE_ROLL_DURATION_MS = DICE_FIRST_IMPACT_MS + 1000;
export const DICE_SIZE = 1.05;
export const BOARD_SURFACE_Y = 1.39;
export const HAND_SCALE = 2.4;
export const PALM_SURFACE_Y = 0.24 * HAND_SCALE;
export const DICE_GRIP_OFFSET = new Vector3(0, PALM_SURFACE_Y + DICE_SIZE / 2 + 0.025, -0.1 * HAND_SCALE);
export const DICE_NORMALS = [
  new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0),
];
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };

export function diceRestRotation(value: number) {
  const face = DICE_NORMALS[Math.max(0, Math.min(5, value - 1))]!;
  return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.28)
    .multiply(new Quaternion().setFromUnitVectors(face, new Vector3(0, 1, 0)));
}

function shakeMotion(t: number) {
  const progress = clamp((t - HAND_SHAKE_START_MS) / HAND_SHAKE_DURATION_MS);
  const envelope = smooth(progress * 6) * smooth((1 - progress) * 6);
  return { swing: Math.sin(progress * Math.PI * 6) * envelope, lift: Math.cos(progress * Math.PI * 6) * envelope };
}

// A single timeline drives the wrist, fingers and held die, including on replay.
export function throwHandPose(elapsedMs: number) {
  const t = Math.max(0, elapsedMs);
  const enter = smooth(t / 480);
  const toss = smooth((t - HAND_THROW_START_MS) / (DICE_RELEASE_MS - HAND_THROW_START_MS));
  const retreat = smooth((t - DICE_RELEASE_MS) / (HAND_EXIT_MS - DICE_RELEASE_MS));
  const { swing: shake, lift } = shakeMotion(t);
  const windup = smooth((t - HAND_SHAKE_START_MS - HAND_SHAKE_DURATION_MS) / 300) * (1 - toss);
  const position = new Vector3(7.8, 3.2, 10).lerp(new Vector3(1.8, 4.1, 2.5), enter);
  position.add(new Vector3(-1.1 * toss + 0.85 * shake, 0.35 * toss + 0.42 * lift + 0.2 * windup, -1.9 * toss + 0.65 * shake + 0.35 * windup));
  position.lerp(new Vector3(8.5, 3, 10.5), retreat);
  return {
    position,
    rotation: new Quaternion().setFromEuler(new Euler(0.08 + 0.4 * shake - 0.18 * windup - 0.25 * toss, -0.3 + 0.14 * shake, -0.12 + 0.32 * shake + 0.08 * toss)),
    grip: (1 - 0.05 * Math.abs(shake)) * (1 - smooth((t - (DICE_RELEASE_MS - 50)) / 140)),
    scale: HAND_SCALE * smooth(t / 160) * (1 - smooth((t - (HAND_EXIT_MS - 150)) / 150)),
    visible: elapsedMs >= 0 && elapsedMs < HAND_EXIT_MS,
  };
}

function heldDicePose(elapsedMs: number) {
  const hand = throwHandPose(elapsedMs);
  const visibility = hand.scale / HAND_SCALE;
  const { swing, lift } = shakeMotion(elapsedMs);
  const rattle = new Quaternion().setFromEuler(new Euler(0.12 * swing, 0.1 * lift, -0.1 * swing));
  const grip = DICE_GRIP_OFFSET.clone();
  grip.x += 0.045 * swing;
  grip.y += supportHeight(rattle) - DICE_SIZE / 2;
  return {
    position: grip.multiplyScalar(visibility).applyQuaternion(hand.rotation).add(hand.position),
    rotation: hand.rotation.clone().multiply(rattle),
    scale: visibility,
  };
}

function supportHeight(rotation: Quaternion) {
  const matrix = new Matrix4().makeRotationFromQuaternion(rotation).elements;
  return DICE_SIZE / 2 * (Math.abs(matrix[1]!) + Math.abs(matrix[5]!) + Math.abs(matrix[9]!));
}

// The server owns the result. After release, gravity and diminishing bounces
// present that result; support height keeps every rotated corner above the board.
export function dicePose(elapsedMs: number, value: number) {
  if (elapsedMs < DICE_RELEASE_MS) {
    const held = heldDicePose(Math.max(0, elapsedMs));
    return { ...held, altitude: held.position.y - BOARD_SURFACE_Y - supportHeight(held.rotation) * held.scale, settled: false };
  }
  const elapsed = Math.min(DICE_ROLL_DURATION_MS, elapsedMs);
  const t = (elapsed - DICE_RELEASE_MS) / 1000;
  const release = heldDicePose(DICE_RELEASE_MS);
  const flight = clamp((elapsed - DICE_RELEASE_MS) / (DICE_FIRST_IMPACT_MS - DICE_RELEASE_MS));
  const bounceTime = (elapsed - DICE_FIRST_IMPACT_MS) / 1000;
  let altitude = 0;
  if (elapsed < DICE_FIRST_IMPACT_MS) {
    const startHeight = release.position.y - BOARD_SURFACE_Y - supportHeight(release.rotation);
    altitude = startHeight * (1 - flight) + 3.6 * flight * (1 - flight);
  } else if (bounceTime < 0.42) altitude = 13 * bounceTime * (0.42 - bounceTime);
  else if (bounceTime < 0.7) altitude = 13 * (bounceTime - 0.42) * (0.7 - bounceTime);
  else if (bounceTime < 0.88) altitude = 13 * (bounceTime - 0.7) * (0.88 - bounceTime);
  const tumble = release.rotation.clone().multiply(new Quaternion().setFromEuler(new Euler(t * 12, t * 9, t * 7)));
  const rotation = tumble.slerp(diceRestRotation(value), smooth((elapsed - DICE_FIRST_IMPACT_MS - 400) / 480));
  const position = release.position.clone().lerp(new Vector3(-1.8, 0, -3.2), flight);
  const slide = 0.3 * smooth((elapsed - DICE_FIRST_IMPACT_MS) / 880);
  position.x -= slide;
  position.z -= slide;
  position.y = BOARD_SURFACE_Y + supportHeight(rotation) + altitude;
  return { position, rotation, altitude, scale: 1, settled: elapsedMs >= DICE_ROLL_DURATION_MS };
}

export type DiceRoll = { id: string; value: number; startedAt: number };
