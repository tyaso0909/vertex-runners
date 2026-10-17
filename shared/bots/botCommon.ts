/**
 * ボットの入力づくりの共通部分。
 * ボットは「進みたい向き（世界の向き）・視線・ボタンを押しているか」を決め、
 * ここでプレイヤーと同じ入力コマンド（InputCommand）に直す。押した瞬間の判定もここで作る。
 */
import { type InputCommand, emptyCommand } from '../input';
import { type Vec3, clamp } from '../math';

export interface BotIntent {
  /** 進みたい向き（水平。長さ 0〜1） */
  move: Vec3 | null;
  /** 視線に対する横の入力を足す（壁走りの入り） */
  side: number;
  yaw: number;
  pitch: number;
  sprint: boolean;
  jump: boolean;
  crouch: boolean;
  fire: boolean;
  ads: boolean;
  reload: boolean;
  switchTo: number;
  grenade: boolean;
  melee: boolean;
  ability: boolean;
  /** 「調べる」を押している（蘇生など） */
  interact: boolean;
  /** ブーストを使う（消耗戦） */
  boost: boolean;
}

export const emptyIntent = (yaw: number, pitch: number): BotIntent => ({
  move: null,
  side: 0,
  yaw,
  pitch,
  sprint: false,
  jump: false,
  crouch: false,
  fire: false,
  ads: false,
  reload: false,
  switchTo: -1,
  grenade: false,
  melee: false,
  ability: false,
  interact: false,
  boost: false,
});

/** 押しているボタンから、押した瞬間を作る */
export class CommandWriter {
  private prevJump = false;
  private prevCrouch = false;
  private prevFire = false;

  build(tick: number, it: BotIntent): InputCommand {
    const c = emptyCommand(tick);
    c.yaw = it.yaw;
    c.pitch = clamp(it.pitch, -1.45, 1.45);
    if (it.move) {
      // 世界の向き → 視線に対する前後・左右
      const fx = -Math.sin(it.yaw),
        fz = -Math.cos(it.yaw);
      const rx = Math.cos(it.yaw),
        rz = -Math.sin(it.yaw);
      c.moveForward = clamp(it.move.x * fx + it.move.z * fz, -1, 1);
      c.moveRight = clamp(it.move.x * rx + it.move.z * rz + it.side, -1, 1);
    } else c.moveRight = clamp(it.side, -1, 1);
    // ダッシュは前へ進んでいるときだけ
    c.sprintHeld = it.sprint && c.moveForward > 0.7;
    c.jumpHeld = it.jump;
    c.jumpPressed = it.jump && !this.prevJump;
    c.crouchHeld = it.crouch;
    c.crouchPressed = it.crouch && !this.prevCrouch;
    c.fireHeld = it.fire;
    c.firePressed = it.fire && !this.prevFire;
    c.adsHeld = it.ads;
    c.reloadPressed = it.reload;
    c.switchTo = it.switchTo;
    c.grenadeHeld = it.grenade;
    c.meleePressed = it.melee;
    c.abilityPressed = it.ability;
    c.interactHeld = it.interact;
    c.boostPressed = it.boost;
    this.prevJump = it.jump;
    this.prevCrouch = it.crouch;
    this.prevFire = it.fire;
    return c;
  }
}

/** 角度の差（-π〜π） */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 目から点への向き（yaw, pitch） */
export function aimAngles(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x,
    dy = to.y - from.y,
    dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}
