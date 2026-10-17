/**
 * 射撃の演出（世界側）：弾道の光跡、着弾の火花、弾痕、銃口の光。
 * どれも使い回し（プール）にして、撃つたびに物を作らないようにしている。
 */
import * as THREE from 'three';

interface Tracer {
  line: THREE.Line;
  from: THREE.Vector3;
  to: THREE.Vector3;
  dist: number;
  head: number;
  speed: number;
  life: number;
}

interface Burst {
  points: THREE.Points;
  vel: Float32Array;
  life: number;
  maxLife: number;
}

interface Decal {
  mesh: THREE.Mesh;
  age: number;
}

const TRACER_POOL = 48;
const BURST_POOL = 24;
const SPARKS = 10;
const DECAL_POOL = 90;
const TRACER_LEN = 7;

function makeDecalTexture(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.95)');
  grad.addColorStop(0.35, 'rgba(10,8,12,0.85)');
  grad.addColorStop(0.5, 'rgba(255,170,90,0.55)');
  grad.addColorStop(0.62, 'rgba(40,30,40,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ShotEffects {
  readonly group = new THREE.Group();
  readonly muzzleLight = new THREE.PointLight('#ffb070', 0, 9, 2);
  private tracers: Tracer[] = [];
  private bursts: Burst[] = [];
  private decals: Decal[] = [];
  private nextTracer = 0;
  private nextBurst = 0;
  private nextDecal = 0;
  private lightTimer = 0;

  constructor() {
    this.group.add(this.muzzleLight);
    for (let i = 0; i < TRACER_POOL; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      this.group.add(line);
      this.tracers.push({ line, from: new THREE.Vector3(), to: new THREE.Vector3(), dist: 0, head: 0, speed: 0, life: 0 });
    }
    for (let i = 0; i < BURST_POOL; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
      const mat = new THREE.PointsMaterial({ size: 0.07, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.visible = false;
      this.group.add(points);
      this.bursts.push({ points, vel: new Float32Array(SPARKS * 3), life: 0, maxLife: 0.3 });
    }
    const decalTex = makeDecalTexture();
    const decalGeo = new THREE.PlaneGeometry(0.11, 0.11);
    for (let i = 0; i < DECAL_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: decalTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
      const mesh = new THREE.Mesh(decalGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.decals.push({ mesh, age: 0 });
    }
  }

  /** 弾道の光跡。光の筋が弾の速さで飛んでいく */
  tracer(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, speed = 650): void {
    const t = this.tracers[this.nextTracer];
    this.nextTracer = (this.nextTracer + 1) % TRACER_POOL;
    t.from.copy(from);
    t.to.copy(to);
    t.dist = from.distanceTo(to);
    t.head = 0;
    t.speed = speed;
    t.life = 0.05;
    const mat = t.line.material as THREE.LineBasicMaterial;
    mat.color.copy(color).multiplyScalar(3);
    mat.opacity = 1;
    t.line.visible = true;
  }

  /** 着弾の火花 */
  impact(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, strength = 1): void {
    const b = this.bursts[this.nextBurst];
    this.nextBurst = (this.nextBurst + 1) % BURST_POOL;
    const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < SPARKS; i++) {
      pos.setXYZ(i, point.x, point.y, point.z);
      tmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6).add(normal).normalize();
      const sp = (2 + Math.random() * 5) * strength;
      b.vel[i * 3] = tmp.x * sp;
      b.vel[i * 3 + 1] = tmp.y * sp;
      b.vel[i * 3 + 2] = tmp.z * sp;
    }
    pos.needsUpdate = true;
    b.life = b.maxLife = 0.22 + Math.random() * 0.12;
    const mat = b.points.material as THREE.PointsMaterial;
    mat.color.copy(color).multiplyScalar(2.5);
    mat.opacity = 1;
    b.points.visible = true;
  }

  /** 弾痕 */
  decal(point: THREE.Vector3, normal: THREE.Vector3): void {
    const d = this.decals[this.nextDecal];
    this.nextDecal = (this.nextDecal + 1) % DECAL_POOL;
    d.mesh.position.copy(point).addScaledVector(normal, 0.004);
    d.mesh.lookAt(point.clone().add(normal));
    d.mesh.rotateZ(Math.random() * Math.PI * 2);
    d.mesh.scale.setScalar(0.8 + Math.random() * 0.5);
    (d.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    d.mesh.visible = true;
    d.age = 0;
  }

  muzzleFlash(pos: THREE.Vector3, strength = 1): void {
    this.muzzleLight.position.copy(pos);
    this.lightTimer = 0.06;
    this.muzzleLight.intensity = 7 * strength;
  }

  update(dt: number): void {
    this.lightTimer -= dt;
    this.muzzleLight.intensity = this.lightTimer > 0 ? this.muzzleLight.intensity * Math.exp(-dt * 30) : 0;

    for (const t of this.tracers) {
      if (!t.line.visible) continue;
      const pos = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (t.head < t.dist) {
        t.head = Math.min(t.dist, t.head + t.speed * dt);
      } else {
        t.life -= dt;
        (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life / 0.05);
        if (t.life <= 0) {
          t.line.visible = false;
          continue;
        }
      }
      const tail = Math.max(0, t.head - TRACER_LEN);
      const dir = t.to.clone().sub(t.from).normalize();
      const a = t.from.clone().addScaledVector(dir, tail);
      const b = t.from.clone().addScaledVector(dir, t.head);
      pos.setXYZ(0, a.x, a.y, a.z);
      pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
    }

    for (const b of this.bursts) {
      if (!b.points.visible) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.points.visible = false;
        continue;
      }
      const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < SPARKS; i++) {
        b.vel[i * 3 + 1] -= 14 * dt;
        pos.setXYZ(i, pos.getX(i) + b.vel[i * 3] * dt, pos.getY(i) + b.vel[i * 3 + 1] * dt, pos.getZ(i) + b.vel[i * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      (b.points.material as THREE.PointsMaterial).opacity = b.life / b.maxLife;
    }

    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      d.age += dt;
      if (d.age > 8) {
        const k = 1 - (d.age - 8) / 2;
        (d.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, k);
        if (k <= 0) d.mesh.visible = false;
      }
    }
  }
}
