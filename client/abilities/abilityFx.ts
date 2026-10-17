/**
 * アビリティの見た目（世界の中に描くもの）。
 * - ワイヤーフック：手元から刺さった点まで伸びるワイヤー
 * - シールドウォール：六角形の模様が流れるエネルギーの壁。弾が当たると波紋が広がる
 * - パルスソナー：広がっていく光の球と、地面を走る輪
 * - 弾薬パック（ソラのパッシブ）：回りながら浮かぶ箱
 */
import * as THREE from 'three';
import type { ShieldWall } from '../../shared/abilities';
import type { AmmoDrop } from '../../shared/simulation';

const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);

// ---------------------------------------------------------------------------
// ワイヤー
// ---------------------------------------------------------------------------

type RopeMode = 'none' | 'shoot' | 'attached' | 'retract';

export class GrappleRope {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly hook: THREE.Mesh;
  private mode: RopeMode = 'none';
  private t = 0;
  private readonly target = new THREE.Vector3();
  private readonly tip = new THREE.Vector3();
  /** 的に刺さったとき（引き寄せたらすぐ戻す） */
  private pullTarget = false;
  static readonly SHOOT_TIME = 0.09;

  constructor(color = '#ff3040') {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), toneMapped: false });
    // 長さ 1 の円柱を、両端に合わせて伸ばして使う
    const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    geo.rotateX(Math.PI / 2); // +Z 方向に伸びる
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.hook = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3), toneMapped: false }));
    this.group.add(this.mesh, this.hook);
    this.group.visible = false;
  }

  /** 撃ち出す。toTarget は的を引き寄せるとき、miss は何にも当たらなかったとき */
  fire(point: { x: number; y: number; z: number }, kind: 'world' | 'target' | 'miss'): void {
    this.target.copy(v(point));
    this.mode = 'shoot';
    this.t = 0;
    this.pullTarget = kind !== 'world';
  }

  /** 引き寄せが終わった */
  release(): void {
    if (this.mode === 'shoot' || this.mode === 'attached') {
      this.mode = 'retract';
      this.t = 0;
    }
  }

  /** from は手元（世界座標） */
  update(dt: number, from: THREE.Vector3, attachedTo: THREE.Vector3 | null): void {
    this.t += dt;
    if (this.mode === 'none') {
      this.group.visible = false;
      return;
    }
    if (attachedTo && this.mode === 'attached') this.target.copy(attachedTo);
    let k = 1;
    if (this.mode === 'shoot') {
      k = Math.min(1, this.t / GrappleRope.SHOOT_TIME);
      if (k >= 1) {
        this.mode = this.pullTarget ? 'retract' : 'attached';
        this.t = 0;
        // 的を引いたときは少し張ったまま見せてから戻す
        if (this.pullTarget) this.t = -0.18;
      }
    } else if (this.mode === 'retract') {
      k = 1 - Math.max(0, this.t) / 0.16;
      if (k <= 0) {
        this.mode = 'none';
        this.group.visible = false;
        return;
      }
    }
    this.tip.lerpVectors(from, this.target, k);
    const d = this.tip.clone().sub(from);
    const len = d.length();
    this.group.visible = len > 0.05;
    this.mesh.position.copy(from);
    this.mesh.lookAt(this.tip);
    // 撃ち出しの間は少し波打たせる
    const wobble = this.mode === 'shoot' ? 1 + 0.4 * Math.sin(this.t * 120) : 1;
    this.mesh.scale.set(wobble, wobble, Math.max(0.001, len));
    this.hook.position.copy(this.tip);
    this.hook.rotation.y += dt * 20;
  }
}

// ---------------------------------------------------------------------------
// シールドウォール
// ---------------------------------------------------------------------------

const MAX_RIPPLES = 6;
/** ブーストのハードカバーの色（ミランダのシールドと見分ける） */
const HARD_COVER_COLOR = '#4fb4ff';

const shieldVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const shieldFrag = /* glsl */ `
  uniform float uTime;
  uniform float uLife;   // 残り時間の割合（1→0）
  uniform float uSpawn;  // 出てからの時間（秒）
  uniform vec3 uColor;
  uniform vec2 uSize;
  uniform vec4 uRipples[${MAX_RIPPLES}]; // xy=壁の上の位置(m), z=経過時間, w=強さ
  varying vec2 vUv;
  varying vec3 vWorld;

  // 六角形の格子（中心からの距離と、セルの番号）
  vec4 hexCoords(vec2 uv) {
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(uv, r) - h;
    vec2 b = mod(uv - h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    float x = atan(gv.x, gv.y);
    float y = 0.5 - max(abs(gv.x), dot(abs(gv), normalize(r)));
    vec2 id = uv - gv;
    return vec4(x, y, id);
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 p = (vUv - 0.5) * uSize;     // 壁の上の位置（m）
    vec4 hc = hexCoords(p * 3.2);
    float edge = smoothstep(0.06, 0.0, hc.y);
    float cell = hash(hc.zw);
    // セルごとにゆっくり明滅
    float twinkle = 0.25 + 0.75 * smoothstep(0.6, 1.0, sin(uTime * (1.2 + cell * 2.0) + cell * 30.0));
    // 下から上へ組み上がる出現の演出
    float build = smoothstep(0.0, 0.08, uSpawn * 1.6 - (vUv.y + cell * 0.3));
    // 縁を明るく
    vec2 e = abs(vUv - 0.5) * 2.0;
    float border = smoothstep(0.92, 1.0, max(e.x, e.y));
    // 弾が当たった波紋
    float ripple = 0.0;
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      vec4 r = uRipples[i];
      if (r.w <= 0.0) continue;
      float d = length(p - r.xy);
      float front = r.z * 6.0;
      ripple += r.w * smoothstep(0.35, 0.0, abs(d - front)) * exp(-r.z * 3.0);
      ripple += r.w * 1.5 * smoothstep(0.5, 0.0, d) * exp(-r.z * 8.0);
    }
    // 消える前に点滅
    float blink = uLife < 0.2 ? 0.55 + 0.45 * step(0.5, fract(uTime * 8.0)) : 1.0;
    float a = (0.08 + edge * 0.55 * twinkle + border * 0.6 + ripple * 0.9) * build * blink;
    vec3 col = uColor * (1.0 + ripple * 1.5 + edge * 0.6);
    gl_FragColor = vec4(col * a, a);
  }`;

interface ShieldVisual {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  ripples: THREE.Vector4[];
  spawn: number;
  lastHits: number;
}

export class ShieldViews {
  readonly group = new THREE.Group();
  private readonly views = new Map<number, ShieldVisual>();

  constructor(private readonly color = '#ff8a2a') {}

  /** シェーダーの準備用：壁の見た目を1つ作って渡す */
  warmObjects(): THREE.Object3D[] {
    const sh = { id: -1, ownerId: -1, center: { x: 0, y: -500, z: 0 }, yaw: 0, width: 1, height: 1, time: 0, hits: 0 };
    this.update(0, [sh], () => 1);
    const sv = this.views.get(-1)!;
    this.views.delete(-1);
    return [sv.mesh];
  }

  /** 弾が当たった位置に波紋を出す */
  hit(shieldId: number, point: { x: number; y: number; z: number }): void {
    const sv = this.views.get(shieldId);
    if (!sv) return;
    const local = sv.mesh.worldToLocal(v(point));
    const slot = sv.ripples.reduce((best, r, i, arr) => (r.z > arr[best].z ? i : best), 0);
    sv.ripples[slot].set(local.x, local.y, 0, 1);
  }

  update(dt: number, shields: ShieldWall[], durationOf: (sh: ShieldWall) => number): void {
    const alive = new Set<number>();
    for (const sh of shields) {
      alive.add(sh.id);
      let sv = this.views.get(sh.id);
      if (!sv) {
        const mat = new THREE.ShaderMaterial({
          vertexShader: shieldVert,
          fragmentShader: shieldFrag,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
          uniforms: {
            uTime: { value: 0 },
            uLife: { value: 1 },
            uSpawn: { value: 0 },
            // ハードカバーは大きく、目の前に立てるので、明るさを抑える
            uColor: { value: new THREE.Color(sh.kind === 'hardcover' ? HARD_COVER_COLOR : this.color).multiplyScalar(sh.kind === 'hardcover' ? 0.62 : 1.6) },
            uSize: { value: new THREE.Vector2(sh.width, sh.height) },
            uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, 9, 0)) },
          },
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sh.width, sh.height, 1, 1), mat);
        // 下端に光る土台
        const base = new THREE.Mesh(
          new THREE.BoxGeometry(sh.width, 0.06, 0.12),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(sh.kind === 'hardcover' ? HARD_COVER_COLOR : this.color).multiplyScalar(2.5), toneMapped: false }),
        );
        base.position.y = -sh.height / 2 + 0.03;
        mesh.add(base);
        this.group.add(mesh);
        sv = { mesh, mat, ripples: mat.uniforms.uRipples.value as THREE.Vector4[], spawn: 0, lastHits: sh.hits };
        this.views.set(sh.id, sv);
      }
      sv.spawn += dt;
      sv.mesh.position.set(sh.center.x, sh.center.y, sh.center.z);
      // 板の正面（+Z）を、壁の正面（視線と同じ決め方の yaw）に向ける
      sv.mesh.rotation.set(0, sh.yaw, 0);
      sv.mat.uniforms.uTime.value += dt;
      sv.mat.uniforms.uSpawn.value = sv.spawn;
      sv.mat.uniforms.uLife.value = sh.time / Math.max(0.01, durationOf(sh));
      for (const r of sv.ripples) {
        r.z += dt;
        if (r.z > 1.2) r.w = 0;
      }
    }
    for (const [id, sv] of this.views) {
      if (alive.has(id)) continue;
      sv.mesh.removeFromParent();
      sv.mat.dispose();
      this.views.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// パルスソナー
// ---------------------------------------------------------------------------

interface Wave {
  sphere: THREE.Mesh;
  ring: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  ringMat: THREE.MeshBasicMaterial;
  t: number;
  radius: number;
  speed: number;
}

export class SonarWaves {
  readonly group = new THREE.Group();
  private waves: Wave[] = [];
  private readonly sphereGeo = new THREE.SphereGeometry(1, 48, 24);
  private readonly ringGeo = new THREE.RingGeometry(0.97, 1, 96, 1);

  constructor(private readonly color = '#4fe3ff') {
    this.ringGeo.rotateX(-Math.PI / 2);
  }

  spawn(origin: { x: number; y: number; z: number }, radius: number, speed: number, groundY: number): void {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { uColor: { value: new THREE.Color(this.color).multiplyScalar(1.5) }, uFade: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uFade;
        varying vec3 vN; varying vec3 vV;
        void main() {
          float rim = pow(1.0 - abs(dot(vN, vV)), 3.0);
          float a = rim * 0.7 * uFade;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    });
    const sphere = new THREE.Mesh(this.sphereGeo, mat);
    sphere.position.set(origin.x, origin.y, origin.z);
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.color).multiplyScalar(2.5),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.set(origin.x, groundY + 0.04, origin.z);
    this.group.add(sphere, ring);
    this.waves.push({ sphere, ring, mat, ringMat, t: 0, radius, speed });
  }

  /** シェーダーの準備用：波を1つ作って渡す */
  warmObjects(): THREE.Object3D[] {
    this.spawn({ x: 0, y: -500, z: 0 }, 10, 10, -500);
    const w = this.waves.pop()!;
    return [w.sphere, w.ring];
  }

  update(dt: number): void {
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += dt;
      const r = Math.max(0.1, w.t * w.speed);
      const k = r / w.radius;
      if (k >= 1) {
        w.sphere.removeFromParent();
        w.ring.removeFromParent();
        w.mat.dispose();
        w.ringMat.dispose();
        this.waves.splice(i, 1);
        continue;
      }
      w.sphere.scale.setScalar(r);
      w.ring.scale.setScalar(r);
      const fade = 1 - k * k;
      w.mat.uniforms.uFade.value = fade;
      w.ringMat.opacity = fade;
    }
  }
}

// ---------------------------------------------------------------------------
// 弾薬パック
// ---------------------------------------------------------------------------

export class AmmoDropViews {
  readonly group = new THREE.Group();
  private readonly views = new Map<number, { obj: THREE.Object3D; t: number; base: THREE.Vector3; ring: THREE.Mesh }>();
  private readonly ringMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#4fe3ff').multiplyScalar(2),
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private readonly ringGeo = new THREE.RingGeometry(0.32, 0.38, 32).rotateX(-Math.PI / 2);

  constructor(private readonly model: THREE.Object3D) {}

  spawn(d: AmmoDrop, groundY: number): void {
    const obj = this.model.clone(true);
    const base = new THREE.Vector3(d.pos.x, groundY, d.pos.z);
    obj.position.copy(base);
    const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    ring.position.set(d.pos.x, groundY + 0.03, d.pos.z);
    this.group.add(obj, ring);
    this.views.set(d.id, { obj, t: 0, base, ring });
  }

  /** すべて消す（ステージを変えたとき） */
  clear(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
  }

  remove(id: number): void {
    const vw = this.views.get(id);
    if (!vw) return;
    vw.obj.removeFromParent();
    vw.ring.removeFromParent();
    this.views.delete(id);
  }

  update(dt: number, drops: AmmoDrop[]): void {
    const timeLeft = new Map(drops.map((d) => [d.id, d.time]));
    for (const [id, vw] of this.views) {
      vw.t += dt;
      vw.obj.position.y = vw.base.y + 0.35 + Math.sin(vw.t * 2.5) * 0.06;
      vw.obj.rotation.y += dt * 1.6;
      const left = timeLeft.get(id) ?? 0;
      // 消える前に点滅
      vw.obj.visible = left > 4 || Math.sin(vw.t * 18) > -0.2;
      vw.ring.scale.setScalar(1 + 0.15 * Math.sin(vw.t * 4));
    }
  }
}
