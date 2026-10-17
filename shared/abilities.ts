/**
 * キャラクターのアビリティ（Q）とパッシブ。
 * どれもゲームロジック側で計算し、描画側は出来事（events）と状態を見て演出するだけ。
 */
import {
  type CharacterId,
  type CharactersConfig,
  type WeaponsConfig,
  abilityNum,
  passiveNum,
} from '../config';
import type { CollisionWorld } from './collision';
import type { InputCommand } from './input';
import { type Vec3, add, clone, dot, horiz, len, lookDir, normalize, scale, sub, v3 } from './math';
import { type PlayerMovement, endGrapple, startGrapple } from './movement';
import { type Target, rayVsTarget } from './targets';
import type { Arsenal } from './weapons';
import { type Actor, chestOf, rayVsActor } from './hitbox';

export interface AbilityState {
  char: CharacterId;
  /** 次に使えるまでの時間 */
  cooldown: number;
  /** 光学迷彩の残り時間 */
  cloak: number;
  /** オーバードライブ：注射の動作の残り時間と、効果の残り時間 */
  inject: number;
  overdrive: number;
  /** フェイズシフト：準備の残り時間と、位相の残り時間 */
  phaseWindup: number;
  phase: number;
  /** 出しているシールドの番号（なければ -1） */
  shieldId: number;
}

export interface ShieldWall {
  id: number;
  ownerId: number;
  center: Vec3;
  /** 正面の向き（ラジアン。yaw と同じ向きの決め方） */
  yaw: number;
  width: number;
  height: number;
  time: number;
  /** 弾を防いだ回数（演出用） */
  hits: number;
  /** 出していられる時間（なければミランダのシールドの長さ） */
  duration?: number;
  /** ブーストのハードカバー（大きく、色が違う） */
  kind?: 'hardcover';
}

export type AbilityEvent =
  | { type: 'abilityUsed'; ability: string }
  | { type: 'abilityNotReady' }
  | { type: 'grappleStart'; point: Vec3 }
  | { type: 'grappleTarget'; targetId: number; point: Vec3 }
  /** ワイヤーが敵に当たった（引き寄せはシミュレーションが行う） */
  | { type: 'grappleActor'; actorId: number; point: Vec3 }
  | { type: 'grappleMiss'; point: Vec3 }
  | { type: 'cloakStart' }
  | { type: 'cloakEnd'; broken: boolean }
  | { type: 'shieldStart'; shieldId: number }
  | { type: 'sonarPulse'; origin: Vec3; radius: number; revealed: number[]; revealedActors: { id: number; delay: number }[] }
  | { type: 'injectStart' }
  | { type: 'overdriveStart' }
  | { type: 'overdriveEnd' }
  | { type: 'phaseWindup' }
  | { type: 'phaseStart' }
  | { type: 'phaseEnd' };

export function createAbilityState(char: CharacterId): AbilityState {
  return { char, cooldown: 0, cloak: 0, inject: 0, overdrive: 0, phaseWindup: 0, phase: 0, shieldId: -1 };
}

export interface AbilityContext {
  world: CollisionWorld;
  targets: Target[];
  shields: ShieldWall[];
  /** 敵チームの参加者（ワイヤーフック・ソナーの相手） */
  actors?: Actor[];
  ccfg: CharactersConfig;
  wcfg: WeaponsConfig;
  newShieldId(): number;
}

/** パッシブと、いま効いているアビリティから、移動の補正を決める */
export function applyMoveMods(m: PlayerMovement, s: AbilityState, ccfg: CharactersConfig): void {
  const def = ccfg[s.char];
  let speed = passiveNum(def.PASSIVE, 'SPEED_MUL', 1);
  if (s.overdrive > 0) speed *= abilityNum(def.ABILITY, 'SPEED_MUL', 1);
  if (s.phase > 0) speed *= abilityNum(def.ABILITY, 'SPEED_MUL', 1);
  m.mods.speedMul = speed;
  m.mods.wallrunTimeMul = passiveNum(def.PASSIVE, 'WALLRUN_TIME_MUL', 1);
}

/** 無敵か（フェイズシフト中） */
export const isPhased = (s: AbilityState) => s.phase > 0;
/** 透明か */
export const isCloaked = (s: AbilityState) => s.cloak > 0;

/** 体力の回復の設定（パッシブとオーバードライブを反映） */
export function regenParams(s: AbilityState, ccfg: CharactersConfig): { delay: number; rate: number } {
  const def = ccfg[s.char];
  let delay = passiveNum(def.PASSIVE, 'REGEN_DELAY', ccfg.COMMON.REGEN_DELAY);
  let rate = ccfg.COMMON.REGEN_RATE * passiveNum(def.PASSIVE, 'REGEN_RATE_MUL', 1);
  if (s.overdrive > 0) {
    rate *= abilityNum(def.ABILITY, 'REGEN_MUL', 1);
    delay = 0;
  }
  return { delay, rate };
}

/** 1ティック分のアビリティの更新 */
export function stepAbility(
  s: AbilityState,
  ownerId: number,
  m: PlayerMovement,
  a: Arsenal,
  eye: Vec3,
  cmd: InputCommand,
  ctx: AbilityContext,
  dt: number,
  events: AbilityEvent[],
): void {
  const def = ctx.ccfg[s.char];
  const ab = def.ABILITY;
  s.cooldown = Math.max(0, s.cooldown - dt);

  // --- 効いているアビリティの時間を進める ---
  if (s.cloak > 0) {
    // 撃つ・殴る・投げると解除
    const broke = a.events.some((e) => e.type === 'shot' || e.type === 'melee' || e.type === 'grenadeThrow');
    s.cloak = broke ? 0 : Math.max(0, s.cloak - dt);
    if (s.cloak <= 0) events.push({ type: 'cloakEnd', broken: broke });
  }
  if (s.inject > 0) {
    s.inject = Math.max(0, s.inject - dt);
    if (s.inject <= 0) {
      s.overdrive = abilityNum(ab, 'DURATION', 6);
      events.push({ type: 'overdriveStart' });
    }
  } else if (s.overdrive > 0) {
    s.overdrive = Math.max(0, s.overdrive - dt);
    if (s.overdrive <= 0) events.push({ type: 'overdriveEnd' });
  }
  if (s.phaseWindup > 0) {
    s.phaseWindup = Math.max(0, s.phaseWindup - dt);
    if (s.phaseWindup <= 0) {
      s.phase = abilityNum(ab, 'DURATION', 3);
      events.push({ type: 'phaseStart' });
    }
  } else if (s.phase > 0) {
    s.phase = Math.max(0, s.phase - dt);
    if (s.phase <= 0) events.push({ type: 'phaseEnd' });
  }
  // フェイズシフト中は撃つ・投げる・殴る・エイムができない
  if (s.phaseWindup > 0 || s.phase > 0) {
    a.actionLock = Math.max(a.actionLock, s.phaseWindup + s.phase);
    a.cooking = false;
  }
  for (let i = ctx.shields.length - 1; i >= 0; i--) {
    const sh = ctx.shields[i];
    if (sh.ownerId !== ownerId) continue;
    sh.time -= dt;
    if (sh.time <= 0) {
      ctx.shields.splice(i, 1);
      if (s.shieldId === sh.id) s.shieldId = -1;
    }
  }

  // --- 発動 ---
  if (!cmd.abilityPressed) return;
  if (s.cooldown > 0 || m.state === 'mantle' || s.phase > 0 || s.phaseWindup > 0) {
    events.push({ type: 'abilityNotReady' });
    return;
  }
  const look = lookDir(cmd.yaw, cmd.pitch);
  switch (ab.TYPE) {
    case 'grapple': {
      const range = abilityNum(ab, 'RANGE', 35);
      const wh = ctx.world.raycast(eye, look, range);
      let best: { t: Target; dist: number; point: Vec3 } | null = null;
      for (const t of ctx.targets) {
        const h = rayVsTarget(eye, look, wh ? wh.t : range, t);
        if (h && (!best || h.t < best.dist)) best = { t, dist: h.t, point: h.point };
      }
      // 敵に当たったら、敵を引き寄せる（的より手前のとき）
      let bestActor: { a: Actor; dist: number; point: Vec3 } | null = null;
      for (const ac of ctx.actors ?? []) {
        const h = rayVsActor(eye, look, best ? best.dist : wh ? wh.t : range, ac);
        if (h && (!bestActor || h.t < bestActor.dist)) bestActor = { a: ac, dist: h.t, point: h.point };
      }
      if (bestActor) {
        events.push({ type: 'grappleActor', actorId: bestActor.a.id, point: clone(chestOf(bestActor.a)) });
      } else if (best) {
        // 的を自分の方へ引き寄せ、よろめかせる
        const t = best.t;
        const toMe = normalize(horiz(sub(m.pos, t.pos)));
        const room = Math.max(0, Math.min(abilityNum(ab, 'TARGET_PULL_DIST', 4), len(horiz(sub(m.pos, t.pos))) - 1.5));
        t.pull = add(t.pull, scale(toMe, room));
        t.pos = add(t.pos, scale(toMe, room));
        t.stagger = abilityNum(ab, 'TARGET_STAGGER_TIME', 1.2);
        t.sinceHit = 0;
        events.push({ type: 'grappleTarget', targetId: t.id, point: best.point });
      } else if (wh) {
        startGrapple(m, wh.point, {
          maxTime: abilityNum(ab, 'MAX_TIME', 1.6),
          accel: abilityNum(ab, 'PULL_ACCEL', 55),
          maxSpeed: abilityNum(ab, 'PULL_MAX_SPEED', 24),
          releaseDist: abilityNum(ab, 'RELEASE_DIST', 1.6),
        });
        events.push({ type: 'grappleStart', point: clone(wh.point) });
      } else {
        // 外れたときは短い待ち時間だけ
        events.push({ type: 'grappleMiss', point: add(eye, scale(look, range)) });
        s.cooldown = 1;
        return;
      }
      break;
    }
    case 'cloak':
      s.cloak = abilityNum(ab, 'DURATION', 5);
      events.push({ type: 'cloakStart' });
      break;
    case 'shield': {
      // 前の壁は消して、目の前に新しく出す
      if (s.shieldId >= 0) {
        const i = ctx.shields.findIndex((x) => x.id === s.shieldId);
        if (i >= 0) ctx.shields.splice(i, 1);
      }
      const fwd = normalize(horiz(look));
      const dist = abilityNum(ab, 'DISTANCE', 1.6);
      const h = abilityNum(ab, 'HEIGHT', 2.4);
      const base = add(m.pos, scale(fwd, dist));
      // 足元の高さにそろえる（段差の上なら少し上げる）
      const ground = ctx.world.raycast(add(base, v3(0, 1.2, 0)), v3(0, -1, 0), 3);
      const y = ground ? ground.point.y : m.pos.y;
      const sh: ShieldWall = {
        id: ctx.newShieldId(),
        ownerId,
        center: v3(base.x, y + h / 2, base.z),
        yaw: cmd.yaw,
        width: abilityNum(ab, 'WIDTH', 4),
        height: h,
        time: abilityNum(ab, 'DURATION', 8),
        hits: 0,
      };
      ctx.shields.push(sh);
      s.shieldId = sh.id;
      events.push({ type: 'shieldStart', shieldId: sh.id });
      break;
    }
    case 'sonar': {
      const radius = abilityNum(ab, 'RADIUS', 40);
      const speed = abilityNum(ab, 'WAVE_SPEED', 60);
      const revealed: number[] = [];
      for (const t of ctx.targets) {
        if (!t.alive) continue;
        const d = len(sub(t.pos, m.pos));
        if (d > radius) continue;
        t.revealDelay = d / speed;
        t.revealed = abilityNum(ab, 'REVEAL_TIME', 3);
        revealed.push(t.id);
      }
      const revealedActors: { id: number; delay: number }[] = [];
      for (const ac of ctx.actors ?? []) {
        const d = len(sub(ac.pos, m.pos));
        if (d <= radius) revealedActors.push({ id: ac.id, delay: d / speed });
      }
      events.push({ type: 'sonarPulse', origin: clone(eye), radius, revealed, revealedActors });
      break;
    }
    case 'overdrive':
      s.inject = abilityNum(ab, 'INJECT_TIME', 0.4);
      a.actionLock = Math.max(a.actionLock, s.inject);
      a.reloading = false;
      a.cooking = false;
      events.push({ type: 'injectStart' });
      break;
    case 'phase':
      if (m.grapple) endGrapple(m, 'cancel');
      s.phaseWindup = abilityNum(ab, 'WINDUP', 0.5);
      a.actionLock = Math.max(a.actionLock, s.phaseWindup + abilityNum(ab, 'DURATION', 3));
      a.reloading = false;
      a.cooking = false;
      events.push({ type: 'phaseWindup' });
      break;
  }
  s.cooldown = ab.COOLDOWN;
  events.push({ type: 'abilityUsed', ability: ab.TYPE });
}

/** 光線とシールドの交差（シールドの正面・背面どちらからでも当たる）。当たった距離を返す */
export function rayVsShield(origin: Vec3, dir: Vec3, maxT: number, sh: ShieldWall): number | null {
  const n = lookDir(sh.yaw, 0); // 壁の正面方向
  const denom = dot(dir, n);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(sub(sh.center, origin), n) / denom;
  if (t < 0 || t > maxT) return null;
  const p = add(origin, scale(dir, t));
  const local = sub(p, sh.center);
  const right = v3(Math.cos(sh.yaw), 0, -Math.sin(sh.yaw));
  if (Math.abs(dot(local, right)) > sh.width / 2) return null;
  if (Math.abs(local.y) > sh.height / 2) return null;
  return t;
}

