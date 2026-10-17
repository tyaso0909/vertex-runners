import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTestRoom } from '../shared/levels/testRoom';
import { mat3FromEulerYXZ, lenH, v3 } from '../shared/math';
import { cfg, driver, flatLevel } from './helpers';

const FWD = { moveForward: 1 };
const SPRINT = { moveForward: 1, sprintHeld: true };

describe('数学', () => {
  it('回転行列が three.js の YXZ オイラー角と一致する', () => {
    const e = new THREE.Euler(0.3, -1.1, 0.7, 'YXZ');
    const m4 = new THREE.Matrix4().makeRotationFromEuler(e);
    const m = mat3FromEulerYXZ((0.3 * 180) / Math.PI, (-1.1 * 180) / Math.PI, (0.7 * 180) / Math.PI);
    const te = m4.elements; // 列優先
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(m[r * 3 + c]).toBeCloseTo(te[c * 4 + r], 6);
  });
});

describe('地上の移動', () => {
  it('落下して着地し、地上状態になる', () => {
    const d = driver(flatLevel(undefined, v3(0, 3, 0)));
    d.run(90, {});
    expect(d.p.movement.state).toBe('ground');
    expect(d.p.movement.pos.y).toBeCloseTo(0, 2);
    expect(d.events).toContain('land');
  });

  it('歩きは WALK_SPEED、ダッシュは SPRINT_SPEED に達する', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(60, FWD);
    expect(lenH(d.p.movement.vel)).toBeCloseTo(5, 1);
    d.run(60, SPRINT);
    expect(lenH(d.p.movement.vel)).toBeCloseTo(8, 1);
    // 前方（-Z）へ進んでいる
    expect(d.p.movement.vel.z).toBeLessThan(-7.9);
  });

  it('入力をやめると止まる', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(60, SPRINT);
    d.run(30, {});
    expect(lenH(d.p.movement.vel)).toBeLessThan(0.01);
  });

  it('25cm の階段を歩いて上れる', () => {
    const d = driver(flatLevel((b) => b.stairs(0, -2, 0, 12, 0.25, 0.5, 4)));
    d.run(20, {});
    let maxY = 0;
    d.run(120, () => {
      maxY = Math.max(maxY, d.p.movement.pos.y);
      return FWD;
    });
    expect(maxY).toBeGreaterThan(2.95);
    // 上っている間、速度が落ちない（引っかからない）
    expect(lenH(d.p.movement.vel)).toBeGreaterThan(4.9);
  });

  it('坂道を上り下りできる（地面から離れない）', () => {
    const d = driver(flatLevel((b) => b.ramp(v3(0, 0, -3), v3(0, 4, -15), 6)));
    d.run(20, {});
    d.run(150, FWD);
    // 坂の上を越えて反対側へ落ちるまでに一度は高さ4付近に達する
    let maxY = 0;
    d.run(1, FWD);
    const d2 = driver(flatLevel((b) => b.ramp(v3(0, 0, -3), v3(0, 4, -15), 6)));
    d2.run(20, {});
    for (let i = 0; i < 200; i++) {
      d2.run(1, FWD);
      maxY = Math.max(maxY, d2.p.movement.pos.y);
      if (d2.p.movement.pos.z < -10) expect(['ground', 'slide']).toContain(d2.p.movement.state);
      if (d2.p.movement.pos.z < -14) break;
    }
    expect(maxY).toBeGreaterThan(3.3);
  });
});

describe('ジャンプ', () => {
  it('ジャンプの最高点は v²/2g（約1.0m）', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    let maxY = 0;
    d.run(1, { jumpHeld: true });
    d.run(60, (t) => {
      maxY = Math.max(maxY, d.p.movement.pos.y);
      return { jumpHeld: t < 5 };
    });
    const c = cfg();
    expect(maxY).toBeGreaterThan(c.JUMP_VELOCITY ** 2 / (2 * c.GRAVITY) - 0.08);
    expect(maxY).toBeLessThan(c.JUMP_VELOCITY ** 2 / (2 * c.GRAVITY) + 0.08);
  });

  it('2段ジャンプで高く跳べ、着地までは1回だけ', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    let maxY = 0;
    let doubles = 0;
    d.run(90, (t) => {
      maxY = Math.max(maxY, d.p.movement.pos.y);
      // 2回目・3回目の押下（空中で2回押す）
      const press = t === 0 || t === 15 || t === 25;
      return { jumpHeld: press };
    });
    doubles = d.events.filter((e) => e === 'doubleJump').length;
    expect(doubles).toBe(1);
    expect(maxY).toBeGreaterThan(1.6);
    expect(d.p.movement.state).toBe('ground');
  });

  it('着地の直前に押したジャンプも着地した瞬間に出る（先行入力）', () => {
    const d = driver(flatLevel(undefined, v3(0, 2, 0)));
    d.p.movement.doubleJumpReady = false; // 2段ジャンプを使い切った状態
    d.until(120, {}, () => d.p.movement.pos.y < 0.4);
    expect(d.p.movement.state).toBe('air');
    d.run(1, { jumpHeld: true }); // 空中で押す（まだ着地していない）
    expect(d.events).not.toContain('jump');
    let jumped = false;
    d.until(10, {}, () => (jumped = d.events.includes('jump')));
    expect(jumped).toBe(true);
  });

  it('着地直後にジャンプすれば勢いを失わない（バニーホップ）', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.p.movement.vel = v3(0, 0, -12);
    d.p.movement.groundTime = 0;
    d.run(1, { moveForward: 1, jumpHeld: true });
    // 着地まで待ってすぐ跳ぶ、を3回
    for (let i = 0; i < 3; i++) {
      d.until(120, FWD, () => d.p.movement.state === 'ground');
      d.run(1, { moveForward: 1, jumpHeld: true });
      d.run(1, FWD);
    }
    expect(lenH(d.p.movement.vel)).toBeGreaterThan(11);
  });
});

describe('スライディング', () => {
  it('ダッシュ中にしゃがむと SLIDE_BOOST だけ加速し、その後減速する', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(60, SPRINT);
    d.run(1, { ...SPRINT, crouchHeld: true });
    expect(d.p.movement.state).toBe('slide');
    const c = cfg();
    expect(lenH(d.p.movement.vel)).toBeGreaterThan(8 + c.SLIDE_BOOST - 0.2);
    d.run(30, { ...SPRINT, crouchHeld: true });
    expect(lenH(d.p.movement.vel)).toBeLessThan(10.6);
    expect(d.p.movement.crouched).toBe(true);
  });

  it('クールダウン中は加速しない', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(60, SPRINT);
    d.run(5, { ...SPRINT, crouchHeld: true });
    d.run(40, SPRINT); // 立ち上がってダッシュに戻す
    const before = lenH(d.p.movement.vel);
    d.run(1, { ...SPRINT, crouchHeld: true });
    expect(d.events.filter((e) => e === 'slideStart').length).toBe(2);
    expect(lenH(d.p.movement.vel)).toBeLessThan(before + 0.5);
  });

  it('下り坂ではスライディングが加速し続ける', () => {
    const d = driver(flatLevel((b) => b.ramp(v3(0, 0, -40), v3(0, 8, -2), 8), v3(0, 8.05, -3)));
    d.run(40, {});
    expect(d.p.movement.state).toBe('ground');
    d.p.movement.vel = v3(0, 0, -8);
    d.run(1, { ...SPRINT, crouchHeld: true });
    expect(d.p.movement.state).toBe('slide');
    const s0 = lenH(d.p.movement.vel);
    d.run(60, { ...SPRINT, crouchHeld: true });
    expect(d.p.movement.state).toBe('slide');
    expect(lenH(d.p.movement.vel)).toBeGreaterThan(s0 + 1);
  });

  it('スライディング中のジャンプで勢いを保つ', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(60, SPRINT);
    d.run(3, { ...SPRINT, crouchHeld: true });
    const s = lenH(d.p.movement.vel);
    d.run(1, { ...SPRINT, crouchHeld: true, jumpHeld: true });
    expect(d.p.movement.state).toBe('air');
    d.run(20, SPRINT);
    expect(lenH(d.p.movement.vel)).toBeGreaterThan(s - 0.5);
  });

  it('しゃがみを押したまま速く着地するとスライディングになる', () => {
    const d = driver(flatLevel(undefined, v3(0, 2, 0)));
    d.p.movement.vel = v3(0, 0, -10);
    d.until(120, { moveForward: 1, crouchHeld: true }, () => d.events.includes('land'));
    expect(d.p.movement.state).toBe('slide');
  });

  it('空中でしゃがんでも姿勢も落下も変わらず、押したまま着地するとスライディングになる', () => {
    const run = (crouch: boolean) => {
      const d = driver(flatLevel());
      d.run(20, {});
      d.run(60, SPRINT);
      d.run(1, { ...SPRINT, jumpHeld: true });
      const ys: number[] = [];
      const heights: number[] = [];
      d.until(120, { ...SPRINT, crouchHeld: crouch }, () => {
        ys.push(d.p.movement.pos.y);
        heights.push(d.p.movement.height);
        return d.p.movement.state !== 'air';
      });
      return { d, ys, heights };
    };
    const normal = run(false);
    const crouched = run(true);
    // 空中の軌道はしゃがみの有無で同じ（急に落ちない）
    expect(crouched.ys.length).toBe(normal.ys.length);
    crouched.ys.forEach((y, i) => expect(y).toBeCloseTo(normal.ys[i], 5));
    // 空中では立ち姿勢のまま
    expect(crouched.heights.slice(0, -1).every((h) => h === cfg().STAND_HEIGHT)).toBe(true);
    // 着地したらスライディング
    expect(crouched.d.p.movement.state).toBe('slide');
    expect(normal.d.p.movement.state).toBe('ground');
  });

  it('低いトンネル（1.25m）は立ったままでは入れず、しゃがめば通れる', () => {
    const tunnel = (b: import('../shared/level').LevelBuilder) => {
      b.boxRange(-2, 1.25, -12, 2, 1.75, -4, 'prop');
    };
    const stand = driver(flatLevel(tunnel));
    stand.run(20, {});
    stand.run(120, FWD);
    expect(stand.p.movement.pos.z).toBeGreaterThan(-4);

    const crouch = driver(flatLevel(tunnel));
    crouch.run(20, {});
    crouch.run(400, { moveForward: 1, crouchHeld: true });
    expect(crouch.p.movement.pos.z).toBeLessThan(-12);
    // トンネル内で立とうとしても立てない
    const inside = driver(flatLevel(tunnel));
    inside.run(20, {});
    inside.until(300, { moveForward: 1, crouchHeld: true }, () => inside.p.movement.pos.z < -8);
    inside.run(5, {});
    expect(inside.p.movement.crouched).toBe(true);
  });
});

describe('壁走り', () => {
  // x=1.0 の位置に南北に長い壁（面は -X を向く）
  const wallLevel = (spawnY = 3) =>
    flatLevel((b) => b.boxRange(1.0, 0, -80, 2.0, 12, 5, 'wall'), v3(0.45, spawnY, 0));

  it('壁と平行に近づくと壁走りが始まり、ゆっくり落ちていく', () => {
    const d = driver(wallLevel());
    d.p.movement.vel = v3(0, 0, -8);
    d.run(2, FWD);
    expect(d.p.movement.state).toBe('wallrun');
    expect(d.events).toContain('wallrunStart');
    const y0 = d.p.movement.pos.y;
    d.run(30, FWD); // 0.5秒
    expect(d.p.movement.state).toBe('wallrun');
    expect(Math.abs(d.p.movement.pos.y - y0)).toBeLessThan(0.8);
    // 壁沿いに WALLRUN_SPEED へ近づく
    expect(lenH(d.p.movement.vel)).toBeGreaterThan(8.3);
  });

  it('壁走りの最初の WALLRUN_HOLD_TIME 秒は高さを保ち、その後に落ち始める', () => {
    const d = driver(wallLevel(6));
    d.p.movement.vel = v3(0, 0, -8);
    d.run(2, FWD);
    expect(d.p.movement.state).toBe('wallrun');
    const y0 = d.p.movement.pos.y;
    const hold = cfg().WALLRUN_HOLD_TIME;
    let minDuringHold = y0;
    d.run(Math.floor(hold * 60) - 4, () => {
      minDuringHold = Math.min(minDuringHold, d.p.movement.pos.y);
      return FWD;
    });
    expect(minDuringHold).toBeGreaterThan(y0 - 0.01); // 保持中は下がらない
    const yHoldEnd = d.p.movement.pos.y;
    d.run(30, FWD);
    expect(d.p.movement.state).toBe('wallrun');
    expect(d.p.movement.pos.y).toBeLessThan(yHoldEnd - 0.05); // その後は落ちていく
  });

  it('最大継続時間を過ぎると壁から離れる', () => {
    const d = driver(wallLevel(6));
    d.p.movement.vel = v3(0, 0, -8);
    d.run(2, FWD);
    const t = d.until(400, FWD, () => d.p.movement.state !== 'wallrun');
    const c = cfg();
    expect(t / 60).toBeGreaterThan(c.WALLRUN_MAX_TIME - 0.1);
    expect(t / 60).toBeLessThan(c.WALLRUN_MAX_TIME + 0.1);
  });

  it('壁走り中のジャンプで壁と反対側の斜め前へ跳び、2段ジャンプも使える', () => {
    const d = driver(wallLevel());
    d.p.movement.vel = v3(0, 0, -8);
    d.run(20, FWD);
    expect(d.p.movement.state).toBe('wallrun');
    d.run(1, { moveForward: 1, jumpHeld: true });
    expect(d.events).toContain('wallJump');
    expect(d.p.movement.vel.x).toBeLessThan(-2); // 壁（+X）から離れる
    expect(d.p.movement.vel.z).toBeLessThan(-5); // 前へ
    expect(d.p.movement.vel.y).toBeGreaterThan(4); // 上へ
    expect(d.p.movement.doubleJumpReady).toBe(true);
  });

  it('同じ壁でも、一度離れたあとはまた壁走りできる（離れてすぐ・離れたときより高い所では張り付けない）', () => {
    const d = driver(wallLevel());
    d.p.movement.vel = v3(0, 0, -8);
    d.run(20, FWD);
    d.run(1, { moveForward: 1, jumpHeld: true });
    expect(d.p.movement.state).toBe('air');
    const leaveY = d.p.movement.pos.y;
    // 壁の方へ戻る：跳び上がっている間（離れたときより高い）と、離れてすぐは張り付かない
    const back = { moveForward: 1, moveRight: 1 };
    const t = d.until(120, back, () => d.p.movement.state === 'wallrun');
    expect(t).toBeGreaterThan(cfg().WALLRUN_REATTACH_DELAY * 60);
    expect(d.p.movement.pos.y).toBeLessThanOrEqual(leaveY + 0.05);
    expect(d.events.filter((e) => e === 'wallrunStart').length).toBe(2);
    // 張り付き直したときは上向きの勢いがない
    expect(d.p.movement.vel.y).toBeLessThanOrEqual(0.01);
  });

  it('同じ壁で壁ジャンプと張り付きをくり返しても、高さは稼げない（少しずつ下がって、やがて着地する）', () => {
    const d = driver(flatLevel((b) => b.boxRange(1.0, 0, -200, 2.0, 30, 5, 'wall'), v3(0.45, 3, 0)));
    d.p.movement.vel = v3(0, 0, -8);
    d.run(20, FWD);
    let maxY = d.p.movement.pos.y;
    let prevLeave = Infinity;
    let cycles = 0;
    for (let i = 0; i < 20; i++) {
      d.run(1, { moveForward: 1, jumpHeld: true });
      const leave = d.p.movement.lastWallY;
      expect(leave).toBeLessThanOrEqual(prevLeave + 0.01);
      prevLeave = leave;
      const t = d.until(120, { moveForward: 1, moveRight: 1 }, () => d.p.movement.state === 'wallrun' || d.p.movement.state === 'ground');
      if (t < 0 || d.p.movement.state !== 'wallrun') break;
      maxY = Math.max(maxY, d.p.movement.pos.y);
      cycles++;
      d.run(10, FWD);
    }
    expect(cycles).toBeGreaterThanOrEqual(2);
    expect(maxY).toBeLessThan(3.3);
    expect(d.p.movement.state).not.toBe('wallrun');
  });

  it('別の壁には、離れてすぐでも張り付ける', () => {
    // 幅 4m の通路の両側の壁（x=1.0 と x=-3.0）
    const d = driver(flatLevel((b) => { b.boxRange(1.0, 0, -80, 2.0, 12, 5, 'wall'); b.boxRange(-4.0, 0, -80, -3.0, 12, 5, 'wall'); }, v3(0.45, 3, 0)));
    d.p.movement.vel = v3(0, 0, -8);
    d.run(20, FWD);
    d.run(1, { moveForward: 1, jumpHeld: true });
    const t = d.until(60, { moveForward: 1, moveRight: -1 }, () => d.p.movement.state === 'wallrun');
    expect(t).toBeGreaterThan(0);
    expect(d.p.movement.pos.x).toBeLessThan(-1.5);
  });

  it('後ろを入力すると壁から離れる', () => {
    const d = driver(wallLevel());
    d.p.movement.vel = v3(0, 0, -8);
    d.run(10, FWD);
    expect(d.p.movement.state).toBe('wallrun');
    d.run(1, { moveForward: -1 });
    expect(d.p.movement.state).toBe('air');
  });

  it('走っていなくても、壁に斜めに向かってジャンプすれば壁走りに入れる', () => {
    // 壁（面は -X 向き、x=1.0）の手前に立ち止まり、右斜め前（壁へ約45°）を入力してその場ジャンプ
    const d = driver(flatLevel((b) => b.boxRange(1.0, 0, -80, 2.0, 12, 5, 'wall'), v3(0.3, 0.02, 0)));
    d.run(20, {});
    expect(lenH(d.p.movement.vel)).toBeLessThan(0.01);
    d.run(1, { moveForward: 1, moveRight: 1, jumpHeld: true });
    const t = d.until(60, { moveForward: 1, moveRight: 1 }, () => d.p.movement.state === 'wallrun');
    expect(t).toBeGreaterThan(0);
    // 壁沿いに前（-Z）へ走り出す
    d.run(20, FWD);
    expect(d.p.movement.state).toBe('wallrun');
    expect(d.p.movement.vel.z).toBeLessThan(-6);
  });

  it('壁に正面から向かってジャンプしても壁走りにはならない', () => {
    // 壁（面は +Z 向き、z=-1.0）に正面を向いて立ち、前を入力してその場ジャンプ
    const d = driver(flatLevel((b) => b.boxRange(-10, 0, -2.0, 10, 12, -1.0, 'wall'), v3(0, 0.02, -0.3)));
    d.run(20, {});
    d.run(1, { moveForward: 1, jumpHeld: true });
    d.run(60, FWD);
    expect(d.events).not.toContain('wallrunStart');
  });

  it('地面の近くでは壁走りしない', () => {
    const d = driver(wallLevel(0.02));
    d.run(10, {});
    d.run(60, { moveForward: 1, sprintHeld: true, moveRight: 0.3 });
    expect(d.events).not.toContain('wallrunStart');
  });

  it('壁が途切れたら壁走りが終わる', () => {
    const d = driver(flatLevel((b) => b.boxRange(1.0, 0, -6, 2.0, 12, 5, 'wall'), v3(0.45, 3, 0)));
    d.p.movement.vel = v3(0, 0, -8);
    d.run(2, FWD);
    expect(d.p.movement.state).toBe('wallrun');
    d.run(60, FWD);
    expect(d.events).toContain('wallrunEnd');
    expect(d.p.movement.pos.z).toBeLessThan(-6);
  });
});

describe('よじ登り', () => {
  it('ジャンプだけでは届かない高さ（ジャンプの頂点 + 0.5m）の台に、前に進みながらジャンプするとよじ登れる', () => {
    const c0 = cfg();
    const H = c0.JUMP_VELOCITY ** 2 / (2 * c0.GRAVITY) + 0.5;
    const d = driver(flatLevel((b) => b.boxRange(-3, 0, -6, 3, H, -3, 'block', { noWallrun: true })));
    d.run(20, {});
    d.run(10, FWD);
    d.until(120, (t) => ({ moveForward: 1, jumpHeld: t < 3 }), () => d.events.includes('mantle'));
    d.run(40, FWD);
    expect(d.events).toContain('mantle');
    expect(d.p.movement.pos.y).toBeGreaterThan(H - 0.05);
  });

  it('高すぎる台（4m）には登れない', () => {
    const d = driver(flatLevel((b) => b.boxRange(-3, 0, -6, 3, 4, -3, 'block', { noWallrun: true })));
    d.run(20, {});
    d.run(10, FWD);
    d.run(90, (t) => ({ moveForward: 1, jumpHeld: t < 3 }));
    expect(d.events).not.toContain('mantle');
    expect(d.p.movement.pos.y).toBeLessThan(0.1);
  });
});

describe('テスト部屋：移動の連携', () => {
  it('壁走り通路を、床に落ちずに壁走り→壁ジャンプの連続で渡り切れる', () => {
    const level = buildTestRoom();
    level.spawn = v3(-37, 4.05, 33);
    const d = driver(level);
    d.run(10, {});
    let side = 1; // 最初は東の壁へ
    let minY = 99;
    let wallruns = 0;
    let lastState = '';
    let jumpCooldown = 0;
    for (let t = 0; t < 900; t++) {
      const m = d.p.movement;
      if (m.state !== lastState) {
        if (m.state === 'wallrun') wallruns++;
        lastState = m.state;
      }
      let input: Record<string, unknown> = { moveForward: 1, sprintHeld: true };
      jumpCooldown--;
      if (m.state === 'ground' && m.pos.z < 27.5 && m.pos.z > 20) input = { ...input, jumpHeld: true };
      if (m.state === 'air' && m.pos.z < 26) input = { ...input, moveRight: side };
      // 通路を抜けたらゴール台の中央へ
      if (m.state === 'air' && m.pos.z < -12)
        input = { moveForward: m.pos.z < -17 ? -1 : 0.3, moveRight: Math.sign(-35 - m.pos.x) * 0.5 };
      if (m.state === 'wallrun' && m.stateTime > 0.55 && jumpCooldown <= 0) {
        input = { ...input, jumpHeld: true };
        side = -side;
        jumpCooldown = 10;
      }
      // 落ちてきたら2段ジャンプで立て直す
      if (m.state === 'air' && m.vel.y < -3 && m.doubleJumpReady && m.pos.z < 24) input = { ...input, jumpHeld: true };
      d.run(1, input);
      if (m.pos.z < 26 && m.pos.z > -14) minY = Math.min(minY, m.pos.y);
      if (m.state === 'ground' && m.pos.z < -15) break;
    }
    const m = d.p.movement;
    expect(wallruns).toBeGreaterThanOrEqual(2);
    expect(minY).toBeGreaterThan(0.5); // 床（高さ0）に落ちていない
    expect(m.pos.z).toBeLessThan(-15); // ゴール台に着いた
    expect(m.pos.y).toBeGreaterThan(3.9);
  });
});

describe('壁走り：壁の角', () => {
  it('2枚の壁の角に向かって跳び続けても、失速と張り付きをくり返して空中に留まらない', () => {
    // 北と西に壁がある角（内側の角）。北西へ向かって押し続ける
    const level = flatLevel((b) => {
      b.boxRange(-6, 0, -6.4, 6, 6, -6, 'wall');
      b.boxRange(-6.4, 0, -6, -6, 6, 6, 'wall');
    }, v3(-4.5, 0.02, -4.5), Math.PI / 4);
    const d = driver(level, cfg());
    let starts = 0;
    let airTime = 0;
    let maxAir = 0;
    for (let t = 0; t < 60 * 6; t++) {
      d.run(1, { moveForward: 1, jumpHeld: t % 50 < 2 });
      const m = d.p.movement;
      starts += m.events.filter((e) => e.type === 'wallrunStart').length;
      airTime = m.state === 'ground' ? 0 : airTime + 1 / 60;
      maxAir = Math.max(maxAir, airTime);
    }
    expect(maxAir).toBeLessThan(3);
    expect(starts).toBeLessThan(25);
  });
});
