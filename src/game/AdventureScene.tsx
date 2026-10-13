"use client";

import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentRef, ReactNode, RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import BoardDice from "./BoardDice";
import LivingSnake from "./LivingSnake";
import { BOARD_SURFACE_Y, DICE_RELEASE_MS, DICE_ROLL_DURATION_MS, type DiceRoll } from "./dice-motion";

export interface AdventureSceneProps {
  players?: { id: string; username: string; position: number }[];
  currentPlayerId?: string;
  totalSteps?: number;
  snakes?: Record<string, number>;
  ladders?: Record<string, number>;
  quality?: "low" | "high";
  reducedMotion?: boolean;
  focusPlayer?: boolean;
  diceRoll?: DiceRoll | null;
  diceValue?: number;
}

type Point = [number, number, number];
type Player = NonNullable<AdventureSceneProps["players"]>[number];
type Controls = ComponentRef<typeof OrbitControls>;

// All scenery, lettering, and materials are local. No fonts, models, or HDRIs load.
const C = {
  sky: "#b8ddfa", ink: "#123d39", grass: "#32996b", grassLight: "#58b778",
  grassDark: "#247c60", grassSun: "#75bc79", rock: "#bd7354", rockLight: "#dc9565",
  rockDark: "#885245", rockDeep: "#65483e", sand: "#eec46e", tile: "#ffe3a1",
  tileLight: "#fff0bf", ivory: "#fff7de", wood: "#885a38", woodLight: "#d8a45e",
  leaf: "#147767", leafLight: "#3aa678", leafSun: "#81c779", water: "#39c5ce",
  waterLight: "#b4f3ec", snake: "#ad87db", snakeLight: "#d7baf5", coral: "#ec8868",
  blue: "#487ca2", gold: "#efb843", skin: "#f5c693",
} as const;
const EMPTY_PLAYERS: Player[] = [];
const EMPTY_LINKS: Record<string, number> = {};
const OVERVIEW: Point = [0, 1.2, 0];
const CAMERA: Point = [0, 27, 22];
const FONT = "ui-rounded, 'Trebuchet MS', Arial, sans-serif";
const UP = new THREE.Vector3(0, 1, 0);

// Bound malformed inputs and excessive GPU allocations; positions are one-based.
function stepCount(value: number): number {
  return Number.isFinite(value) ? Math.max(2, Math.min(1000, Math.round(value))) : 100;
}

function heightAt(_x: number, _z: number): number { return 1; }

/** A traditional serpentine board; fractional steps interpolate along each edge. */
export function positionForStep(step: number, totalSteps = 100): Point {
  const count = stepCount(totalSteps);
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const spacing = 14 / Math.max(columns, rows);
  const value = Math.max(1, Math.min(count, Number.isFinite(step) ? step : 1));
  const cell = (n: number): Point => {
    const row = Math.floor((n - 1) / columns);
    const col = (n - 1) % columns;
    return [((row % 2 ? columns - 1 - col : col) - (columns - 1) / 2) * spacing,
      1.26, ((rows - 1) / 2 - row) * spacing];
  };
  const a = cell(Math.floor(value)), b = cell(Math.min(count, Math.ceil(value)));
  const t = value % 1;
  return [a[0] + (b[0] - a[0]) * t, a[1], a[2] + (b[2] - a[2]) * t];
}

function noise(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function Terrain({ high }: { high: boolean }) {
  const data = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const greens = [C.grass, C.grassLight, C.grassDark, C.grassSun].map(c => new THREE.Color(c));
    const rocks = [C.rock, C.rockLight, C.rockDark, C.rockDeep].map(c => new THREE.Color(c));
    let face = 0;
    function triangle(a: Point, b: Point, c: Point, palette: THREE.Color[]) {
      const color = palette[Math.floor(noise(face++) * palette.length)]!;
      positions.push(...a, ...b, ...c);
      for (let k = 0; k < 3; k++) colors.push(color.r, color.g, color.b);
    }
    const n = high ? 26 : 16;
    const rows: Point[][] = [];
    for (let j = 0; j <= n; j++) {
      const z = -9.2 + (j / n) * 18.4;
      const halfWidth = 9.1 * Math.pow(1 - Math.pow(z / 10.5, 4), 0.25);
      const row: Point[] = [];
      for (let i = 0; i <= n; i++) {
        const boundary = i === 0 || i === n || j === 0 || j === n;
        const x = -halfWidth + (i / n) * halfWidth * 2 + (boundary ? 0 : (noise(j * n + i) - 0.5) * 0.38);
        const zz = z + (boundary ? 0 : (noise(i * n + j + 72) - 0.5) * 0.28);
        row.push([x, heightAt(x, zz), zz]);
      }
      rows.push(row);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = rows[j]![i]!;
      const b = rows[j]![i + 1]!;
      const c = rows[j + 1]![i]!;
      const d = rows[j + 1]![i + 1]!;
      triangle(a, c, b, greens);
      triangle(b, c, d, greens);
    }
    const rim = [
      ...rows[0]!, ...rows.slice(1).map(row => row[n]!),
      ...rows[n]!.slice(0, n).reverse(), ...rows.slice(1, n).reverse().map(row => row[0]!),
    ];
    for (let i = 0; i < rim.length; i++) {
      const a = rim[i]!;
      const b = rim[(i + 1) % rim.length]!;
      const lipA: Point = [a[0] * 1.015, a[1] - 0.32, a[2] * 1.015];
      const lipB: Point = [b[0] * 1.015, b[1] - 0.32, b[2] * 1.015];
      const baseA: Point = [a[0] * 0.82, -1.9 - noise(i) * 0.6, a[2] * 0.82];
      const baseB: Point = [b[0] * 0.82, -1.9 - noise((i + 1) % rim.length) * 0.6, b[2] * 0.82];
      triangle(a, b, lipA, greens);
      triangle(b, lipB, lipA, greens);
      triangle(lipA, lipB, baseA, rocks);
      triangle(lipB, baseB, baseA, rocks);
      triangle(baseA, baseB, [0.8, -4.3, -0.4], [rocks[2]!, rocks[3]!]);
    }
    return { positions: new Float32Array(positions), colors: new Float32Array(colors) };
  }, [high]);

  return (
    <mesh receiveShadow castShadow>
      <bufferGeometry onUpdate={geometry => geometry.computeVertexNormals()}>
        <bufferAttribute attach="attributes-position" args={[data.positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[data.colors, 3]} />
      </bufferGeometry>
      <meshStandardMaterial vertexColors flatShading roughness={1} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Trail({ count, high }: { count: number; high: boolean }) {
  const tiles = useRef<THREE.InstancedMesh>(null);
  const points = useMemo(() => Array.from({ length: count }, (_, i) => positionForStep(i + 1, count)), [count]);

  const radius = 6.7 / Math.ceil(Math.sqrt(count));
  const [atlas, setAtlas] = useState<{ texture: THREE.CanvasTexture; positions: Float32Array; uv: Float32Array } | null>(null);
  const invalidate = useThree(state => state.invalidate);

  useLayoutEffect(() => {
    const mesh = tiles.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    points.forEach((p, i) => {
      dummy.position.set(p[0], p[1], p[2]);
      dummy.rotation.y = 0;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(["#36b8eb", "#ffd05b", "#4cc887", "#ff796a", "#b7a3e4"][(i + Math.floor(i / 10) * 2) % 5]!));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [points, count, invalidate]);

  useEffect(() => {
    const columns = Math.ceil(Math.sqrt(count));
    const cell = high ? 128 : 64;
    const canvas = document.createElement("canvas");
    canvas.width = columns * cell;
    canvas.height = Math.ceil(count / columns) * cell;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = C.ink;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const positions: number[] = [];
    const uv: number[] = [];
    const half = radius * 0.76;
    points.forEach((p, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      context.font = `800 ${cell * ((i + 1).toString().length > 2 ? 0.43 : 0.57)}px ${FONT}`;
      context.fillText(String(i + 1), (col + 0.5) * cell, (row + 0.52) * cell);
      const x = p[0], y = p[1] + 0.145, z = p[2];
      positions.push(x - half, y, z + half, x + half, y, z + half, x - half, y, z - half,
        x + half, y, z + half, x + half, y, z - half, x - half, y, z - half);
      const u0 = col / columns, u1 = (col + 1) / columns;
      const v0 = 1 - ((row + 1) * cell) / canvas.height, v1 = 1 - (row * cell) / canvas.height;
      uv.push(u0, v0, u1, v0, u0, v1, u1, v0, u1, v1, u0, v1);
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = high ? 4 : 1;
    setAtlas({ texture, positions: new Float32Array(positions), uv: new Float32Array(uv) });
    invalidate();
    return () => texture.dispose();
  }, [count, high, points, radius, invalidate]);

  return (
    <group>
      <mesh position={[0, 1.04, 0]} receiveShadow castShadow>
        <boxGeometry args={[14.7, 0.3, 14.7]} />
        <meshStandardMaterial color={C.wood} roughness={0.65} />
      </mesh>
      {[-1, 1].map(side => <group key={side}>
        <mesh position={[side * 7.25, 1.3, 0]} castShadow><boxGeometry args={[0.22, 0.35, 14.7]} /><meshStandardMaterial color={C.woodLight} /></mesh>
        <mesh position={[0, 1.3, side * 7.25]} castShadow><boxGeometry args={[14.7, 0.35, 0.22]} /><meshStandardMaterial color={C.woodLight} /></mesh>
      </group>)}
      <instancedMesh key={count} ref={tiles} args={[undefined, undefined, count]} receiveShadow castShadow>
        <boxGeometry args={[radius * 2, 0.26, radius * 2]} />
        <meshStandardMaterial roughness={0.32} metalness={0.05} />
      </instancedMesh>
      {atlas && <mesh renderOrder={2}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[atlas.positions, 3]} />
          <bufferAttribute attach="attributes-uv" args={[atlas.uv, 2]} />
        </bufferGeometry>
        <meshBasicMaterial map={atlas.texture} transparent alphaTest={0.12} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>}
    </group>
  );
}

function Beam({ start, end, radius = 0.055, color = C.woodLight }: { start: Point; end: Point; radius?: number; color?: string }) {
  const a = new THREE.Vector3(...start);
  const b = new THREE.Vector3(...end);
  const direction = b.clone().sub(a);
  return <mesh position={a.add(b).multiplyScalar(0.5)} quaternion={new THREE.Quaternion().setFromUnitVectors(UP, direction.clone().normalize())} castShadow>
    <cylinderGeometry args={[radius, radius, direction.length(), 6]} />
    <meshStandardMaterial color={color} roughness={0.95} flatShading />
  </mesh>;
}

function bridgeRoute(from: number, to: number, count: number) {
  const start = new THREE.Vector3(...positionForStep(from, count)).setY(BOARD_SURFACE_Y + 0.12);
  const end = new THREE.Vector3(...positionForStep(to, count)).setY(BOARD_SURFACE_Y + 0.12);
  const rise = Math.min(1.05, start.distanceTo(end) * 0.2);
  const peak = start.clone().lerp(end, 0.5); peak.y += rise;
  const curve = new THREE.CurvePath<THREE.Vector3>();
  curve.add(new THREE.LineCurve3(start, peak));
  curve.add(new THREE.LineCurve3(peak, end));
  return { start, end, peak, rise, curve };
}

function Ladder({ from, to, count }: { from: number; to: number; count: number }) {
  const { start, end, rise } = bridgeRoute(from, to, count);
  const delta = end.clone().sub(start);
  const length = delta.length();
  const planks = Math.max(6, Math.ceil(length / 0.32));
  // Two climbing faces and triangular side trusses stand on the same flat board.
  // The feet, horizontal ties, and center posts all touch or brace the deck.
  const deckY = (z: number) => 0.12 + (1 - Math.abs(2 * z / length - 1)) * rise;
  return <group position={[start.x, BOARD_SURFACE_Y, start.z]} rotation={[0, Math.atan2(delta.x, delta.z), 0]}>
    {[-0.36, 0.36].map(x => <group key={x}>
      <Beam start={[x, 0.07, 0]} end={[x, 0.07, length]} radius={0.065} color="#80502e" />
      <Beam start={[x, 0.12, 0]} end={[x, rise + 0.12, length / 2]} radius={0.065} color="#a56b39" />
      <Beam start={[x, rise + 0.12, length / 2]} end={[x, 0.12, length]} radius={0.065} color="#a56b39" />
      <Beam start={[x, 0.07, length / 2]} end={[x, rise + 0.12, length / 2]} radius={0.07} color="#80502e" />
      {[0, length].map(z => <mesh key={z} position={[x, 0.07, z]} castShadow receiveShadow>
        <boxGeometry args={[0.24, 0.14, 0.27]} /><meshStandardMaterial color="#795134" />
      </mesh>)}
    </group>)}
    {Array.from({ length: planks }, (_, i) => {
      const z = (i + 0.5) * length / planks;
      return <mesh key={i} position={[0, deckY(z), z]} rotation={[z < length / 2 ? -Math.atan2(rise, length / 2) : Math.atan2(rise, length / 2), 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.83, 0.1, length / planks * 0.94]} />
        <meshStandardMaterial color={i % 2 ? "#e5b677" : "#d69b5b"} roughness={0.7} />
      </mesh>;
    })}
  </group>;
}

function snakeCurve(from: number, to: number, count: number) {
  const start = new THREE.Vector3(...positionForStep(from, count));
  const end = new THREE.Vector3(...positionForStep(to, count));
  const direction = end.clone().sub(start).setY(0);
  const side = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
  const amplitude = Math.min(0.32, direction.length() * 0.065);
  const points = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16;
    const p = start.clone().lerp(end, t);
    p.addScaledVector(side, Math.sin(t * Math.PI * 3) * Math.sin(t * Math.PI) * amplitude);
    p.y = 1.65 + Math.sin(t * Math.PI) * 0.04;
    return p;
  });
  return new THREE.CatmullRomCurve3(points, false, "centripetal");
}

function Snake({ from, to, count, index, high, reduced, activeRef }: {
  from: number; to: number; count: number; index: number; high: boolean; reduced: boolean;
  activeRef: RefObject<THREE.Group | null>;
}) {
  const curve = useMemo(() => snakeCurve(from, to, count), [from, to, count]);
  return <LivingSnake curve={curve} index={index} high={high} reduced={reduced} activeRef={activeRef} />;
}

function Palm({ x, z, scale = 1, seed = 0 }: { x: number; z: number; scale?: number; seed?: number }) {
  const lean = (noise(seed) - 0.5) * 0.7;
  return <group position={[x, heightAt(x, z), z]} scale={scale} rotation={[0, noise(seed + 1) * Math.PI * 2, 0]}>
    <Beam start={[0, 0, 0]} end={[lean, 1.5, 0]} radius={0.13} color={C.wood} />
    <Beam start={[lean, 1.45, 0]} end={[lean + 0.18, 2.4, 0]} radius={0.09} color={C.woodLight} />
    <group position={[lean + 0.18, 2.35, 0]}>
      {Array.from({ length: 6 }, (_, i) => <group key={i} rotation={[0, (i / 6) * Math.PI * 2, 0]}>
        <mesh position={[0, 0.03, 0.67]} rotation={[-0.19, 0, 0]} scale={[0.3, 0.075, 1.05]} castShadow>
          <octahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={i % 2 ? C.leafLight : C.leaf} flatShading roughness={1} />
        </mesh>
        <mesh position={[0, -0.19, 1.28]} rotation={[0.45, 0, 0]} scale={[0.18, 0.06, 0.58]} castShadow>
          <octahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={C.leafSun} flatShading />
        </mesh>
      </group>)}
      <mesh position={[0.12, -0.07, 0]}><icosahedronGeometry args={[0.2, 0]} /><meshStandardMaterial color={C.gold} /></mesh>
    </group>
  </group>;
}

function Castle({ count }: { count: number }) {
  const end = positionForStep(count, count);
  const z = end[2] - 1.7;
  const y = heightAt(end[0], z);
  return <group position={[end[0], y, z]}>
    <mesh position={[0, 0.14, 0]} receiveShadow><cylinderGeometry args={[1.35, 1.55, 0.32, 8]} /><meshStandardMaterial color={C.sand} flatShading /></mesh>
    <mesh position={[0, 0.86, 0]} castShadow receiveShadow><boxGeometry args={[1.8, 1.45, 0.95]} /><meshStandardMaterial color={C.ivory} roughness={0.9} /></mesh>
    <mesh position={[0, 0.67, 0.483]}><boxGeometry args={[0.48, 0.9, 0.035]} /><meshStandardMaterial color={C.wood} /></mesh>
    <mesh position={[0, 1.1, 0.5]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.24, 0.24, 0.04, 12]} /><meshStandardMaterial color={C.wood} /></mesh>
    {[-1, 1].map(side => <group key={side} position={[side * 0.91, 0, 0]}>
      <mesh position={[0, 1.05, 0]} castShadow><cylinderGeometry args={[0.37, 0.44, 1.9, 8]} /><meshStandardMaterial color={C.ivory} roughness={1} flatShading /></mesh>
      <mesh position={[0, 2.3, 0]} castShadow><coneGeometry args={[0.56, 0.84, 6]} /><meshStandardMaterial color={C.leaf} flatShading /></mesh>
      <mesh position={[0, 1.55, 0.355]}><boxGeometry args={[0.12, 0.3, 0.03]} /><meshStandardMaterial color={C.ink} /></mesh>
      <mesh position={[0, 2.76, 0]}><sphereGeometry args={[0.085, 6, 4]} /><meshStandardMaterial color={C.gold} /></mesh>
    </group>)}
    {[-0.6, -0.2, 0.2, 0.6].map(x => <mesh key={x} position={[x, 1.69, 0.28]} castShadow><boxGeometry args={[0.22, 0.26, 0.4]} /><meshStandardMaterial color={C.ivory} /></mesh>)}
    <Beam start={[0, 1.6, -0.08]} end={[0, 3.1, -0.08]} radius={0.035} />
    <mesh position={[0.31, 2.88, -0.08]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[new Float32Array([-0.3, 0.22, 0, 0.4, 0.08, 0, -0.3, -0.2, 0]), 3]} />
      </bufferGeometry>
      <meshBasicMaterial color={C.gold} side={THREE.DoubleSide} />
    </mesh>
  </group>;
}

function Waterfall({ high }: { high: boolean }) {
  const x = 7.8, z = 3.3, y = heightAt(x, z) + 0.1;
  const ribbons = useMemo(() => Array.from({ length: high ? 5 : 3 }, (_, i) => {
    const offset = (i - (high ? 2 : 1)) * 0.14;
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, y, z + offset), new THREE.Vector3(8.75, y - 0.15, z + offset),
      new THREE.Vector3(9.18, y - 0.65, z + offset), new THREE.Vector3(9.27, -1.9, z + offset),
      new THREE.Vector3(9.48, -3.55, z + offset + 0.15),
    ]);
  }), [high, y]);
  return <group>
    <mesh position={[x - 0.1, y - 0.11, z]} scale={[1.15, 0.1, 1.25]}><icosahedronGeometry args={[1, 1]} /><meshStandardMaterial color={C.sand} flatShading /></mesh>
    <mesh position={[x - 0.1, y, z]} rotation={[-Math.PI / 2, 0, 0]} scale={[1, 1.1, 1]}>
      <circleGeometry args={[0.9, 12]} /><meshStandardMaterial color={C.water} roughness={0.3} metalness={0.12} />
    </mesh>
    {ribbons.map((curve, i) => <mesh key={i}>
      <tubeGeometry args={[curve, high ? 28 : 16, i % 2 ? 0.07 : 0.12, 5, false]} />
      <meshStandardMaterial color={i % 2 ? C.waterLight : C.water} roughness={0.35} />
    </mesh>)}
    {[0, 1, 2, 3].map(i => <mesh key={i} position={[9.45 + noise(i) * 0.3, -3.65 + noise(i + 7) * 0.45, z + (i - 1.5) * 0.27]} scale={[0.4, 0.2, 0.35]}>
      <icosahedronGeometry args={[1, 1]} /><meshStandardMaterial color={C.ivory} flatShading />
    </mesh>)}
    {[0, 1, 2].map(i => <mesh key={i} position={[x - 0.4 + i * 0.3, y + 0.012, z + (i % 2) * 0.25]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[0.16, 7]} /><meshStandardMaterial color={C.leafLight} />
    </mesh>)}
  </group>;
}

function Scenery({ high }: { high: boolean }) {
  const trees = [[-8, 5.4, 0.85], [-7.9, -0.4, 1.05], [7.9, -2.8, 0.95], [-7.5, -6.8, 0.82], [7.5, -7.2, 0.9], [5.2, 8.1, 0.75], [-2.5, -8.6, 0.62], [7.9, 0, 0.65]];
  return <group>
    {trees.slice(0, high ? trees.length : 5).map(([x, z, scale], i) => <Palm key={i} x={x!} z={z!} scale={scale!} seed={i * 11} />)}
    {Array.from({ length: high ? 24 : 12 }, (_, i) => {
      const side = i % 2 ? 1 : -1;
      const x = side * (7.3 + noise(i + 83) * 0.55);
      const z = -7.8 + noise(i + 16) * 15.4;
      if (x > 0 && z > 1.6 && z < 5) return null;
      const size = 0.18 + noise(i + 2) * 0.35;
      return <mesh key={i} position={[x, heightAt(x, z) + size * 0.25, z]} scale={[size * 1.4, size, size]} rotation={[0, i * 1.7, 0]} castShadow>
        <dodecahedronGeometry args={[1, 0]} /><meshStandardMaterial color={i % 3 ? C.rockLight : C.rockDark} flatShading roughness={1} />
      </mesh>;
    })}
    {Array.from({ length: high ? 18 : 8 }, (_, i) => {
      const x = (i % 2 ? -1 : 1) * (7.05 + noise(i) * 0.3);
      const z = -7 + noise(i + 90) * 13.5;
      return <group key={i} position={[x, heightAt(x, z), z]}>
        {[0, 1, 2].map(j => <mesh key={j} position={[(j - 1) * 0.12, 0.2, 0]} rotation={[0, j, (j - 1) * -0.5]} scale={[0.1, 0.38, 0.13]}>
          <octahedronGeometry args={[1, 0]} /><meshStandardMaterial color={j % 2 ? C.leafSun : C.leaf} flatShading />
        </mesh>)}
      </group>;
    })}
    {[[-10, -1.8, -5, 1.1], [7, -3.3, -8, 0.9], [-5, -3.7, 7, 0.65]].map(([x, y, z, scale], i) => <group key={i} position={[x!, y!, z!]} scale={scale!}>
      {[[-0.8, 0, 0.05], [0, 0.15, 0], [0.8, 0, 0], [0.25, 0.45, -0.12]].map((p, j) => <mesh key={j} position={p as Point} scale={[1.2, 0.65, 0.72]}>
        <icosahedronGeometry args={[0.9, 1]} /><meshStandardMaterial color={C.ivory} flatShading roughness={1} />
      </mesh>)}
    </group>)}
    <Waterfall high={high} />
  </group>;
}

function NameTag({ name }: { name: string }) {
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);
  const invalidate = useThree(state => state.invalidate);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 112;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = C.ivory;
    context.beginPath();
    context.roundRect(2, 2, 508, 108, 20);
    context.fill();
    context.fillStyle = C.ink;
    context.font = `700 42px ${FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const characters = Array.from(name || "Petualang");
    const label = characters.length > 16 ? `${characters.slice(0, 15).join("")}...` : characters.join("");
    context.fillText(label, 256, 58, 472);
    const next = new THREE.CanvasTexture(canvas);
    next.colorSpace = THREE.SRGBColorSpace;
    setTexture(next);
    invalidate();
    return () => next.dispose();
  }, [name, invalidate]);
  return texture ? <sprite position={[0, 1.7, 0]} scale={[1.65, 0.36, 1]} renderOrder={5}>
    <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} toneMapped={false} />
  </sprite> : null;
}

function Adventurer({ player, count, selected, slot, occupants, reduced, activeRef, snakes, ladders }: {
  player: Player; count: number; selected: boolean; slot: number; occupants: number;
  reduced: boolean; activeRef: RefObject<THREE.Group | null>;
  snakes: Record<string, number>; ladders: Record<string, number>;
}) {
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const limbs = useRef<(THREE.Group | null)[]>([]);
  const target = Math.max(1, Math.min(count, Number.isFinite(player.position) ? player.position : 1));
  const step = useRef(target);
  const previousTarget = useRef(target);
  const shortcut = useRef<{ curve: THREE.Curve<THREE.Vector3>; progress: number } | null>(null);
  const speed = useRef(5);
  const invalidate = useThree(state => state.invalidate);
  const [hovered, setHovered] = useState(false);
  let hash = 0;
  for (let i = 0; i < player.id.length; i++) hash = ((hash << 5) - hash + player.id.charCodeAt(i)) | 0;
  const color = [C.coral, C.blue, C.leaf, C.snake][Math.abs(hash) % 4]!;
  const angle = (slot / Math.max(occupants, 1)) * Math.PI * 2;
  // Keep tokens on a tile's back edge, leaving its numeral visible from overview.
  const offsetX = occupants > 1 ? Math.cos(angle) * 0.23 : 0;
  const offsetZ = occupants > 1 ? Math.sin(angle) * 0.18 - 0.17 : -0.19;

  useLayoutEffect(() => {
    const node = group.current;
    if (selected) activeRef.current = node;
    return () => { if (activeRef.current === node) activeRef.current = null; };
  }, [selected, activeRef]);

  useEffect(() => {
    const from = previousTarget.current;
    previousTarget.current = target;
    if (from !== target && (snakes[String(from)] === target || ladders[String(from)] === target)) {
      shortcut.current = { curve: snakes[String(from)] === target ? snakeCurve(from, target, count) : bridgeRoute(from, target, count).curve, progress: 0 };
    }
    speed.current = Math.max(5, Math.abs(target - step.current) / 2.4);
    invalidate();
  }, [target, count, reduced, offsetX, offsetZ, invalidate, snakes, ladders]);

  useFrame((_, delta) => {
    if (!group.current) return;
    const walking = Math.abs(target - step.current) > 0.001 || !!shortcut.current;
    limbs.current.forEach((limb, i) => {
      if (limb) limb.rotation.x = walking && !reduced ? Math.sin(step.current * Math.PI * 3 + (i % 2) * Math.PI) * 0.6 : 0;
    });
    if (shortcut.current) {
      const route = shortcut.current;
      route.progress = reduced ? 1 : Math.min(1, route.progress + Math.min(delta, 0.05) / 1.15);
      const point = route.curve.getPoint(route.progress);
      group.current.position.set(point.x + offsetX, point.y + 0.1, point.z + offsetZ);
      if (route.progress === 1) { shortcut.current = null; step.current = target; }
      invalidate();
      return;
    }
    const previous = step.current;
    const distance = target - previous;
    const moving = Math.abs(distance) > 0.001;
    step.current = reduced ? target : previous + Math.sign(distance) * Math.min(Math.abs(distance), speed.current * Math.min(delta, 0.05));
    const p = positionForStep(step.current, count);
    const bob = moving && !reduced ? Math.abs(Math.sin(step.current * Math.PI)) * 0.13 : 0;
    group.current.position.set(p[0] + offsetX, p[1] + 0.09 + bob, p[2] + offsetZ);
    if (body.current && moving && !reduced) {
      const ahead = positionForStep(step.current + Math.sign(distance) * 0.1, count);
      const heading = Math.atan2(ahead[0] - p[0], ahead[2] - p[2]);
      const turn = Math.atan2(Math.sin(heading - body.current.rotation.y), Math.cos(heading - body.current.rotation.y));
      body.current.rotation.y += turn * (1 - Math.exp(-12 * delta));
    }
    if (moving) invalidate();
  });

  const initial = positionForStep(target, count);
  return <group ref={group} position={[initial[0] + offsetX, initial[1] + 0.09, initial[2] + offsetZ]}>
    {selected && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
      <ringGeometry args={[0.25, 0.31, 24]} /><meshBasicMaterial color={C.ivory} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>}
    <group ref={body} onPointerOver={event => { event.stopPropagation(); setHovered(true); }} onPointerOut={() => setHovered(false)}>
      {[-1, 1].map((side, i) => <group key={side}>
        <group ref={node => { limbs.current[i] = node; }} position={[side * 0.13, 0.42, 0]}>
          <mesh position={[0, -0.13, 0]} castShadow><capsuleGeometry args={[0.095, 0.17, 4, 10]} /><meshStandardMaterial color="#36536e" /></mesh>
          <mesh position={[0, -0.31, 0.07]} scale={[1, 0.7, 1.5]} castShadow><sphereGeometry args={[0.12, 12, 8]} /><meshStandardMaterial color="#70462f" /></mesh>
        </group>
        <group ref={node => { limbs.current[i + 2] = node; }} position={[side * 0.27, 0.67, 0]} rotation={[0, 0, side * 0.15]}>
          <mesh position={[0, -0.08, 0]} castShadow><capsuleGeometry args={[0.08, 0.13, 4, 10]} /><meshStandardMaterial color={color} /></mesh>
          <mesh position={[0, -0.22, 0.02]}><sphereGeometry args={[0.085, 12, 8]} /><meshStandardMaterial color={C.skin} /></mesh>
        </group>
      </group>)}
      <mesh position={[0, 0.58, 0]} scale={[1, 1.1, 0.75]} castShadow><sphereGeometry args={[0.27, 16, 12]} /><meshStandardMaterial color={color} /></mesh>
      <mesh position={[0, 0.95, 0.025]} scale={[1, 1.05, 0.9]} castShadow><sphereGeometry args={[0.29, 20, 16]} /><meshStandardMaterial color={C.skin} /></mesh>
      <mesh position={[0, 1.11, -0.025]} scale={[1, 0.65, 0.95]} castShadow><sphereGeometry args={[0.3, 16, 12]} /><meshStandardMaterial color="#523426" /></mesh>
      <mesh position={[0, 1.2, 0]} castShadow><cylinderGeometry args={[0.4, 0.4, 0.055, 24]} /><meshStandardMaterial color="#ffe1a0" /></mesh>
      <mesh position={[0, 1.31, -0.02]} castShadow><sphereGeometry args={[0.25, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={color} /></mesh>
      <mesh position={[0, 0.61, -0.23]} scale={[1, 1.1, 0.55]} castShadow><sphereGeometry args={[0.24, 12, 10]} /><meshStandardMaterial color="#e4b359" /></mesh>
      {[-1, 1].map(side => <group key={side}>
        <mesh position={[side * 0.11, 0.99, 0.267]}><sphereGeometry args={[0.046, 12, 8]} /><meshStandardMaterial color="#263044" /></mesh>
        <mesh position={[side * 0.11 - 0.01, 1.008, 0.303]}><sphereGeometry args={[0.014, 8, 6]} /><meshBasicMaterial color="white" /></mesh>
        <mesh position={[side * 0.18, 0.91, 0.235]} scale={[1, 0.5, 0.3]}><sphereGeometry args={[0.057, 10, 8]} /><meshStandardMaterial color="#ef9b88" /></mesh>
        <mesh position={[side * 0.16, 0.64, 0.18]}><boxGeometry args={[0.035, 0.31, 0.035]} /><meshStandardMaterial color="#ffe1a0" /></mesh>
      </group>)}
      <mesh position={[0, 0.9, 0.288]} rotation={[0, 0, Math.PI]}><torusGeometry args={[0.065, 0.012, 6, 16, Math.PI]} /><meshStandardMaterial color="#8c493b" /></mesh>

    </group>
    {(selected || hovered) && <NameTag name={player.username} />}
  </group>;
}

function CameraRig({ focus, reduced, activeRef }: { focus: boolean; reduced: boolean; activeRef: RefObject<THREE.Group | null> }) {
  const controls = useRef<Controls>(null);
  const { camera, size, invalidate } = useThree();
  const desired = useRef(new THREE.Vector3());
  const shift = useRef(new THREE.Vector3());
  const baseZoom = Math.max(1, Math.min(size.width / 22, size.height / 22));

  useLayoutEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return;
    camera.zoom = baseZoom;
    camera.updateProjectionMatrix();
    invalidate();
  }, [baseZoom, camera, invalidate]);

  useEffect(() => { invalidate(); }, [focus, reduced, invalidate]);
  useFrame((_, delta) => {
    const control = controls.current;
    if (!control) return;
    if (focus && activeRef.current) {
      desired.current.copy(activeRef.current.position);
      desired.current.y += 0.4;
    }
    else desired.current.set(...OVERVIEW);
    shift.current.copy(desired.current).sub(control.target);
    if (shift.current.lengthSq() > 0.00001) {
      shift.current.multiplyScalar(reduced ? 1 : 1 - Math.exp(-4 * Math.min(delta, 0.05)));
      control.target.add(shift.current);
      camera.position.add(shift.current);
      control.update();
      invalidate();
    }
  });

  return <OrbitControls ref={controls} makeDefault target={OVERVIEW} enablePan={false} enableDamping={!reduced}
    dampingFactor={0.12} rotateSpeed={0.55} zoomSpeed={0.75} minZoom={baseZoom * 0.85} maxZoom={baseZoom * 3.8}
    minPolarAngle={0.3} maxPolarAngle={0.95} minAzimuthAngle={-0.55} maxAzimuthAngle={0.65} />;
}

function validLinks(links: Record<string, number>, count: number): [number, number][] {
  return Object.entries(links).flatMap(([key, to]) => {
    const from = Number(key);
    return Number.isInteger(from) && Number.isInteger(to) && from >= 1 && from <= count && to >= 1 && to <= count && from !== to ? [[from, to] as [number, number]] : [];
  });
}

function World({ players, currentPlayerId, count, snakes, ladders, high, reduced, focus, diceRoll, diceValue }: {
  players: Player[]; currentPlayerId: string | undefined; count: number;
  snakes: Record<string, number>; ladders: Record<string, number>; high: boolean; reduced: boolean; focus: boolean; diceRoll?: DiceRoll | null; diceValue?: number;
}) {
  const invalidate = useThree(state => state.invalidate);
  useEffect(() => {
    invalidate();
    if (reduced || Object.keys(snakes).length === 0) return;
    // One shared, capped idle loop; do not animate hidden tabs or reduced-motion scenes.
    const timer = window.setInterval(() => { if (!document.hidden) invalidate(); }, high ? 33 : 66);
    return () => window.clearInterval(timer);
  }, [high, reduced, snakes, invalidate]);
  const activeRef = useRef<THREE.Group | null>(null);
  const start = positionForStep(1, count);
  return <>
    <color attach="background" args={[C.sky]} />
    <ambientLight intensity={0.7} />
    <hemisphereLight args={[C.ivory, C.leaf, 1.25]} />
    <directionalLight position={[-7, 16, 10]} intensity={2.3} color={C.ivory} castShadow={high}
      shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-camera-left={-14} shadow-camera-right={14}
      shadow-camera-top={15} shadow-camera-bottom={-14} shadow-camera-far={55} shadow-normalBias={0.06} />
    <directionalLight position={[8, 6, -10]} intensity={0.65} color={C.waterLight} />
    <Terrain high={high} />
    <Trail count={count} high={high} />
    <Scenery high={high} />
    <Castle count={count} />
    <group position={[start[0], start[1], start[2] + 0.65]}>
      <Beam start={[-0.48, 0, 0]} end={[-0.48, 0.85, 0]} radius={0.045} />
      <Beam start={[0.48, 0, 0]} end={[0.48, 0.85, 0]} radius={0.045} />
      <mesh position={[0, 0.72, 0]}><boxGeometry args={[1.05, 0.18, 0.045]} /><meshStandardMaterial color={C.coral} /></mesh>
    </group>
    {validLinks(ladders, count).map(([from, to]) => <Ladder key={`ladder-${from}-${to}`} from={from} to={to} count={count} />)}
    {validLinks(snakes, count).map(([from, to], index) => <Snake key={`snake-${from}-${to}`} from={from} to={to} count={count} index={index} high={high} reduced={reduced} activeRef={activeRef} />)}
    {players.map(player => {
      const occupants = players.filter(other => Math.max(1, Math.min(count, Number.isFinite(other.position) ? other.position : 1)) === Math.max(1, Math.min(count, Number.isFinite(player.position) ? player.position : 1)));
      return <Adventurer key={player.id} player={player} count={count} selected={player.id === currentPlayerId}
        slot={occupants.findIndex(other => other.id === player.id)} occupants={occupants.length} reduced={reduced} activeRef={activeRef} snakes={snakes} ladders={ladders} />;
    })}
    <BoardDice roll={diceRoll} value={diceValue} reduced={reduced} />
    <CameraRig focus={focus} reduced={reduced} activeRef={activeRef} />
  </>;
}

function webglSupported(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (canvas.getContext("webgl2") || canvas.getContext("webgl")));
  } catch {
    return false;
  }
}

type XY = readonly [number, number];

function Ladder2D({ base, top }: { base: XY; top: XY }) {
  const dx = top[0] - base[0], dy = top[1] - base[1];
  const length = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const height = Math.min(10, length * 0.18);
  const planks = Math.max(4, Math.round(length / 6));
  return <g transform={`translate(${base[0]} ${base[1]}) rotate(${angle})`}>
    <path d={`M 0 5 L ${length / 2} ${5 - height} L ${length} 5 Z`} fill="#b77e49" stroke="#79512e" strokeWidth={2} />
    <line x1={length / 2} y1={5} x2={length / 2} y2={5 - height} stroke="#79512e" strokeWidth={2} />
    {Array.from({ length: planks }, (_, i) => {
      const x = (i + 0.5) * length / planks;
      const y = -(1 - Math.abs(2 * x / length - 1)) * height;
      return <rect key={i} x={x - length / planks / 2} y={y - 4} width={length / planks * 0.95} height={9} rx={0.7}
        fill={i % 2 ? "#e8bb81" : "#d69b5b"} stroke="#a77849" strokeWidth={0.5} />;
    })}
    {[0, length].map(x => <rect key={x} x={x - 2} y={3} width={4} height={4} rx={0.5} fill="#79512e" />)}
  </g>;
}

function Snake2D({ head, tail, index }: { head: XY; tail: XY; index: number }) {
  const dx = tail[0] - head[0], dy = tail[1] - head[1];
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  const px = -uy, py = ux;
  const wiggle = Math.min(9, length * 0.08);
  const color = ["#9254c6", "#2eae83", "#318cc9", "#e97860"][index % 4]!;
  const path = `M ${head[0]} ${head[1]} C ${head[0] + dx * 0.26 + px * wiggle} ${head[1] + dy * 0.26 + py * wiggle}, ${head[0] + dx * 0.68 - px * wiggle} ${head[1] + dy * 0.68 - py * wiggle}, ${tail[0]} ${tail[1]}`;
  return <g>
    <path d={path} fill="none" stroke="#5a4476" strokeWidth={5.4} strokeLinecap="round" />
    <path d={path} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" />
    <ellipse cx={head[0]} cy={head[1]} rx={5.3} ry={4.2} fill={color}
      transform={`rotate(${(Math.atan2(uy, ux) * 180 / Math.PI).toFixed(1)} ${head[0]} ${head[1]})`} />
    {[-1, 1].map(side => <circle key={side} cx={head[0] - ux * 2 + px * side * 2.7}
      cy={head[1] - uy * 2 + py * side * 2.7} r={1.5} fill={C.ivory} />)}
    <line x1={head[0] - ux * 6} y1={head[1] - uy * 6} x2={head[0] - ux * 10} y2={head[1] - uy * 10}
      stroke={C.coral} strokeWidth={1.5} strokeLinecap="round" />
  </g>;
}

/** SVG fallback board: same journey, same links, no GPU required. */
function Board2D({ players, currentPlayerId, count, snakes, ladders }: {
  players: Player[]; currentPlayerId: string | undefined; count: number; snakes: Record<string, number>; ladders: Record<string, number>;
}) {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const size = Math.min(28, 280 / Math.max(columns, rows));
  const left = (384 - columns * size) / 2, top = (328 - rows * size) / 2;
  const project = (step: number) => {
    const row = Math.floor((step - 1) / columns);
    const col = (step - 1) % columns;
    return [left + (row % 2 ? columns - col - 0.5 : col + 0.5) * size,
      top + (rows - row - 0.5) * size] as const;
  };
  const path = Array.from({ length: count }, (_, i) => project(i + 1));
  const tileColors = ["#44bcec", "#ffd368", "#58c997", "#ff8376", "#baa9e8"];
  return <svg viewBox="0 0 384 328" role="img" aria-label="Papan petualangan mode hemat" style={{ width: "100%", height: "100%", display: "block", background: C.sky }}>
    <rect x={left - 5} y={top - 5} width={columns * size + 10} height={rows * size + 10} rx={7} fill="#8f5c37" />
    {path.map(([x, y], i) => {
      const step = i + 1;
      return <rect key={step} x={x - size / 2 + 0.7} y={y - size / 2 + 0.7} width={size - 1.4} height={size - 1.4}
        rx={2.4} fill={step === count ? "#ffc64f" : tileColors[(i + Math.floor(i / columns) * 2) % tileColors.length]} stroke="#ffffffa8" strokeWidth={0.8} />;
    })}
    {validLinks(ladders, count).map(([from, to]) => <Ladder2D key={`l${from}`} base={project(from)} top={project(to)} />)}
    {validLinks(snakes, count).map(([from, to], index) => <Snake2D key={`s${from}`} head={project(from)} tail={project(to)} index={index} />)}
    {path.map(([x, y], i) => <text key={i} x={x} y={y + 4} textAnchor="middle" fontSize={size * 0.46}
      fontWeight={800} fill="#19364a" stroke="#ffffffc9" strokeWidth={2} paintOrder="stroke" fontFamily={FONT}>{i + 1}</text>)}
    {players.map(player => {
      const target = Math.max(1, Math.min(count, Number.isFinite(player.position) ? player.position : 1));
      const [x, y] = project(target);
      const selected = player.id === currentPlayerId;
      return <g key={player.id} transform={`translate(${x + (selected ? 8 : -8)} ${y + 4})`}>
        <title>{player.username || "Petualang"} berada di petak {target}{selected ? ", giliran saat ini" : ""}</title>
        <circle r={6} fill={selected ? C.coral : C.leaf} stroke={C.ivory} strokeWidth={1.5} />
        <text y={2.4} textAnchor="middle" fontSize={7} fontWeight={800} fill={C.ivory} fontFamily={FONT}>{(player.username || "P").slice(0, 1).toUpperCase()}</text>
      </g>;
    })}
  </svg>;
}

function DiceReadout({ roll, value, reduced }: { roll?: DiceRoll | null; value: number; reduced: boolean }) {
  const [phase, setPhase] = useState<"shaking" | "rolling" | "settled">("settled");
  useEffect(() => {
    if (!roll || reduced) { setPhase("settled"); return; }
    const update = () => {
      const elapsed = Date.now() - roll.startedAt;
      setPhase(elapsed < DICE_RELEASE_MS ? "shaking" : elapsed < DICE_ROLL_DURATION_MS ? "rolling" : "settled");
    };
    update();
    const timers = [DICE_RELEASE_MS, DICE_ROLL_DURATION_MS].map(time =>
      setTimeout(update, Math.max(0, roll.startedAt + time - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [roll?.id, roll?.startedAt, reduced]);
  return <div className="board-dice-result" role="status" aria-live="polite">{phase === "shaking" ? "Mengocok dadu…" : phase === "rolling" ? "Dadu bergulir…" : roll || value ? `Dadu: ${roll?.value || value}` : "Dadu belum dilempar"}</div>;
}

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Presentational only: supplied positions and connections never change game state.
   * Mount in a sized parent (or use the built-in 240px minimum height).
 * Import dynamically with SSR disabled in frameworks that pre-render client trees.
 */
export default function AdventureScene({
  players = EMPTY_PLAYERS, currentPlayerId, totalSteps = 100, snakes = EMPTY_LINKS, ladders = EMPTY_LINKS,
  quality, reducedMotion, focusPlayer = false, diceRoll, diceValue = 0,
}: AdventureSceneProps) {
  const [preferences, setPreferences] = useState({ low: true, reduced: true });
  const [contextLost, setContextLost] = useState(false);
  const [ready, setReady] = useState(false);
  const canvasElement = useRef<HTMLCanvasElement | null>(null);
  const count = stepCount(totalSteps);
  const high = quality ? quality === "high" : !preferences.low;
  const reduced = reducedMotion ?? preferences.reduced;

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mobile = window.matchMedia("(max-width: 767px), (pointer: coarse)");
    const update = () => setPreferences({ low: mobile.matches, reduced: motion.matches });
    update();
    motion.addEventListener("change", update);
    mobile.addEventListener("change", update);
    return () => { motion.removeEventListener("change", update); mobile.removeEventListener("change", update); };
  }, []);

  useEffect(() => {
    const canvas = canvasElement.current;
    if (!canvas) return;
    const lost = (event: Event) => { event.preventDefault(); setContextLost(true); };
    const restored = () => setContextLost(false);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    return () => { canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", restored); };
  }, [ready]);

  const [gpuBlocked, setGpuBlocked] = useState(false);
  useEffect(() => { setGpuBlocked(!webglSupported()); }, []);
  useEffect(() => {
    if (gpuBlocked || ready) return;
    // Some browsers expose a WebGL context but cannot finish creating the
    // renderer. Canvas' HTML fallback is hidden inside the canvas element.
    const timer = window.setTimeout(() => setGpuBlocked(true), 2500);
    return () => window.clearTimeout(timer);
  }, [gpuBlocked, ready]);
  const fallback = <Board2D players={players} currentPlayerId={currentPlayerId} count={count} snakes={snakes} ladders={ladders} />;
  const playerSummary = players.length ? players.map(player => `${player.username || "Petualang"}: petak ${Number.isFinite(player.position) ? player.position : 0}${player.id === currentPlayerId ? ", giliran saat ini" : ""}`).join(". ") : "Belum ada petualang di jalur ini.";

  return <section aria-label="Papan petualangan rimba" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", minHeight: 240, overflow: "clip", background: C.sky, isolation: "isolate" }}>
    {gpuBlocked ? fallback : <SceneBoundary fallback={fallback}>
      <Canvas orthographic camera={{ position: CAMERA, zoom: 24, near: 0.1, far: 150 }} frameloop="demand"
        dpr={high ? [1, 1.75] : [1, 1]} shadows={high ? "soft" : false}
        gl={{ antialias: true, alpha: false, powerPreference: "low-power" }}
        style={{ minHeight: 240, touchAction: "pan-y" }}
        onCreated={({ gl }) => { canvasElement.current = gl.domElement; setReady(true); }}>
        <Suspense fallback={null}>
          <World players={players} currentPlayerId={currentPlayerId} count={count} snakes={snakes} ladders={ladders} high={high} reduced={reduced} focus={focusPlayer} diceRoll={diceRoll} diceValue={diceValue} />
        </Suspense>
      </Canvas>
    </SceneBoundary>}
    <DiceReadout roll={diceRoll} value={diceValue} reduced={reduced} />
    {contextLost && <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", color: C.ink, font: `600 13px ${FONT}`, background: C.sky }}>Memulihkan tampilan pulau...</div>}
    <details style={{ position: "absolute", left: 12, top: 12, maxWidth: "min(280px, calc(100% - 24px))", maxHeight: "45%", overflow: "auto", padding: "7px 10px", borderRadius: 6, background: C.ivory, color: C.ink, font: `500 12px ${FONT}` }}>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>Ringkasan papan</summary>
      <p style={{ margin: "8px 0", lineHeight: 1.5, overflowWrap: "anywhere" }}>{count} petak dari gerbang rimba menuju kastel puncak. {playerSummary}</p>
      <p style={{ margin: "8px 0", lineHeight: 1.5 }}>
        Jembatan: {validLinks(ladders, count).map(([from, to]) => `${from} ke ${to}`).join(", ") || "tidak ada"}.<br />
        Ular: {validLinks(snakes, count).map(([from, to]) => `${from} ke ${to}`).join(", ") || "tidak ada"}.
      </p>
    </details>
  </section>;
}
