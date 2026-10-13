"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferGeometry, CatmullRomCurve3, Color, Float32BufferAttribute, Group, Vector3 } from "three";
import { throwHandPose, type DiceRoll } from "./dice-motion";

const SKIN = "#e9b087";
const FINGERS = [
  { x: -0.43, z: -0.48, lengths: [0.31, 0.24, 0.18], radius: 0.125, splay: -0.09 },
  { x: -0.145, z: -0.56, lengths: [0.36, 0.27, 0.2], radius: 0.137, splay: -0.025 },
  { x: 0.145, z: -0.54, lengths: [0.33, 0.25, 0.19], radius: 0.128, splay: 0.04 },
  { x: 0.405, z: -0.43, lengths: [0.25, 0.19, 0.16], radius: 0.105, splay: 0.15 },
];

// A continuous loft joins the broad knuckles to a narrower wrist and forearm.
// Each section is [z, centerX, halfWidth, upperSurface, lowerSurface].
const PALM_SECTIONS = [
  [-0.71, 0, 0.03, 0.02, -0.02], [-0.64, 0, 0.43, 0.105, -0.12],
  [-0.48, 0, 0.58, 0.17, -0.19], [-0.12, -0.015, 0.62, 0.24, -0.2],
  [0.2, -0.025, 0.56, 0.225, -0.2], [0.48, -0.015, 0.41, 0.185, -0.18],
  [0.76, 0, 0.285, 0.15, -0.15], [1.02, 0, 0.29, 0.155, -0.16],
  [1.4, 0, 0.35, 0.19, -0.2], [1.9, 0, 0.4, 0.23, -0.24],
];

function makePalm() {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  const sides = 40, steps = 6;
  const base = new Color(SKIN), blush = new Color("#d89a7b");
  for (let i = 0; i < (PALM_SECTIONS.length - 1) * steps + 1; i++) {
    const section = Math.min(PALM_SECTIONS.length - 2, Math.floor(i / steps));
    const t = Math.min(1, (i - section * steps) / steps);
    const eased = t * t * (3 - 2 * t);
    const a = PALM_SECTIONS[section]!, b = PALM_SECTIONS[section + 1]!;
    const z = a[0]! + (b[0]! - a[0]!) * t;
    const values = a.map((v, j) => v + (b[j]! - v) * eased);
    for (let ring = 0; ring <= sides; ring++) {
      const angle = ring / sides * Math.PI * 2;
      const sin = Math.sin(angle), cos = Math.cos(angle);
      const y = sin >= 0 ? values[3]! * sin : -values[4]! * sin;
      positions.push(values[1]! + cos * values[2]!, y, z);
      const color = base.clone().lerp(blush, Math.max(0, sin) * 0.12 + Math.abs(cos) * 0.07);
      colors.push(color.r, color.g, color.b);
      if (i > 0 && ring < sides) {
        const n = i * (sides + 1) + ring, previous = n - sides - 1;
        indices.push(previous, previous + 1, n, n, previous + 1, n + 1);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function SkinMaterial() {
  return <meshPhysicalMaterial color={SKIN} roughness={0.57} clearcoat={0.035} clearcoatRoughness={0.8} />;
}

function Crease({ points, radius = 0.006 }: { points: [number, number, number][]; radius?: number }) {
  const curve = useMemo(() => new CatmullRomCurve3(points.map(p => new Vector3(...p))), [points]);
  return <mesh>
    <tubeGeometry args={[curve, 16, radius, 5, false]} />
    <meshStandardMaterial color="#b6775e" transparent opacity={0.28} roughness={0.9} depthWrite={false} />
  </mesh>;
}

// Tapered phalanges overlap at the joints, with softer pads and a thin dorsal nail.
function Phalanx({ length, radius, nail = false }: { length: number; radius: number; nail?: boolean }) {
  return <group>
    <mesh position={[0, 0, -length / 2]} rotation={[-Math.PI / 2, 0, 0]} scale={[1, 1, 0.85]} castShadow receiveShadow>
      <cylinderGeometry args={[radius * 0.87, radius, length, 20]} /><SkinMaterial />
    </mesh>
    {[0, -length].map((z, i) => <mesh key={z} position={[0, 0, z]} scale={[1, 0.85, 1]} castShadow receiveShadow>
      <sphereGeometry args={[radius * (i ? 0.88 : 1), 20, 12]} /><SkinMaterial />
    </mesh>)}
    {nail ? <group>
      <mesh position={[0, -radius * 0.79, -length * 0.6]} scale={[radius * 0.7, 0.014, length * 0.43]}>
        <sphereGeometry args={[1, 20, 12]} /><meshPhysicalMaterial color="#f1c6b5" roughness={0.36} clearcoat={0.2} />
      </mesh>
      <mesh position={[0, -radius * 0.81, -length * 0.33]} scale={[radius * 0.45, 0.009, length * 0.13]}>
        <sphereGeometry args={[1, 16, 8]} /><meshStandardMaterial color="#f5d7c4" roughness={0.55} />
      </mesh>
    </group> : <Crease points={[[-radius * 0.65, radius * 0.65, -0.025], [0, radius * 0.86, -0.04], [radius * 0.65, radius * 0.65, -0.025]]} radius={0.004} />}
  </group>;
}

// Palm faces up, fingertips point toward -Z, sleeve extends back toward +Z.
export default function ThrowingHand({ roll, reduced }: { roll?: DiceRoll | null; reduced: boolean }) {
  const wrist = useRef<Group>(null);
  const joints = useRef<(Group | null)[]>([]);
  const thumb = useRef<Group>(null);
  const thumbTip = useRef<Group>(null);
  const palm = useMemo(makePalm, []);
  useEffect(() => () => palm.dispose(), [palm]);
  useFrame(() => {
    if (!wrist.current) return;
    const pose = throwHandPose(roll ? Date.now() - roll.startedAt : -1);
    wrist.current.visible = !reduced && !!roll && pose.visible;
    if (!wrist.current.visible) return;
    wrist.current.position.copy(pose.position);
    wrist.current.quaternion.copy(pose.rotation);
    wrist.current.scale.setScalar(pose.scale);
    FINGERS.forEach((finger, i) => {
      const root = joints.current[i * 3], middle = joints.current[i * 3 + 1], tip = joints.current[i * 3 + 2];
      if (root) {
        root.rotation.x = 0.08 + pose.grip * (1.27 + (i === 3 ? 0.12 : 0));
        root.rotation.y = finger.splay * (1 - pose.grip * 0.7);
      }
      if (middle) middle.rotation.x = 0.06 + pose.grip * 0.59;
      if (tip) tip.rotation.x = 0.04 + pose.grip * 0.56;
    });
    if (thumb.current) thumb.current.rotation.set(0.15 + pose.grip * 0.6, 0.7 - pose.grip * 1.25, -0.12);
    if (thumbTip.current) thumbTip.current.rotation.x = 0.1 + pose.grip * 0.8;
  });
  return <group ref={wrist} visible={false}>
    <mesh geometry={palm} castShadow receiveShadow>
      <meshPhysicalMaterial vertexColors roughness={0.57} clearcoat={0.035} clearcoatRoughness={0.8} />
    </mesh>
    <mesh position={[-0.34, 0.035, 0.18]} rotation={[0, -0.35, -0.16]} scale={[0.26, 0.19, 0.39]} castShadow receiveShadow>
      <sphereGeometry args={[1, 24, 16]} /><SkinMaterial />
    </mesh>
    <Crease points={[[-0.43, 0.16, -0.26], [-0.19, 0.215, -0.25], [0.09, 0.235, -0.15], [0.39, 0.18, -0.11]]} />
    <Crease points={[[-0.21, 0.223, -0.21], [-0.1, 0.241, -0.02], [-0.14, 0.215, 0.23], [-0.25, 0.168, 0.39]]} />
    <Crease points={[[-0.19, 0.13, 0.72], [0, 0.154, 0.73], [0.19, 0.13, 0.72]]} radius={0.004} />
    <mesh position={[0, 0, 1.93]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.75]} castShadow>
      <capsuleGeometry args={[0.405, 0.88, 8, 24]} /><meshStandardMaterial color="#487ca2" roughness={0.92} />
    </mesh>
    <mesh position={[0, 0, 1.38]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1, 0.76]} castShadow>
      <cylinderGeometry args={[0.395, 0.41, 0.19, 32]} /><meshStandardMaterial color="#c4d4de" roughness={0.92} />
    </mesh>
    {FINGERS.map(({ x, z, lengths: [proximal, middle, distal], radius }, i) => <group key={i} ref={node => { joints.current[i * 3] = node; }} position={[x, 0.035, z]}>
      <Phalanx length={proximal!} radius={radius} />
      <group ref={node => { joints.current[i * 3 + 1] = node; }} position={[0, 0, -proximal!]}>
        <Phalanx length={middle!} radius={radius * 0.88} />
        <group ref={node => { joints.current[i * 3 + 2] = node; }} position={[0, 0, -middle!]}>
          <Phalanx length={distal!} radius={radius * 0.76} nail />
        </group>
      </group>
    </group>)}
    <group ref={thumb} position={[-0.49, 0.04, 0.17]}>
      <Phalanx length={0.34} radius={0.17} />
      <group ref={thumbTip} position={[0, 0, -0.34]}>
        <Phalanx length={0.26} radius={0.145} nail />
      </group>
    </group>
  </group>;
}
