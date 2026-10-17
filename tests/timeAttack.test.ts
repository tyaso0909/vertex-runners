import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ATTACK } from '../config';
import { buildTimeAttackLevel } from '../shared/courses/neonCourse';
import { type Vec3, lenH, v3 } from '../shared/math';
import { TICK_DT } from '../shared/simulation';
import { TimeAttackRun, formatDelta, formatTime, ghostSample } from '../shared/timeAttack';
import { cfg, driver } from './helpers';

const level = buildTimeAttackLevel();
const course = level.course!;
const c = cfg();
const ta = { ...DEFAULT_TIME_ATTACK };

/** (dx, dz) の方向を向く視線の yaw */
const face = (dx: number, dz: number) => Math.atan2(-dx, -dz);

describe('タイムアタック：コース', () => {
  it('ターゲットは 20 体（立っている的・レールの上を動く的・ドローン）', () => {
    expect(course.targets.length).toBe(20);
    const stat = course.targets.filter((t) => t.kind === 'dummy' && !t.moveTo).length;
    const moving = course.targets.filter((t) => t.kind === 'dummy' && t.moveTo).length;
    const drones = course.targets.filter((t) => t.kind === 'drone').length;
    expect(stat).toBeGreaterThan(0);
    expect(moving).toBeGreaterThan(0);
    expect(drones).toBeGreaterThan(0);
    expect(stat + moving + drones).toBe(20);
    for (const t of course.targets) expect(t.noRespawn).toBe(true);
  });

  it('スタート・チェックポイント・戻る場所が、床の上にある', () => {
    const d = driver(level, c);
    const onFloor = (p: Vec3, name: string) => {
      const hit = d.sim.world.raycast(v3(p.x, p.y + 1.5, p.z), v3(0, -1, 0), 3);
      expect(hit, name).not.toBeNull();
      expect(Math.abs(hit!.point.y - p.y), name).toBeLessThan(0.15);
      const free = !d.sim.world.blocked(v3(p.x, hit!.point.y + 0.8, p.z), v3(p.x, hit!.point.y + 1.4, p.z), c.PLAYER_RADIUS);
      expect(free, name + '（体がぶつからない）').toBe(true);
    };
    onFloor(course.start.pos, 'スタート');
    for (const cp of course.checkpoints) {
      onFloor(cp.pos, cp.name);
      onFloor(cp.respawn, cp.name + '（戻る場所）');
      // 戻る場所は、その区間の「落ちた」高さより上
      expect(cp.respawn.y).toBeGreaterThan(cp.minY);
    }
  });

  it('動く的・ドローン・立っている的が、地形に埋まっていない', () => {
    const d = driver(level, c);
    for (const t of course.targets) {
      for (const p of t.moveTo ? [t.pos, t.moveTo] : [t.pos]) {
        const y0 = t.kind === 'drone' ? p.y - 0.4 : p.y + 0.3;
        const y1 = t.kind === 'drone' ? p.y + 0.4 : p.y + 1.6;
        expect(d.sim.world.blocked(v3(p.x, y0, p.z), v3(p.x, y1, p.z), 0.3), `${t.kind} ${p.x},${p.y},${p.z}`).toBe(false);
      }
    }
  });
});

describe('タイムアタック：進行（チェックポイント・落下・ペナルティ・ゴール）', () => {
  it('カウントダウン中は動けず、GO で計測が始まる', () => {
    const d = driver(level, c, undefined, 'pearl');
    const run = new TimeAttackRun(course, d.sim, d.p.id, ta);
    const counts: number[] = [];
    let go = false;
    for (let i = 0; i < 60 * 3 + 5; i++) {
      const cmd = run.filterCommand({ ...d.p.lastCmd, tick: d.sim.tick + 1, moveForward: 1, sprintHeld: true, yaw: course.start.yaw });
      d.sim.step(new Map([[d.p.id, cmd]]));
      run.step();
      for (const e of run.events) {
        if (e.type === 'countdown') counts.push(e.n);
        if (e.type === 'go') go = true;
      }
    }
    expect(counts).toEqual([3, 2, 1]);
    expect(go).toBe(true);
    expect(run.phase).toBe('running');
    // カウントダウンの間は進まない（GO の後、数ティックだけ進む）
    expect(lenH({ x: d.p.movement.pos.x - course.start.pos.x, y: 0, z: d.p.movement.pos.z - course.start.pos.z })).toBeLessThan(0.5);
    expect(run.time).toBeGreaterThan(0);
    expect(run.time).toBeLessThan(0.2);
  });

  it('チェックポイントを順に通ると区間タイムが記録され、ゴールでペナルティが足される', () => {
    const d = driver(level, c);
    const run = new TimeAttackRun(course, d.sim, d.p.id, ta);
    const tick = () => {
      d.sim.step(new Map([[d.p.id, { ...d.p.lastCmd, tick: d.sim.tick + 1 }]]));
      run.step();
      return run.events;
    };
    for (let i = 0; i < 60 * 3 + 2; i++) tick();
    expect(run.phase).toBe('running');
    // ターゲットを 3 体壊しておく
    for (const t of d.sim.targets.slice(0, 3)) {
      t.alive = false;
      t.health = 0;
    }
    // 順番を飛ばしたチェックポイントは数えない
    d.sim.teleport(d.p.id, course.checkpoints[2].respawn);
    for (let i = 0; i < 30; i++) tick();
    expect(run.next).toBe(0);
    let finished = null as null | ReturnType<typeof tick>[number];
    for (const cp of course.checkpoints) {
      d.sim.teleport(d.p.id, v3(cp.pos.x, cp.pos.y + 0.05, cp.pos.z));
      for (let i = 0; i < 30; i++) for (const e of tick()) if (e.type === 'finish') finished = e;
    }
    expect(run.phase).toBe('finished');
    expect(run.splits.length).toBe(course.checkpoints.length);
    for (let i = 1; i < run.splits.length; i++) expect(run.splits[i]).toBeGreaterThan(run.splits[i - 1]);
    expect(finished).not.toBeNull();
    const r = run.result!;
    expect(r.destroyed).toBe(3);
    expect(r.missed).toBe(17);
    expect(r.penalty).toBeCloseTo(17 * ta.MISS_PENALTY);
    expect(r.total).toBeCloseTo(r.time + r.penalty);
    // 倒したターゲットは復活しない
    for (let i = 0; i < 60 * 5; i++) tick();
    expect(d.sim.targets.slice(0, 3).every((t) => !t.alive)).toBe(true);
  });

  it('コースから落ちると、直前のチェックポイントへ戻る（タイマーは止まらない）', () => {
    const d = driver(level, c);
    const run = new TimeAttackRun(course, d.sim, d.p.id, ta);
    const tick = () => {
      d.sim.step(new Map([[d.p.id, { ...d.p.lastCmd, tick: d.sim.tick + 1 }]]));
      run.step();
      return run.events;
    };
    for (let i = 0; i < 60 * 3 + 2; i++) tick();
    // 1つ目のチェックポイント（ゲームセンターの屋上）を通る
    const cp = course.checkpoints[0];
    d.sim.teleport(d.p.id, v3(cp.pos.x, cp.pos.y + 0.05, cp.pos.z));
    for (let i = 0; i < 10; i++) tick();
    expect(run.next).toBe(1);
    // 大通り（地面）へ落とす
    d.sim.teleport(d.p.id, v3(-60, 3, -2));
    const t0 = run.time;
    let reset = false;
    for (let i = 0; i < 120 && !reset; i++) for (const e of tick()) if (e.type === 'fallReset') reset = true;
    expect(reset).toBe(true);
    expect(lenH({ x: d.p.movement.pos.x - cp.respawn.x, y: 0, z: d.p.movement.pos.z - cp.respawn.z })).toBeLessThan(0.5);
    expect(run.time).toBeGreaterThan(t0);
    expect(run.resets).toBe(1);
  });

  it('ゴーストの記録を、あとから同じ時刻の姿として取り出せる', () => {
    const d = driver(level, c);
    const run = new TimeAttackRun(course, d.sim, d.p.id, ta);
    for (let i = 0; i < 60 * 3 + 120; i++) {
      d.sim.step(new Map([[d.p.id, run.filterCommand({ ...d.p.lastCmd, tick: d.sim.tick + 1, moveForward: 1, sprintHeld: true, yaw: course.start.yaw })]]));
      run.step();
    }
    expect(run.ghost.length).toBeGreaterThan(0);
    const s = ghostSample(run.ghost, ta.GHOST_INTERVAL_TICKS, run.time);
    expect(s).not.toBeNull();
    expect(lenH({ x: s!.pos.x - d.p.movement.pos.x, y: 0, z: s!.pos.z - d.p.movement.pos.z })).toBeLessThan(0.5);
    expect(formatTime(83.456)).toBe('1:23.46');
    expect(formatDelta(-1.2)).toBe('−1.20');
  });
});

/**
 * コースの難所を、実際の移動の計算で通ってみる（ボットではなく、決まった入力で）。
 * 入力は「進む向き」「横に寄る」「ジャンプ・しゃがむタイミング」だけ。
 */
describe('タイムアタック：難所を実際に通れる', () => {
  const at = (x: number, y: number, z: number, yaw: number) => driver({ ...level, spawn: v3(x, y + 0.05, z), spawnYaw: yaw }, c);

  it('スタート → ゲームセンターの屋上（8m を 2段ジャンプ）', () => {
    const d = at(course.start.pos.x, 10, course.start.pos.z, course.start.yaw);
    const m = d.p.movement;
    let stage = 0;
    d.run(60 * 4, () => {
      const ground = d.sim.world.raycast(v3(m.pos.x + 1.0, m.pos.y + 0.5, m.pos.z), v3(0, -1, 0), 2);
      let jump = false;
      if (stage === 0 && m.state === 'ground' && !ground) {
        jump = true;
        stage = 1;
      } else if (stage === 1 && m.vel.y < 0.5) {
        jump = true;
        stage = 2;
      }
      return { yaw: course.start.yaw, moveForward: 1, sprintHeld: true, jumpHeld: jump };
    });
    expect(m.pos.y).toBeGreaterThan(9.9);
    expect(m.pos.x).toBeGreaterThan(-56);
  });

  it('高架道路の壁：パネルを壁走りして、壁ジャンプと2段ジャンプで壁の向こうへ', () => {
    // 鯉の塔の基壇（高架道路の北）を東へ走り、端で跳んでパネルに張り付く
    const d = at(-2, 10, -53.6, -Math.PI / 2);
    const m = d.p.movement;
    let stage = 0;
    let wallran = false;
    let t = 0;
    d.run(60 * 5, () => {
      t++;
      if (m.state === 'wallrun') wallran = true;
      const ground = d.sim.world.raycast(v3(m.pos.x + 1.0, m.pos.y + 0.5, m.pos.z), v3(0, -1, 0), 2);
      let jump = false;
      let right = 0;
      if (stage === 0 && m.state === 'ground' && !ground) {
        jump = true;
        stage = 1;
      } else if (stage === 1) {
        right = -1; // 北（パネルの方）へ寄る
        if (m.state === 'wallrun' && m.pos.x > 20.5) {
          jump = true; // 壁ジャンプ
          stage = 2;
        }
      } else if (stage === 2) {
        right = 1;
        if (m.vel.y < 0.5) {
          jump = true; // 2段ジャンプ
          stage = 3;
        }
      } else if (stage === 3) {
        right = 1;
        if (m.state === 'ground') stage = 4; // 着地したら止まる
      }
      if (stage === 4) return { yaw: -Math.PI / 2, moveForward: 0 };
      return { yaw: face(1, stage >= 2 ? 0.55 : 0), moveForward: 1, moveRight: right, sprintHeld: true, jumpHeld: jump };
    });
    expect(wallran).toBe(true);
    // 壁（x=19）の向こうの高架道路の上に降りている
    expect(m.pos.x).toBeGreaterThan(19.5);
    expect(m.pos.y).toBeGreaterThan(9.9);
    expect(m.pos.y).toBeLessThan(10.5);
    expect(m.pos.z).toBeGreaterThan(-51);
    expect(m.pos.z).toBeLessThan(-43);
    void t;
  });

  it('ゲート：立ったままでは通れず、スライディングでくぐれる', () => {
    // 立ったまま
    const a = at(22, 10, -47, -Math.PI / 2);
    a.run(60 * 2, { moveForward: 1, sprintHeld: true, yaw: -Math.PI / 2 });
    expect(a.p.movement.pos.x).toBeLessThan(26.85);
    // スライディング
    const b = at(20.5, 10, -47, -Math.PI / 2);
    b.run(60 * 2, (i) => ({ moveForward: 1, sprintHeld: true, yaw: -Math.PI / 2, crouchHeld: i > 25 && i < 80 }));
    expect(b.p.movement.pos.x).toBeGreaterThan(28);
  });

  it('オフィスの基壇 → オフィスの屋上（8m を跳ぶ）', () => {
    const d = at(48, 10, -45, Math.PI);
    const m = d.p.movement;
    let stage = 0;
    d.run(60 * 4, () => {
      const ground = d.sim.world.raycast(v3(m.pos.x, m.pos.y + 0.5, m.pos.z + 1.0), v3(0, -1, 0), 2);
      let jump = false;
      if (stage === 0 && m.state === 'ground' && !ground) {
        jump = true;
        stage = 1;
      } else if (stage === 1 && m.vel.y < 0.5) {
        jump = true;
        stage = 2;
      }
      return { yaw: Math.PI, moveForward: 1, sprintHeld: true, jumpHeld: jump };
    });
    expect(m.pos.z).toBeGreaterThan(-32);
    expect(m.pos.y).toBeGreaterThan(9.9);
  });

  it('駐車場の屋上 → ホテルの屋上（ゴール）', () => {
    const d = at(48, 15, 12, -Math.PI / 2);
    const m = d.p.movement;
    let stage = 0;
    d.run(60 * 4, () => {
      let jump = false;
      if (stage === 0 && m.pos.x > 53.4) {
        jump = true; // 屋上の縁の手すりを跳び越える
        stage = 1;
      } else if (stage === 1 && m.vel.y < 0) {
        jump = true;
        stage = 2;
      }
      return { yaw: -Math.PI / 2, moveForward: 1, sprintHeld: true, jumpHeld: jump };
    });
    expect(m.pos.x).toBeGreaterThan(64);
    expect(m.pos.y).toBeGreaterThan(9.9);
    expect(m.pos.y).toBeLessThan(10.5);
  });

  it('車路で駐車場の3階から屋上へ上れる', () => {
    // 3階の東 → 西へ → 車路の下の端 → 上って屋上
    const d = at(54, 10, 4, Math.PI / 2);
    const m = d.p.movement;
    const go = (tx: number, tz: number, max: number) => {
      for (let i = 0; i < max; i++) {
        const dx = tx - m.pos.x,
          dz = tz - m.pos.z;
        if (Math.hypot(dx, dz) < 0.6) return true;
        d.run(1, { yaw: face(dx, dz), moveForward: 1, sprintHeld: false });
      }
      return false;
    };
    expect(go(43.4, 4, 400)).toBe(true);
    expect(go(43.4, 23.5, 600)).toBe(true);
    expect(go(39, 23.5, 300)).toBe(true);
    expect(go(39, 3, 800)).toBe(true);
    expect(m.pos.y).toBeGreaterThan(14.9);
    void TICK_DT;
  });
});
