/**
 * グレネードの見た目（世界側）。種類ごとに形と効き目の見た目が違う。
 * - 飛んでいる・刺さっているグレネード（種類ごとのモデル。光る灯りが点滅し、爆発が近いほど速く点滅する）
 *   刺さる種類（ファイアスター・グラビティスター・サッチェル）は、刺さった面に向きをそろえて止まる
 * - 爆発：フラグ・サッチェルは閃光・火球・衝撃波の輪・破片・煙・焦げ跡。アークは青白い放電の稲妻、グラビティスターは紫の爆発
 * - 効いている間：ファイアスターの炎、グラビティスターの渦、スモークの煙の幕（中に入ると画面も煙る）
 * - 構えている間の軌道の予測線と、落ちる・刺さる位置の印（効く範囲の輪）
 *
 * 光源は増やさない（光の数が変わるとシェーダーの作り直しが起きて、画面が止まるため）。光って見えるのは加算合成の板と点。
 */
import * as THREE from 'three';
import { type GrenadeId, grenadeNum, grenadesConfig } from '../../config';
import type { Grenade } from '../../shared/grenades';
import type { Vec3 } from '../../shared/math';
import type { Simulation } from '../../shared/simulation';

/** 種類ごとの色（灯り・予測線・効き目） */
export const GRENADE_COLORS: Record<GrenadeId, string> = {
  frag: '#ff3a6a',
  arc: '#5fdcff',
  firestar: '#ff7a2a',
  gravity: '#b47aff',
  smoke: '#b8ffb0',
  satchel: '#ff2a2a',
};

/** 光る部品のマテリアル名（点滅させる） */
const GLOW_MATS: Partial<Record<GrenadeId, string>> = { arc: 'ArcGlow', firestar: 'FireGlow', gravity: 'GravGlow', smoke: 'SmokeGlow', satchel: 'SatchelLed', frag: 'GrenadeGlow' };
/** 構えると抜けるピン */
const PINS: Partial<Record<GrenadeId, string>> = { frag: 'Pin', arc: 'ArcPin', smoke: 'SmokePin' };

interface Live {
  id: number;
  kind: GrenadeId;
  obj: THREE.Object3D;
  light: THREE.Mesh;
  glowMats: THREE.MeshStandardMaterial[];
  prev: THREE.Vector3;
  cur: THREE.Vector3;
  fuse: number;
  spin: THREE.Vector3;
  stuck: boolean;
  /** 刺さった向き */
  stuckQ: THREE.Quaternion | null;
  active: number | undefined;
  age: number;
}

interface Palette {
  flash: string;
  fire: string | null;
  ring: string;
  spark: string;
  smoke: boolean;
  scorch: boolean;
  bolts: boolean;
  light: string;
}

const PALETTES: Record<'frag' | 'arc' | 'gravity' | 'satchel', Palette> = {
  frag: { flash: '#fff2d8', fire: '#ff8a3a', ring: '#ffc890', spark: '#ffc070', smoke: true, scorch: true, bolts: false, light: '#ff9a50' },
  satchel: { flash: '#fff0d0', fire: '#ff7a2a', ring: '#ffb878', spark: '#ffb060', smoke: true, scorch: true, bolts: false, light: '#ff8a40' },
  arc: { flash: '#e8fbff', fire: null, ring: '#7fe8ff', spark: '#9ff0ff', smoke: false, scorch: false, bolts: true, light: '#6fd8ff' },
  gravity: { flash: '#f2e6ff', fire: '#b46cff', ring: '#c99aff', spark: '#d9b4ff', smoke: true, scorch: true, bolts: false, light: '#b07aff' },
};

interface Blast {
  t: number;
  radius: number;
  flash: THREE.Mesh;
  fire: THREE.Mesh | null;
  ring: THREE.Mesh;
  sparks: THREE.Points;
  sparkVel: Float32Array;
  smoke: THREE.Points | null;
  smokeVel: Float32Array;
  scorch: THREE.Mesh | null;
  bolts: THREE.LineSegments | null;
  boltT: number;
  center: THREE.Vector3;
  light: number;
}

/** ファイアスターの炎 */
interface FireField {
  id: number;
  group: THREE.Group;
  flames: THREE.Points;
  tongues: THREE.Points;
  glow: THREE.Mesh;
  seeds: Float32Array;
  t: number;
  /** 消えていく（0〜1。1 で消える） */
  out: number;
  base: THREE.Vector3;
  radius: number;
  onBody: boolean;
}

/** グラビティスターの渦 */
interface GravField {
  id: number;
  group: THREE.Group;
  swirl: THREE.Points;
  seeds: Float32Array;
  core: THREE.Mesh;
  hole: THREE.Mesh;
  ring: THREE.Mesh;
  t: number;
  center: THREE.Vector3;
}

/** スモークの煙の幕 */
interface SmokeField {
  id: number;
  group: THREE.Group;
  puffs: THREE.Mesh[];
  seeds: Array<{ dir: THREE.Vector3; dist: number; size: number; rot: number; spin: number; drift: THREE.Vector3 }>;
  mat: THREE.MeshBasicMaterial;
  center: THREE.Vector3;
  radius: number;
  density: number;
  ground: number;
  seen: boolean;
  t: number;
}

const SPARK_N = 60;
const SMOKE_N = 26;
const FLAME_N = 44;
const TONGUE_N = 30;
const SWIRL_N = 110;
const PUFF_N = 46;
const BOLT_SEGS = 8;
const BOLTS = 9;

function radialTexture(stops: Array<[number, string]>): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** もこもこした煙の塊（柔らかい丸をいくつも重ねる） */
function cloudTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * s * 0.22;
    const x = s / 2 + Math.cos(a) * r;
    const y = s / 2 + Math.sin(a) * r;
    const R = s * (0.14 + rnd() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, R);
    const k = 0.5 + rnd() * 0.5;
    grad.addColorStop(0, `rgba(255,255,255,${0.7 * k})`);
    grad.addColorStop(0.6, `rgba(255,255,255,${0.32 * k})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }
  // 縁を必ず透明に（板の形が見えないように）
  g.globalCompositeOperation = 'destination-in';
  const edge = g.createRadialGradient(s / 2, s / 2, s * 0.25, s / 2, s / 2, s / 2);
  edge.addColorStop(0, 'rgba(0,0,0,1)');
  edge.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = edge;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const UP = new THREE.Vector3(0, 1, 0);
const add = THREE.AdditiveBlending;

export class GrenadeView {
  readonly group = new THREE.Group();
  private live = new Map<number, Live>();
  private blasts: Blast[] = [];
  private fires = new Map<number, FireField>();
  private gravs = new Map<number, GravField>();
  private smokes = new Map<number, SmokeField>();
  private readonly glowTex = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,200,150,0.8)'],
    [1, 'rgba(255,120,40,0)'],
  ]);
  private readonly whiteGlow = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.35, 'rgba(255,255,255,0.55)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  private readonly smokeTex = radialTexture([
    [0, 'rgba(70,60,80,0.75)'],
    [0.6, 'rgba(50,40,60,0.35)'],
    [1, 'rgba(40,30,50,0)'],
  ]);
  private readonly scorchTex = radialTexture([
    [0, 'rgba(0,0,0,0.85)'],
    [0.5, 'rgba(10,6,10,0.55)'],
    [0.75, 'rgba(255,120,60,0.25)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  private readonly flameTex = radialTexture([
    [0, 'rgba(255,246,214,1)'],
    [0.22, 'rgba(255,186,80,0.95)'],
    [0.55, 'rgba(255,90,24,0.4)'],
    [1, 'rgba(255,40,0,0)'],
  ]);
  private readonly cloudTex = cloudTexture();
  private readonly puffGeo = new THREE.PlaneGeometry(1, 1);
  // 軌道の予測
  private readonly arc: THREE.Points;
  private readonly arcGeo: THREE.BufferGeometry;
  private readonly landing: THREE.Mesh;
  private readonly radiusRing: THREE.Mesh;
  /** 煙の中に入ったとき、目の前を覆う板 */
  private readonly fog: THREE.Mesh;

  /**
   * 爆発の光は1つを使い回す（爆発のたびに光を増やすと、光の数が変わってシェーダーの作り直しが起き、画面が止まるため）
   */
  private readonly blastLight = new THREE.PointLight('#ff9a50', 0, 12, 2);
  private sim: Simulation | null = null;

  constructor(private readonly models: Record<GrenadeId, THREE.Object3D>) {
    this.group.add(this.blastLight);
    // 軌道は光る点の列で描く（細い線だと見えにくいため）
    this.arcGeo = new THREE.BufferGeometry();
    this.arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 300), 3));
    const arcMat = new THREE.PointsMaterial({
      map: this.glowTex,
      size: 0.16,
      color: new THREE.Color('#ff7aa0').multiplyScalar(1.3),
      transparent: true,
      blending: add,
      depthWrite: false,
      toneMapped: false,
    });
    this.arc = new THREE.Points(this.arcGeo, arcMat);
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.group.add(this.arc);

    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#ff7aa0').multiplyScalar(1.6),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.landing = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.36, 40), ringMat);
    this.landing.visible = false;
    this.group.add(this.landing);
    const radMat = ringMat.clone();
    radMat.opacity = 0.25;
    this.radiusRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), radMat);
    this.radiusRing.visible = false;
    this.group.add(this.radiusRing);

    this.fog = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.MeshBasicMaterial({ color: '#7c818c', transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    this.fog.renderOrder = 999;
    this.fog.frustumCulled = false;
    this.fog.visible = false;
    this.group.add(this.fog);
  }

  // ---------------------------------------------------------------------------
  // 飛んでいる・刺さっているグレネード
  // ---------------------------------------------------------------------------

  private makeModel(kind: GrenadeId): { obj: THREE.Object3D; glowMats: THREE.MeshStandardMaterial[] } {
    const obj = (this.models[kind] ?? this.models.frag).clone(true);
    obj.scale.setScalar(kind === 'frag' ? 1.35 : 1.25);
    const glowMats: THREE.MeshStandardMaterial[] = [];
    const glowName = GLOW_MATS[kind];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      // 光る部品だけ、点滅させるために複製する
      const copy = (x: THREE.Material) => {
        if (x.name !== glowName) return x;
        const c = (x as THREE.MeshStandardMaterial).clone();
        glowMats.push(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(copy) : copy(m.material);
    });
    const pin = PINS[kind] ? obj.getObjectByName(PINS[kind]!) : null;
    if (pin) pin.visible = false;
    return { obj, glowMats };
  }

  spawn(id: number, pos: Vec3, fuse: number, kind: GrenadeId = 'frag'): void {
    const { obj, glowMats } = this.makeModel(kind);
    const light = new THREE.Mesh(
      new THREE.PlaneGeometry(kind === 'satchel' ? 0.32 : 0.5, kind === 'satchel' ? 0.32 : 0.5),
      new THREE.MeshBasicMaterial({ map: this.glowTex, color: new THREE.Color(GRENADE_COLORS[kind]).multiplyScalar(2), transparent: true, blending: add, depthWrite: false, toneMapped: false }),
    );
    this.group.add(obj, light);
    const p = new THREE.Vector3(pos.x, pos.y, pos.z);
    const star = kind === 'firestar' || kind === 'gravity';
    this.live.set(id, {
      id,
      kind,
      obj,
      light,
      glowMats,
      prev: p.clone(),
      cur: p.clone(),
      fuse,
      // 星は手裏剣のように速く回る
      spin: star ? new THREE.Vector3(0, 0, 26 + Math.random() * 6) : new THREE.Vector3(Math.random() * 8 + 4, Math.random() * 4, Math.random() * 6),
      stuck: false,
      stuckQ: null,
      active: undefined,
      age: 0,
    });
    if (star) obj.rotation.set(Math.PI / 2, Math.random() * Math.PI * 2, 0, 'YXZ');
  }

  /** ゲームロジックが1ティック進んだあとに呼ぶ */
  afterTick(grenades: Grenade[], sim?: Simulation): void {
    if (sim) this.sim = sim;
    const alive = new Set<number>();
    for (const g of grenades) {
      const l = this.live.get(g.id);
      if (!l) continue;
      alive.add(g.id);
      l.prev.copy(l.cur);
      l.cur.set(g.pos.x, g.pos.y, g.pos.z);
      l.fuse = g.fuse;
      l.active = g.active;
      if (g.resting) l.spin.multiplyScalar(0.8);
      if (g.stuck && !l.stuck) {
        // 刺さった：面の向きにそろえて止める（ひねりはばらばらに）
        l.stuck = true;
        l.prev.copy(l.cur);
        const n = new THREE.Vector3(g.stuck.normal.x, g.stuck.normal.y, g.stuck.normal.z).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(UP, n);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * Math.PI * 2));
        l.stuckQ = q;
      } else if (!g.stuck && l.stuck) {
        // 刺さっていた相手が倒れて落ちた
        l.stuck = false;
        l.stuckQ = null;
      }
      // 効き目
      if (g.kind === 'firestar' && g.active !== undefined && g.active >= grenadeNum(grenadesConfig.firestar, 'ARM_TIME', 0.2)) this.ensureFire(g);
      if (g.kind === 'gravity' && g.active !== undefined && g.active >= grenadeNum(grenadesConfig.gravity, 'ARM_TIME', 0.35)) this.ensureGrav(g);
    }
    for (const [id, l] of this.live) {
      if (alive.has(id)) continue;
      this.group.remove(l.obj, l.light);
      this.live.delete(id);
      // 炎はゆっくり消える。渦は爆発と一緒に消える
      const f = this.fires.get(id);
      if (f && f.out === 0) f.out = 0.001;
      const gv = this.gravs.get(id);
      if (gv) this.removeGrav(gv);
    }
    // 煙の幕：シミュレーションの煙に合わせる
    if (this.sim) {
      for (const s of this.smokes.values()) s.seen = false;
      for (const sm of this.sim.smokes()) {
        let f = this.smokes.get(sm.id);
        if (!f) {
          f = this.makeSmoke(sm.id, sm.pos);
          this.smokes.set(sm.id, f);
        }
        f.seen = true;
        f.center.set(sm.pos.x, sm.pos.y, sm.pos.z);
        f.radius = sm.radius;
        f.density = sm.density;
      }
      for (const [id, s] of this.smokes) {
        if (s.seen) continue;
        this.removeSmoke(s);
        this.smokes.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 爆発
  // ---------------------------------------------------------------------------

  /** 爆発（種類で見た目が変わる。frag・satchel は火の玉、arc は放電、gravity は紫の爆発） */
  explode(pos: Vec3, radius: number, groundY: number | null, kind: GrenadeId = 'frag'): void {
    const pal = PALETTES[kind === 'arc' || kind === 'gravity' || kind === 'satchel' ? kind : 'frag'];
    const p = new THREE.Vector3(pos.x, pos.y, pos.z);
    const flash = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.glowTex, color: new THREE.Color(pal.flash).multiplyScalar(4), transparent: true, blending: add, depthWrite: false, toneMapped: false }),
    );
    flash.position.copy(p);
    let fire: THREE.Mesh | null = null;
    if (pal.fire) {
      fire = new THREE.Mesh(
        new THREE.SphereGeometry(1, 20, 14),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.fire).multiplyScalar(3), transparent: true, blending: add, depthWrite: false, toneMapped: false }),
      );
      fire.position.copy(p);
    }
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.ring).multiplyScalar(2.5), transparent: true, blending: add, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    );
    ring.position.set(p.x, (groundY ?? p.y) + 0.05, p.z);
    ring.rotation.x = -Math.PI / 2;

    // 破片の火花
    const sGeo = new THREE.BufferGeometry();
    const sPos = new Float32Array(SPARK_N * 3);
    const sVel = new Float32Array(SPARK_N * 3);
    const sp = kind === 'arc' ? 0.6 : 1;
    for (let i = 0; i < SPARK_N; i++) {
      sPos.set([p.x, p.y, p.z], i * 3);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize().multiplyScalar((8 + Math.random() * 14) * sp);
      sVel.set([v.x, v.y, v.z], i * 3);
    }
    sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    const sparks = new THREE.Points(
      sGeo,
      new THREE.PointsMaterial({ size: 0.12, color: new THREE.Color(pal.spark).multiplyScalar(3), transparent: true, blending: add, depthWrite: false, toneMapped: false }),
    );
    sparks.frustumCulled = false;

    // 煙
    let smoke: THREE.Points | null = null;
    const mVel = new Float32Array(SMOKE_N * 3);
    if (pal.smoke) {
      const mGeo = new THREE.BufferGeometry();
      const mPos = new Float32Array(SMOKE_N * 3);
      for (let i = 0; i < SMOKE_N; i++) {
        mPos.set([p.x + (Math.random() - 0.5) * 0.6, p.y + Math.random() * 0.4, p.z + (Math.random() - 0.5) * 0.6], i * 3);
        const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.4, Math.random() - 0.5).multiplyScalar(2 + Math.random() * 2.5);
        mVel.set([v.x, v.y, v.z], i * 3);
      }
      mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
      smoke = new THREE.Points(mGeo, new THREE.PointsMaterial({ map: this.smokeTex, size: 2.2, transparent: true, depthWrite: false, opacity: 0.9 }));
      smoke.frustumCulled = false;
    }

    // 放電の稲妻（アーク）
    let bolts: THREE.LineSegments | null = null;
    if (pal.bolts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLTS * BOLT_SEGS * 2 * 3), 3));
      bolts = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color('#bff6ff').multiplyScalar(3), transparent: true, blending: add, depthWrite: false, toneMapped: false }));
      bolts.frustumCulled = false;
      this.reshapeBolts(bolts, p, radius);
    }

    const light = this.blastLight;
    light.color.set(pal.light);
    light.position.copy(p).add(new THREE.Vector3(0, 0.5, 0));
    light.distance = radius * 3.5;
    const lightBase = kind === 'satchel' ? 80 : kind === 'arc' ? 45 : 60;
    light.intensity = lightBase;

    let scorch: THREE.Mesh | null = null;
    if (pal.scorch) {
      scorch = new THREE.Mesh(
        new THREE.PlaneGeometry(radius * 0.7, radius * 0.7),
        new THREE.MeshBasicMaterial({ map: this.scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
      );
      scorch.rotation.x = -Math.PI / 2;
      scorch.rotation.z = Math.random() * Math.PI * 2;
      scorch.position.set(p.x, (groundY ?? p.y - 10) + 0.01, p.z);
      scorch.visible = groundY !== null;
    }

    for (const o of [flash, fire, ring, sparks, smoke, scorch, bolts]) if (o) this.group.add(o);
    this.blasts.push({ t: 0, radius, flash, fire, ring, sparks, sparkVel: sVel, smoke, smokeVel: mVel, scorch, bolts, boltT: 0, center: p, light: lightBase });
    // 古い爆発の跡は数を限る
    while (this.blasts.length > 8) this.disposeBlast(this.blasts.shift()!);
  }

  /** 稲妻の形を作り直す（爆心から外へ、ぎざぎざに折れながら伸びる） */
  private reshapeBolts(b: THREE.LineSegments, c: THREE.Vector3, radius: number) {
    const attr = b.geometry.getAttribute('position') as THREE.BufferAttribute;
    let k = 0;
    const dir = new THREE.Vector3();
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (let i = 0; i < BOLTS; i++) {
      dir.set(Math.random() - 0.5, Math.random() * 0.6 - 0.15, Math.random() - 0.5).normalize();
      const L = radius * (0.45 + Math.random() * 0.55);
      p.copy(c);
      for (let s = 0; s < BOLT_SEGS; s++) {
        q.copy(c).addScaledVector(dir, (L * (s + 1)) / BOLT_SEGS);
        q.x += (Math.random() - 0.5) * 0.5;
        q.y += (Math.random() - 0.5) * 0.5;
        q.z += (Math.random() - 0.5) * 0.5;
        attr.setXYZ(k++, p.x, p.y, p.z);
        attr.setXYZ(k++, q.x, q.y, q.z);
        p.copy(q);
      }
    }
    attr.needsUpdate = true;
  }

  /** シェーダーの準備用：爆発・炎・渦・煙・どの種類のモデルも1組ずつ作って渡す（起きたときに作るので、先にシェーダーを作っておく） */
  warmObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const k of ['frag', 'arc'] as GrenadeId[]) {
      this.explode({ x: 0, y: -500, z: 0 }, 4, -500, k);
      const b = this.blasts.pop()!;
      for (const o of [b.flash, b.fire, b.ring, b.sparks, b.smoke, b.scorch, b.bolts]) if (o) out.push(o);
    }
    this.blastLight.intensity = 0;
    const far = { x: 0, y: -500, z: 0 };
    const fakeG = (id: number, kind: GrenadeId): Grenade => ({ id, ownerId: -1, kind, pos: far, vel: far, fuse: 1, resting: true, stuck: { normal: { x: 0, y: 1, z: 0 }, entityId: -1, offset: far }, active: 1 });
    const f = this.makeFire(fakeG(-1, 'firestar'));
    const g = this.makeGrav(fakeG(-2, 'gravity'));
    const s = this.makeSmoke(-3, far);
    s.mat.opacity = 0.5;
    out.push(f.group, g.group, s.group);
    for (const k of Object.keys(this.models) as GrenadeId[]) {
      const m = this.makeModel(k);
      m.obj.position.set(0, -500, 0);
      out.push(m.obj);
    }
    const fog = this.fog.clone();
    fog.visible = true;
    fog.position.set(0, -500, 0);
    out.push(fog);
    return out;
  }

  private disposeBlast(b: Blast) {
    for (const o of [b.flash, b.fire, b.ring, b.sparks, b.smoke, b.scorch, b.bolts] as Array<THREE.Mesh | THREE.Points | THREE.LineSegments | null>) {
      if (!o) continue;
      this.group.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // ファイアスターの炎
  // ---------------------------------------------------------------------------

  private ensureFire(g: Grenade) {
    if (this.fires.has(g.id)) return;
    const f = this.makeFire(g);
    this.fires.set(g.id, f);
    this.group.add(f.group);
  }

  private makeFire(g: Grenade): FireField {
    const def = grenadesConfig.firestar;
    const onBody = !!g.stuck && g.stuck.entityId >= 0;
    const radius = onBody ? 0.45 : grenadeNum(def, 'FIRE_RADIUS', 2.6) * 0.85;
    const group = new THREE.Group();
    const mk = (n: number, size: number, color: string) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({ map: this.flameTex, size, color: new THREE.Color(color).multiplyScalar(0.9), transparent: true, blending: add, depthWrite: false, toneMapped: false }));
      pts.frustumCulled = false;
      group.add(pts);
      return pts;
    };
    const flames = mk(FLAME_N, onBody ? 0.6 : 0.95, '#ff6a1e');
    const tongues = mk(TONGUE_N, onBody ? 0.34 : 0.48, '#ffc060');
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.whiteGlow, color: new THREE.Color('#ff6a1a').multiplyScalar(1.5), transparent: true, blending: add, depthWrite: false, toneMapped: false }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.scale.setScalar(radius * 2.4);
    glow.visible = !onBody;
    group.add(glow);
    const seeds = new Float32Array((FLAME_N + TONGUE_N) * 4);
    for (let i = 0; i < FLAME_N + TONGUE_N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      seeds.set([Math.cos(a) * r, Math.sin(a) * r, Math.random(), 0.6 + Math.random() * 0.6], i * 4);
    }
    const f: FireField = { id: g.id, group, flames, tongues, glow, seeds, t: 0, out: 0, base: new THREE.Vector3(), radius, onBody };
    this.placeFire(f, g);
    return f;
  }

  /** 炎の根もと：地面に刺されば刺さった所。壁なら、その下の地面へ炎が垂れる（シミュレーションと同じ高さ）。敵に刺されば体と一緒に動く */
  private placeFire(f: FireField, g: Grenade) {
    const p = g.pos;
    if (f.onBody || !g.stuck || g.stuck.normal.y > 0.5) {
      f.base.set(p.x, f.onBody ? p.y - 0.4 : p.y, p.z);
      return;
    }
    const n = g.stuck.normal;
    f.base.set(p.x + n.x * 0.6, g.fireY ?? p.y - 1.2, p.z + n.z * 0.6);
  }

  private stepFire(f: FireField, dt: number) {
    f.t += dt;
    if (f.out > 0) f.out += dt / 0.7;
    // 刺さっている敵と一緒に動く
    const l = this.live.get(f.id);
    if (l && f.onBody) {
      f.base.copy(l.obj.position);
      f.base.y -= 0.4;
    }
    const fade = f.out > 0 ? Math.max(0, 1 - f.out) : Math.min(1, f.t / 0.25);
    const R = f.radius;
    const flicker = 0.85 + Math.sin(f.t * 23) * 0.08 + Math.sin(f.t * 37) * 0.07;
    const write = (pts: THREE.Points, off: number, n: number, rise: number) => {
      const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < n; i++) {
        const s = (off + i) * 4;
        const life = f.seeds[s + 3];
        const ph = (f.seeds[s + 2] + f.t / life) % 1;
        // 外ほど低く、上へ行くほど真ん中へ寄って細くなる
        const r = R * (1 - ph * 0.55);
        const x = f.base.x + f.seeds[s] * r;
        const z = f.base.z + f.seeds[s + 1] * r;
        const h = (1 - Math.hypot(f.seeds[s], f.seeds[s + 1]) * 0.6) * rise * ph * (f.onBody ? 1.6 : 1);
        attr.setXYZ(i, x, f.base.y + 0.15 + h, z);
      }
      attr.needsUpdate = true;
      (pts.material as THREE.PointsMaterial).opacity = 0.7 * fade * flicker;
    };
    write(f.flames, 0, FLAME_N, 1.4);
    write(f.tongues, FLAME_N, TONGUE_N, 2.1);
    f.glow.position.set(f.base.x, f.base.y + 0.04, f.base.z);
    (f.glow.material as THREE.MeshBasicMaterial).opacity = 0.55 * fade * flicker;
  }

  private removeFire(f: FireField) {
    this.group.remove(f.group);
    for (const o of [f.flames, f.tongues, f.glow]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // グラビティスターの渦
  // ---------------------------------------------------------------------------

  private ensureGrav(g: Grenade) {
    if (this.gravs.has(g.id)) return;
    const f = this.makeGrav(g);
    this.gravs.set(g.id, f);
    this.group.add(f.group);
  }

  private makeGrav(g: Grenade): GravField {
    const R = grenadeNum(grenadesConfig.gravity, 'PULL_RADIUS', 7);
    const group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SWIRL_N * 3), 3));
    const swirl = new THREE.Points(geo, new THREE.PointsMaterial({ map: this.whiteGlow, size: 0.13, color: new THREE.Color('#c48cff').multiplyScalar(2.2), transparent: true, blending: add, depthWrite: false, toneMapped: false }));
    swirl.frustumCulled = false;
    const seeds = new Float32Array(SWIRL_N * 4);
    for (let i = 0; i < SWIRL_N; i++) seeds.set([Math.random(), Math.random() * Math.PI * 2, Math.random() * 2 - 1, 0.7 + Math.random() * 0.8], i * 4);
    const core = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.whiteGlow, color: new THREE.Color('#b06cff').multiplyScalar(3), transparent: true, blending: add, depthWrite: false, toneMapped: false }),
    );
    const hole = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), new THREE.MeshBasicMaterial({ color: '#05020a' }));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#b07aff').multiplyScalar(1.8), transparent: true, opacity: 0.3, blending: add, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(swirl, core, hole, ring);
    const center = new THREE.Vector3();
    if (this.sim) {
      const c = this.sim.gravityCenter(g);
      center.set(c.x, c.y, c.z);
    } else center.set(g.pos.x, g.pos.y + 1, g.pos.z);
    void R;
    return { id: g.id, group, swirl, seeds, core, hole, ring, t: 0, center };
  }

  private stepGrav(f: GravField, dt: number, camera: THREE.Camera) {
    f.t += dt;
    const R = grenadeNum(grenadesConfig.gravity, 'PULL_RADIUS', 7);
    const grow = Math.min(1, f.t / 0.3);
    const attr = f.swirl.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < SWIRL_N; i++) {
      const s = i * 4;
      // 外から中心へ、回りながら吸い込まれる
      const ph = (f.seeds[s] + f.t * 0.7 * f.seeds[s + 3]) % 1;
      const r = R * 0.55 * (1 - ph) ** 1.6 + 0.12;
      const a = f.seeds[s + 1] + f.t * (2.5 + 6 * ph) * f.seeds[s + 3];
      const y = f.seeds[s + 2] * r * 0.45;
      attr.setXYZ(i, f.center.x + Math.cos(a) * r, f.center.y + y, f.center.z + Math.sin(a) * r);
    }
    attr.needsUpdate = true;
    (f.swirl.material as THREE.PointsMaterial).opacity = grow;
    f.core.position.copy(f.center);
    f.core.quaternion.copy(camera.quaternion);
    f.core.scale.setScalar((1.1 + Math.sin(f.t * 18) * 0.15 + f.t * 0.4) * grow);
    f.hole.position.copy(f.center);
    f.hole.scale.setScalar(grow * (1 + f.t * 0.5));
    // 輪は外から縮み続ける
    const rk = 1 - ((f.t * 0.9) % 1);
    f.ring.position.set(f.center.x, f.center.y - 0.9, f.center.z);
    f.ring.scale.setScalar(R * rk + 0.2);
    (f.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - rk) * grow;
  }

  private removeGrav(f: GravField) {
    this.group.remove(f.group);
    for (const o of [f.swirl, f.core, f.hole, f.ring]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.gravs.delete(f.id);
  }

  // ---------------------------------------------------------------------------
  // スモークの煙の幕
  // ---------------------------------------------------------------------------

  private makeSmoke(id: number, pos: Vec3): SmokeField {
    const group = new THREE.Group();
    // 煙は明かりを受けない色の板（街の暗さに合わせた、少し青い灰色）
    const mat = new THREE.MeshBasicMaterial({ map: this.cloudTex, color: '#8d929e', transparent: true, opacity: 0, depthWrite: false });
    const puffs: THREE.Mesh[] = [];
    const seeds: SmokeField['seeds'] = [];
    for (let i = 0; i < PUFF_N; i++) {
      const m = new THREE.Mesh(this.puffGeo, mat);
      m.frustumCulled = false;
      group.add(m);
      puffs.push(m);
      const dir = new THREE.Vector3(Math.random() - 0.5, (Math.random() - 0.35) * 0.9, Math.random() - 0.5).normalize();
      seeds.push({
        dir,
        dist: 0.1 + Math.random() * 0.75,
        size: 0.6 + Math.random() * 0.45,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.25,
        drift: new THREE.Vector3((Math.random() - 0.5) * 0.25, Math.random() * 0.12, (Math.random() - 0.5) * 0.25),
      });
    }
    let ground = pos.y - 3;
    if (this.sim) {
      const hit = this.sim.world.raycast({ x: pos.x, y: pos.y + 0.5, z: pos.z }, { x: 0, y: -1, z: 0 }, 8);
      if (hit) ground = hit.point.y;
    }
    const f: SmokeField = { id, group, puffs, seeds, mat, center: new THREE.Vector3(pos.x, pos.y, pos.z), radius: 1, density: 0, ground, seen: true, t: 0 };
    this.group.add(group);
    return f;
  }

  private stepSmoke(f: SmokeField, dt: number, camera: THREE.Camera) {
    f.t += dt;
    f.mat.opacity = 0.95 * f.density;
    for (let i = 0; i < f.puffs.length; i++) {
      const s = f.seeds[i];
      const m = f.puffs[i];
      const size = f.radius * s.size * 1.25;
      m.position.copy(f.center).addScaledVector(s.dir, f.radius * s.dist).addScaledVector(s.drift, f.t);
      // 地面にめり込まない
      m.position.y = Math.max(m.position.y, f.ground + size * 0.32);
      m.quaternion.copy(camera.quaternion);
      m.rotateZ(s.rot + s.spin * f.t);
      m.scale.setScalar(size);
    }
  }

  private removeSmoke(f: SmokeField) {
    this.group.remove(f.group);
    f.mat.dispose();
  }

  // ---------------------------------------------------------------------------
  // 軌道の予測
  // ---------------------------------------------------------------------------

  /** 予測線の色を種類に合わせる */
  setPreviewKind(kind: GrenadeId): void {
    const c = new THREE.Color(GRENADE_COLORS[kind]);
    (this.arc.material as THREE.PointsMaterial).color.copy(c).multiplyScalar(1.3);
    (this.landing.material as THREE.MeshBasicMaterial).color.copy(c).multiplyScalar(1.6);
    (this.radiusRing.material as THREE.MeshBasicMaterial).color.copy(c).multiplyScalar(1.6);
  }

  showPreview(points: Vec3[], landing: Vec3 | null, end: Vec3, radius: number, stuckNormal: Vec3 | null = null): void {
    // およそ 0.6m おきに点を置く。最初の 1m（手元）は描かない
    const attr = this.arcGeo.getAttribute('position') as THREE.BufferAttribute;
    let n = 0;
    let acc = 0;
    let travelled = 0;
    for (let i = 1; i < points.length && n < attr.count; i++) {
      const a = points[i - 1],
        b = points[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      acc += seg;
      travelled += seg;
      if (acc >= 0.6 && travelled > 1) {
        acc = 0;
        attr.setXYZ(n++, b.x, b.y, b.z);
      }
    }
    attr.needsUpdate = true;
    this.arcGeo.setDrawRange(0, n);
    this.arc.visible = n > 0;
    const at = landing ?? end;
    this.landing.visible = true;
    if (stuckNormal) {
      // 刺さる所：面に沿わせた印
      const nrm = new THREE.Vector3(stuckNormal.x, stuckNormal.y, stuckNormal.z).normalize();
      this.landing.position.set(at.x + nrm.x * 0.03, at.y + nrm.y * 0.03, at.z + nrm.z * 0.03);
      this.landing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
    } else {
      this.landing.position.set(at.x, at.y + 0.03, at.z);
      this.landing.rotation.set(-Math.PI / 2, 0, 0);
    }
    // 効く範囲の輪は地面に置く（壁に刺さるときは、その下）
    let ry = end.y;
    if (stuckNormal && stuckNormal.y < 0.5 && this.sim) {
      const hit = this.sim.world.raycast({ x: end.x + stuckNormal.x * 0.4, y: end.y, z: end.z + stuckNormal.z * 0.4 }, { x: 0, y: -1, z: 0 }, 4);
      if (hit) ry = hit.point.y;
    }
    this.radiusRing.position.set(end.x, ry + 0.03, end.z);
    this.radiusRing.rotation.set(-Math.PI / 2, 0, 0);
    this.radiusRing.scale.setScalar(radius);
    this.radiusRing.visible = true;
  }

  hidePreview(): void {
    this.arc.visible = false;
    this.landing.visible = false;
    this.radiusRing.visible = false;
  }

  // ---------------------------------------------------------------------------

  update(dt: number, alpha: number, camera: THREE.Camera): void {
    const time = performance.now() / 1000;
    for (const l of this.live.values()) {
      l.age += dt;
      l.obj.position.lerpVectors(l.prev, l.cur, alpha);
      if (l.stuckQ) l.obj.quaternion.copy(l.stuckQ);
      else {
        l.obj.rotation.x += l.spin.x * dt;
        l.obj.rotation.y += l.spin.y * dt;
        l.obj.rotation.z += l.spin.z * dt;
      }
      // 灯りの点滅：フラグ・アークは爆発が近いほど速く。サッチェルはゆっくり、刺さる星は光り続ける
      let on = true;
      let k = 1;
      switch (l.kind) {
        case 'frag':
        case 'arc': {
          const rate = l.fuse > 1.5 ? 2.5 : l.fuse > 0.7 ? 6 : 14;
          on = Math.sin(time * rate * Math.PI * (l.kind === 'arc' ? 3 : 2)) > 0;
          break;
        }
        case 'satchel':
          on = time % 1 < 0.14;
          k = 0.7;
          break;
        case 'smoke':
          on = l.active === undefined ? Math.sin(time * 10) > 0 : false;
          k = 0.6;
          break;
        default:
          k = 0.8 + Math.sin(time * 20) * 0.2;
      }
      l.light.position.copy(l.obj.position);
      l.light.quaternion.copy(camera.quaternion);
      l.light.scale.setScalar((on ? 1 : 0.35) * k);
      (l.light.material as THREE.MeshBasicMaterial).opacity = on ? 1 : 0.4;
      for (const m of l.glowMats) m.emissiveIntensity = on ? 1.6 : 0.35;
    }

    for (const [id, f] of this.fires) {
      this.stepFire(f, dt);
      if (f.out >= 1) {
        this.removeFire(f);
        this.fires.delete(id);
      }
    }
    for (const f of this.gravs.values()) this.stepGrav(f, dt, camera);

    // 煙：中に入ると、目の前も煙る
    let inside = 0;
    const cam = camera.getWorldPosition(new THREE.Vector3());
    for (const f of this.smokes.values()) {
      this.stepSmoke(f, dt, camera);
      const d = cam.distanceTo(f.center);
      inside = Math.max(inside, Math.min(1, Math.max(0, 1 - d / (f.radius * 0.95)) * 1.6) * f.density);
    }
    this.fog.visible = inside > 0.01;
    if (this.fog.visible) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      this.fog.position.copy(cam).addScaledVector(fwd, 0.2);
      this.fog.quaternion.copy(camera.quaternion);
      (this.fog.material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, inside);
    }

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.t += dt;
      const t = b.t;
      const R = b.radius;
      // 閃光（0.12秒）
      b.flash.visible = t < 0.14;
      b.flash.quaternion.copy(camera.quaternion);
      b.flash.scale.setScalar(R * 1.6 * (0.6 + t * 4));
      (b.flash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t / 0.14);
      // 火球（0.35秒で広がって消える）
      if (b.fire) {
        const ft = Math.min(1, t / 0.35);
        b.fire.visible = t < 0.35;
        b.fire.scale.setScalar(R * 0.45 * (0.3 + 0.7 * Math.sqrt(ft)));
        (b.fire.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - ft);
      }
      // 衝撃波の輪（地面を走る）
      const rt = Math.min(1, t / 0.4);
      b.ring.visible = t < 0.4;
      b.ring.scale.setScalar(R * (0.2 + 0.9 * rt));
      (b.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - rt);
      // 光
      if (b === this.blasts[this.blasts.length - 1]) this.blastLight.intensity = b.light * Math.exp(-t * 9);
      // 稲妻：0.45 秒、ちらつきながら形が変わる
      if (b.bolts) {
        b.boltT += dt;
        b.bolts.visible = t < 0.5 && Math.random() > 0.15;
        if (b.boltT > 0.05) {
          b.boltT = 0;
          this.reshapeBolts(b.bolts, b.center, R);
        }
        (b.bolts.material as THREE.LineBasicMaterial).opacity = Math.max(0, 1 - t / 0.5);
      }
      // 火花
      if (t < 1.2) {
        const pos = b.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let k = 0; k < SPARK_N; k++) {
          b.sparkVel[k * 3 + 1] -= 18 * dt;
          b.sparkVel[k * 3] *= 1 - 1.5 * dt;
          b.sparkVel[k * 3 + 2] *= 1 - 1.5 * dt;
          pos.setXYZ(k, pos.getX(k) + b.sparkVel[k * 3] * dt, pos.getY(k) + b.sparkVel[k * 3 + 1] * dt, pos.getZ(k) + b.sparkVel[k * 3 + 2] * dt);
        }
        pos.needsUpdate = true;
        (b.sparks.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - t / 1.2);
      } else b.sparks.visible = false;
      // 煙（3秒かけて広がり、薄くなる）
      if (b.smoke) {
        if (t < 3.2) {
          const pos = b.smoke.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let k = 0; k < SMOKE_N; k++) {
            b.smokeVel[k * 3] *= 1 - 2.2 * dt;
            b.smokeVel[k * 3 + 1] = b.smokeVel[k * 3 + 1] * (1 - 1.8 * dt) + 0.4 * dt;
            b.smokeVel[k * 3 + 2] *= 1 - 2.2 * dt;
            pos.setXYZ(k, pos.getX(k) + b.smokeVel[k * 3] * dt, pos.getY(k) + b.smokeVel[k * 3 + 1] * dt, pos.getZ(k) + b.smokeVel[k * 3 + 2] * dt);
          }
          pos.needsUpdate = true;
          const sm = b.smoke.material as THREE.PointsMaterial;
          sm.size = 2.2 + t * 2.2;
          sm.opacity = 0.6 * Math.max(0, 1 - t / 3.2) ** 1.5 * Math.min(1, t / 0.12);
        } else b.smoke.visible = false;
      }
      // 焦げ跡（12秒で消える）
      if (b.scorch && t > 10) (b.scorch.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - (t - 10) / 2);
      if (t > (b.scorch ? 12 : 3.5)) {
        this.disposeBlast(b);
        this.blasts.splice(i, 1);
      }
    }
  }
}
