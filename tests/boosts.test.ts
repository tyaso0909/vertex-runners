/**
 * ブースト（消耗戦。マップハック・ホロパイロット・フェイズリワインド・ハードカバー・ティック・ダイスロール）のテスト
 */
import { describe, expect, it } from 'vitest';
import { BOOST_IDS, DEFAULT_MOVEMENT, boostsConfig } from '../config';
import { AttritionMatch } from '../shared/attrition';
import { BoostSystem } from '../shared/boosts';
import { type InputCommand, emptyCommand } from '../shared/input';
import { buildNeonCity } from '../shared/levels/neonCity';
import { checkLoadout, defaultLoadouts, repairLoadout } from '../shared/loadout';
import { len, lenH, sub, v3 } from '../shared/math';
import { buildNavGraph } from '../shared/nav';
import { type Entity, Simulation } from '../shared/simulation';
import { charsCfg, flatLevel, weaponsCfg } from './helpers';
import { DEFAULT_BOTS } from '../config';
import { BotWorld } from '../shared/bots/botWorld';
import { GruntBot } from '../shared/bots/gruntBot';
import { PilotBot } from '../shared/bots/pilotBot';
import { rayVsActor } from '../shared/hitbox';
import { ASSAULT_BODY, ASSAULT_HEIGHT } from '../shared/td/units';

const B = boostsConfig.BOOSTS;

function arena() {
  const level = { ...flatLevel(), bounds: { min: v3(-60, -6, -60), max: v3(60, 10, 60) } };
  const sim = new Simulation(level, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
  sim.soloTeam = false;
  sim.rules = { respawnTime: (e) => (e.kind === 'pilot' ? 5 : null), spawnInvuln: 0, assistWindow: 5 };
  const bs = new BoostSystem(sim, null, 11);
  return { sim, bs };
}

/** ブーストと一緒に1ティック進める */
function step(sim: Simulation, bs: BoostSystem, cmds = new Map<number, InputCommand>()) {
  bs.preStep(cmds, true);
  sim.step(cmds);
  let i = 0;
  const flush = () => {
    while (i < sim.events.length) bs.onSimEvent(sim.events[i++]);
  };
  flush();
  bs.postStep();
  flush();
  return bs.events;
}

const fill = (bs: BoostSystem, id: number) => bs.addPoints(id, 999, false);
const pressX = (sim: Simulation, e: Entity, yaw = 0, pitch = 0) => new Map([[e.id, { ...emptyCommand(sim.tick + 1), yaw, pitch, boostPressed: true }]]);

describe('ブースト：ゲージ', () => {
  it('得点でたまり、満タンで知らせる。倒されても減らない。続けて倒すとたまり方が増える', () => {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    bs.register(p.id, 'maphack');
    const cost = B.maphack.COST;
    bs.addPoints(p.id, 5, true);
    expect(bs.fraction(p.id)).toBeCloseTo(5 / cost, 5);
    bs.addPoints(p.id, 5, true); // 2 人目：+25%
    expect(bs.states.get(p.id)!.points).toBeCloseTo(5 + 5 * (1 + boostsConfig.STREAK_BONUS), 5);
    const before = bs.states.get(p.id)!.points;
    bs.onDeath(p.id);
    expect(bs.states.get(p.id)!.points).toBe(before);
    expect(bs.states.get(p.id)!.streak).toBe(0);
    bs.events = [];
    fill(bs, p.id);
    expect(bs.ready(p.id)).toBe(true);
    expect(bs.states.get(p.id)!.points).toBe(cost); // 満タンで止まる
    expect(bs.events.some((e) => e.type === 'boostReady')).toBe(true);
  });

  it('満タンでないと使えない。使うとゲージは 0 に戻る', () => {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    bs.register(p.id, 'maphack');
    bs.addPoints(p.id, 5, true);
    expect(step(sim, bs, pressX(sim, p)).some((e) => e.type === 'boostUsed')).toBe(false);
    fill(bs, p.id);
    expect(step(sim, bs, pressX(sim, p)).some((e) => e.type === 'boostUsed')).toBe(true);
    expect(bs.fraction(p.id)).toBe(0);
  });
});

describe('ブースト：それぞれの効き目', () => {
  it('マップハック：決まった間、決まった間隔で敵の位置をチームに知らせる', () => {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    const en = sim.spawnPlayer('E', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(30, 0.02, 0) });
    bs.register(p.id, 'maphack');
    fill(bs, p.id);
    let pulses = 0;
    for (let t = 0; t < 60 * 20; t++) {
      const ev = step(sim, bs, t === 0 ? pressX(sim, p) : undefined);
      for (const e of ev) if (e.type === 'mapHackPulse') {
        pulses++;
        expect(e.team).toBe(0);
        expect(e.ids).toContain(en.id);
      }
    }
    const want = Math.ceil((B.maphack.DURATION as number) / (B.maphack.PULSE as number));
    expect(Math.abs(pulses - want)).toBeLessThanOrEqual(1);
    expect(bs.mapHack[0]).toBe(0);
  });

  it('ホロパイロット：自分と同じ姿の 5 体が前へ走り出し、撃たれると消える（得点にならない）', () => {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'sora', { team: 0, pos: v3(0, 0.02, 0) });
    const en = sim.spawnPlayer('E', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -40) });
    bs.register(p.id, 'holopilot');
    fill(bs, p.id);
    for (let t = 0; t < 30; t++) step(sim, bs, t === 0 ? pressX(sim, p, 0) : undefined);
    const holos = [...sim.entities.values()].filter((e) => e.kind === 'holo');
    expect(holos.length).toBe(B.holopilot.COUNT);
    for (const h of holos) {
      expect(h.character).toBe('sora');
      expect(h.team).toBe(0);
      expect(h.name).toBe('P');
    }
    for (let t = 0; t < 60; t++) step(sim, bs);
    // 前（-Z）へ進んでいる
    for (const h of holos) if (sim.entities.has(h.id)) expect(h.movement.pos.z).toBeLessThan(-3);
    // 撃たれると消える
    const h0 = holos[0];
    sim.damageEntity(h0, 10, v3(), 'shot', en.id);
    step(sim, bs);
    expect(sim.entities.has(h0.id)).toBe(false);
    // 時間がたつと全部消える
    for (let t = 0; t < 60 * 12; t++) step(sim, bs);
    expect([...sim.entities.values()].some((e) => e.kind === 'holo')).toBe(false);
    expect(bs.holos.size).toBe(0);
  });

  it('フェイズリワインド：5 秒前にいた場所へ戻る。戻る間は弾が当たらない', () => {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    const en = sim.spawnPlayer('E', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(40, 0.02, 0) });
    bs.register(p.id, 'phaserewind');
    // 6 秒間、前へ歩く
    const walk = () => new Map([[p.id, { ...emptyCommand(sim.tick + 1), moveForward: 1 }]]);
    for (let t = 0; t < 60 * 6; t++) step(sim, bs, walk());
    const now = { ...p.movement.pos };
    const back = (B.phaserewind.REWIND as number) * 60;
    // 5 秒前の位置：まっすぐ歩いているので、だいたい今より後ろ
    fill(bs, p.id);
    step(sim, bs, pressX(sim, p));
    expect(bs.rewinding(p.id)).toBe(true);
    const hp = p.health;
    sim.damageEntity(p, 50, v3(), 'shot', en.id);
    expect(p.health).toBe(hp); // 戻っている間は当たらない
    for (let t = 0; t < 60; t++) step(sim, bs);
    expect(bs.rewinding(p.id)).toBe(false);
    expect(p.kinematic).toBe(false);
    const moved = lenH(sub(now, p.movement.pos));
    const speed = DEFAULT_MOVEMENT.WALK_SPEED ?? 6;
    expect(moved).toBeGreaterThan((back / 60) * speed * 0.6);
  });

  it('ハードカバー：目の前に大きな盾が 20 秒立ち、敵の弾を止める', () => {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    bs.register(p.id, 'hardcover');
    fill(bs, p.id);
    step(sim, bs, pressX(sim, p, 0));
    const sh = sim.shields.find((s) => s.kind === 'hardcover')!;
    expect(sh).toBeTruthy();
    expect(sh.width).toBe(B.hardcover.WIDTH);
    expect(sh.center.z).toBeLessThan(-1); // 前（-Z）
    for (let t = 0; t < 60 * 21; t++) step(sim, bs);
    expect(sim.shields.some((s) => s.kind === 'hardcover')).toBe(false);
  });

  it('ティック：投げると着地して敵へ這っていき、爆発する。倒したら投げた人のもの', () => {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    const en = sim.spawnPlayer('E', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -16) });
    en.maxHealth = en.health = 100;
    bs.register(p.id, 'ticks');
    fill(bs, p.id);
    const seen = new Set<string>();
    let kill: { killerId: number; source?: string } | null = null;
    for (let t = 0; t < 60 * 8 && !kill; t++) {
      for (const e of step(sim, bs, t === 0 ? pressX(sim, p, 0, 0) : undefined)) seen.add(e.type);
      const k = sim.events.find((x) => x.type === 'kill' && x.victimId === en.id);
      if (k && k.type === 'kill') kill = k;
    }
    expect(seen.has('tickThrow')).toBe(true);
    expect(seen.has('tickLand')).toBe(true);
    expect(seen.has('tickExplode')).toBe(true);
    expect(kill?.killerId).toBe(p.id);
    expect(kill?.source).toBe('tick');
  });

  it('ティック：高い壁があれば回り込み、低い段差は跳ねて越える', () => {
    for (const wallH of [4, 0.8]) {
      const level = {
        ...flatLevel((b) => b.boxTop(0, wallH, -10, 7, wallH, 0.6, 'wall')),
        bounds: { min: v3(-60, -6, -60), max: v3(60, 10, 60) },
      };
      const sim = new Simulation(level, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
      sim.soloTeam = false;
      sim.rules = { respawnTime: () => null, spawnInvuln: 0, assistWindow: 5 };
      const bs = new BoostSystem(sim, null, 11);
      const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
      const en = sim.spawnPlayer('E', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -14) });
      en.maxHealth = en.health = 100;
      bs.register(p.id, 'ticks');
      fill(bs, p.id);
      let exploded = false;
      for (let t = 0; t < 60 * 10 && !exploded; t++) {
        // 投げる人は後ろ向きに投げない：壁の手前へ低く
        for (const e of step(sim, bs, t === 0 ? pressX(sim, p, 0, -0.3) : undefined)) if (e.type === 'tickExplode') exploded = true;
      }
      expect(exploded, `wall ${wallH}m`).toBe(true);
      expect(en.dead || en.health < 100, `wall ${wallH}m`).toBe(true);
    }
  });

  /** ティックを投げて、着地させる（近くに敵がいないので、その場で待つ） */
  function landedTicks() {
    const { sim, bs } = arena();
    const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
    bs.register(p.id, 'ticks');
    fill(bs, p.id);
    for (let t = 0; t < 60 * 2; t++) step(sim, bs, t === 0 ? pressX(sim, p, 0, -0.3) : undefined);
    expect(bs.ticks.length).toBe(B.ticks.COUNT);
    for (const t of bs.ticks) expect(t.state).toBe('crawl');
    return { sim, bs, p };
  }

  it('ティック：爆弾兵と同じ大きさ・当たり判定の参加者（種類 tick）として出て、ティックと一緒に動く', () => {
    const { sim, bs } = landedTicks();
    for (const t of bs.ticks) {
      const e = sim.entities.get(t.entityId)!;
      expect(e.kind).toBe('tick');
      expect(e.team).toBe(0);
      expect(e.body).toBe(ASSAULT_BODY);
      expect(e.movement.height).toBeCloseTo(ASSAULT_HEIGHT, 5);
      expect(e.maxHealth).toBe(B.ticks.HEALTH);
      expect(lenH(sub(e.movement.pos, t.pos))).toBeLessThan(1e-6);
      // 横から撃った弾が、体に当たる
      const a = sim.actorOf(e);
      const hit = rayVsActor(v3(e.movement.pos.x - 10, e.movement.pos.y + 0.5, e.movement.pos.z), v3(1, 0, 0), 20, a);
      expect(hit).not.toBeNull();
    }
  });

  it('ティック：撃たれて体力が 0 になると、爆発せずに壊れる。得点・キルフィードにはならない', () => {
    const { sim, bs } = landedTicks();
    const en = sim.spawnPlayer('E', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(40, 0.02, 40) });
    const t = bs.ticks[0];
    const e = sim.entities.get(t.entityId)!;
    sim.damageEntity(e, 999, en.movement.pos, 'shot', en.id);
    const evs = step(sim, bs).map((x) => x.type);
    expect(evs).toContain('tickDestroyed');
    expect(evs).not.toContain('tickExplode');
    expect(bs.ticks.find((x) => x.id === t.id)).toBeUndefined();
    expect(bs.ticks.length).toBe((B.ticks.COUNT as number) - 1);
    // 体は少しして取り除かれ、復活しない
    for (let k = 0; k < 60 * 4; k++) step(sim, bs);
    expect(sim.entities.has(t.entityId)).toBe(false);
  });

  it('ティック：近くの歩兵を追いかけ、相手が動いても追いついて爆発する', () => {
    const { sim, bs } = landedTicks();
    const g = sim.spawnPlayer('G', ['ar', 'smg'], 'pearl', { team: 1, kind: 'grunt', pos: v3(12, 0.02, -10) });
    g.maxHealth = g.health = 100;
    let boom = false;
    for (let t = 0; t < 60 * 8 && !boom; t++) {
      // 歩兵は横へ歩いて離れていく
      const c = { ...emptyCommand(sim.tick + 1), yaw: -Math.PI / 2, moveForward: t < 90 ? 1 : 0 };
      boom = step(sim, bs, new Map([[g.id, c]])).some((x) => x.type === 'tickExplode');
    }
    expect(boom).toBe(true);
    expect(g.movement.pos.x).toBeGreaterThan(14);
    expect(g.health).toBeLessThan(100);
  });

  it('歩兵はティックに気づかない（近づいてきても撃たない）。パイロットのボットは近くのティックを撃って壊す', () => {
    for (const who of ['grunt', 'pilot'] as const) {
      const { sim, bs, p } = landedTicks();
      sim.despawn(p.id);
      const bw = new BotWorld(sim, buildNavGraph(sim.level, DEFAULT_MOVEMENT), 3, v3());
      const t = bs.ticks[0];
      const at = v3(t.pos.x, 0.02, t.pos.z - 9);
      const bot = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, kind: who === 'grunt' ? 'grunt' : 'pilot', pos: at, yaw: 0 });
      bot.maxHealth = bot.health = 9999;
      const brain =
        who === 'grunt'
          ? new GruntBot(bot.id, bw, sim.cfg, sim.wcfg, DEFAULT_BOTS.hard, 5, 0)
          : new PilotBot(bot.id, bw, sim.cfg, sim.wcfg, DEFAULT_BOTS.hard, sim.ccfg.pearl, 5);
      brain.setAim(0, -0.1);
      // ティックはこのボットを狙わない（その場にとどまる）
      for (const x of bs.ticks) (x.ignoreId = bot.id), (x.ignoreT = 99);
      let shots = 0;
      let noticed = false;
      let destroyed = false;
      for (let k = 0; k < 60 * 4 && !destroyed; k++) {
        bw.processPaths();
        const cmds = new Map([[bot.id, brain.think(bot, 1 / 60)]]);
        bs.preStep(cmds, true);
        sim.step(cmds);
        bs.postStep();
        for (const ev of bot.arsenal.events) if (ev.type === 'shot') shots++;
        if (brain.contacts.has(t.entityId)) noticed = true;
        if (bs.events.some((x) => x.type === 'tickDestroyed')) destroyed = true;
      }
      if (who === 'grunt') {
        expect(noticed, '歩兵は気づかない').toBe(false);
        expect(shots).toBe(0);
        expect(destroyed).toBe(false);
      } else {
        expect(noticed, 'パイロットは気づく').toBe(true);
        expect(destroyed).toBe(true);
      }
    }
  }, 30000);

  it('ダイスロール：ほかの 5 つのどれかが出る', () => {
    const got = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const { sim, bs } = arena();
      const p = sim.spawnPlayer('P', ['ar', 'smg'], 'meia', { team: 0, pos: v3(0, 0.02, 0) });
      (bs as unknown as { rng: { next(): number } }).rng.next = (() => {
        const v = (s * 0.137) % 1;
        return () => v;
      })();
      bs.register(p.id, 'diceroll');
      fill(bs, p.id);
      const used = step(sim, bs, pressX(sim, p)).find((e) => e.type === 'boostUsed');
      if (used && used.type === 'boostUsed') {
        expect(used.boost).toBe('diceroll');
        expect(used.rolled).toBeDefined();
        expect(used.rolled).not.toBe('diceroll');
        got.add(used.rolled!);
      }
    }
    expect(got.size).toBe(5);
  });
});

describe('ブースト：ロードアウトと試合', () => {
  it('ロードアウトに 1 つ入れる。壊れた値は直る', () => {
    for (const l of defaultLoadouts()) expect(BOOST_IDS).toContain(l.boost);
    const d = defaultLoadouts()[0];
    expect(repairLoadout({ ...d, boost: 'nope' }, d).boost).toBe(d.boost);
    expect(repairLoadout({ ...d, boost: 'ticks' }, d).boost).toBe('ticks');
    expect(checkLoadout({ ...d, boost: 'nope' }).ok).toBe(false);
    const old = { name: d.name, character: d.character, primary: d.primary, secondary: d.secondary, custom: {} };
    expect(repairLoadout(old, d).boost).toBe(d.boost); // 前の版の保存
  });

  it('消耗戦：得点でゲージがたまり、ボットもブーストを使う。ホロパイロットを倒しても得点にならない', () => {
    const city = buildNeonCity();
    const nav = buildNavGraph(city, DEFAULT_MOVEMENT);
    const sim = new Simulation(city, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
    const m = new AttritionMatch(sim, nav, { difficulty: 'normal', humanPlayer: true, seed: 5, playerBoost: 'holopilot' });
    expect(m.boosts.states.get(m.player!.id)!.boost).toBe('holopilot');
    let used = 0;
    for (let t = 0; t < 60 * 150; t++) {
      m.step(emptyCommand(sim.tick + 1));
      used += m.events.filter((e) => e.type === 'boost' && e.ev.type === 'boostUsed').length;
    }
    expect(used).toBeGreaterThan(0);
    // ゲージと得点：誰かのゲージがたまっている
    expect([...m.boosts.states.values()].some((s) => s.points > 0 || s.used > 0)).toBe(true);
    // ホロパイロットを倒しても、得点・倒された数は増えない
    const p = m.player!;
    for (let t = 0; t < 60 * 10 && p.dead; t++) m.step(emptyCommand(sim.tick + 1));
    m.boosts.addPoints(p.id, 999, false);
    const scores = [...m.scores];
    m.step({ ...emptyCommand(sim.tick + 1), yaw: p.lastCmd.yaw, boostPressed: true });
    const holo = [...sim.entities.values()].find((e) => e.kind === 'holo' && e.ownerId === p.id)!;
    expect(holo).toBeTruthy();
    const enemy = [...sim.entities.values()].find((e) => e.team === 1 && e.kind === 'pilot')!;
    // 敵の弾として当てる
    sim.damageEntity(holo, 50, enemy.movement.pos, 'shot', enemy.id);
    const kills0 = m.stats.get(enemy.id)!.kills;
    m.step(emptyCommand(sim.tick + 1));
    expect(sim.entities.has(holo.id)).toBe(false);
    expect(m.stats.get(enemy.id)!.kills).toBe(kills0);
    expect(m.scores[1]).toBeLessThanOrEqual(scores[1] + 10); // ホロの分の得点は入らない（ほかの撃ち合いの分だけ）
    void len;
  }, 60000);
});
