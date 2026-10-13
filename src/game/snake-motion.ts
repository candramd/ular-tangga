// Idle motion stays inside the existing route; tile endpoints never drift sideways.
export function snakeBodyMotion(t: number, seconds: number, index: number, reduced = false) {
  const u = Math.max(0, Math.min(1, t));
  const phase = seconds * 1.65 + index * 1.73;
  const neck = (1 - u) ** 6;
  const tail = Math.max(0, (u - 0.78) / 0.22);
  return {
    sideways: reduced || u === 0 || u === 1 ? 0 : Math.sin(Math.PI * u) * Math.sin(phase - u * 7) * 0.065,
    lift: 0.13 * neck - 0.2 * tail * tail + (reduced ? 0 :
      0.03 * (1 + Math.sin(phase)) * neck + 0.018 * (1 + Math.sin(phase - u * 5)) * Math.sin(Math.PI * u)),
  };
}

export function snakeExpression(seconds: number, index: number, reduced = false) {
  if (reduced) return { blink: 1, tongue: 0, yaw: 0, pitch: -0.08 };
  const phase = seconds + index * 1.73;
  const blinkTime = ((phase % 4.7) + 4.7) % 4.7;
  const blink = blinkTime < 0.2 ? 1 - 0.94 * Math.sin(blinkTime / 0.2 * Math.PI) : 1;
  const tongueTime = ((phase % 6.3) + 6.3) % 6.3;
  const tongue = tongueTime > 2.1 && tongueTime < 2.65 ? Math.sin((tongueTime - 2.1) / 0.55 * Math.PI) : 0;
  return { blink, tongue, yaw: Math.sin(phase * 0.85) * 0.12, pitch: -0.08 + Math.sin(phase * 1.65) * 0.035 };
}
