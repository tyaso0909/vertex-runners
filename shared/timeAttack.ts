/**
 * タイムアタック（仕様 5.2）のゲームロジック。描画から切り離してあり、固定 60Hz のシミュレーションと一緒に進める。
 *
 * - スタート前にカウントダウン（その間は動けない）。「GO」でタイマーが動き出す
 * - チェックポイントを順に通る。通った時刻（区間タイム）を記録する
 * - コースから落ちる（区間ごとに決めた高さより下へ落ちる）と、直前のチェックポイントへ戻る（タイマーは止まらない）
 * - ゴールしたとき、壊し損ねたターゲット1体ごとに MISS_PENALTY 秒を足す
 * - 走りを一定間隔で記録し、ゴースト（ベスト記録の走りの再生）に使う
 */
import type { TimeAttackConfig } from '../config';
import type { BoxDef } from './level';
import { type Vec3, clone, v3 } from './math';
import type { InputCommand } from './input';
import type { Simulation } from './simulation';
import type { TargetDef } from './targets';
import { TICK_DT } from './simulation';

export interface CourseCheckpoint {
  name: string;
  /** 通ったとみなす場所（円柱の中心の足元） */
  pos: Vec3;
  radius?: number;
  /** 落ちたときに戻る場所と向き（視線の yaw） */
  respawn: Vec3;
  respawnYaw: number;
  /** ここを通った後、この高さより下に落ちたらここへ戻す */
  minY: number;
}

export interface CourseDef {
  id: string;
  name: string;
  start: { pos: Vec3; yaw: number; minY: number };
  /** 順に通るチェックポイント。最後がゴール */
  checkpoints: CourseCheckpoint[];
  targets: TargetDef[];
  /** コース用の足場・壁（ホログラムで描く） */
  boxes: BoxDef[];
  /** 説明（近道など） */
  notes: string[];
}

export type TimeAttackPhase = 'countdown' | 'running' | 'finished';

export type TimeAttackEvent =
  | { type: 'countdown'; n: number }
  | { type: 'go' }
  | { type: 'checkpoint'; index: number; time: number }
  | { type: 'fallReset'; checkpoint: number; yaw: number }
  | { type: 'targetDestroyed'; destroyed: number; total: number }
  | { type: 'finish'; result: TimeAttackResult };

export interface TimeAttackResult {
  courseId: string;
  /** 走った時間（秒） */
  time: number;
  /** 壊し損ねたターゲットの数と、足された秒数 */
  missed: number;
  penalty: number;
  /** 記録（time + penalty） */
  total: number;
  /** 各チェックポイント（ゴールを含む）を通った時刻 */
  splits: number[];
  destroyed: number;
  targets: number;
  resets: number;
}

/** ゴーストの1コマ：位置・向き・動きの種類 */
export const GHOST_STRIDE = 5;
export enum GhostPose {
  Run = 0,
  Air = 1,
  WallRun = 2,
  Slide = 3,
  Idle = 4,
}

export class TimeAttackRun {
  phase: TimeAttackPhase = 'countdown';
  countdown: number;
  time = 0;
  /** 次に通るチェックポイントの番号 */
  next = 0;
  splits: number[] = [];
  destroyed = 0;
  resets = 0;
  result: TimeAttackResult | null = null;
  events: TimeAttackEvent[] = [];
  /** ゴースト用の記録（[x, y, z, yaw, 動き] の繰り返し。GHOST_INTERVAL_TICKS ごと） */
  ghost: number[] = [];
  private ticks = 0;
  private lastCount = -1;
  private readonly targetIds: Set<number>;

  constructor(
    readonly course: CourseDef,
    private readonly sim: Simulation,
    private readonly playerId: number,
    private readonly cfg: TimeAttackConfig,
  ) {
    this.countdown = cfg.COUNTDOWN;
    // コースのターゲットは、ステージの的の最初の course.targets.length 体
    this.targetIds = new Set(sim.targets.slice(0, course.targets.length).map((t) => t.id));
  }

  get total(): number {
    return this.course.targets.length;
  }

  /** いま戻る先（直前に通ったチェックポイント。まだならスタート） */
  get lastCheckpoint(): { pos: Vec3; yaw: number; minY: number } {
    if (this.next === 0) return { pos: this.course.start.pos, yaw: this.course.start.yaw, minY: this.course.start.minY };
    const c = this.course.checkpoints[this.next - 1];
    return { pos: c.respawn, yaw: c.respawnYaw, minY: c.minY };
  }

  /** カウントダウン中は動けない（見回すことはできる） */
  filterCommand(cmd: InputCommand): InputCommand {
    if (this.phase !== 'countdown') return cmd;
    return {
      ...cmd,
      moveForward: 0,
      moveRight: 0,
      jumpPressed: false,
      jumpHeld: false,
      crouchHeld: false,
      crouchPressed: false,
      sprintHeld: false,
      fireHeld: false,
      firePressed: false,
      grenadeHeld: false,
      meleePressed: false,
      abilityPressed: false,
    };
  }

  /** シミュレーションを1ティック進めた後に呼ぶ */
  step(): void {
    this.events = [];
    const e = this.sim.entities.get(this.playerId);
    if (!e) return;
    const m = e.movement;

    if (this.phase === 'countdown') {
      const before = Math.ceil(this.countdown);
      this.countdown -= TICK_DT;
      const after = Math.ceil(this.countdown);
      if (this.lastCount < 0 || after !== before) {
        if (after > 0) this.events.push({ type: 'countdown', n: after });
      }
      this.lastCount = after;
      if (this.countdown <= 0) {
        this.phase = 'running';
        this.events.push({ type: 'go' });
      }
      return;
    }

    // 壊したターゲットの数
    let destroyed = 0;
    for (const t of this.sim.targets) if (this.targetIds.has(t.id) && !t.alive) destroyed++;
    if (destroyed !== this.destroyed) {
      this.destroyed = destroyed;
      this.events.push({ type: 'targetDestroyed', destroyed, total: this.total });
    }

    if (this.phase !== 'running') return;
    this.time += TICK_DT;
    this.ticks++;

    // ゴーストの記録
    if (this.ticks % this.cfg.GHOST_INTERVAL_TICKS === 0) {
      const pose =
        m.state === 'wallrun' ? GhostPose.WallRun : m.state === 'slide' ? GhostPose.Slide : m.state === 'air' || m.state === 'mantle' ? GhostPose.Air : Math.hypot(m.vel.x, m.vel.z) > 0.5 ? GhostPose.Run : GhostPose.Idle;
      this.ghost.push(round2(m.pos.x), round2(m.pos.y), round2(m.pos.z), round3(e.lastCmd.yaw), pose);
    }

    // コースから落ちたら、直前のチェックポイントへ戻す
    const last = this.lastCheckpoint;
    if (m.pos.y < last.minY && m.state !== 'wallrun') {
      this.sim.teleport(this.playerId, clone(last.pos));
      this.resets++;
      this.events.push({ type: 'fallReset', checkpoint: this.next - 1, yaw: last.yaw });
      return;
    }

    // 次のチェックポイント
    const cp = this.course.checkpoints[this.next];
    const r = cp.radius ?? this.cfg.CHECKPOINT_RADIUS;
    const dx = m.pos.x - cp.pos.x,
      dz = m.pos.z - cp.pos.z;
    const dy = m.pos.y - cp.pos.y;
    if (dx * dx + dz * dz < r * r && dy > -1 && dy < this.cfg.CHECKPOINT_HEIGHT) {
      this.splits.push(this.time);
      this.events.push({ type: 'checkpoint', index: this.next, time: this.time });
      this.next++;
      if (this.next >= this.course.checkpoints.length) this.finish();
    }
  }

  private finish() {
    this.phase = 'finished';
    const missed = this.total - this.destroyed;
    const penalty = missed * this.cfg.MISS_PENALTY;
    this.result = {
      courseId: this.course.id,
      time: this.time,
      missed,
      penalty,
      total: this.time + penalty,
      splits: [...this.splits],
      destroyed: this.destroyed,
      targets: this.total,
      resets: this.resets,
    };
    this.events.push({ type: 'finish', result: this.result });
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** ゴーストの記録の、ある時刻の姿（間を補間する） */
export function ghostSample(frames: ArrayLike<number>, intervalTicks: number, time: number): { pos: Vec3; yaw: number; pose: GhostPose } | null {
  const n = Math.floor(frames.length / GHOST_STRIDE);
  if (n === 0) return null;
  const f = time / (TICK_DT * intervalTicks) - 1;
  const i = Math.max(0, Math.min(n - 1, Math.floor(f)));
  const j = Math.min(n - 1, i + 1);
  const k = Math.max(0, Math.min(1, f - i));
  const a = i * GHOST_STRIDE,
    b = j * GHOST_STRIDE;
  // 大きく飛んでいるとき（チェックポイントへ戻った）は補間しない
  const jump = Math.abs(frames[b] - frames[a]) + Math.abs(frames[b + 2] - frames[a + 2]) > 4;
  const t = jump ? 0 : k;
  let dyaw = frames[b + 3] - frames[a + 3];
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  return {
    pos: v3(frames[a] + (frames[b] - frames[a]) * t, frames[a + 1] + (frames[b + 1] - frames[a + 1]) * t, frames[a + 2] + (frames[b + 2] - frames[a + 2]) * t),
    yaw: frames[a + 3] + dyaw * t,
    pose: frames[a + 4] as GhostPose,
  };
}

/** 記録の時間の表示（0:23.41） */
export function formatTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** ベストとの差の表示（-1.20 / +0.53） */
export function formatDelta(d: number): string {
  return `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
}
