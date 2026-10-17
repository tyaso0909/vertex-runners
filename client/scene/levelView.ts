/**
 * ステージの見た目。shared のステージデータ（箱の一覧）から three.js のメッシュを作る。
 * フェーズ1 では箱だけのテスト部屋を、ネオン都市の雰囲気（夕暮れの空・発光する線・ブルーム）で描く。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LevelData, SurfaceKind } from '../../shared/level';
import { makeConcreteTexture, makeGridTexture, makeLabelTexture, makeWindowTexture } from './textures';

interface KindStyle {
  base: string;
  glow: string;
  glowIntensity: number;
  edge: string;
  roughness: number;
  metalness: number;
}

const STYLES: Record<SurfaceKind, KindStyle> = {
  floor: { base: '#262833', glow: '#2bd8ff', glowIntensity: 0.3, edge: '#2bd8ff', roughness: 0.62, metalness: 0.12 },
  wall: { base: '#3a3e4c', glow: '#4fd1ff', glowIntensity: 0.55, edge: '#7fe3ff', roughness: 0.7, metalness: 0.15 },
  platform: { base: '#34303f', glow: '#8a5cff', glowIntensity: 0.6, edge: '#b08cff', roughness: 0.6, metalness: 0.2 },
  ramp: { base: '#3a2f40', glow: '#ff4fd8', glowIntensity: 0.6, edge: '#ff8ae6', roughness: 0.5, metalness: 0.2 },
  block: { base: '#3d3530', glow: '#ffb45c', glowIntensity: 0.65, edge: '#ffc985', roughness: 0.7, metalness: 0.15 },
  pillar: { base: '#383b47', glow: '#4fd1ff', glowIntensity: 0.5, edge: '#7fe3ff', roughness: 0.6, metalness: 0.2 },
  boundary: { base: '#1c1e29', glow: '#5b4cff', glowIntensity: 0.3, edge: '#7b6cff', roughness: 0.8, metalness: 0.1 },
  prop: { base: '#403a36', glow: '#ffb45c', glowIntensity: 0.45, edge: '#ffc985', roughness: 0.7, metalness: 0.15 },
};

/** テクスチャ1枚が何メートルに当たるか */
const TILE = 4;

/** 箱の各面の UV を面の大きさに合わせて伸ばし、グリッドが全部の面で同じ間隔になるようにする */
function boxGeometryWithWorldUV(sx: number, sy: number, sz: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // BoxGeometry の面の順番：+x, -x, +y, -y, +z, -z（各4頂点）
  const faceScale: Array<[number, number]> = [
    [sz, sy],
    [sz, sy],
    [sx, sz],
    [sx, sz],
    [sx, sy],
    [sx, sy],
  ];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, (uv.getX(idx) * faceScale[f][0]) / TILE, (uv.getY(idx) * faceScale[f][1]) / TILE);
    }
  }
  uv.needsUpdate = true;
  return g;
}

export class LevelView {
  readonly group = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(level: LevelData) {
    const grid = makeGridTexture();
    const concrete = makeConcreteTexture();
    this.disposables.push(grid, concrete);

    const materials = new Map<SurfaceKind, THREE.MeshStandardMaterial>();
    const edgeMaterials = new Map<SurfaceKind, THREE.LineBasicMaterial>();
    for (const [kind, s] of Object.entries(STYLES) as Array<[SurfaceKind, KindStyle]>) {
      const m = new THREE.MeshStandardMaterial({
        color: s.base,
        map: concrete,
        emissive: s.glow,
        emissiveMap: grid,
        emissiveIntensity: s.glowIntensity,
        roughness: s.roughness,
        metalness: s.metalness,
      });
      materials.set(kind, m);
      const em = new THREE.LineBasicMaterial({ color: new THREE.Color(s.edge).multiplyScalar(2.2), toneMapped: false });
      edgeMaterials.set(kind, em);
      this.disposables.push(m, em);
    }

    // 箱（ネオン都市などは Blender で作った見た目を mapView.ts で描くので、ここでは描かない）
    const edgeGeoms = new Map<SurfaceKind, THREE.BufferGeometry[]>();
    const drawBoxes = level.style === 'neon' || level.style === 'fortress' ? [] : level.boxes;
    for (const b of drawBoxes) {
      const geo = boxGeometryWithWorldUV(b.size.x, b.size.y, b.size.z);
      const mesh = new THREE.Mesh(geo, materials.get(b.kind));
      mesh.position.set(b.center.x, b.center.y, b.center.z);
      if (b.rot) mesh.rotation.set((b.rot.x * Math.PI) / 180, (b.rot.y * Math.PI) / 180, (b.rot.z * Math.PI) / 180, 'YXZ');
      mesh.castShadow = b.kind !== 'floor' && b.kind !== 'boundary';
      mesh.receiveShadow = true;
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.disposables.push(geo);

      // 輪郭線（ネオンの縁取り）。床は大きすぎるので描かない
      if (b.kind !== 'floor') {
        const eg = new THREE.EdgesGeometry(geo).applyMatrix4(mesh.matrix);
        if (!edgeGeoms.has(b.kind)) edgeGeoms.set(b.kind, []);
        edgeGeoms.get(b.kind)!.push(eg);
      }
    }
    for (const [kind, list] of edgeGeoms) {
      const merged = mergeGeometries(list);
      list.forEach((g) => g.dispose());
      if (!merged) continue;
      this.group.add(new THREE.LineSegments(merged, edgeMaterials.get(kind)));
      this.disposables.push(merged);
    }

    // 看板
    for (const l of level.labels) {
      const { texture, aspect } = makeLabelTexture(l.text, l.sub, l.color ?? '#4fd1ff');
      const h = l.sub ? 1.9 : 0.75;
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      mat.color.setScalar(1.25);
      const geo = new THREE.PlaneGeometry(h * aspect, h);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(l.pos.x, l.pos.y, l.pos.z);
      mesh.rotation.y = (l.yaw * Math.PI) / 180;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.disposables.push(texture, mat, geo);
    }

    // ダメージ床（赤く脈打つ板と、縁の線）
    for (const hz of level.hazards ?? []) {
      const w = hz.max.x - hz.min.x;
      const d = hz.max.z - hz.min.z;
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        uniforms: { uTime: this.hazardTime },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform float uTime; varying vec2 vUv;
          void main(){
            vec2 e = abs(vUv - 0.5) * 2.0;
            float border = smoothstep(0.9, 1.0, max(e.x, e.y));
            float stripes = step(0.5, fract((vUv.x + vUv.y) * ${(Math.max(w, d) * 1.2).toFixed(1)} - uTime * 0.6));
            float pulse = 0.55 + 0.45 * sin(uTime * 4.0);
            float a = 0.25 + border * 0.7 + stripes * 0.18 * pulse;
            gl_FragColor = vec4(vec3(1.6, 0.18, 0.25) * a, a);
          }`,
      });
      const geo = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((hz.min.x + hz.max.x) / 2, hz.min.y + 0.03, (hz.min.z + hz.max.z) / 2);
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.disposables.push(mat, geo);
    }

    // 遠景のビル群。ネオン都市はマップのまわりに Blender で作ったビルがあるので、さらに外側に置く
    if (level.style !== 'fortress') this.group.add(level.style === 'neon' ? this.buildSkyline(250, 320, 1.5, -1) : this.buildSkyline());
  }

  /** ダメージ床の模様を動かす時間 */
  readonly hazardTime = { value: 0 };
  update(dt: number): void {
    this.hazardTime.value += dt;
  }

  /** 遠景の高層ビル群（当たり判定なし。雰囲気づくり用） */
  private buildSkyline(minDist = 125, spread = 230, heightMul = 1, baseY = 0): THREE.Object3D {
    const windows = makeWindowTexture();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const geoms: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 170; i++) {
      const ang = rnd() * Math.PI * 2;
      const dist = minDist + rnd() * spread;
      const w = 10 + rnd() * 22,
        d = 10 + rnd() * 22;
      const h = (25 + Math.pow(rnd(), 1.6) * 190) * heightMul - baseY;
      const g = new THREE.BoxGeometry(w, h, d);
      // 窓の大きさがビルの大きさによらず一定になるよう UV を調整（テクスチャ1枚 = 32m×64m）
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const fs: Array<[number, number]> = [
        [d, h],
        [d, h],
        [0, 0],
        [0, 0],
        [w, h],
        [w, h],
      ];
      for (let f = 0; f < 6; f++)
        for (let k = 0; k < 4; k++) {
          const idx = f * 4 + k;
          uv.setXY(idx, (uv.getX(idx) * fs[f][0]) / 32 + ((i * 0.37) % 1), (uv.getY(idx) * fs[f][1]) / 64 + ((i * 0.61) % 1));
        }
      g.translate(Math.cos(ang) * dist, h / 2 - 2 + baseY, Math.sin(ang) * dist);
      geoms.push(g);
    }
    const merged = mergeGeometries(geoms)!;
    geoms.forEach((g) => g.dispose());
    const mat = new THREE.MeshStandardMaterial({
      color: '#0a0912',
      roughness: 0.9,
      metalness: 0.1,
      emissive: '#ffffff',
      emissiveMap: windows,
      emissiveIntensity: 1.25,
    });
    this.disposables.push(merged, mat, windows);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** 夕暮れのグラデーションの空 */
export function makeSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sunDir: { value: new THREE.Vector3(-0.55, 0.06, -0.83).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 below = vec3(0.07, 0.04, 0.12);
        vec3 horizon = vec3(1.0, 0.45, 0.42);
        vec3 low = vec3(0.78, 0.30, 0.62);
        vec3 mid = vec3(0.36, 0.16, 0.55);
        vec3 top = vec3(0.07, 0.04, 0.19);
        vec3 col;
        if (y < 0.0) col = mix(horizon * 0.6, below, smoothstep(0.0, -0.12, y));
        else if (y < 0.08) col = mix(horizon, low, y / 0.08);
        else if (y < 0.3) col = mix(low, mid, (y - 0.08) / 0.22);
        else col = mix(mid, top, smoothstep(0.3, 0.85, y));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += vec3(1.0, 0.55, 0.3) * (pow(s, 220.0) * 1.3 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.12);
        // 上の色は sRGB で指定しているので、描画用に線形の色へ直す
        gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
