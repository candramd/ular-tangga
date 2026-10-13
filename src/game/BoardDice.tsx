"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import { Group, Quaternion, Vector3 } from "three";
import { DICE_NORMALS, DICE_ROLL_DURATION_MS, DICE_SIZE, dicePose, type DiceRoll } from "./dice-motion";

import ThrowingHand from "./ThrowingHand";

const DOTS: [number, number][][] = [
  [[0, 0]], [[-1, 1], [1, -1]], [[-1, 1], [0, 0], [1, -1]],
  [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]],
  [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]],
];

export default function BoardDice({ roll, value = 1, reduced }: { roll?: DiceRoll | null; value?: number; reduced: boolean }) {
  const group = useRef<Group>(null);
  const invalidate = useThree(state => state.invalidate);
  const result = roll?.value || value || 1;
  const initial = useMemo(() => dicePose(DICE_ROLL_DURATION_MS, result), [result]);
  useEffect(() => { invalidate(); }, [roll?.id, result, reduced, invalidate]);
  useFrame(() => {
    if (!group.current) return;
    const elapsed = reduced || !roll ? DICE_ROLL_DURATION_MS : Date.now() - roll.startedAt;
    const pose = dicePose(elapsed, result);
    group.current.position.copy(pose.position);
    group.current.quaternion.copy(pose.rotation);
    group.current.scale.setScalar(pose.scale);
    if (!pose.settled) invalidate();
  });
  return <>
    <ThrowingHand roll={roll} reduced={reduced} />
    <group ref={group} position={initial.position} quaternion={initial.rotation}>
    <RoundedBox args={[DICE_SIZE, DICE_SIZE, DICE_SIZE]} radius={0.1} smoothness={4} castShadow receiveShadow>
      <meshStandardMaterial color="#fff8e7" roughness={0.28} metalness={0.04} />
    </RoundedBox>
    {DICE_NORMALS.map((normal, face) => <group key={face} position={normal.clone().multiplyScalar(DICE_SIZE / 2 + 0.003)}
      quaternion={new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal)}>
      {DOTS[face]!.map(([x, y], dot) => <mesh key={dot} position={[x * 0.245, y * 0.245, 0]}>
        <circleGeometry args={[face === 0 ? 0.105 : 0.078, 24]} />
        <meshStandardMaterial color={face === 0 ? "#d6503e" : "#263345"} roughness={0.6} />
      </mesh>)}
    </group>)}
  </group>
  </>;
}
