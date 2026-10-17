/**
 * 移動アクション（このゲームの核）。
 * 歩き・ダッシュ・ジャンプ・2段ジャンプ・壁走り・壁ジャンプ・スライディング・しゃがみ・よじ登りを、
 * 1ティック分の入力コマンドから計算する。
 *
 * 描画やキー入力には一切依存しない（プレイヤーもボットも同じ関数で動く）。
 */
import type { MovementConfig } from '../config';
import type { CollisionWorld, Contact } from './collision';
import type { InputCommand } from './input';
import {
  type Vec3,
  DEG,
  add,
  addScaled,
  clamp,
  clone,
  copy,
  cross,
  dot,
  forwardFromYaw,
  horiz,
  len,
  lenH,
  lerp,
  lerpNum,
  lookDir,
  moveTowardsVec,
  normalize,
  rightFromYaw,
  scale,
  smoothstep,
  sub,
  v3,
} from './math';

export type MoveState = 'ground' | 'air' | 'wallrun' | 'slide' | 'mantle';

export type WallrunEndReason = 'jump' | 'timeout' | 'slow' | 'wallEnded' | 'back' | 'drop' | 'landed';

export type MoveEvent =
  | { type: 'jump' }
  | { type: 'doubleJump' }
  | { type: 'land'; impactSpeed: number }
  | { type: 'wallrunStart'; /** 同じ壁に張り付き直した */ again?: boolean }
  | { type: 'wallrunEnd'; reason: WallrunEndReason }
  | { type: 'wallJump' }
  | { type: 'slideStart'; boosted: boolean }
  | { type: 'slideEnd' }
  | { type: 'mantle' }
  | { type: 'respawn' }
  | { type: 'grappleEnd'; reason: 'arrived' | 'timeout' | 'jump' | 'landed' | 'blocked' | 'cancel' };

export interface MoveMods {
  /** 移動速度の倍率（歩き・ダッシュ・壁走り・スライディング・空中） */
  speedMul: number;
  /** 壁走りの最大時間の倍率 */
  wallrunTimeMul: number;
}

export interface GrappleData {
  point: Vec3;
  time: number;
  maxTime: number;
  accel: number;
  maxSpeed: number;
  releaseDist: number;
}

interface MantleData {
  from: Vec3;
  to: Vec3;
  t: number;
  duration: number;
  exitVel: Vec3;
}

export interface PlayerMovement {
  /** 足元の位置 */
  pos: Vec3;
  vel: Vec3;
  state: MoveState;
  crouched: boolean;
  /** 現在の身長（立ち／しゃがみ） */
  height: number;
  groundNormal: Vec3;
  /** 今の状態になってからの時間 */
  stateTime: number;
  /** 着地してからの時間 */
  groundTime: number;
  coyote: number;
  jumpBuffer: number;
  doubleJumpReady: boolean;
  slideCooldown: number;
  /**
   * 壁走りが失速・時間切れ・後ろ入力で終わった直後は、少しの間だけ壁走りに入れない。
   * 壁の角（2枚の壁の間）で、失速 → 隣の壁に張り付く をくり返して空中に留まり続けないように
   */
  wallrunBlock: number;
  wallNormal: Vec3;
  wallKey: string | null;
  /**
   * 直前に張り付いて離れた壁。その壁には、離れてから WALLRUN_REATTACH_DELAY 秒たてば、離れたときの高さ以下でまた張り付ける
   * （同じ壁で壁ジャンプと張り付きをくり返して、どこまでも登れないように）。着地すると忘れる
   */
  lastWallKey: string | null;
  /** 直前の壁から離れたときの高さ（足元の y）と、離れてからの時間 */
  lastWallY: number;
  lastWallAge: number;
  mantle: MantleData | null;
  /** キャラクターや武器による移動の補正（パッシブ・アビリティ） */
  mods: MoveMods;
  /** ワイヤーフックで引き寄せられている途中 */
  grapple: GrappleData | null;
  /** このティックで起きた出来事（音や演出のきっかけに使う） */
  events: MoveEvent[];
  spawnPos: Vec3;
  spawnYaw: number;
}

export function createPlayerMovement(spawnPos: Vec3, spawnYaw: number, cfg: MovementConfig): PlayerMovement {
  return {
    pos: clone(spawnPos),
    vel: v3(),
    state: 'air',
    crouched: false,
    height: cfg.STAND_HEIGHT,
    groundNormal: v3(0, 1, 0),
    stateTime: 0,
    groundTime: 0,
    coyote: 0,
    jumpBuffer: 0,
    doubleJumpReady: true,
    slideCooldown: 0,
    wallrunBlock: 0,
    wallNormal: v3(),
    wallKey: null,
    lastWallKey: null,
    lastWallY: 0,
    lastWallAge: 0,
    mantle: null,
    mods: { speedMul: 1, wallrunTimeMul: 1 },
    grapple: null,
    events: [],
    spawnPos: clone(spawnPos),
    spawnYaw,
  };
}

export function respawn(p: PlayerMovement, cfg: MovementConfig): void {
  teleport(p, p.spawnPos, cfg);
}

/** 好きな場所へ移す（止まった状態で、空中から始める）。カメラが補間しないよう respawn の出来事を出す */
export function teleport(p: PlayerMovement, pos: Vec3, cfg: MovementConfig): void {
  copy(p.pos, pos);
  p.vel = v3();
  setState(p, 'air');
  p.crouched = false;
  p.height = cfg.STAND_HEIGHT;
  p.doubleJumpReady = true;
  p.lastWallKey = null;
  p.wallKey = null;
  p.mantle = null;
  p.grapple = null;
  p.events.push({ type: 'respawn' });
}

const UP = v3(0, 1, 0);

function setState(p: PlayerMovement, s: MoveState): void {
  if (p.state !== s) p.stateTime = 0;
  p.state = s;
}

/** 外から打ち上げる（ジャンプパッド）。その速さで空中へ。二段ジャンプと壁走りはまた使える */
export function launch(p: PlayerMovement, vel: Vec3): void {
  if (p.state === 'mantle' || p.grapple) return;
  p.vel = clone(vel);
  setState(p, 'air');
  p.coyote = 0;
  p.jumpBuffer = 0;
  p.doubleJumpReady = true;
  p.lastWallKey = null;
  p.wallKey = null;
}

// ---------------------------------------------------------------------------
// 当たり判定まわり
// ---------------------------------------------------------------------------

function capsuleEnds(pos: Vec3, height: number, r: number): [Vec3, Vec3] {
  return [v3(pos.x, pos.y + r, pos.z), v3(pos.x, pos.y + height - r, pos.z)];
}

type StepContact = Contact & { stepped?: boolean };

/**
 * 段差の角に当たったとき、真上に持ち上げれば乗り越えられるならその量を返す（無理なら 0）。
 * 角が足元から stepHeight 以内の高さにあり、体（カプセル下端の球）より手前にあるときだけ。
 */
function stepUpAmount(c: Contact, feetY: number, r: number, stepHeight: number): number {
  if (!c.onEdge || c.normal.y < 0.05) return 0; // 段差の角ではない（壁の面や床・坂の面）
  const h = c.point.y - feetY;
  if (h <= 0.005 || h > stepHeight) return 0;
  const dh = Math.hypot(c.segPoint.x - c.point.x, c.segPoint.z - c.point.z);
  if (dh >= r - 1e-4) return 0;
  const need = Math.sqrt(r * r - dh * dh) - (c.segPoint.y - c.point.y);
  return need > 0 ? need + 1e-4 : 0;
}

/**
 * 地形から押し出す。触れた面の一覧を返す。
 * groundSnap=true のときは、歩ける面からは真上へ押し出す（坂道で地面に吸い付けるときに、
 * 斜面の向きに押し戻されて前に進めなくなるのを防ぐ）
 */
function resolvePenetration(
  pos: Vec3,
  height: number,
  r: number,
  world: CollisionWorld,
  walkableY = 2,
  groundSnap = false,
  stepHeight = 0,
): StepContact[] {
  const touched: StepContact[] = [];
  for (let iter = 0; iter < 6; iter++) {
    const [a, b] = capsuleEnds(pos, height, r);
    const contacts = world.overlaps(a, b, r);
    let deepest: StepContact | null = null;
    for (const c of contacts) if (c.depth > 1e-5 && (!deepest || c.depth > deepest.depth)) deepest = c;
    if (!deepest) break;
    const stepUp = stepHeight > 0 ? stepUpAmount(deepest, pos.y, r, stepHeight) : 0;
    if (stepUp > 0) {
      // 低い段差の角に足が当たった：横に押し戻さず、真上に持ち上げて乗り越える
      pos.y += stepUp;
      // 段差の角に支えられている＝地面として扱う
      deepest = { ...deepest, normal: v3(0, 1, 0), stepped: true };
    } else if (groundSnap && deepest.normal.y >= walkableY) {
      pos.y += (deepest.depth + 1e-4) / deepest.normal.y;
    } else {
      copy(pos, addScaled(pos, deepest.normal, deepest.depth + 1e-4));
    }
    if (!touched.some((t) => t.boxId === deepest!.boxId && dot(t.normal, deepest!.normal) > 0.99)) touched.push(deepest);
  }
  return touched;
}

/** 位置を delta だけ動かし、ぶつかったら押し出す（速い移動ですり抜けないよう細かく分けて動かす） */
function moveAndCollide(
  p: PlayerMovement,
  delta: Vec3,
  world: CollisionWorld,
  r: number,
  walkableY = 2,
  groundSnap = false,
  stepHeight = 0,
): StepContact[] {
  const dist = len(delta);
  const steps = Math.max(1, Math.ceil(dist / (r * 0.45)));
  const step = scale(delta, 1 / steps);
  const all: StepContact[] = [];
  for (let i = 0; i < steps; i++) {
    copy(p.pos, addScaled(p.pos, step, 1));
    for (const c of resolvePenetration(p.pos, p.height, r, world, walkableY, groundSnap, stepHeight)) all.push(c);
  }
  return all;
}

/** 速度から、面に向かう成分を取り除く */
function clipVelocity(vel: Vec3, contacts: Contact[]): void {
  for (const c of contacts) {
    const vn = dot(vel, c.normal);
    if (vn < 0) copy(vel, addScaled(vel, c.normal, -vn));
  }
}

const isWalkable = (n: Vec3, cfg: MovementConfig) => n.y >= Math.cos(cfg.WALKABLE_SLOPE_DEG * DEG);
const isWallNormal = (n: Vec3) => Math.abs(n.y) < 0.35;
const wallKeyOf = (c: Contact) => {
  const n = normalize(horiz(c.normal));
  return `${c.boxId}:${n.x.toFixed(1)}:${n.z.toFixed(1)}`;
};

/** 速度を地面の傾きに沿わせる（坂道を歩くため） */
function alongGround(hv: Vec3, n: Vec3): Vec3 {
  if (n.y < 0.05) return hv;
  return v3(hv.x, -(n.x * hv.x + n.z * hv.z) / n.y, hv.z);
}

function canStand(p: PlayerMovement, world: CollisionWorld, cfg: MovementConfig): boolean {
  const [a, b] = capsuleEnds(p.pos, cfg.STAND_HEIGHT, cfg.PLAYER_RADIUS);
  return !world.blocked(a, b, cfg.PLAYER_RADIUS - 0.02);
}

// ---------------------------------------------------------------------------
// 1ティック分の更新
// ---------------------------------------------------------------------------

export function stepMovement(
  p: PlayerMovement,
  cmd: InputCommand,
  world: CollisionWorld,
  cfg: MovementConfig,
  dt: number,
  killY = -50,
  /** 地上の移動速度の倍率（持っている武器やエイム中で変わる） */
  speedMul = 1,
): void {
  p.events = [];
  speedMul *= p.mods.speedMul;
  p.stateTime += dt;
  p.groundTime += dt;
  p.slideCooldown = Math.max(0, p.slideCooldown - dt);
  p.wallrunBlock = Math.max(0, p.wallrunBlock - dt);
  p.lastWallAge += dt;
  p.coyote = Math.max(0, p.coyote - dt);
  p.jumpBuffer = cmd.jumpPressed ? cfg.JUMP_BUFFER : Math.max(0, p.jumpBuffer - dt);

  const r = cfg.PLAYER_RADIUS;
  const fwd = forwardFromYaw(cmd.yaw);
  const right = rightFromYaw(cmd.yaw);
  let wish = v3(
    fwd.x * cmd.moveForward + right.x * cmd.moveRight,
    0,
    fwd.z * cmd.moveForward + right.z * cmd.moveRight,
  );
  const wishLen = len(wish);
  if (wishLen > 1) wish = scale(wish, 1 / wishLen);
  const hasWish = wishLen > 0.01;
  const wishDir = hasWish ? normalize(wish) : v3();

  // --- よじ登り中は決まった軌道で動かすだけ ---
  if (p.state === 'mantle' && p.mantle) {
    const m = p.mantle;
    m.t += dt / m.duration;
    const ty = smoothstep(m.t / 0.6);
    const txz = smoothstep((m.t - 0.3) / 0.7);
    p.pos = v3(lerpNum(m.from.x, m.to.x, txz), lerpNum(m.from.y, m.to.y, ty), lerpNum(m.from.z, m.to.z, txz));
    if (m.t >= 1) {
      p.mantle = null;
      p.vel = clone(m.exitVel);
      enterGround(p, cfg);
    }
    finishTick(p, cmd, world, cfg, killY);
    return;
  }

  // --- ワイヤーフックで引き寄せられている間は、ふつうの空中の動きの代わりにこちらで動かす ---
  const grappling = !!p.grapple && updateGrapple(p, cmd, cfg, dt, wishDir, hasWish);

  // --- 状態ごとの速度の更新（移動前） ---
  if (!grappling)
  switch (p.state) {
    case 'ground':
      updateGround(p, cmd, cfg, dt, wish, wishDir, hasWish, speedMul);
      break;
    case 'slide':
      updateSlide(p, cmd, cfg, dt, wishDir, hasWish, speedMul);
      break;
    case 'air':
      updateAir(p, cmd, cfg, dt, wish, wishDir, hasWish, speedMul);
      break;
    case 'wallrun':
      updateWallrun(p, cmd, cfg, dt, speedMul);
      break;
  }

  // 水平速度の上限
  const hs = lenH(p.vel);
  if (hs > cfg.MAX_HORIZONTAL_SPEED) {
    const k = cfg.MAX_HORIZONTAL_SPEED / hs;
    p.vel.x *= k;
    p.vel.z *= k;
  }

  // --- 移動と衝突 ---
  const velBefore = clone(p.vel);
  const wasGrounded = p.state === 'ground' || p.state === 'slide';
  const delta = scale(p.vel, dt);
  const contacts = moveAndCollide(p, delta, world, r, 2, false, wasGrounded ? cfg.STEP_HEIGHT : 0);
  clipVelocity(p.vel, contacts);

  const groundContact = pickGround(contacts, cfg);

  // --- 移動後の判定 ---
  if (wasGrounded && (p.state === 'ground' || p.state === 'slide')) {
    if (groundContact) {
      p.groundNormal = groundContact.normal;
    } else if (!snapToGround(p, world, cfg)) {
      // 足場から落ちた
      p.coyote = cfg.COYOTE_TIME;
      if (p.state === 'slide') p.events.push({ type: 'slideEnd' });
      setState(p, 'air');
    }
    if (p.state === 'ground' || p.state === 'slide') {
      p.vel = alongGround(horiz(p.vel), p.groundNormal);
    }
  } else if (p.state === 'air' || p.state === 'wallrun') {
    // 地面に向かって（または平行に）動いていて、歩ける面に触れたら着地
    if (groundContact && dot(velBefore, groundContact.normal) <= 0.1) {
      if (p.grapple) endGrapple(p, 'landed');
      land(p, cmd, cfg, groundContact, -velBefore.y);
    } else if (p.state === 'wallrun') {
      maintainWallrun(p, cmd, world, cfg);
    } else if (p.grapple) {
      // 壁にぶつかって止まったら、そこで引き寄せを終える
      if (contacts.length && len(p.vel) < 3) endGrapple(p, 'blocked');
    } else {
      tryStartWallrun(p, cmd, world, cfg, velBefore, wishDir, hasWish) ||
        tryStartMantle(p, cmd, world, cfg, contacts, velBefore, fwd);
    }
  }

  finishTick(p, cmd, world, cfg, killY);
}

function finishTick(p: PlayerMovement, cmd: InputCommand, world: CollisionWorld, cfg: MovementConfig, killY: number) {
  // しゃがみ（スライディング中は常にしゃがみ姿勢）
  // しゃがみは地上のときだけ。空中で押しても姿勢は変えず、押したまま着地したらスライディングに入る
  const wantCrouch = p.state === 'slide' || (cmd.crouchHeld && p.state === 'ground');
  if (wantCrouch) {
    p.crouched = true;
  } else if (p.crouched && canStand(p, world, cfg)) {
    p.crouched = false;
  }
  p.height = p.crouched ? cfg.CROUCH_HEIGHT : cfg.STAND_HEIGHT;

  if (p.pos.y < killY) respawn(p, cfg);
}

function pickGround(contacts: Contact[], cfg: MovementConfig): Contact | null {
  let best: Contact | null = null;
  for (const c of contacts) if (isWalkable(c.normal, cfg) && (!best || c.normal.y > best.normal.y)) best = c;
  return best;
}

/** 下り坂や小さな段差で、地面に吸い付ける */
function snapToGround(p: PlayerMovement, world: CollisionWorld, cfg: MovementConfig): boolean {
  const saved = clone(p.pos);
  const walkableY = Math.cos(cfg.WALKABLE_SLOPE_DEG * DEG);
  const contacts = moveAndCollide(p, v3(0, -cfg.GROUND_SNAP, 0), world, cfg.PLAYER_RADIUS, walkableY, true, cfg.STEP_HEIGHT);
  const g = pickGround(contacts, cfg);
  if (g) {
    p.groundNormal = g.normal;
    return true;
  }
  copy(p.pos, saved);
  return false;
}

function enterGround(p: PlayerMovement, _cfg: MovementConfig) {
  setState(p, 'ground');
  p.groundTime = 0;
  p.doubleJumpReady = true;
  p.lastWallKey = null;
  p.wallKey = null;
}

function land(p: PlayerMovement, cmd: InputCommand, cfg: MovementConfig, g: Contact, impactSpeed: number) {
  if (p.state === 'wallrun') p.events.push({ type: 'wallrunEnd', reason: 'landed' });
  p.groundNormal = g.normal;
  p.events.push({ type: 'land', impactSpeed: Math.max(0, impactSpeed) });
  enterGround(p, cfg);
  // しゃがみを押したまま速く着地したら、そのままスライディングへ
  if (cmd.crouchHeld && lenH(p.vel) >= cfg.SLIDE_MIN_SPEED) startSlide(p, cfg, p.mods.speedMul);
  p.vel = alongGround(horiz(p.vel), p.groundNormal);
}

// ---------------------------------------------------------------------------
// 地上
// ---------------------------------------------------------------------------

function updateGround(
  p: PlayerMovement,
  cmd: InputCommand,
  cfg: MovementConfig,
  dt: number,
  wish: Vec3,
  wishDir: Vec3,
  hasWish: boolean,
  speedMul: number,
) {
  const hv = horiz(p.vel);
  const speed = len(hv);

  // ダッシュ中にしゃがみ → スライディング
  if (cmd.crouchPressed && speed >= cfg.SLIDE_MIN_SPEED) {
    startSlide(p, cfg, speedMul);
    updateSlide(p, cmd, cfg, dt, wishDir, hasWish, speedMul);
    return;
  }

  const crouched = p.crouched;
  const sprinting = cmd.sprintHeld && cmd.moveForward > 0.1 && !crouched;
  const target = (crouched ? cfg.CROUCH_SPEED : sprinting ? cfg.SPRINT_SPEED : cfg.WALK_SPEED) * speedMul;
  const inGrace = p.groundTime < cfg.LANDING_GRACE;

  let newHv: Vec3;
  if (speed > target + 0.01 && hasWish) {
    // 通常より速い（勢いが残っている）：ゆっくり減速しつつ、入力方向へ曲がる
    const newSpeed = inGrace ? speed : Math.max(target, speed - cfg.OVERSPEED_FRICTION * dt);
    const dir = normalize(lerp(scale(hv, 1 / speed), wishDir, clamp(cfg.OVERSPEED_STEER * dt, 0, 1)));
    newHv = scale(dir, newSpeed);
  } else if (speed > target + 0.01 && inGrace) {
    newHv = hv; // 着地直後の猶予中は勢いを保つ
  } else {
    const desired = scale(wish, target);
    const rate = hasWish ? cfg.GROUND_ACCEL : cfg.GROUND_DECEL;
    newHv = moveTowardsVec(hv, desired, rate * dt);
  }
  p.vel = alongGround(newHv, p.groundNormal);

  if (p.jumpBuffer > 0) doJump(p, cfg);
}

function doJump(p: PlayerMovement, cfg: MovementConfig) {
  p.vel.y = Math.max(p.vel.y, 0) + cfg.JUMP_VELOCITY;
  if (p.state === 'slide') p.events.push({ type: 'slideEnd' });
  setState(p, 'air');
  p.jumpBuffer = 0;
  p.coyote = 0;
  p.events.push({ type: 'jump' });
}

// ---------------------------------------------------------------------------
// スライディング
// ---------------------------------------------------------------------------

function startSlide(p: PlayerMovement, cfg: MovementConfig, speedMul = 1) {
  const boosted = p.slideCooldown <= 0;
  if (boosted) {
    const hv = horiz(p.vel);
    const s = len(hv);
    if (s > 0.01) {
      const nv = scale(hv, (s + cfg.SLIDE_BOOST * speedMul) / s);
      p.vel.x = nv.x;
      p.vel.z = nv.z;
    }
    p.slideCooldown = cfg.SLIDE_COOLDOWN;
  }
  p.crouched = true;
  setState(p, 'slide');
  p.events.push({ type: 'slideStart', boosted });
}

function updateSlide(p: PlayerMovement, cmd: InputCommand, cfg: MovementConfig, dt: number, wishDir: Vec3, hasWish: boolean, _speedMul = 1) {
  const n = p.groundNormal;
  // 摩擦
  const s = len(p.vel);
  if (s > 1e-4) p.vel = scale(p.vel, Math.max(0, s - cfg.SLIDE_FRICTION * dt) / s);
  // 坂道：重力の斜面方向の成分で加速・減速する
  const g = v3(0, -cfg.GRAVITY * cfg.SLIDE_GRAVITY_SCALE, 0);
  const gt = sub(g, scale(n, dot(g, n)));
  p.vel = addScaled(p.vel, gt, dt);
  // 少しだけ曲がれる
  const hv = horiz(p.vel);
  const hs = len(hv);
  if (hasWish && hs > 0.1) {
    const dir = normalize(lerp(scale(hv, 1 / hs), wishDir, clamp(cfg.SLIDE_STEER * dt, 0, 1)));
    p.vel = alongGround(scale(dir, hs), n);
  } else {
    p.vel = alongGround(hv, n);
  }

  if (p.jumpBuffer > 0) {
    doJump(p, cfg); // 勢いを保ったままジャンプ
    return;
  }
  const speed = lenH(p.vel);
  if (!cmd.crouchHeld || speed < cfg.SLIDE_END_SPEED) {
    setState(p, 'ground');
    p.events.push({ type: 'slideEnd' });
  }
}

// ---------------------------------------------------------------------------
// 空中
// ---------------------------------------------------------------------------

function updateAir(
  p: PlayerMovement,
  cmd: InputCommand,
  cfg: MovementConfig,
  dt: number,
  wish: Vec3,
  wishDir: Vec3,
  hasWish: boolean,
  speedMul = 1,
) {
  if (p.jumpBuffer > 0 && p.coyote > 0) {
    // 足場から落ちた直後のジャンプは地上ジャンプ扱い
    p.vel.y = 0;
    doJump(p, cfg);
  } else if (cmd.jumpPressed && p.doubleJumpReady) {
    doDoubleJump(p, cfg, wishDir, hasWish);
  }

  p.vel.y = Math.max(p.vel.y - cfg.GRAVITY * dt, -cfg.MAX_FALL_SPEED);

  // 空中制御：速さはなるべく保ったまま、入力方向へ向きを寄せる
  if (hasWish) {
    const hv = horiz(p.vel);
    const speed = len(hv);
    const k = 1 - Math.exp(-cfg.AIR_CONTROL * cfg.AIR_STEER_RATE * dt);
    const wishAmount = len(wish);
    const desiredSpeed = Math.max(speed, cfg.AIR_MIN_SPEED * speedMul * wishAmount);
    let nh: Vec3;
    if (speed > 0.1 && dot(scale(hv, 1 / speed), wishDir) > -0.3) {
      const dir = normalize(lerp(scale(hv, 1 / speed), wishDir, k));
      nh = scale(dir, lerpNum(speed, desiredSpeed, k));
    } else {
      // 進行方向と逆を入力：ブレーキ
      nh = lerp(hv, scale(wishDir, cfg.AIR_MIN_SPEED * speedMul * wishAmount), k);
    }
    p.vel.x = nh.x;
    p.vel.z = nh.z;
  }
}

function doDoubleJump(p: PlayerMovement, cfg: MovementConfig, wishDir: Vec3, hasWish: boolean) {
  p.doubleJumpReady = false;
  p.jumpBuffer = 0;
  p.vel.y = cfg.DOUBLE_JUMP_VELOCITY;
  if (hasWish) {
    const hv = horiz(p.vel);
    const s = len(hv);
    const dir = s > 0.1 ? normalize(lerp(scale(hv, 1 / s), wishDir, cfg.DOUBLE_JUMP_REDIRECT)) : wishDir;
    const ns = Math.max(s, cfg.DOUBLE_JUMP_MIN_HSPEED);
    p.vel.x = dir.x * ns;
    p.vel.z = dir.z * ns;
  }
  p.events.push({ type: 'doubleJump' });
}

// ---------------------------------------------------------------------------
// 壁走り
// ---------------------------------------------------------------------------

/** 壁に沿った水平方向（進んでいる向きにそろえる） */
function wallTangent(n: Vec3, vel: Vec3): Vec3 {
  let t = normalize(cross(UP, n));
  if (dot(t, vel) < 0) t = scale(t, -1);
  return t;
}

function tryStartWallrun(
  p: PlayerMovement,
  cmd: InputCommand,
  world: CollisionWorld,
  cfg: MovementConfig,
  velBefore: Vec3,
  wishDir: Vec3,
  hasWish: boolean,
): boolean {
  if (cmd.moveForward < -0.3 || cmd.crouchHeld || p.wallrunBlock > 0) return false;
  const hv = horiz(velBefore);
  const hs = len(hv);
  if (hs < cfg.WALLRUN_MIN_SPEED) return false;
  // 進む向き：ある程度動いていれば実際の進行方向、ほぼ止まっていれば入力している方向で判定する
  // （その場からの垂直跳びでも、壁に斜めに向かって入力していれば壁走りに入れる）
  let dir: Vec3;
  if (hs >= 1.5) dir = scale(hv, 1 / hs);
  else if (hasWish) dir = wishDir;
  else return false;

  // 地面に近すぎるときは壁走りしない
  const down = world.raycast(v3(p.pos.x, p.pos.y + 0.05, p.pos.z), v3(0, -1, 0), cfg.WALLRUN_MIN_HEIGHT + 0.05);
  if (down && isWalkable(down.normal, cfg)) return false;

  const r = cfg.PLAYER_RADIUS;
  const [a, b] = capsuleEnds(p.pos, p.height, r);
  const near = world.overlaps(a, b, r + cfg.WALLRUN_ATTACH_DIST);
  let best: { c: Contact; key: string } | null = null;
  for (const c of near) {
    // 壁の面だけ（壁の端の角では張り付かない）
    if (!isWallNormal(c.normal) || c.onEdge) continue;
    const box = world.getBox(c.boxId);
    if (box?.noWallrun) continue;
    const key = wallKeyOf(c);
    // 直前に離れた壁：少し時間がたち、離れたときより高くなければ、また張り付ける
    if (key === p.lastWallKey && (p.lastWallAge < cfg.WALLRUN_REATTACH_DELAY || p.pos.y > p.lastWallY + cfg.WALLRUN_REATTACH_MAX_RISE)) continue;
    const nh = normalize(horiz(c.normal));
    const into = -dot(dir, nh); // 壁に向かう度合い（sin）
    if (into < -0.17) continue; // 壁から離れていく途中
    const angle = Math.asin(clamp(into, -1, 1)) / DEG;
    if (angle < cfg.WALLRUN_MIN_ANGLE - 10 || angle > cfg.WALLRUN_MAX_ANGLE) continue;
    if (!best || c.depth > best.c.depth) best = { c, key };
  }
  if (!best) return false;

  const n = normalize(horiz(best.c.normal));
  const t = wallTangent(n, dir);
  // 遅く入っても、壁走りの最低速度から始める（そこから WALLRUN_SPEED まで加速する）
  const s = Math.max(dot(hv, t), hs * cfg.WALLRUN_ENTRY_SPEED_KEEP, cfg.WALLRUN_ENTRY_MIN_SPEED);
  // 同じ壁に張り付き直したときは、上向きの勢いを付けない（高さを稼げないように。落ちている途中なら、落ちる速さをゆるめるだけ）
  const again = best.key === p.lastWallKey;
  const vy = again ? Math.min(0, Math.max(velBefore.y, -cfg.WALLRUN_START_MAX_UP)) : clamp(velBefore.y, cfg.WALLRUN_START_MIN_UP, cfg.WALLRUN_START_MAX_UP);
  p.vel = v3(t.x * s, vy, t.z * s);
  p.wallNormal = n;
  p.wallKey = best.key;
  p.doubleJumpReady = true;
  setState(p, 'wallrun');
  // 同じ壁に張り付き直したときは、高さを保つ時間（WALLRUN_HOLD_TIME）なしで、すぐにゆっくり落ち始める
  if (again) p.stateTime = cfg.WALLRUN_HOLD_TIME * p.mods.wallrunTimeMul;
  p.events.push({ type: 'wallrunStart', again });
  return true;
}

function updateWallrun(p: PlayerMovement, cmd: InputCommand, cfg: MovementConfig, dt: number, speedMul = 1) {
  const maxTime = cfg.WALLRUN_MAX_TIME * p.mods.wallrunTimeMul;
  const holdTime = cfg.WALLRUN_HOLD_TIME * p.mods.wallrunTimeMul;
  const runSpeed = cfg.WALLRUN_SPEED * speedMul;
  const n = p.wallNormal;
  const t = wallTangent(n, p.vel);
  let s = dot(horiz(p.vel), t);

  // 壁ジャンプ
  if (cmd.jumpPressed) {
    const up = cfg.WALLJUMP_UP_ANGLE * DEG;
    const out = cfg.WALLJUMP_VELOCITY * Math.cos(up);
    const upv = cfg.WALLJUMP_VELOCITY * Math.sin(up);
    let hv = addScaled(scale(t, Math.max(s, 0)), n, out);
    const look = normalize(horiz(lookDir(cmd.yaw, cmd.pitch)));
    if (dot(look, n) > -0.2) {
      const hl = len(hv);
      hv = scale(normalize(lerp(normalize(hv), look, cfg.WALLJUMP_LOOK_INFLUENCE)), hl);
    }
    p.vel = v3(hv.x, upv, hv.z);
    endWallrun(p, 'jump');
    p.doubleJumpReady = true;
    p.jumpBuffer = 0;
    p.events.push({ type: 'wallJump' });
    return;
  }

  const exit = (reason: 'timeout' | 'slow' | 'back' | 'drop', push: number) => {
    p.vel = addScaled(p.vel, n, push);
    endWallrun(p, reason);
  };
  if (cmd.crouchPressed) return exit('drop', 1.5);
  if (cmd.moveForward < -0.5) return exit('back', 2.0);
  if (p.stateTime > maxTime) return exit('timeout', 1.0);
  if (s < cfg.WALLRUN_END_SPEED) return exit('slow', 1.0);

  // 壁沿いの速さを WALLRUN_SPEED に近づける
  if (s < runSpeed) s = Math.min(runSpeed, s + cfg.WALLRUN_ACCEL * dt);
  else s = Math.max(runSpeed, s - cfg.WALLRUN_OVERSPEED_DECEL * dt);

  // 最初の WALLRUN_HOLD_TIME 秒は高さを保つ（上向きの勢いだけゆるやかに消える）。
  // その後は弱い重力から始まり、時間とともに強くなって落ちていく
  let vy: number;
  if (p.stateTime < holdTime) {
    vy = p.vel.y > 0 ? p.vel.y * Math.exp(-4 * dt) : 0;
  } else {
    const rest = Math.max(1e-3, maxTime - holdTime);
    const k = Math.min(1, (p.stateTime - holdTime) / rest);
    const g = cfg.GRAVITY * cfg.WALLRUN_GRAVITY_SCALE * (1 + cfg.WALLRUN_GRAVITY_RAMP * k * k);
    vy = Math.max(p.vel.y - g * dt, -cfg.MAX_FALL_SPEED);
  }
  // 壁に少し押し付けて接触を保つ
  p.vel = v3(t.x * s - n.x * 1.0, vy, t.z * s - n.z * 1.0);
}

function maintainWallrun(p: PlayerMovement, _cmd: InputCommand, world: CollisionWorld, cfg: MovementConfig) {
  const r = cfg.PLAYER_RADIUS;
  const [a, b] = capsuleEnds(p.pos, p.height, r);
  const near = world.overlaps(a, b, r + cfg.WALLRUN_ATTACH_DIST);
  let found: Contact | null = null;
  for (const c of near) {
    // 角（壁の端）には沿わない。沿うと壁の端を回り込んでしまう
    if (!isWallNormal(c.normal) || c.onEdge) continue;
    if (world.getBox(c.boxId)?.noWallrun) continue;
    const nh = normalize(horiz(c.normal));
    if (dot(nh, p.wallNormal) > 0.6 && (!found || c.depth > found.depth)) found = c;
  }
  if (!found) {
    endWallrun(p, 'wallEnded');
    return;
  }
  // 曲がった壁や角度の違う面にも沿えるよう、壁の向きを更新する
  p.wallNormal = normalize(horiz(lerp(p.wallNormal, normalize(horiz(found.normal)), 0.5)));
  const key = wallKeyOf(found);
  p.wallKey = key;
}

function endWallrun(p: PlayerMovement, reason: WallrunEndReason) {
  if (reason === 'slow' || reason === 'timeout' || reason === 'back' || reason === 'drop') p.wallrunBlock = 0.45;
  p.lastWallKey = p.wallKey;
  p.lastWallY = p.pos.y;
  p.lastWallAge = 0;
  p.wallKey = null;
  setState(p, 'air');
  p.events.push({ type: 'wallrunEnd', reason });
}

// ---------------------------------------------------------------------------
// よじ登り
// ---------------------------------------------------------------------------

function tryStartMantle(
  p: PlayerMovement,
  cmd: InputCommand,
  world: CollisionWorld,
  cfg: MovementConfig,
  contacts: Contact[],
  velBefore: Vec3,
  fwd: Vec3,
): boolean {
  if (cmd.moveForward < 0.3 || p.vel.y > 4.5) return false;
  // 正面の壁にぶつかっているか
  const r = cfg.PLAYER_RADIUS;
  const [a, b] = capsuleEnds(p.pos, p.height, r);
  const near = contacts.concat(world.overlaps(a, b, r + 0.08));
  const facing = near.find((c) => isWallNormal(c.normal) && dot(normalize(horiz(c.normal)), fwd) < -0.5);
  if (!facing) return false;
  const wallIn = scale(normalize(horiz(facing.normal)), -1);

  // 縁の上を探す
  const reach = r + 0.35;
  const top = p.pos.y + cfg.MANTLE_MAX_HEIGHT + 0.05;
  const origin = v3(p.pos.x + wallIn.x * reach, top, p.pos.z + wallIn.z * reach);
  const hit = world.raycast(origin, v3(0, -1, 0), cfg.MANTLE_MAX_HEIGHT + 0.05 - cfg.MANTLE_MIN_HEIGHT);
  if (!hit || !isWalkable(hit.normal, cfg)) return false;

  const target = v3(origin.x, hit.point.y + 0.02, origin.z);
  // 縁の上に体が収まるか（立てなければしゃがみで）
  let height = cfg.STAND_HEIGHT;
  let [ta, tb] = capsuleEnds(target, height, r);
  if (world.blocked(ta, tb, r - 0.02)) {
    height = cfg.CROUCH_HEIGHT;
    [ta, tb] = capsuleEnds(target, height, r);
    if (world.blocked(ta, tb, r - 0.02)) return false;
  }
  // 今の位置から真上に縁の高さまで、頭がぶつからないか
  const [ua, ub] = capsuleEnds(v3(p.pos.x, p.pos.y + 0.05, p.pos.z), target.y - p.pos.y + height - 0.05, r - 0.05);
  if (world.blocked(ua, ub, r - 0.05)) return false;

  const climb = target.y - p.pos.y;
  const exitSpeed = Math.max(lenH(velBefore) * 0.6, cfg.WALK_SPEED);
  p.mantle = {
    from: clone(p.pos),
    to: target,
    t: 0,
    duration: cfg.MANTLE_TIME * clamp(climb / cfg.MANTLE_MAX_HEIGHT, 0.55, 1),
    exitVel: scale(fwd, exitSpeed),
  };
  if (height === cfg.CROUCH_HEIGHT) p.crouched = true;
  p.vel = v3();
  setState(p, 'mantle');
  p.events.push({ type: 'mantle' });
  return true;
}

/** HUD 表示用：状態の日本語名 */
export const STATE_LABEL: Record<MoveState, string> = {
  ground: '地上',
  air: '空中',
  wallrun: '壁走り',
  slide: 'スライディング',
  mantle: 'よじ登り',
};

/** 目の高さ（足元からの距離） */
export const eyeHeightOf = (p: PlayerMovement, cfg: MovementConfig) => p.height - cfg.EYE_FROM_TOP;

// ---------------------------------------------------------------------------
// ワイヤーフック（メイアのアビリティ）
// ---------------------------------------------------------------------------

/** ワイヤーを撃ち込んだ点へ引き寄せ始める */
export function startGrapple(p: PlayerMovement, point: Vec3, g: Omit<GrappleData, 'point' | 'time'>): void {
  p.grapple = { point: clone(point), time: 0, ...g };
  if (p.state === 'ground' || p.state === 'slide' || p.state === 'wallrun') {
    if (p.state === 'wallrun') p.events.push({ type: 'wallrunEnd', reason: 'jump' });
    // 地面から浮かせる
    p.vel.y = Math.max(p.vel.y, 4);
    p.pos.y += 0.05;
  }
  setState(p, 'air');
  p.mantle = null;
}

export function endGrapple(p: PlayerMovement, reason: 'arrived' | 'timeout' | 'jump' | 'landed' | 'blocked' | 'cancel'): void {
  if (!p.grapple) return;
  p.grapple = null;
  p.doubleJumpReady = true;
  p.lastWallKey = null;
  p.events.push({ type: 'grappleEnd', reason });
}

/** 引き寄せ中の速度の更新。続けるなら true */
function updateGrapple(p: PlayerMovement, cmd: InputCommand, cfg: MovementConfig, dt: number, wishDir: Vec3, hasWish: boolean): boolean {
  const g = p.grapple!;
  g.time += dt;
  const chest = v3(p.pos.x, p.pos.y + p.height * 0.6, p.pos.z);
  const to = sub(g.point, chest);
  const dist = len(to);
  if (cmd.jumpPressed) {
    // ジャンプで切り離す：勢いはそのまま、少し上へ
    p.vel.y = Math.max(p.vel.y, 0) + cfg.JUMP_VELOCITY * 0.6;
    endGrapple(p, 'jump');
    p.jumpBuffer = 0;
    return true;
  }
  if (dist < g.releaseDist) {
    endGrapple(p, 'arrived');
    return false;
  }
  if (g.time > g.maxTime) {
    endGrapple(p, 'timeout');
    return false;
  }
  const dir = scale(to, 1 / dist);
  // ワイヤーの方向へ加速し、横にずれる成分は弱める（まっすぐ引き寄せられる）
  let v = addScaled(p.vel, dir, g.accel * dt);
  const along = dot(v, dir);
  const side = sub(v, scale(dir, along));
  v = add(scale(dir, along), scale(side, Math.exp(-dt * 3)));
  // 少しだけ入力で振れる
  if (hasWish) v = addScaled(v, wishDir, 6 * dt);
  // 弱い重力
  v.y -= cfg.GRAVITY * 0.25 * dt;
  const sp = len(v);
  if (sp > g.maxSpeed) v = scale(v, g.maxSpeed / sp);
  p.vel = v;
  return true;
}
