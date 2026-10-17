/**
 * グレネード。投げると放物線を描いて飛び、地形や的に当たって跳ね返る（刺さる種類は、当たった所に刺さる）。
 * 種類（ロードアウトで 1 つ選ぶ。数値は config/grenades.json。フラグは weapons.json の COMMON.GRENADE_*）：
 * - フラグ：跳ねて転がり、時間で爆発
 * - アーク：跳ねて、時間で放電。当たった敵は動きが鈍り、狙いが乱れる
 * - ファイアスター：刺さった所が燃える（敵に刺されば、その敵ごと燃える）
 * - グラビティスター：刺さると周りの敵を引き寄せて浮かせ、そのあと爆発
 * - スモーク：跳ねて、時間で大きな煙の幕を張る（ボットも煙越しには見えない）
 * - サッチェル：張り付き、もう一度 G を押すと起爆
 * 投げる前の「軌道の予測線」も同じ計算で出すので、見た目と実際の飛び方が一致する。
 */
import { type GrenadeId, type GrenadesConfig, type WeaponCommon, grenadeNum, grenadesConfig } from '../config';
import { type Box, type CollisionWorld, capsuleVsBox } from './collision';
import { type Vec3, DEG, add, addScaled, clone, cross, dot, len, lookDir, normalize, scale, sub, v3 } from './math';
import { type Target, bodyBox } from './targets';

export interface GrenadeStuck {
  /** 刺さった面の向き */
  normal: Vec3;
  /** 刺さった参加者（地形なら -1）。参加者に刺さると、その体と一緒に動く */
  entityId: number;
  /** 参加者の足元からの位置 */
  offset: Vec3;
}

export interface Grenade {
  id: number;
  ownerId: number;
  /** 投げた人のチーム（味方には爆風が当たらない） */
  team?: number;
  /** 種類（省くとフラグ） */
  kind?: GrenadeId;
  pos: Vec3;
  vel: Vec3;
  /** 爆発・効き始めまでの残り時間（刺さる種類は、刺さらなかったときの保険） */
  fuse: number;
  /** 地面で止まっている */
  resting: boolean;
  /** 刺さった・張り付いた（刺さる種類だけ） */
  stuck?: GrenadeStuck | null;
  /** 投げてからの時間 */
  age?: number;
  /** 効いている時間（煙・炎・渦。始まっていなければ undefined） */
  active?: number;
  /** サッチェル：起爆を頼まれた */
  detonate?: boolean;
  /** ファイアスター：燃える面の高さ（壁に刺さったときは、その下の地面） */
  fireY?: number;
}

export interface BlastHit {
  targetId: number;
  damage: number;
  killed: boolean;
}

/** 飛び方（種類ごと） */
export interface GrenadePhys {
  gravity: number;
  bounce: number;
  friction: number;
  size: number;
  /** 当たった所に刺さる */
  stick: boolean;
}

/** 爆風の大きさ・強さ */
export interface BlastSpec {
  radius: number;
  inner: number;
  max: number;
  min: number;
}

/** フラグの数値（weapons.json の COMMON）と、grenades.json の名前の対応 */
const FRAG_KEYS: Record<string, keyof WeaponCommon> = {
  COUNT: 'GRENADE_COUNT',
  REGEN_TIME: 'GRENADE_REGEN_TIME',
  FUSE: 'GRENADE_FUSE',
  THROW_SPEED: 'GRENADE_THROW_SPEED',
  GRAVITY: 'GRENADE_GRAVITY',
  BOUNCE: 'GRENADE_BOUNCE',
  FRICTION: 'GRENADE_FRICTION',
  SIZE: 'GRENADE_SIZE',
  RADIUS: 'GRENADE_BLAST_RADIUS',
  INNER_RADIUS: 'GRENADE_INNER_RADIUS',
  MAX_DAMAGE: 'GRENADE_MAX_DAMAGE',
  MIN_DAMAGE: 'GRENADE_MIN_DAMAGE',
};

/** 種類ごとの数値。書いていなければフラグと同じ（COMMON.GRENADE_*） */
export function gStat(kind: GrenadeId | undefined, key: string, c: WeaponCommon, g: GrenadesConfig = grenadesConfig): number {
  const k = kind ?? 'frag';
  const fk = FRAG_KEYS[key];
  const fallback = fk ? (c[fk] as number) : 0;
  if (k === 'frag') return fallback;
  return grenadeNum(g[k], key, fallback);
}

export const grenadeCount = (kind: GrenadeId | undefined, c: WeaponCommon) => gStat(kind, 'COUNT', c);
export const grenadeRegenTime = (kind: GrenadeId | undefined, c: WeaponCommon) => gStat(kind, 'REGEN_TIME', c);
export const isSticky = (kind: GrenadeId | undefined, g: GrenadesConfig = grenadesConfig) => !!g[kind ?? 'frag'].STICK;

export function grenadePhys(kind: GrenadeId | undefined, c: WeaponCommon, g: GrenadesConfig = grenadesConfig): GrenadePhys {
  return {
    gravity: gStat(kind, 'GRAVITY', c, g),
    bounce: gStat(kind, 'BOUNCE', c, g),
    friction: gStat(kind, 'FRICTION', c, g),
    size: gStat(kind, 'SIZE', c, g),
    stick: isSticky(kind, g),
  };
}

export function blastSpec(kind: GrenadeId | undefined, c: WeaponCommon, g: GrenadesConfig = grenadesConfig): BlastSpec {
  return { radius: gStat(kind, 'RADIUS', c, g), inner: gStat(kind, 'INNER_RADIUS', c, g), max: gStat(kind, 'MAX_DAMAGE', c, g), min: gStat(kind, 'MIN_DAMAGE', c, g) };
}

/**
 * 投げてから効き始めるまで（予測線の長さ・爆発の時間）。刺さる種類は刺さってから効くので、
 * ここでは「刺さらなかったときの保険」の時間を返す
 */
export function grenadeFuse(kind: GrenadeId | undefined, c: WeaponCommon, g: GrenadesConfig = grenadesConfig): number {
  const k = kind ?? 'frag';
  if (k === 'satchel') return grenadeNum(g.satchel, 'LIFE', 90);
  if (isSticky(k, g)) return 6;
  return gStat(k, 'FUSE', c, g);
}

/** 投げる向きと速さ（視線より少し上へ、自分の動きの一部を引き継ぐ） */
export function throwVelocity(yaw: number, pitch: number, ownerVel: Vec3, c: WeaponCommon, speed = c.GRENADE_THROW_SPEED): Vec3 {
  const p = Math.min(Math.PI / 2 - 0.01, pitch + c.GRENADE_UP_ANGLE * DEG);
  return addScaled(scale(lookDir(yaw, p), speed), ownerVel, c.GRENADE_INHERIT_VEL);
}

/** 投げる位置（目の少し前・右下） */
export function throwOrigin(eye: Vec3, yaw: number, pitch: number): Vec3 {
  const fwd = lookDir(yaw, pitch);
  const right = normalize(cross(fwd, v3(0, 1, 0)));
  return add(add(eye, scale(fwd, 0.45)), add(scale(right, 0.12), v3(0, -0.12, 0)));
}

/** 的の体を、グレネードが跳ね返る箱として作る */
export function targetColliders(targets: Target[]): Box[] {
  return targets.filter((t) => t.alive).map((t) => ({ ...bodyBox(t), id: -1000 - t.id }));
}

/** フラグの飛び方（古い呼び方のため） */
const fragPhys = (c: WeaponCommon): GrenadePhys => ({ gravity: c.GRENADE_GRAVITY, bounce: c.GRENADE_BOUNCE, friction: c.GRENADE_FRICTION, size: c.GRENADE_SIZE, stick: false });

/**
 * 1ティック分動かす。跳ね返り・転がり・停止を計算する。刺さる種類は、最初に当たった所で止まる（g.stuck）。
 * extra には的など、地形以外で跳ね返るものを渡す。跳ねたら true
 */
export function stepGrenadePhysics(g: Grenade, world: CollisionWorld, extra: Box[], cOrPhys: WeaponCommon | GrenadePhys, dt: number): boolean {
  const ph: GrenadePhys = 'gravity' in cOrPhys ? cOrPhys : fragPhys(cOrPhys);
  let bounced = false;
  if (g.resting || g.stuck) return false;
  const steps = 4;
  const h = dt / steps;
  const r = ph.size;
  for (let s = 0; s < steps; s++) {
    g.vel.y -= ph.gravity * h;
    const before = clone(g.pos);
    g.pos = addScaled(g.pos, g.vel, h);
    // 刺さる種類：速く飛ぶので、通り抜けないように線で確かめる
    if (ph.stick) {
      const step = sub(g.pos, before);
      const L = len(step);
      if (L > 1e-6) {
        const hit = world.raycast(before, scale(step, 1 / L), L + r);
        if (hit) {
          g.pos = addScaled(hit.point, hit.normal, r * 0.6);
          g.vel = v3();
          g.stuck = { normal: clone(hit.normal), entityId: -1, offset: v3() };
          return true;
        }
      }
    }
    // 押し出しと跳ね返り
    for (let iter = 0; iter < 3; iter++) {
      let hit: { normal: Vec3; depth: number } | null = null;
      for (const ct of world.overlaps(g.pos, g.pos, r)) {
        if (!hit || ct.depth > hit.depth) hit = ct;
      }
      for (const box of extra) {
        const ct = capsuleVsBox(g.pos, g.pos, r, box);
        if (ct && (!hit || ct.depth > hit.depth)) hit = ct;
      }
      if (!hit) break;
      g.pos = addScaled(g.pos, hit.normal, hit.depth + 1e-4);
      if (ph.stick) {
        g.vel = v3();
        g.stuck = { normal: clone(hit.normal), entityId: -1, offset: v3() };
        return true;
      }
      const vn = dot(g.vel, hit.normal);
      if (vn < 0) {
        // 法線方向は跳ね返り、面に沿った方向は摩擦で遅くなる
        const normalPart = scale(hit.normal, vn);
        const tangent = sub(g.vel, normalPart);
        g.vel = add(scale(tangent, ph.friction), scale(normalPart, -ph.bounce));
        if (-vn > 1.5) bounced = true;
        // 地面の上でほとんど動かなくなったら止める
        if (hit.normal.y > 0.7 && len(g.vel) < 0.6) {
          g.vel = v3();
          g.resting = true;
        }
      }
    }
    if (g.resting) break;
  }
  return bounced;
}

/** 爆風のダメージ（中心ほど大きい。間に壁があれば届かない） */
export function blastDamageOf(center: Vec3, targetPos: Vec3, world: CollisionWorld, b: BlastSpec, aimHeight = 0.78): number {
  const aim = add(targetPos, v3(0, aimHeight, 0));
  const d = len(sub(aim, center));
  if (d > b.radius) return 0;
  // 遮蔽：爆心から的の胴までの間に地形があればダメージなし
  const dir = normalize(sub(aim, center));
  const lifted = add(center, v3(0, 0.05, 0));
  const block = world.raycast(lifted, dir, Math.max(0, d - 0.3));
  if (block) return 0;
  if (d <= b.inner) return b.max;
  const k = (d - b.inner) / Math.max(1e-3, b.radius - b.inner);
  return b.max + (b.min - b.max) * k;
}

/** フラグの爆風のダメージ */
export function blastDamage(center: Vec3, targetPos: Vec3, world: CollisionWorld, c: WeaponCommon, aimHeight = 0.78): number {
  return blastDamageOf(center, targetPos, world, { radius: c.GRENADE_BLAST_RADIUS, inner: c.GRENADE_INNER_RADIUS, max: c.GRENADE_MAX_DAMAGE, min: c.GRENADE_MIN_DAMAGE }, aimHeight);
}

/** 投げる前の軌道の予測（点の列と、最初に地面に落ちる位置。刺さる種類は刺さる所まで） */
export function predictPath(
  origin: Vec3,
  vel: Vec3,
  fuse: number,
  world: CollisionWorld,
  extra: Box[],
  cOrPhys: WeaponCommon | GrenadePhys,
  dt: number,
): { points: Vec3[]; landing: Vec3 | null; end: Vec3; stuck: GrenadeStuck | null } {
  const g: Grenade = { id: -1, ownerId: -1, pos: clone(origin), vel: clone(vel), fuse, resting: false, stuck: null };
  const points: Vec3[] = [clone(g.pos)];
  let landing: Vec3 | null = null;
  for (let t = 0; t < fuse && t < 4; t += dt) {
    const before = clone(g.vel);
    stepGrenadePhysics(g, world, extra, cOrPhys, dt);
    points.push(clone(g.pos));
    if (g.stuck) {
      landing = clone(g.pos);
      break;
    }
    if (!landing && (g.resting || (before.y < 0 && g.vel.y > before.y + 0.5))) landing = clone(g.pos);
    if (g.resting) break;
  }
  return { points, landing, end: clone(g.pos), stuck: g.stuck ?? null };
}
