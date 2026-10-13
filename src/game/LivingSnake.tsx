"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { snakeBodyMotion, snakeExpression } from "./snake-motion";

const PALETTES = [
  { body: "#9356d1", light: "#c99af3", belly: "#ffdfa8", cheek: "#f4a5bf" },
  { body: "#37b97c", light: "#a5e970", belly: "#fff0b9", cheek: "#f2ac86" },
  { body: "#2c9fda", light: "#8ee4f5", belly: "#fff0c9", cheek: "#f5b3b8" },
  { body: "#f18757", light: "#ffd575", belly: "#fff0bf", cheek: "#f4b49b" },
];

export default function LivingSnake({ curve, index, high, reduced, activeRef }: {
  curve: THREE.CatmullRomCurve3; index: number; high: boolean; reduced: boolean;
  activeRef: RefObject<THREE.Group | null>;
}) {
  const headRef = useRef<THREE.Group>(null);
  const eyes = useRef<(THREE.Group | null)[]>([]);
  const pupils = useRef<(THREE.Group | null)[]>([]);
  const tongue = useRef<THREE.Group>(null);
  const excitedUntil = useRef(0);
  const hovered = useRef(false);
  const invalidate = useThree(state => state.invalidate);
  const clock = useThree(state => state.clock);
  const palette = PALETTES[index % PALETTES.length]!;
  const segments = high ? 80 : 40, radial = high ? 12 : 8;
  const shape = useMemo(() => {
    const geometry = new THREE.TubeGeometry(curve, segments, 0.22, radial, false);
    const positions = geometry.attributes.position!;
    const normals = geometry.attributes.normal!;
    const colors = new Float32Array(positions.count * 3);
    const body = new THREE.Color(palette.body), light = new THREE.Color(palette.light), belly = new THREE.Color(palette.belly);
    const side = new THREE.Vector3(), tangent = new THREE.Vector3();
    const directions: THREE.Vector3[] = [];
    for (let ring = 0; ring <= segments; ring++) {
      const u = ring / segments;
      const center = curve.getPointAt(u);
      tangent.copy(curve.getTangentAt(u));
      directions.push(side.set(-tangent.z, 0, tangent.x).normalize().clone());
      const taper = 1 - 0.95 * Math.max(0, (u - 0.48) / 0.52) ** 1.3;
      for (let j = 0; j <= radial; j++) {
        const vertex = ring * (radial + 1) + j;
        positions.setXYZ(vertex,
          center.x + (positions.getX(vertex) - center.x) * taper,
          center.y + (positions.getY(vertex) - center.y) * taper,
          center.z + (positions.getZ(vertex) - center.z) * taper);
        const ny = normals.getY(vertex);
        const color = body.clone().lerp(light, Math.max(0, ny) * 0.22);
        if (ny < -0.2) color.lerp(belly, Math.min(1, (-ny - 0.2) * 3));
        // Soft oval markings follow the back, keeping the tile numbers readable.
        if (ny > 0.65 && Math.cos(u * Math.PI * 18) > 0.65 + (1 - ny) * 0.8) color.lerp(light, 0.85);
        color.toArray(colors, vertex * 3);
      }
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.4;
    return { geometry, base: new Float32Array(positions.array), directions };
  }, [curve, segments, radial, palette]);
  useEffect(() => () => shape.geometry.dispose(), [shape]);
  const { head, angle, smile, fork } = useMemo(() => {
    const head = curve.getPoint(0), next = curve.getPoint(0.03);
    return {
      head, angle: Math.atan2(head.x - next.x, head.z - next.z),
      smile: new THREE.CatmullRomCurve3([
        new THREE.Vector3(-0.24, -0.01, 0.37), new THREE.Vector3(-0.14, -0.09, 0.445),
        new THREE.Vector3(0, -0.115, 0.47), new THREE.Vector3(0.14, -0.09, 0.445), new THREE.Vector3(0.24, -0.01, 0.37),
      ]),
      fork: [-1, 1].map(side => new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0.12), new THREE.Vector3(side * 0.035, 0.005, 0.21), new THREE.Vector3(side * 0.07, 0.018, 0.27),
      ])),
    };
  }, [curve]);
  const gaze = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    const expression = snakeExpression(time, index, reduced);
    const motion = snakeBodyMotion(0, time, index, reduced);
    const excited = !reduced && excitedUntil.current > time;
    const reactionTime = 1.2 - (excitedUntil.current - time);
    const nod = excited ? Math.sin(reactionTime * Math.PI * 3) * Math.sin(reactionTime / 1.2 * Math.PI) * 0.12 : 0;
    const positions = shape.geometry.attributes.position!;
    for (let ring = 0; ring <= segments; ring++) {
      const u = ring / segments, offset = snakeBodyMotion(u, time, index, reduced), direction = shape.directions[ring]!;
      for (let j = 0; j <= radial; j++) {
        const vertex = ring * (radial + 1) + j, start = vertex * 3;
        positions.setXYZ(vertex, shape.base[start]! + direction.x * offset.sideways,
          shape.base[start + 1]! + offset.lift, shape.base[start + 2]! + direction.z * offset.sideways);
      }
    }
    positions.needsUpdate = true;
    if (headRef.current) {
      headRef.current.position.set(head.x, head.y + motion.lift, head.z);
      headRef.current.rotation.set(expression.pitch + nod, angle + expression.yaw, 0);
      if (activeRef.current && !reduced) {
        gaze.copy(activeRef.current.position);
        headRef.current.updateWorldMatrix(true, false);
        headRef.current.worldToLocal(gaze);
      } else gaze.set(0, 1, 5);
    }
    eyes.current.forEach(eye => { if (eye) eye.scale.y = hovered.current && !reduced ? 1 : expression.blink; });
    pupils.current.forEach(pupil => {
      if (pupil) pupil.position.set(THREE.MathUtils.clamp(gaze.x * 0.012, -0.035, 0.035),
        0.024 + THREE.MathUtils.clamp(gaze.y * 0.008, -0.018, 0.018), 0.12);
    });
    if (tongue.current) { tongue.current.visible = expression.tongue > 0.01; tongue.current.scale.z = expression.tongue; }
  });
  return <group>
    <mesh geometry={shape.geometry} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.38} metalness={0.02} />
    </mesh>
    <group ref={headRef} position={[head.x, head.y + 0.13, head.z]} rotation={[0, angle, 0]}
      onPointerOver={event => { event.stopPropagation(); hovered.current = true; invalidate(); }}
      onPointerOut={() => { hovered.current = false; invalidate(); }}
      onClick={event => { event.stopPropagation(); excitedUntil.current = clock.elapsedTime + 1.2; invalidate(); }}>
      <mesh scale={[0.4, 0.3, 0.46]} castShadow>
        <sphereGeometry args={[1, 24, 16]} /><meshStandardMaterial color={palette.body} roughness={0.4} />
      </mesh>
      <mesh position={[0, -0.15, 0.16]} scale={[0.3, 0.12, 0.28]} castShadow>
        <sphereGeometry args={[1, 20, 12]} /><meshStandardMaterial color={palette.belly} roughness={0.65} />
      </mesh>
      <mesh><tubeGeometry args={[smile, 20, 0.014, 6, false]} /><meshStandardMaterial color="#613958" roughness={0.8} /></mesh>
      {[-1, 1].map((side, i) => <group key={side}>
        <group ref={node => { eyes.current[i] = node; }} position={[side * 0.22, 0.245, 0.2]} rotation={[-0.18, side * 0.08, 0]}>
          <mesh><sphereGeometry args={[0.15, 20, 14]} /><meshStandardMaterial color="#fffdf0" roughness={0.28} /></mesh>
          <group ref={node => { pupils.current[i] = node; }} position={[0, 0.025, 0.12]}>
            <mesh scale={[1, 1.13, 0.62]}><sphereGeometry args={[0.075, 16, 12]} /><meshStandardMaterial color="#2a3551" roughness={0.2} /></mesh>
            <mesh position={[-0.021, 0.03, 0.044]}><sphereGeometry args={[0.024, 10, 8]} /><meshBasicMaterial color="#ffffff" /></mesh>
            <mesh position={[0.027, -0.023, 0.043]}><sphereGeometry args={[0.011, 8, 6]} /><meshBasicMaterial color="#ffffff" /></mesh>
          </group>
        </group>
        <mesh position={[side * 0.31, -0.015, 0.275]} rotation={[0, side * 0.5, 0]} scale={[0.095, 0.055, 0.021]}>
          <sphereGeometry args={[1, 12, 8]} /><meshStandardMaterial color={palette.cheek} roughness={0.75} />
        </mesh>
        <mesh position={[side * 0.115, 0.09, 0.438]} scale={[1, 0.65, 0.5]}>
          <sphereGeometry args={[0.024, 10, 6]} /><meshStandardMaterial color="#613958" />
        </mesh>
      </group>)}
      <group ref={tongue} position={[0, -0.085, 0.45]} visible={false}>
        <mesh position={[0, 0, 0.075]}><boxGeometry args={[0.038, 0.02, 0.15]} /><meshStandardMaterial color="#f2859f" /></mesh>
        {fork.map((curve, i) => <mesh key={i}><tubeGeometry args={[curve, 8, 0.012, 5, false]} /><meshStandardMaterial color="#f2859f" /></mesh>)}
      </group>
    </group>
  </group>;
}
