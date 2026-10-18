/**
 * フェーズ6：消耗戦（チーム・撃ち合い・得点・復活・歩兵・ボット）のテスト
 */
import { checkCustom } from '../shared/weaponCustom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTRITION, DEFAULT_BOTS, DEFAULT_MOVEMENT } from '../config';
import { AttritionMatch } from '../shared/attrition';
import { BotWorld } from '../shared/bots/botWorld';
import { PilotBot } from '../shared/bots/pilotBot';
import { rayVsActor } from '../shared/hitbox';
import { type InputCommand, emptyCommand } from '../shared/input';
import { buildNeonCity } from '../shared/levels/neonCity';
import { type Vec3, lenH, v3 } from '../shared/math';
import { buildNavGraph } from '../shared/nav';
import { type Entity, type SimEvent, Simulation } from '../shared/simulation';
import { charsCfg, flatLevel, weaponsCfg } from './helpers';

const city = buildNeonCity();
const cityNav = buildNavGraph(city, DEFAULT_MOVEMENT);

/** 平らな床の上に、チームの決まりを入れたシミュレーション */
function arena() {
  const level = { ...flatLevel(), bounds: { min: v3(-60, -6, -60), max: v3(60, 10, 60) } };
  const sim = new Simulation(level, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
  sim.soloTeam = false;
  sim.rules = { respawnTime: (e) => (e.kind === 'grunt' ? null : 5), spawnInvuln: 2, assistWindow: 5 };
  return sim;
}

const face = (from: Vec3, to: Vec3) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** a が b の胸を狙って撃つ入力 */
function aimAt(sim: Simulation, a: Entity, b: Entity, fire: boolean, tick: number): InputCommand {
  const eye = sim.eyeOf(a);
  const tgt = v3(b.movement.pos.x, b.movement.pos.y + 1.1, b.movement.pos.z);
  const c = emptyCommand(tick);
  c.yaw = face(eye, tgt);
  c.pitch = Math.atan2(tgt.y - eye.y, Math.hypot(tgt.x - eye.x, tgt.z - eye.z));
  c.fireHeld = fire;
  c.firePressed = fire && tick % 2 === 0;
  c.adsHeld = true;
  return c;
}

function run(sim: Simulation, ticks: number, cmds: (t: number) => Map<number, InputCommand>, events: SimEvent[] = []) {
  for (let t = 0; t < ticks; t++) {
    sim.step(cmds(t));
    events.push(...sim.events);
  }
  return events;
}

describe('消耗戦：当たり判定', () => {
  const actor = { id: 1, team: 1, pos: v3(0, 0, -10), height: 1.8 };
  it('頭と体に当たり、外れた弾は当たらない', () => {
    const head = rayVsActor(v3(0, 1.56, 0), v3(0, 0, -1), 50, actor);
    expect(head?.head).toBe(true);
    const body = rayVsActor(v3(0, 1.0, 0), v3(0, 0, -1), 50, actor);
    expect(body?.head).toBe(false);
    expect(body!.t).toBeCloseTo(10 - 0.38, 1);
    expect(rayVsActor(v3(0.6, 1.0, 0), v3(0, 0, -1), 50, actor)).toBeNull();
    expect(rayVsActor(v3(0, 2.2, 0), v3(0, 0, -1), 50, actor)).toBeNull();
  });
  it('しゃがむと頭の位置が下がる', () => {
    const crouched = { ...actor, height: 1.05 };
    expect(rayVsActor(v3(0, 1.56, 0), v3(0, 0, -1), 50, crouched)).toBeNull();
    expect(rayVsActor(v3(0, 0.8, 0), v3(0, 0, -1), 50, crouched)?.head).toBe(true);
  });
});

describe('消耗戦：チームと撃ち合い', () => {
  it('敵を撃つとダメージ。倒すと得点の相手が記録される', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -12) });
    const ev = run(sim, 120, () => new Map([[a.id, aimAt(sim, a, b, true, sim.tick + 1)]]));
    expect(ev.some((e) => e.type === 'playerDamaged' && e.entityId === b.id && e.attackerId === a.id && e.source === 'shot')).toBe(true);
    const kill = ev.find((e) => e.type === 'kill');
    expect(kill).toBeDefined();
    if (kill?.type === 'kill') {
      expect(kill.killerId).toBe(a.id);
      expect(kill.victimId).toBe(b.id);
      expect(kill.weapon).toBe('ar');
    }
    expect(b.dead).toBe(true);
  });

  it('味方には弾が当たらず、通り抜けて後ろの敵に当たる', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const ally = sim.spawnPlayer('ally', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, -5) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -12) });
    run(sim, 40, () => new Map([[a.id, aimAt(sim, a, b, true, sim.tick + 1)]]));
    expect(ally.health).toBe(ally.maxHealth);
    expect(b.health).toBeLessThan(b.maxHealth);
  });

  it('アシスト：倒される前の5秒以内にダメージを与えた敵', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const c = sim.spawnPlayer('C', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(4, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -12) });
    sim.damageEntity(b, 30, v3(), 'shot', a.id);
    const ev = run(sim, 60, () => new Map([[c.id, aimAt(sim, c, b, true, sim.tick + 1)]]));
    const kill = ev.find((e) => e.type === 'kill');
    expect(kill?.type === 'kill' && kill.killerId).toBe(c.id);
    expect(kill?.type === 'kill' && kill.assists).toEqual([a.id]);
  });

  it('自分のグレネード・落下などで倒れても、直前にダメージを与えた敵の得点になる', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -12) });
    sim.damageEntity(b, 50, v3(), 'shot', a.id);
    sim.damageEntity(b, 80, v3(), 'hazard');
    const kill = sim.events.find((e) => e.type === 'kill');
    expect(kill?.type === 'kill' && kill.killerId).toBe(a.id);
  });

  it('味方の爆風は当たらず、敵と自分には当たる', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const ally = sim.spawnPlayer('ally', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(1.5, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(-1.5, 0.02, 0) });
    sim.grenades.push({ id: 99, ownerId: a.id, team: 0, pos: v3(0, 0.3, 0.8), vel: v3(), fuse: 0.01, resting: true });
    run(sim, 2, () => new Map());
    expect(ally.health).toBe(ally.maxHealth);
    expect(b.health).toBeLessThan(b.maxHealth);
    expect(a.health).toBeLessThan(a.maxHealth);
  });

  it('格闘は敵に当たる（一撃で大きなダメージ）', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -1.6) });
    const c = aimAt(sim, a, b, false, sim.tick + 1);
    c.meleePressed = true;
    sim.step(new Map([[a.id, c]]));
    expect(b.dead).toBe(true);
  });

  it('蘭丸のフェイズシフト中は撃たれず、ほかの参加者とぶつからない', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const r = sim.spawnPlayer('R', ['ar', 'smg'], 'ranmaru', { team: 1, pos: v3(0, 0.02, -12) });
    const q = emptyCommand(sim.tick + 1);
    q.abilityPressed = true;
    sim.step(new Map([[r.id, q]]));
    run(sim, 40, () => new Map()); // 準備（0.5秒）が終わるまで
    expect(r.ability.phase).toBeGreaterThan(0);
    run(sim, 60, () => new Map([[a.id, aimAt(sim, a, r, true, sim.tick + 1)]]));
    expect(r.health).toBe(r.maxHealth);
    // 重なっていても押し離されない
    const g = sim.spawnPlayer('G', ['ar', 'smg'], 'pearl', { team: 0, pos: { ...r.movement.pos } });
    const before = { ...g.movement.pos };
    run(sim, 10, () => new Map());
    expect(lenH(v3(g.movement.pos.x - before.x, 0, g.movement.pos.z - before.z))).toBeLessThan(0.05);
  });

  it('ふだんは、重なった参加者が押し離される', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0.1, 0.02, 0) });
    run(sim, 30, () => new Map());
    expect(Math.abs(b.movement.pos.x - a.movement.pos.x)).toBeGreaterThan(0.7);
  });

  it('ワイヤーフックが敵に当たると、敵を引き寄せてよろめかせる', () => {
    const sim = arena();
    const m = sim.spawnPlayer('M', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -15) });
    const c = aimAt(sim, m, b, false, sim.tick + 1);
    c.adsHeld = false;
    c.abilityPressed = true;
    sim.step(new Map([[m.id, c]]));
    expect(sim.events.some((e) => e.type === 'actorPulled' && e.entityId === b.id)).toBe(true);
    expect(b.stagger).toBeGreaterThan(0);
    run(sim, 30, () => new Map());
    expect(b.movement.pos.z).toBeGreaterThan(-13.5);
  });

  it('ソナーで見つけた敵は、敵チームに壁越しに見える', () => {
    const sim = arena();
    const s = sim.spawnPlayer('S', ['ar', 'smg'], 'sora', { team: 0, pos: v3(0, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -20) });
    const far = sim.spawnPlayer('F', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -55) });
    const c = emptyCommand(sim.tick + 1);
    c.abilityPressed = true;
    sim.step(new Map([[s.id, c]]));
    run(sim, 30, () => new Map());
    expect(b.revealed).toBeGreaterThan(2);
    expect(far.revealed).toBe(0);
  });
});

describe('ソラのパッシブ：弾を当てた敵をマップに映す', () => {
  const T = charsCfg().sora.PASSIVE.MARK_TIME as number;

  it('ソラが弾を当てた敵は MARK_TIME 秒のあいだ映り、当てるたびに延びる。切れると消える', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'sora', { team: 0, pos: v3(0, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -12) });
    b.maxHealth = b.health = 99999;
    const ev = run(sim, 40, () => new Map([[a.id, aimAt(sim, a, b, true, sim.tick + 1)]]));
    expect(T).toBe(4);
    expect(b.mapMarked).toBeGreaterThan(T - 0.2);
    // 映ったことの知らせは、映っていなかったときの最初の 1 回だけ
    expect(ev.filter((e) => e.type === 'mapMarked' && e.entityId === b.id && e.byId === a.id).length).toBe(1);
    run(sim, Math.round((T - 1) * 60), () => new Map());
    expect(b.mapMarked).toBeGreaterThan(0);
    expect(b.mapMarked).toBeLessThan(1.2);
    run(sim, 90, () => new Map());
    expect(b.mapMarked).toBe(0);
  });

  it('ソラ以外が当てても映らない。グレネード・格闘のダメージでも映らない。倒されると消える', () => {
    const sim = arena();
    const a = sim.spawnPlayer('A', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const s = sim.spawnPlayer('S', ['ar', 'smg'], 'sora', { team: 0, pos: v3(4, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -12) });
    b.maxHealth = b.health = 99999;
    run(sim, 40, () => new Map([[a.id, aimAt(sim, a, b, true, sim.tick + 1)]]));
    expect(b.health).toBeLessThan(99999);
    expect(b.mapMarked).toBe(0);
    sim.damageEntity(b, 10, s.movement.pos, 'grenade', s.id);
    sim.damageEntity(b, 10, s.movement.pos, 'melee', s.id);
    expect(b.mapMarked).toBe(0);
    sim.damageEntity(b, 10, s.movement.pos, 'shot', s.id);
    expect(b.mapMarked).toBe(T);
    sim.damageEntity(b, 999999, s.movement.pos, 'shot', s.id);
    expect(b.dead).toBe(true);
    expect(b.mapMarked).toBe(0);
  });

  it('映っている敵は、壁の向こうでもソラの味方のボットに居場所が伝わる', () => {
    const level = { ...flatLevel((bb) => bb.boxTop(0, 4, -8, 10, 4, 0.6, 'wall')), bounds: { min: v3(-60, -6, -60), max: v3(60, 10, 60) } };
    const sim = new Simulation(level, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
    sim.soloTeam = false;
    sim.rules = { respawnTime: () => 5, spawnInvuln: 0, assistWindow: 5 };
    const bw = new BotWorld(sim, buildNavGraph(sim.level, DEFAULT_MOVEMENT), 1, v3());
    const bot = sim.spawnPlayer('bot', ['ar', 'shotgun'], 'pearl', { team: 0, pos: v3(0, 0.02, 0), yaw: 0 });
    const s = sim.spawnPlayer('S', ['ar', 'smg'], 'sora', { team: 0, pos: v3(20, 0.02, 0) });
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -16) });
    b.maxHealth = b.health = 99999;
    const brain = new PilotBot(bot.id, bw, sim.cfg, sim.wcfg, DEFAULT_BOTS.hard, sim.ccfg.pearl, 1);
    const think = (n: number) => {
      for (let t = 0; t < n; t++) {
        bw.processPaths();
        sim.step(new Map([[bot.id, brain.think(bot, 1 / 60)]]));
      }
    };
    think(30);
    expect(brain.contacts.has(b.id), '壁の向こうは見えない').toBe(false);
    sim.damageEntity(b, 10, s.movement.pos, 'shot', s.id);
    think(12);
    const c = brain.contacts.get(b.id);
    expect(c).toBeDefined();
    expect(c!.visible).toBe(false);
    expect(lenH({ x: c!.pos.x - b.movement.pos.x, y: 0, z: c!.pos.z - b.movement.pos.z })).toBeLessThan(0.5);
  });
});

describe('消耗戦：復活', () => {
  it('倒されると5秒後に復活し、直後の2秒は無敵', () => {
    const sim = arena();
    const b = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -12) });
    sim.damageEntity(b, 200, v3(), 'hazard');
    expect(b.dead).toBe(true);
    run(sim, 60 * 4.9, () => new Map());
    expect(b.dead).toBe(true);
    run(sim, 10, () => new Map());
    expect(b.dead).toBe(false);
    expect(b.invuln).toBeGreaterThan(1.8);
    expect(sim.damageEntity(b, 50, v3(), 'hazard')).toBe(false);
    run(sim, 60 * 2.1, () => new Map());
    expect(sim.damageEntity(b, 50, v3(), 'hazard')).toBe(true);
  });

  it('歩兵は復活せず、少しして取り除かれる', () => {
    const sim = arena();
    const g = sim.spawnPlayer('歩兵', ['ar', 'smg'], 'pearl', { team: 1, kind: 'grunt', pos: v3(0, 0.02, -12), maxHealth: 40 });
    sim.damageEntity(g, 50, v3(), 'hazard');
    const ev = run(sim, 60 * 3, () => new Map());
    expect(sim.entities.has(g.id)).toBe(false);
    expect(ev.some((e) => e.type === 'entityRemoved' && e.entityId === g.id)).toBe(true);
  });

  it('復活する場所は、敵から離れた出現地点', () => {
    const m = new AttritionMatch(new Simulation(city, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg()), cityNav, { difficulty: 'normal', seed: 3 });
    const p = m.player!;
    // 敵を全員、西の駅のまわりに集める
    for (const e of m.sim.entities.values()) if (e.team === 1) e.movement.pos = v3(-70 + Math.random() * 4, 0.05, Math.random() * 6 - 3);
    const sp = m.pickSpawn(p)!;
    expect(Math.hypot(sp.pos.x + 70, sp.pos.z)).toBeGreaterThan(DEFAULT_ATTRITION.SPAWN_ENEMY_AVOID);
  });
});

describe('消耗戦：試合', () => {
  const newMatch = (seed = 5, human = true) =>
    new AttritionMatch(new Simulation(city, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg()), cityNav, { difficulty: 'normal', seed, humanPlayer: human });

  it('ボットはランダムにサイト・アタッチメントを付けている（どれもその武器に付けられる物）', () => {
    const m = newMatch(3, false);
    const pilots = [...m.sim.entities.values()].filter((e) => e.kind === 'pilot');
    expect(pilots.length).toBe(12);
    const customized = pilots.filter((e) => e.arsenal.slots.some((sl) => sl.custom.attachments.length > 0));
    expect(customized.length).toBeGreaterThanOrEqual(11);
    const sights = new Set(pilots.flatMap((e) => e.arsenal.slots.map((sl) => sl.custom.sight)));
    expect(sights.size).toBeGreaterThanOrEqual(3);
    for (const e of pilots) for (const sl of e.arsenal.slots) expect(checkCustom(sl.custom, m.sim.wcfg[sl.id]).ok).toBe(true);
  });


  it('6対6（プレイヤー＋味方5体と、敵6体）。キャラクターは6種からランダムで、同じチームでの重複に制限はない', () => {
    const m = newMatch();
    const pilots = [...m.sim.entities.values()].filter((e) => e.kind === 'pilot');
    expect(pilots.filter((e) => e.team === 0).length).toBe(6);
    expect(pilots.filter((e) => e.team === 1).length).toBe(6);
    expect(m.player?.team).toBe(0);
    // いくつかの試合を作ると、同じチームに同じキャラクターが3体以上いることもある（制限していない）
    let maxSame = 0;
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const mm = seed === 5 ? m : newMatch(seed, false);
      for (const t of [0, 1]) {
        const chars = [...mm.sim.entities.values()].filter((e) => e.kind === 'pilot' && e.team === t && e !== mm.player).map((e) => e.character);
        for (const c of chars) {
          seen.add(c);
          maxSame = Math.max(maxSame, chars.filter((x) => x === c).length);
        }
      }
    }
    expect(seen.size).toBe(6);
    expect(maxSame).toBeGreaterThanOrEqual(3);
  });

  it('得点：パイロット 5・歩兵 1・アシスト 1。目標スコアで勝敗が決まる', () => {
    const m = newMatch();
    m.step(null);
    // 試合を始める
    while (m.phase !== 'playing') m.step(null);
    const p = m.player!;
    const enemy = [...m.sim.entities.values()].find((e) => e.team === 1 && e.kind === 'pilot')!;
    const ally = [...m.sim.entities.values()].find((e) => e.team === 0 && e.kind === 'pilot' && e !== p)!;
    m.sim.damageEntity(enemy, 20, v3(), 'shot', ally.id);
    const before = m.scores[0];
    m.sim.damageEntity(enemy, 200, v3(), 'shot', p.id);
    // 出来事は step の中で数える：試しに、同じ出来事を流す
    for (const ev of m.sim.events) (m as unknown as { onSimEvent(e: SimEvent): void }).onSimEvent(ev);
    expect(m.scores[0] - before).toBe(DEFAULT_ATTRITION.PILOT_KILL_SCORE + DEFAULT_ATTRITION.ASSIST_SCORE);
    expect(m.stats.get(p.id)!.kills).toBe(1);
    expect(m.stats.get(ally.id)!.assists).toBe(1);
    expect(m.stats.get(enemy.id)!.deaths).toBe(1);
    // 目標スコアに届くと終わり
    m.scores[0] = DEFAULT_ATTRITION.SCORE_LIMIT;
    m.step(null);
    expect(m.phase).toBe('ended');
    expect(m.result?.winner).toBe(0);
    expect(m.result?.reason).toBe('score');
  });

  it('制限時間が来たら、点の多いチームの勝ち（同点は引き分け）', () => {
    const m = newMatch();
    while (m.phase !== 'playing') m.step(null);
    m.scores[0] = 40;
    m.scores[1] = 55;
    m.timeLeft = 0.01;
    m.step(null);
    expect(m.phase).toBe('ended');
    expect(m.result?.winner).toBe(1);
    expect(m.result?.reason).toBe('time');
    const d = newMatch(6);
    while (d.phase !== 'playing') d.step(null);
    d.timeLeft = 0.01;
    d.step(null);
    expect(d.result?.winner).toBe(-1);
  });

  it('ボットだけの試合（90秒）：撃ち合い・得点・復活が起き、歩兵は各チーム12体まで・地上だけを歩く', () => {
    const m = newMatch(11, false);
    const moved = new Map<number, number>();
    const last = new Map<number, Vec3>();
    let maxGrunts = 0;
    let gruntHigh = 0;
    const abilities = new Set<string>();
    const moves = new Set<string>();
    let respawns = 0;
    for (let t = 0; t < 60 * 90; t++) {
      m.step(null);
      for (const e of m.sim.entities.values()) {
        expect(Number.isFinite(e.movement.pos.x + e.movement.pos.y + e.movement.pos.z)).toBe(true);
        // 地面に立っている間の高さ（爆風で浮いた分は数えない）
        if (e.kind === 'grunt' && !e.dead && e.movement.state === 'ground') gruntHigh = Math.max(gruntHigh, e.movement.pos.y);
        for (const ev of e.abilityEvents) if (ev.type === 'abilityUsed') abilities.add(ev.ability);
        for (const ev of e.movement.events) moves.add(ev.type);
        if (e.kind !== 'pilot') continue;
        const l = last.get(e.id);
        if (l && !e.dead) moved.set(e.id, (moved.get(e.id) ?? 0) + lenH(v3(e.movement.pos.x - l.x, 0, e.movement.pos.z - l.z)));
        last.set(e.id, { ...e.movement.pos });
      }
      respawns += m.sim.events.filter((e) => e.type === 'playerRespawn').length;
      maxGrunts = Math.max(maxGrunts, m.gruntCount(0), m.gruntCount(1));
    }
    expect(m.scores[0] + m.scores[1]).toBeGreaterThan(30);
    expect(respawns).toBeGreaterThan(2);
    expect(maxGrunts).toBeGreaterThan(0);
    expect(maxGrunts).toBeLessThanOrEqual(DEFAULT_ATTRITION.GRUNT_MAX);
    expect(gruntHigh).toBeLessThan(1.5);
    // パイロットはみな動き回る
    for (const [, d] of moved) expect(d).toBeGreaterThan(40);
    // 壁走り・2段ジャンプ・スライディングを使う
    expect(moves.has('wallrunStart')).toBe(true);
    expect(moves.has('doubleJump')).toBe(true);
    expect(moves.has('slideStart')).toBe(true);
    expect(abilities.size).toBeGreaterThanOrEqual(3);
  }, 120000);
});

describe('消耗戦：ボット', () => {
  it('ボットは経路の壁走りのつながりを、実際に壁走りして渡る', () => {
    const level = city;
    const sim = new Simulation(level, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
    sim.soloTeam = false;
    const bw = new BotWorld(sim, cityNav, 1, v3(-4, 0, -12));
    // 西の大通りの看板：ゲームセンターの屋上 → パチンコ店の屋上
    const link = level.navLinks!.find((l) => l.kind === 'wallrun' && l.from.x < -38 && l.from.y === 10)!;
    const e = sim.spawnPlayer('bot', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(link.from.x - 6, link.from.y + 0.05, link.from.z - 1) });
    const brain = new PilotBot(e.id, bw, sim.cfg, sim.wcfg, DEFAULT_BOTS.normal, sim.ccfg.pearl, 1);
    brain.nav.goTo(link.to, e.movement.pos);
    let wallran = false;
    for (let t = 0; t < 60 * 12; t++) {
      // 巡回で行き先を変えないよう、移動だけを使う
      const out = brain.nav.update(e, 1 / 60);
      const c = emptyCommand(sim.tick + 1);
      const yaw = out.lockYaw ?? (out.dir ? Math.atan2(-out.dir.x, -out.dir.z) : 0);
      c.yaw = yaw;
      if (out.dir) {
        c.moveForward = out.dir.x * -Math.sin(yaw) + out.dir.z * -Math.cos(yaw);
        c.moveRight = out.dir.x * Math.cos(yaw) + out.dir.z * -Math.sin(yaw) + out.sideInput;
      }
      c.sprintHeld = out.sprint && c.moveForward > 0.7;
      c.jumpHeld = c.jumpPressed = out.jump;
      bw.processPaths();
      sim.step(new Map([[e.id, c]]));
      if (e.movement.state === 'wallrun') wallran = true;
      if (brain.nav.arrived(e, 2)) break;
    }
    expect(wallran).toBe(true);
    expect(brain.nav.arrived(e, 3)).toBe(true);
    expect(e.movement.pos.y).toBeGreaterThan(9);
  });

  it('難しいボットほど、早く相手を倒す', () => {
    const ttk = (diff: 'easy' | 'normal' | 'hard') => {
      let total = 0;
      for (let trial = 0; trial < 6; trial++) {
        const sim = arena();
        const bw = new BotWorld(sim, buildNavGraph(sim.level, DEFAULT_MOVEMENT), trial + 1, v3());
        const bot = sim.spawnPlayer('bot', ['ar', 'shotgun'], 'pearl', { team: 1, pos: v3(0, 0.02, -18), yaw: Math.PI });
        const tgt = sim.spawnPlayer('t', ['ar', 'shotgun'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
        const brain = new PilotBot(bot.id, bw, sim.cfg, sim.wcfg, DEFAULT_BOTS[diff], sim.ccfg.pearl, trial * 7 + 3);
        brain.setAim(Math.PI + 0.2, 0);
        let t = 0;
        for (; t < 60 * 20 && !tgt.dead; t++) {
          bw.processPaths();
          sim.step(new Map([[bot.id, brain.think(bot, 1 / 60)]]));
          tgt.sinceDamage = 0;
        }
        total += t / 60;
      }
      return total / 6;
    };
    const easy = ttk('easy');
    const hard = ttk('hard');
    expect(hard).toBeLessThan(easy);
  }, 60000);

  it('ボットは、走り回る相手のほうが、止まっている相手より当てにくい', () => {
    const hitRate = (moving: boolean) => {
      let shots = 0;
      let hits = 0;
      for (let trial = 0; trial < 5; trial++) {
        const sim = arena();
        const bw = new BotWorld(sim, buildNavGraph(sim.level, DEFAULT_MOVEMENT), trial + 1, v3());
        const bot = sim.spawnPlayer('bot', ['ar', 'shotgun'], 'pearl', { team: 1, pos: v3(0, 0.02, -20), yaw: Math.PI });
        const tgt = sim.spawnPlayer('t', ['ar', 'shotgun'], 'pearl', { team: 0, pos: v3(0, 0.02, 0), yaw: 0 });
        const brain = new PilotBot(bot.id, bw, sim.cfg, sim.wcfg, DEFAULT_BOTS.normal, sim.ccfg.pearl, trial * 5 + 1);
        brain.setAim(Math.PI, 0);
        for (let t = 0; t < 60 * 8; t++) {
          bw.processPaths();
          const cmds = new Map([[bot.id, brain.think(bot, 1 / 60)]]);
          if (moving) {
            // 横に走って行ったり来たり（ダッシュ）
            const c = emptyCommand(t);
            c.moveRight = Math.floor(t / 70) % 2 ? 1 : -1;
            c.sprintHeld = true;
            c.moveForward = 0.2;
            cmds.set(tgt.id, c);
          }
          sim.step(cmds);
          for (const ev of bot.arsenal.events) if (ev.type === 'shot') { shots++; if (ev.hits.some((h) => h.kind === 'actor')) hits++; }
          tgt.health = tgt.maxHealth; // 倒れないようにして、当たる割合だけを比べる
          // 目の前の範囲から出ないように戻す
          if (Math.abs(tgt.movement.pos.x) > 9) sim.teleport(tgt.id, v3(Math.sign(tgt.movement.pos.x) * 8.5, tgt.movement.pos.y, 0));
        }
      }
      return hits / Math.max(1, shots);
    };
    const still = hitRate(false);
    const run = hitRate(true);
    expect(still).toBeGreaterThan(0.1);
    expect(run).toBeLessThan(still * 0.8);
  }, 60000);

  it('光学迷彩の敵は、遠くからは見つけられない', () => {
    const sim = arena();
    const bw = new BotWorld(sim, buildNavGraph(sim.level, DEFAULT_MOVEMENT), 1, v3());
    const bot = sim.spawnPlayer('bot', ['ar', 'shotgun'], 'pearl', { team: 1, pos: v3(0, 0.02, -20), yaw: Math.PI });
    const p = sim.spawnPlayer('P', ['ar', 'shotgun'], 'pearl', { team: 0, pos: v3(0, 0.02, 0) });
    const brain = new PilotBot(bot.id, bw, sim.cfg, sim.wcfg, DEFAULT_BOTS.hard, sim.ccfg.pearl, 1);
    brain.setAim(Math.PI, 0);
    const c = emptyCommand(1);
    c.abilityPressed = true;
    sim.step(new Map([[p.id, c]]));
    for (let t = 0; t < 60; t++) sim.step(new Map([[bot.id, brain.think(bot, 1 / 60)]]));
    expect(p.health).toBe(p.maxHealth);
    expect(brain.contacts.get(p.id)?.visible ?? false).toBe(false);
  });
});

