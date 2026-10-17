/**
 * 軽い粒の表示（煙・炎・光の粒）。1つの描画でたくさんの粒を出す（THREE.Points と小さなシェーダー）。
 * ロケットの煙の尾・爆発の煙・減速フィールドの粒などに使う。
 */
import * as THREE from 'three';

export interface ParticleSpec {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  /** 寿命（秒） */
  life: number;
  /** 大きさ（メートル）：出たとき → 消えるとき */
  size0: number;
  size1: number;
  color: THREE.Color;
  /** 濃さ（出たとき。消えるにつれて 0 へ） */
  alpha?: number;
  /** 重力（上向きは負。煙はゆっくり上がる） */
  gravity?: number;
  /** 空気の抵抗（1秒あたりに速さが減る割合） */
  drag?: number;
}

const VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 0.0, 512.0);
  vAlpha = aAlpha;
  vColor = aColor;
}`;

const FRAG_SOFT = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = smoothstep(1.0, 0.15, d) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}`;

/** 煙用：少しむらのある丸（向きを粒ごとに変えて、同じ形が並ばないようにする） */
const FRAG_SMOKE = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float seed = vColor.r * 13.7 + vAlpha * 3.1;
  float k = n(c * 5.0 + seed) * 0.55 + n(c * 11.0 - seed) * 0.25;
  float a = smoothstep(1.0, 0.25, d + (k - 0.4) * 0.6) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * (0.85 + k * 0.3), a);
}`;

export class Particles {
  readonly points: THREE.Points;
  private readonly max: number;
  private count = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  /** 粒ごと：残りの寿命・寿命・大きさ（初め・終わり）・濃さ・重力・抵抗 */
  private readonly meta: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor(max: number, kind: 'smoke' | 'glow') {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.meta = new Float32Array(max * 7);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: kind === 'smoke' ? FRAG_SMOKE : FRAG_SOFT,
      uniforms: { uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: kind === 'glow' ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: kind !== 'glow',
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = kind === 'glow' ? 6 : 5;
  }

  spawn(p: ParticleSpec): void {
    let i = this.count;
    if (i >= this.max) i = Math.floor(Math.random() * this.max); // いっぱいなら、どれかを置き換える
    else this.count++;
    this.pos.set([p.pos.x, p.pos.y, p.pos.z], i * 3);
    const v = p.vel;
    this.vel.set([v?.x ?? 0, v?.y ?? 0, v?.z ?? 0], i * 3);
    this.col.set([p.color.r, p.color.g, p.color.b], i * 3);
    const m = i * 7;
    this.meta[m] = p.life;
    this.meta[m + 1] = p.life;
    this.meta[m + 2] = p.size0;
    this.meta[m + 3] = p.size1;
    this.meta[m + 4] = p.alpha ?? 1;
    this.meta[m + 5] = p.gravity ?? 0;
    this.meta[m + 6] = p.drag ?? 0;
    this.size[i] = p.size0;
    this.alpha[i] = p.alpha ?? 1;
  }

  /** 画面の高さと視野角から、粒の大きさ（メートル → 画素）の倍率を決める */
  setView(camera: THREE.PerspectiveCamera, heightPx: number): void {
    this.mat.uniforms.uScale.value = heightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }

  update(dt: number): void {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      const m = i * 7;
      this.meta[m] -= dt;
      if (this.meta[m] <= 0) {
        // 最後の粒と入れ替えて消す
        n--;
        if (i !== n) {
          this.pos.copyWithin(i * 3, n * 3, n * 3 + 3);
          this.vel.copyWithin(i * 3, n * 3, n * 3 + 3);
          this.col.copyWithin(i * 3, n * 3, n * 3 + 3);
          this.meta.copyWithin(m, n * 7, n * 7 + 7);
          this.size[i] = this.size[n];
          this.alpha[i] = this.alpha[n];
          i--;
        }
        continue;
      }
      const t = 1 - this.meta[m] / this.meta[m + 1];
      const drag = Math.exp(-this.meta[m + 6] * dt);
      const j = i * 3;
      this.vel[j] *= drag;
      this.vel[j + 1] = this.vel[j + 1] * drag - this.meta[m + 5] * dt;
      this.vel[j + 2] *= drag;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] = this.meta[m + 2] + (this.meta[m + 3] - this.meta[m + 2]) * t;
      // 出てすぐ濃くなり、ゆっくり消える
      const fadeIn = Math.min(1, t * 8);
      this.alpha[i] = this.meta[m + 4] * fadeIn * (1 - t) * (1 - t * 0.3);
    }
    this.count = n;
    this.geo.setDrawRange(0, n);
    for (const a of ['position', 'aColor', 'aSize', 'aAlpha']) (this.geo.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.points.removeFromParent();
  }
}
