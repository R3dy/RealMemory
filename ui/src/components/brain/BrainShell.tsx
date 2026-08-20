import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { getBrainGeometries } from './brain-mesh';
import { useUiStore } from '@/lib/ui-store';
import { glowScale } from '@/lib/glow';

/**
 * Translucent anatomical brain shell — arc-reactor cyan fresnel rim glow +
 * additive wireframe, matching the medical-scan reference. DoubleSide so the
 * camera can fly INSIDE the cortical cavern; depthWrite off so interior
 * neurons/synapses always shine through. Raycast is disabled on every shell
 * mesh so the shell never blocks hover/selection of interior nodes.
 */

const FRESNEL_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRESNEL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uPower;
  uniform float uGlow;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), uPower);
    vec3 col = uColor * (f * uIntensity + 0.015);
    gl_FragColor = vec4(col * uGlow, 1.0);
  }
`;

function makeFresnelMaterial(color: string, intensity: number, power: number) {
  return new THREE.ShaderMaterial({
    vertexShader: FRESNEL_VERT,
    fragmentShader: FRESNEL_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uPower: { value: power },
      // uGlow scales the whole fresnel output (rim + 0.015 floor) linearly.
      // At uGlow=0 the floor collapses to 0 → true zero glow on the shell.
      // uIntensity is NOT scaled (would double-scale as g² on the rim); uGlow
      // is the sole fresnel scaler. Default 1.0 = bit-identical to pre-slider.
      uGlow: { value: 1.0 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const noRaycast = () => null;

export default function BrainShell() {
  const geo = useMemo(() => getBrainGeometries(), []);
  const { glowIntensity } = useUiStore();
  const g = glowScale(glowIntensity);
  const materials = useMemo(
    () => ({
      cerebrum: makeFresnelMaterial('#00d4ff', 1.5, 2.4),
      cerebellum: makeFresnelMaterial('#2fb8e6', 1.1, 2.6),
      stem: makeFresnelMaterial('#2fb8e6', 1.0, 2.4),
      wireCerebrum: new THREE.MeshBasicMaterial({
        color: '#5fdcff',
        wireframe: true,
        transparent: true,
        opacity: 0.09,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      wireSub: new THREE.MeshBasicMaterial({
        color: '#3fc4ef',
        wireframe: true,
        transparent: true,
        opacity: 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    }),
    [],
  );

  // C4 fix: mutate fresnel uGlow + wireframe opacities when the slider moves.
  // uIntensity stays at base (uGlow is the sole fresnel scaler — avoids g²).
  // No material recreation — cheap uniform/opacity writes.
  useEffect(() => {
    materials.cerebrum.uniforms.uGlow.value = glowIntensity;
    materials.cerebellum.uniforms.uGlow.value = glowIntensity;
    materials.stem.uniforms.uGlow.value = glowIntensity;
    materials.wireCerebrum.opacity = g.wireCerebrum;
    materials.wireSub.opacity = g.wireSub;
  }, [glowIntensity, g.wireCerebrum, g.wireSub, materials]);

  return (
    <group>
      {/* cerebrum hemispheres */}
      <mesh geometry={geo.left} material={materials.cerebrum} raycast={noRaycast} />
      <mesh geometry={geo.right} material={materials.cerebrum} raycast={noRaycast} />
      <mesh geometry={geo.left} material={materials.wireCerebrum} raycast={noRaycast} />
      <mesh geometry={geo.right} material={materials.wireCerebrum} raycast={noRaycast} />
      {/* cerebellum + brain stem */}
      <mesh geometry={geo.cerebellum} material={materials.cerebellum} raycast={noRaycast} />
      <mesh geometry={geo.cerebellum} material={materials.wireSub} raycast={noRaycast} />
      <mesh geometry={geo.stem} material={materials.stem} raycast={noRaycast} />
      <mesh geometry={geo.stem} material={materials.wireSub} raycast={noRaycast} />
    </group>
  );
}
