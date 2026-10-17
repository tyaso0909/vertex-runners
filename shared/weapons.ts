/**
 * 射撃のゲームロジック。弾は撃った瞬間に届く「ヒットスキャン」方式。
 * - 持ち替え、エイム（ADS）、リロード、連射、弾のばらつき、距離による威力の低下、ヘッドショット
 * - 乱数は参加者ごとに固定の種から作るので、同じ入力なら同じ結果になる（将来サーバーで再現できる）
 */
import type { GrenadeId, WeaponId, WeaponsConfig } from '../config';
import { type CustomWeaponDef, type WeaponCustom, defaultCustom, repairCustom, slotDef } from './weaponCustom';
import type { CollisionWorld } from './collision';
import type { InputCommand } from './input';
import { type Vec3, DEG, add, clamp, cross, dot, horiz, len, lenH, lookDir, normalize, scale, sub, v3 } from './math';
import type { PlayerMovement } from './movement';
import { type Target, bodyOf, damageTarget, rayVsTarget } from './targets';
import { gStat, grenadeCount, grenadeFuse, grenadeRegenTime, throwOrigin, throwVelocity } from './grenades';
import { type Actor, chestOf, rayVsActor } from './hitbox';
import { type ShieldWall, rayVsShield } from './abilities';

export interface WeaponSlot {
  id: WeaponId;
  ammo: number;
  reserve: number;
  /** サイト・アタッチメント。数値は slotDef で、これを当てはめたものを使う */
  custom: WeaponCustom;
}

export type WeaponEvent =
  | { type: 'shot'; weapon: WeaponId; origin: Vec3; dirs: Vec3[]; hits: ShotHit[]; suppressed: boolean }
  | { type: 'dryFire'; weapon: WeaponId }
  | { type: 'reloadStart'; weapon: WeaponId; perShell: boolean }
  | { type: 'reloadShell'; weapon: WeaponId }
  | { type: 'reloadEnd'; weapon: WeaponId }
  | { type: 'swap'; weapon: WeaponId }
  | { type: 'targetKilled'; targetId: number; ttk: number }
  /** 参加者（敵のパイロット・歩兵）に当たった。ダメージはシミュレーションが与える */
  | { type: 'actorHit'; actorId: number; damage: number; head: boolean; point: Vec3; source: 'shot' | 'melee' }
  | { type: 'grenadeCook' }
  | { type: 'grenadeThrow'; origin: Vec3; vel: Vec3; fuse: number; kind: GrenadeId }
  /** サッチェルを起爆する（置いたサッチェルがあるときに G を押した） */
  | { type: 'grenadeDetonate' }
  | { type: 'grenadeEmpty' }
  /** 回転式の銃身が回り始めた・止まった */
  | { type: 'spinUp'; weapon: WeaponId }
  | { type: 'spinDown'; weapon: WeaponId }
  | { type: 'grenadeRegen'; count: number }
  | { type: 'melee'; hit: MeleeHit | null; lunge: boolean };

export interface MeleeHit {
  kind: 'target' | 'world' | 'actor';
  targetId?: number;
  actorId?: number;
  damage?: number;
  point: Vec3;
  normal: Vec3;
}

export interface ShotHit {
  point: Vec3;
  normal: Vec3;
  /** 当たったもの：地形か的か、参加者（敵）か、シールドか、何も当たらなかったか */
  kind: 'world' | 'target' | 'actor' | 'shield' | 'none';
  targetId?: number;
  actorId?: number;
  shieldId?: number;
  damage?: number;
  head?: boolean;
  distance: number;
}

export interface Arsenal {
  slots: [WeaponSlot, WeaponSlot];
  active: 0 | 1;
  /** 次に撃てるまでの時間 */
  cooldown: number;
  /** 持ち替え中の残り時間 */
  swapTimer: number;
  reloading: boolean;
  reloadTimer: number;
  /** エイムの度合い（0＝腰だめ、1＝完全にエイム） */
  ads: number;
  /** 連射で広がったばらつき（度） */
  bloom: number;
  /** 撃ち続けている時間（LMG の集弾性向上に使う） */
  sustained: number;
  /** 撃っていない時間 */
  sinceShot: number;
  /** 3点射の残りの弾数（0 なら点射の途中ではない） */
  burstLeft: number;
  /** 回転式の銃身の回り具合（0〜1。1 で一番速く撃てる） */
  spin: number;
  rng: number;
  events: WeaponEvent[];
  /** グレネードの種類（ロードアウトで選ぶ） */
  grenadeKind: GrenadeId;
  /** グレネードの所持数 */
  grenades: number;
  /** 置いてあるサッチェルの数（シミュレーションが毎ティック数える。あれば G で起爆する） */
  satchelsOut: number;
  /** 前のティックに G を押していたか（起爆は押した瞬間だけ） */
  grenadeHeldPrev: boolean;
  /** グレネードが1つ回復するまでの時間 */
  grenadeRegen: number;
  /** グレネードを構えている（ボタンを押している） */
  cooking: boolean;
  /** 次にグレネードを投げられるまでの時間 */
  grenadeCooldown: number;
  /** 次に格闘できるまでの時間 */
  meleeCooldown: number;
  /** 投げた直後・格闘の直後で、撃てない残り時間 */
  actionLock: number;
  /** 直前の動作（武器の表示の動きを決める） */
  lastAction: 'none' | 'throw' | 'melee';
}

/** customs：メイン・サブのカスタマイズ（なければ、その武器に最初から付いているサイトだけ） */
export function createArsenal(
  primary: WeaponId,
  secondary: WeaponId,
  cfg: WeaponsConfig,
  seed: number,
  customs?: [WeaponCustom?, WeaponCustom?],
  grenadeKind: GrenadeId = 'frag',
): Arsenal {
  const slot = (id: WeaponId, c?: WeaponCustom): WeaponSlot => {
    const custom = c ? repairCustom(c, cfg[id]) : defaultCustom(cfg[id]);
    const s: WeaponSlot = { id, ammo: 0, reserve: cfg[id].RESERVE, custom };
    s.ammo = slotDef(cfg, s).MAG_SIZE;
    return s;
  };
  return {
    slots: [slot(primary, customs?.[0]), slot(secondary, customs?.[1])],
    active: 0,
    cooldown: 0,
    swapTimer: 0,
    reloading: false,
    reloadTimer: 0,
    ads: 0,
    bloom: 0,
    sustained: 0,
    sinceShot: 99,
    burstLeft: 0,
    spin: 0,
    rng: seed >>> 0 || 1,
    events: [],
    grenadeKind,
    grenades: grenadeCount(grenadeKind, cfg.COMMON),
    satchelsOut: 0,
    grenadeHeldPrev: false,
    grenadeRegen: 0,
    cooking: false,
    grenadeCooldown: 0,
    meleeCooldown: 0,
    actionLock: 0,
    lastAction: 'none',
  };
}

/** 予備弾が無限か */
export const infiniteReserve = (cfg: WeaponsConfig) => !!cfg.COMMON.INFINITE_RESERVE;

export const activeSlot = (a: Arsenal) => a.slots[a.active];

/** 弾薬を満タンにする（スタート地点に戻ったときなど） */
export function refillArsenal(a: Arsenal, cfg: WeaponsConfig): void {
  for (const s of a.slots) {
    s.ammo = slotDef(cfg, s).MAG_SIZE;
    s.reserve = cfg[s.id].RESERVE;
  }
  a.reloading = false;
  a.grenades = grenadeCount(a.grenadeKind, cfg.COMMON);
  a.grenadeRegen = 0;
  a.cooking = false;
}

/** 0〜1 の乱数（mulberry32） */
function rand(a: Arsenal): number {
  let t = (a.rng = (a.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** いまの連射速度（発/分）。回転式は回り具合で RPM_MIN から RPM まで上がる */
export function currentRpm(w: { RPM: number; RPM_MIN: number; SPINUP_TIME: number }, spin: number): number {
  if (w.SPINUP_TIME <= 0 || w.RPM_MIN <= 0) return w.RPM;
  return w.RPM_MIN + (w.RPM - w.RPM_MIN) * clamp(spin, 0, 1);
}

/** 1 秒あたりに撃てるおおよその弾数（3点射は点射の間の待ちも入れる。表示・ボットの判断用） */
export function sustainedRpm(w: { RPM: number; RPM_MIN: number; SPINUP_TIME: number; BURST: number; BURST_DELAY: number }): number {
  if (w.BURST > 1) return (w.BURST * 60) / ((w.BURST * 60) / w.RPM + w.BURST_DELAY);
  return w.RPM;
}

/** 移動速度の倍率（持っている武器とエイムで変わる） */
export function weaponSpeedMul(a: Arsenal, cfg: WeaponsConfig): number {
  const w = slotDef(cfg, activeSlot(a));
  return w.MOVE_SPEED_MUL * (1 - a.ads * (1 - w.ADS_MOVE_MUL));
}

/** いまの弾のばらつき（度。円錐の半角） */
export function currentSpread(a: Arsenal, m: PlayerMovement, cfg: WeaponsConfig): number {
  const w = slotDef(cfg, activeSlot(a));
  const c = cfg.COMMON;
  let s = w.HIP_SPREAD + (w.ADS_SPREAD - w.HIP_SPREAD) * a.ads;
  // 動いているとばらつく（エイム中は影響が小さい）
  const speedK = clamp(lenH(m.vel) / 8, 0, 1);
  s += c.MOVE_SPREAD_ADD * w.MOVE_SPREAD_MUL * speedK * (1 - a.ads * 0.75);
  if (m.state === 'air') s *= c.AIR_SPREAD_MUL;
  else if (m.state === 'wallrun') s *= c.WALLRUN_SPREAD_MUL;
  else if (m.state === 'slide') s *= c.SLIDE_SPREAD_MUL;
  else if (m.crouched) s *= c.CROUCH_SPREAD_MUL;
  // 撃ち続けるほど集弾が良くなる武器（LMG）
  if (w.SUSTAINED_MIN_MUL < 1) {
    const k = clamp(a.sustained / w.SUSTAINED_TIME, 0, 1);
    s *= 1 + (w.SUSTAINED_MIN_MUL - 1) * k;
  }
  return Math.max(0, s + a.bloom);
}

/** 距離による威力の倍率 */
export function falloffMul(w: { FALLOFF_START: number; FALLOFF_END: number; FALLOFF_MIN_MUL: number }, dist: number): number {
  if (dist <= w.FALLOFF_START) return 1;
  if (dist >= w.FALLOFF_END) return w.FALLOFF_MIN_MUL;
  const k = (dist - w.FALLOFF_START) / (w.FALLOFF_END - w.FALLOFF_START);
  return 1 + (w.FALLOFF_MIN_MUL - 1) * k;
}

/** 視線方向を中心に、半角 spreadDeg の円錐の中でランダムな方向を選ぶ（中心ほど出やすい） */
function spreadDir(a: Arsenal, dir: Vec3, spreadDeg: number): Vec3 {
  if (spreadDeg <= 1e-4) return dir;
  const up = Math.abs(dir.y) > 0.99 ? v3(1, 0, 0) : v3(0, 1, 0);
  const right = normalize(cross(dir, up));
  const upv = cross(right, dir);
  const r = Math.tan(spreadDeg * DEG) * Math.sqrt(rand(a)) * (0.55 + 0.45 * rand(a));
  const th = rand(a) * Math.PI * 2;
  return normalize(add(dir, add(scale(right, Math.cos(th) * r), scale(upv, Math.sin(th) * r))));
}

function startReload(a: Arsenal, cfg: WeaponsConfig) {
  const s = activeSlot(a);
  const w = slotDef(cfg, s);
  const hasReserve = infiniteReserve(cfg) || s.reserve > 0;
  if (a.reloading || s.ammo >= w.MAG_SIZE || !hasReserve || a.swapTimer > 0 || a.cooking || a.actionLock > 0) return;
  a.reloading = true;
  a.reloadTimer = w.RELOAD_PER_SHELL ? w.RELOAD_START_DELAY + w.RELOAD_TIME : w.RELOAD_TIME;
  a.events.push({ type: 'reloadStart', weapon: s.id, perShell: w.RELOAD_PER_SHELL });
}

export interface ShootContext {
  world: CollisionWorld;
  targets: Target[];
  /** シミュレーションの経過時間（倒すまでの時間を測る） */
  time: number;
  /** 撃てる相手（敵チームの参加者。味方の体は弾が通り抜ける） */
  actors?: Actor[];
  /** 弾を止める壁（敵のシールド。味方のシールドは通り抜けて撃てる） */
  shields?: ShieldWall[];
  /** 与えるダメージの倍率（歩兵は弱い） */
  damageMul?: number;
}

/** 1ティック分の武器の更新 */
export function stepArsenal(
  a: Arsenal,
  m: PlayerMovement,
  eye: Vec3,
  cmd: InputCommand,
  cfg: WeaponsConfig,
  ctx: ShootContext,
  dt: number,
): void {
  a.events = [];
  a.cooldown -= dt;
  a.swapTimer = Math.max(0, a.swapTimer - dt);
  a.sinceShot += dt;

  // --- 持ち替え ---
  let want = cmd.switchTo;
  if (cmd.switchNext) want = a.active === 0 ? 1 : 0;
  if ((want === 0 || want === 1) && want !== a.active) {
    a.active = want;
    a.reloading = false;
    a.swapTimer = slotDef(cfg, activeSlot(a)).SWAP_TIME;
    a.cooldown = 0;
    a.bloom = 0;
    a.sustained = 0;
    a.burstLeft = 0;
    a.spin = 0;
    a.events.push({ type: 'swap', weapon: activeSlot(a).id });
  }

  const slot = activeSlot(a);
  const w = slotDef(cfg, slot);
  const infinite = infiniteReserve(cfg);

  // --- グレネードと格闘（撃つより先に処理する） ---
  stepGrenadeAndMelee(a, m, eye, cmd, cfg, ctx, dt);

  // --- リロード ---
  if (cmd.reloadPressed) startReload(a, cfg);
  if (a.reloading) {
    a.reloadTimer -= dt;
    if (w.RELOAD_PER_SHELL) {
      // 1発ずつ込める（撃てば中断できる）
      while (a.reloading && a.reloadTimer <= 0) {
        slot.ammo++;
        if (!infinite) slot.reserve--;
        a.events.push({ type: 'reloadShell', weapon: slot.id });
        if (slot.ammo >= w.MAG_SIZE || (!infinite && slot.reserve <= 0)) {
          a.reloading = false;
          a.events.push({ type: 'reloadEnd', weapon: slot.id });
        } else {
          a.reloadTimer += w.RELOAD_TIME;
        }
      }
    } else if (a.reloadTimer <= 0) {
      const need = w.MAG_SIZE - slot.ammo;
      const take = infinite ? need : Math.min(need, slot.reserve);
      slot.ammo += take;
      if (!infinite) slot.reserve -= take;
      a.reloading = false;
      a.events.push({ type: 'reloadEnd', weapon: slot.id });
    }
  }

  // --- エイム ---
  const canAds = cmd.adsHeld && !(a.reloading && !w.RELOAD_PER_SHELL) && a.swapTimer <= 0 && !a.cooking && a.actionLock <= 0;
  const adsRate = dt / Math.max(0.01, w.ADS_TIME);
  a.ads = clamp(a.ads + (canAds ? adsRate : -adsRate * 1.4), 0, 1);

  // --- 射撃 ---
  const trigger = w.AUTO ? cmd.fireHeld : cmd.firePressed;
  const able = a.swapTimer <= 0 && m.state !== 'mantle' && !a.cooking && a.actionLock <= 0;
  const burst = w.BURST > 1;
  // 点射の途中で撃てなくなったら（持ち替え・リロード・構えた・弾切れ）、点射をやめる
  if (a.burstLeft > 0 && (!able || a.reloading || slot.ammo <= 0)) {
    a.burstLeft = 0;
    a.cooldown = Math.max(a.cooldown, w.BURST_DELAY);
  }
  // 回転式：引き金を引いている間は回転が上がり、離すとゆっくり落ちる
  const spinning = w.SPINUP_TIME > 0;
  if (spinning) {
    const was = a.spin;
    if (cmd.fireHeld && able && !a.reloading && slot.ammo > 0) a.spin = Math.min(1, a.spin + dt / w.SPINUP_TIME);
    else a.spin = Math.max(0, a.spin - dt / (w.SPINUP_TIME * 1.6));
    if (was === 0 && a.spin > 0) a.events.push({ type: 'spinUp', weapon: slot.id });
    if (was > 0 && a.spin === 0) a.events.push({ type: 'spinDown', weapon: slot.id });
  } else a.spin = 0;
  const rpm = currentRpm(w, a.spin);
  let fired = false;
  const wantShot = burst ? a.burstLeft > 0 || trigger : trigger;
  if (wantShot && able) {
    if (slot.ammo <= 0) {
      if (cmd.firePressed) a.events.push({ type: 'dryFire', weapon: slot.id });
      startReload(a, cfg);
    } else if (a.reloading && w.RELOAD_PER_SHELL && cmd.firePressed) {
      // ショットガンは込めている途中でも撃てる
      a.reloading = false;
    }
    if (slot.ammo > 0 && !a.reloading && a.cooldown <= 0) {
      // 3点射：引き金で点射を始め、離しても点射は最後まで撃つ
      if (burst && a.burstLeft <= 0) a.burstLeft = w.BURST;
      fire(a, m, eye, cmd, cfg, w, ctx);
      fired = true;
      // 連射の待ち時間は引き算で持ち越し、フレームのずれで連射速度が落ちないようにする
      a.cooldown += 60 / rpm;
      if (burst) {
        a.burstLeft--;
        if (a.burstLeft <= 0) a.cooldown += w.BURST_DELAY;
      }
      if (slot.ammo <= 0) {
        a.burstLeft = 0;
        startReload(a, cfg);
      }
    }
  }
  if (!fired && a.cooldown <= 0) a.cooldown = 0;

  // --- ばらつきの回復 ---
  if (fired || a.sinceShot <= 60 / rpm + 0.05 + (burst ? w.BURST_DELAY : 0)) {
    a.sustained += dt; // 撃ち続けている
  } else {
    a.sustained = Math.max(0, a.sustained - dt * 2);
    a.bloom = Math.max(0, a.bloom - w.SPREAD_RECOVERY * dt);
  }
}

function fire(a: Arsenal, m: PlayerMovement, eye: Vec3, cmd: InputCommand, cfg: WeaponsConfig, w: CustomWeaponDef, ctx: ShootContext) {
  const slot = activeSlot(a);
  const spread = currentSpread(a, m, cfg);
  const aim = lookDir(cmd.yaw, cmd.pitch);
  const dirs: Vec3[] = [];
  const hits: ShotHit[] = [];
  const maxRange = cfg.COMMON.MAX_RANGE;
  // ショットガンの1発ぶんのダメージを的ごとにまとめる
  const perTarget = new Map<number, { damage: number; head: boolean }>();
  const perActor = new Map<number, { damage: number; head: boolean; point: Vec3 }>();
  const mul = ctx.damageMul ?? 1;

  for (let i = 0; i < w.PELLETS; i++) {
    const dir = spreadDir(a, aim, spread);
    dirs.push(dir);
    const wh = ctx.world.raycast(eye, dir, maxRange);
    let best: ShotHit = wh
      ? { point: wh.point, normal: wh.normal, kind: 'world', distance: wh.t }
      : { point: add(eye, scale(dir, maxRange)), normal: scale(dir, -1), kind: 'none', distance: maxRange };
    for (const t of ctx.targets) {
      const th = rayVsTarget(eye, dir, best.distance, t);
      if (th && th.t < best.distance) {
        const dmg = w.DAMAGE * mul * falloffMul(w, th.t) * (th.head ? w.HEAD_MUL : 1);
        best = { point: th.point, normal: th.normal, kind: 'target', targetId: t.id, damage: dmg, head: th.head, distance: th.t };
      }
    }
    for (const sh of ctx.shields ?? []) {
      const st = rayVsShield(eye, dir, best.distance, sh);
      if (st !== null && st < best.distance) {
        best = { point: add(eye, scale(dir, st)), normal: scale(dir, -1), kind: 'shield', shieldId: sh.id, distance: st };
      }
    }
    for (const ac of ctx.actors ?? []) {
      const ah = rayVsActor(eye, dir, best.distance, ac);
      if (ah && ah.t < best.distance && ah.blocked) {
        // 盾（重装兵の前面）に当たった：弾は止まり、ダメージは入らない
        best = { point: ah.point, normal: ah.normal, kind: 'shield', distance: ah.t };
        continue;
      }
      if (ah && ah.t < best.distance) {
        const dmg = w.DAMAGE * mul * falloffMul(w, ah.t) * (ah.head ? w.HEAD_MUL : 1);
        best = { point: ah.point, normal: ah.normal, kind: 'actor', actorId: ac.id, damage: dmg, head: ah.head, distance: ah.t };
      }
    }
    if (best.kind === 'target') {
      const acc = perTarget.get(best.targetId!) ?? { damage: 0, head: false };
      acc.damage += best.damage!;
      acc.head ||= !!best.head;
      perTarget.set(best.targetId!, acc);
    } else if (best.kind === 'actor') {
      const acc = perActor.get(best.actorId!) ?? { damage: 0, head: false, point: best.point };
      acc.damage += best.damage!;
      acc.head ||= !!best.head;
      perActor.set(best.actorId!, acc);
    }
    hits.push(best);
  }
  for (const [id, d] of perActor) a.events.push({ type: 'actorHit', actorId: id, damage: d.damage, head: d.head, point: d.point, source: 'shot' });

  // ダメージを与える
  for (const [id, d] of perTarget) {
    const t = ctx.targets.find((x) => x.id === id);
    if (!t) continue;
    const r = damageTarget(t, d.damage, ctx.time, cfg.COMMON.TARGET_RESPAWN_TIME);
    if (r.killed) a.events.push({ type: 'targetKilled', targetId: id, ttk: r.ttk });
  }

  slot.ammo--;
  a.bloom = Math.min(w.SPREAD_MAX_ADD, a.bloom + w.SPREAD_PER_SHOT);
  a.sinceShot = 0;
  a.events.unshift({ type: 'shot', weapon: slot.id, origin: eye, dirs, hits, suppressed: w.SUPPRESSED });
}

// ---------------------------------------------------------------------------
// グレネード・格闘
// ---------------------------------------------------------------------------

function stepGrenadeAndMelee(
  a: Arsenal,
  m: PlayerMovement,
  eye: Vec3,
  cmd: InputCommand,
  cfg: WeaponsConfig,
  ctx: ShootContext,
  dt: number,
) {
  const c = cfg.COMMON;
  a.grenadeCooldown = Math.max(0, a.grenadeCooldown - dt);
  a.meleeCooldown = Math.max(0, a.meleeCooldown - dt);
  a.actionLock = Math.max(0, a.actionLock - dt);

  // 時間でグレネードが1つずつ回復する（0 なら回復しない）
  const regenTime = grenadeRegenTime(a.grenadeKind, c);
  const pressed = cmd.grenadeHeld && !a.grenadeHeldPrev;
  a.grenadeHeldPrev = cmd.grenadeHeld;
  if (regenTime > 0 && a.grenades < grenadeCount(a.grenadeKind, c)) {
    a.grenadeRegen += dt;
    if (a.grenadeRegen >= regenTime) {
      a.grenadeRegen = 0;
      a.grenades++;
      a.events.push({ type: 'grenadeRegen', count: a.grenades });
    }
  } else {
    a.grenadeRegen = 0;
  }

  // --- 格闘（構えているグレネードより優先しない：投げ終わってから） ---
  if (cmd.meleePressed && a.meleeCooldown <= 0 && !a.cooking && m.state !== 'mantle') {
    doMelee(a, m, eye, cmd, cfg, ctx);
    return;
  }

  // --- サッチェル：置いてあれば、G を押した瞬間に起爆する（構えない） ---
  if (a.grenadeKind === 'satchel' && a.satchelsOut > 0 && !a.cooking) {
    if (pressed && a.grenadeCooldown <= 0) {
      a.events.push({ type: 'grenadeDetonate' });
      a.grenadeCooldown = 0.35;
    }
    return;
  }

  // --- グレネード：押している間は構え、離すと投げる ---
  if (cmd.grenadeHeld && !a.cooking) {
    if (a.grenades <= 0) {
      if (!a.cooking && a.grenadeCooldown <= 0) {
        a.events.push({ type: 'grenadeEmpty' });
        a.grenadeCooldown = 0.5;
      }
    } else if (a.grenadeCooldown <= 0 && a.actionLock <= 0 && m.state !== 'mantle') {
      a.cooking = true;
      a.reloading = false; // 構えるとリロードは中断
      a.events.push({ type: 'grenadeCook' });
    }
  } else if (!cmd.grenadeHeld && a.cooking) {
    a.cooking = false;
    a.grenades--;
    a.grenadeCooldown = c.GRENADE_COOLDOWN;
    a.actionLock = c.GRENADE_THROW_LOCK;
    a.lastAction = 'throw';
    a.events.push({
      type: 'grenadeThrow',
      origin: throwOrigin(eye, cmd.yaw, cmd.pitch),
      vel: throwVelocity(cmd.yaw, cmd.pitch, m.vel, c, gStat(a.grenadeKind, 'THROW_SPEED', c)),
      fuse: grenadeFuse(a.grenadeKind, c),
      kind: a.grenadeKind,
    });
  }
}

/** 格闘：目の前の的を殴る。少し離れていれば踏み込む */
function doMelee(a: Arsenal, m: PlayerMovement, eye: Vec3, cmd: InputCommand, cfg: WeaponsConfig, ctx: ShootContext) {
  const c = cfg.COMMON;
  a.meleeCooldown = c.MELEE_COOLDOWN;
  a.actionLock = c.MELEE_LOCK;
  a.reloading = false;
  a.lastAction = 'melee';
  const look = lookDir(cmd.yaw, cmd.pitch);
  const flatLook = normalize(horiz(look));

  // 視線の向きの円錐の中で、一番近い的・敵を探す（踏み込める距離まで）
  let best: { kind: 'target' | 'actor'; id: number; pos: Vec3; chest: Vec3; dist: number; t?: Target } | null = null;
  const consider = (kind: 'target' | 'actor', id: number, pos: Vec3, chest: Vec3, bodyHalf: number, t?: Target) => {
    const to = sub(chest, eye);
    const distH = lenH(to) - bodyHalf;
    if (distH > c.MELEE_LUNGE_RANGE || Math.abs(to.y) > 1.6) return;
    const ang = Math.acos(clamp(dot(normalize(horiz(to)), flatLook), -1, 1)) / DEG;
    if (ang > c.MELEE_ANGLE) return;
    // 間に壁があれば殴れない
    if (ctx.world.raycast(eye, normalize(to), Math.max(0, len(to) - 0.3))) return;
    if (!best || distH < best.dist) best = { kind, id, pos, chest, dist: distH, t };
  };
  for (const t of ctx.targets) {
    if (!t.alive) continue;
    const body = bodyOf(t);
    consider('target', t.id, t.pos, add(t.pos, v3(0, body.centerY + 0.3, 0)), body.size.x * 0.4, t);
  }
  for (const ac of ctx.actors ?? []) consider('actor', ac.id, ac.pos, chestOf(ac), 0.3);

  let lunge = false;
  const found = best as { kind: 'target' | 'actor'; id: number; pos: Vec3; chest: Vec3; dist: number; t?: Target } | null;
  if (found && found.dist > c.MELEE_RANGE) {
    // 踏み込み：相手の方へ素早く寄る
    const dir = normalize(horiz(sub(found.pos, m.pos)));
    const sp = Math.max(lenH(m.vel), c.MELEE_LUNGE_SPEED);
    m.vel.x = dir.x * sp;
    m.vel.z = dir.z * sp;
    lunge = true;
  }

  if (found) {
    const dmg = c.MELEE_DAMAGE * (ctx.damageMul ?? 1);
    if (found.kind === 'target' && found.t) {
      const t = found.t;
      const point = add(t.pos, v3(0, bodyOf(t).centerY + 0.25, 0));
      const r = damageTarget(t, dmg, ctx.time, c.TARGET_RESPAWN_TIME);
      a.events.push({ type: 'melee', hit: { kind: 'target', targetId: t.id, damage: dmg, point, normal: scale(flatLook, -1) }, lunge });
      if (r.killed) a.events.push({ type: 'targetKilled', targetId: t.id, ttk: r.ttk });
    } else {
      const point = found.chest;
      a.events.push({ type: 'melee', hit: { kind: 'actor', actorId: found.id, damage: dmg, point, normal: scale(flatLook, -1) }, lunge });
      a.events.push({ type: 'actorHit', actorId: found.id, damage: dmg, head: false, point, source: 'melee' });
    }
    return;
  }

  // 的がなければ、目の前の壁を殴る（手ごたえの演出用）
  const wh = ctx.world.raycast(eye, look, c.MELEE_RANGE);
  a.events.push({ type: 'melee', hit: wh ? { kind: 'world', point: wh.point, normal: wh.normal } : null, lunge: false });
}
