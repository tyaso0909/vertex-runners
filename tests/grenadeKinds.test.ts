/**
 * グレネードの種類（ロードアウトで 1 つ選ぶ）：フラグ・アーク・ファイアスター・グラビティスター・スモーク・サッチェル
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVEMENT, GRENADE_IDS, type GrenadeId, grenadeNum, grenadesConfig } from '../config';
import { grenadeCount } from '../shared/grenades';
import { type InputCommand, emptyCommand } from '../shared/input';
import { checkLoadout, defaultLoadouts, repairLoadout } from '../shared/loadout';
import { type Vec3, len, lenH, sub, v3 } from '../shared/math';
import { type SimEvent, Simulation } from '../shared/simulation';
import { charsCfg, flatLevel, weaponsCfg } from './helpers';

const G = grenadesConfig;

function arena(kind: GrenadeId, wall = false) {
  const level = {
    ...flatLevel((b) => {
      // 正面 12m 先に高い壁（刺さる種類を刺す）
      if (wall) b.boxTop(0, 4, -12, 10, 4, 0.6, 'wall');
    }),
    bounds: { min: v3(-60, -6, -60), max: v3(60, 10, 60) },
  };
  const sim = new Simulation(level, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
  sim.soloTeam = false;
  sim.rules = { respawnTime: (e) => (e.kind === 'pilot' ? 5 : null), spawnInvuln: 0, assistWindow: 5 };
  const p = sim.spawnPlayer('P', ['ar', 'smg'], 'pearl', { team: 0, pos: v3(0, 0.02, 0), grenade: kind });
  const events: SimEvent[] = [];
  const step = (cmd: Partial<InputCommand> = {}, extra = new Map<number, InputCommand>()) => {
    const c: InputCommand = { ...emptyCommand(sim.tick + 1), yaw: 0, ...cmd };
    extra.set(p.id, c);
    sim.step(extra);
    events.push(...sim.events);
  };
  /** 構えて投げる */
  const throwIt = (pitch = 0) => {
    for (let i = 0; i < 6; i++) step({ grenadeHeld: true, pitch });
    step({ pitch });
  };
  const enemy = (pos: Vec3, name = 'E') => {
    const e = sim.spawnPlayer(name, ['ar', 'smg'], 'pearl', { team: 1, pos });
    e.maxHealth = e.health = 100;
    e.regen = false;
    return e;
  };
  return { sim, p, step, throwIt, enemy, events };
}

const run = (n: number, step: () => void) => {
  for (let i = 0; i < n; i++) step();
};

describe('グレネードの種類：数・ロードアウト', () => {
  it('種類ごとに所持数・回復の時間が決まる。ロードアウトで 1 つ選び、壊れた値は直る', () => {
    const c = weaponsCfg().COMMON;
    for (const k of GRENADE_IDS) {
      const { p } = arena(k);
      expect(p.arsenal.grenadeKind).toBe(k);
      expect(p.arsenal.grenades).toBe(grenadeCount(k, c));
    }
    const lo = defaultLoadouts();
    expect(new Set(lo.map((l) => l.grenade)).size).toBeGreaterThanOrEqual(4);
    const ok = checkLoadout({ ...lo[0], grenade: 'satchel' });
    expect(ok.ok && ok.loadout.grenade).toBe('satchel');
    expect(checkLoadout({ ...lo[0], grenade: 'nuke' }).ok).toBe(false);
    // 古い保存（グレネードがない）は、その枠の最初のグレネード
    const { grenade: _g, ...old } = lo[2];
    void _g;
    expect(repairLoadout(old, lo[2]).grenade).toBe(lo[2].grenade);
  });

  it('試合中にグレネードの種類を変えられる（所持数は満タン、置いたサッチェルは消える）', () => {
    const { sim, p, throwIt, step } = arena('satchel');
    run(10, step);
    throwIt(0.1);
    run(60, step);
    expect(sim.grenades.length).toBe(1);
    sim.setGrenade(p.id, 'arc');
    expect(sim.grenades.length).toBe(0);
    expect(p.arsenal.grenadeKind).toBe('arc');
    expect(p.arsenal.grenades).toBe(grenadeCount('arc', weaponsCfg().COMMON));
  });
});

describe('アークグレネード', () => {
  it('放電で小さなダメージ。電撃を受けた敵は動きが鈍る', () => {
    const { sim, step, throwIt, enemy, events } = arena('arc');
    run(10, step);
    throwIt(-0.25);
    // 落ちる所に敵を置く
    const e = enemy(v3(0, 0.02, -5));
    let t = 0;
    while (!events.some((x) => x.type === 'explosion') && t++ < 300) {
      // 敵は落ちた所へ寄る
      const g = sim.grenades[0];
      if (g) {
        e.movement.pos.x = g.pos.x;
        e.movement.pos.z = g.pos.z - 1.2;
      }
      step();
    }
    const ex = events.find((x) => x.type === 'explosion');
    expect(ex && ex.type === 'explosion' && ex.kind).toBe('arc');
    expect(e.health).toBeLessThan(100);
    expect(e.health).toBeGreaterThan(100 - grenadeNum(G.arc, 'MAX_DAMAGE', 32) - 1);
    expect(e.shock).toBeGreaterThan(2);
    expect(events.some((x) => x.type === 'shocked' && x.entityId === e.id)).toBe(true);
    expect(sim.shockMul(e)).toBeLessThan(0.6);
    // 走る速さが落ちる
    const start = { ...e.movement.pos };
    const cmds = () => new Map([[e.id, { ...emptyCommand(sim.tick + 1), yaw: 0, moveForward: 1, sprintHeld: true }]]);
    for (let i = 0; i < 40; i++) step({}, cmds());
    const slow = lenH(sub(e.movement.pos, start));
    e.shock = 0;
    const s2 = { ...e.movement.pos };
    for (let i = 0; i < 40; i++) step({}, cmds());
    const fast = lenH(sub(e.movement.pos, s2));
    expect(slow).toBeLessThan(fast * 0.75);
  });
});

describe('ファイアスター', () => {
  it('壁に刺さり、燃える所にいる敵を焼き続ける。倒すと投げた人のもの（種類が残る）', () => {
    const { sim, p, step, throwIt, enemy, events } = arena('firestar', true);
    run(10, step);
    throwIt(-0.05);
    let t = 0;
    while (!events.some((x) => x.type === 'grenadeStick') && t++ < 120) step();
    const st = events.find((x) => x.type === 'grenadeStick');
    expect(st && st.type === 'grenadeStick' && st.entityId).toBe(-1);
    const g = sim.grenades[0];
    expect(g.stuck).toBeTruthy();
    // 壁の前に敵を立たせる
    const e = enemy(v3(g.pos.x, 0.02, g.pos.z + 1.0));
    let kill: SimEvent | undefined;
    for (let i = 0; i < 60 * 6 && !kill; i++) {
      step();
      kill = sim.events.find((x) => x.type === 'kill' && x.victimId === e.id);
    }
    expect(events.some((x) => x.type === 'grenadeActivate')).toBe(true);
    expect(kill && kill.type === 'kill' && kill.killerId).toBe(p.id);
    expect(kill && kill.type === 'kill' && kill.grenade).toBe('firestar');
  });

  it('敵に当たると、その敵に刺さって一緒に動き、その敵ごと燃える', () => {
    const { sim, step, throwIt, enemy, events } = arena('firestar');
    const e = enemy(v3(0, 0.02, -6));
    e.maxHealth = e.health = 400;
    run(10, step);
    throwIt(-0.2);
    let t = 0;
    while (!events.some((x) => x.type === 'grenadeStick') && t++ < 120) step();
    const st = events.find((x) => x.type === 'grenadeStick');
    expect(st && st.type === 'grenadeStick' && st.entityId).toBe(e.id);
    // 敵が動くと、一緒に動く
    e.movement.pos.x += 3;
    step();
    const g = sim.grenades[0];
    expect(Math.abs(g.pos.x - e.movement.pos.x)).toBeLessThan(0.8);
    run(60 * 3, step);
    expect(e.health).toBeLessThan(400 - grenadeNum(G.firestar, 'FIRE_DPS', 30) * 2);
  });
});

describe('グラビティスター', () => {
  it('刺さると周りの敵を引き寄せて浮かせ、そのあと爆発する', () => {
    const { sim, step, throwIt, enemy, events } = arena('gravity', true);
    run(10, step);
    throwIt(-0.05);
    let t = 0;
    while (!events.some((x) => x.type === 'grenadeStick') && t++ < 120) step();
    const g = sim.grenades[0];
    expect(g?.stuck).toBeTruthy();
    const center = sim.gravityCenter(g);
    // 渦から 5m ほど離れた所に敵
    const e = enemy(v3(center.x + 5, 0.02, center.z + 1.5));
    e.maxHealth = e.health = 300;
    const d0 = len(sub(center, e.movement.pos));
    let maxY = 0;
    let ex: SimEvent | undefined;
    for (let i = 0; i < 60 * 3 && !ex; i++) {
      step();
      maxY = Math.max(maxY, e.movement.pos.y);
      ex = sim.events.find((x) => x.type === 'explosion');
      if (!ex) expect(e.dead).toBe(false);
    }
    expect(ex && ex.type === 'explosion' && ex.kind).toBe('gravity');
    expect(len(sub(center, e.movement.pos))).toBeLessThan(d0 * 0.5);
    expect(maxY).toBeGreaterThan(0.5);
    expect(e.health).toBeLessThan(300 - grenadeNum(G.gravity, 'MIN_DAMAGE', 25));
  });
});

describe('スモークグレネード', () => {
  it('時間で煙の幕を張り、煙の向こうの見通しをふさぐ。時間が来ると消える', () => {
    const { sim, step, throwIt, events } = arena('smoke');
    run(10, step);
    throwIt(-0.15);
    let t = 0;
    while (!events.some((x) => x.type === 'grenadeActivate') && t++ < 200) step();
    expect(t).toBeLessThan(200);
    run(90, step);
    const sm = sim.smokes();
    expect(sm.length).toBe(1);
    const c = sm[0].pos;
    // 煙をまたぐ見通しはふさがれ、煙のない所は見える
    expect(sim.smokeBlocks(v3(c.x - 12, 1.5, c.z), v3(c.x + 12, 1.5, c.z))).toBe(true);
    expect(sim.smokeBlocks(v3(c.x - 12, 1.5, c.z + 15), v3(c.x + 12, 1.5, c.z + 15))).toBe(false);
    run(60 * grenadeNum(G.smoke, 'SMOKE_TIME', 12), step);
    expect(sim.smokes().length).toBe(0);
    expect(events.some((x) => x.type === 'grenadeEnd')).toBe(true);
  });
});

describe('サッチェル', () => {
  it('張り付いて待ち、もう一度 G を押すと起爆する。置いた人が倒されると消える', () => {
    const { sim, p, step, throwIt, enemy, events } = arena('satchel');
    run(10, step);
    throwIt(-0.2);
    run(120, step);
    expect(sim.grenades.length).toBe(1);
    expect(p.arsenal.satchelsOut).toBe(1);
    expect(events.some((x) => x.type === 'explosion')).toBe(false);
    const g = sim.grenades[0];
    const e = enemy(v3(g.pos.x, 0.02, g.pos.z - 1));
    e.maxHealth = e.health = 100;
    // G を押す → 起爆
    step({ grenadeHeld: true });
    step();
    run(5, step);
    const ex = events.find((x) => x.type === 'explosion');
    expect(ex && ex.type === 'explosion' && ex.kind).toBe('satchel');
    expect(e.dead).toBe(true);
    // 2 つ目を置いて、置いた人が倒されると消える
    run(30, step);
    throwIt(-0.2);
    run(60, step);
    expect(sim.grenades.length, JSON.stringify([p.arsenal.grenades, p.arsenal.satchelsOut, p.arsenal.grenadeCooldown, p.dead])).toBe(1);
    sim.damageEntity(p, 999, p.movement.pos, 'shot', e.id);
    run(2, step);
    expect(sim.grenades.length).toBe(0);
  });
});

describe('ボット', () => {
  it('煙の向こうの敵は見えない', async () => {
    const { BotWorld } = await import('../shared/bots/botWorld');
    const { PilotBot } = await import('../shared/bots/pilotBot');
    const { buildNavGraph } = await import('../shared/nav');
    const { botsConfig, charactersConfig } = await import('../config');
    const { sim, p, step, throwIt } = arena('smoke');
    const e = sim.spawnPlayer('B', ['ar', 'smg'], 'pearl', { team: 1, pos: v3(0, 0.02, -16), yaw: Math.PI });
    const bw = new BotWorld(sim, buildNavGraph(sim.level, sim.cfg), 1, v3());
    const bot = new PilotBot(e.id, bw, sim.cfg, sim.wcfg, botsConfig.normal, charactersConfig.pearl, 7);
    bot.setAim(Math.PI, 0);
    const sees = () => {
      for (let i = 0; i < 6; i++) bot.think(e, 1 / 60);
      return [...(bot as unknown as { contacts: Map<number, { visible: boolean }> }).contacts.values()].some((c) => c.visible);
    };
    run(10, step);
    // 敵（ボット）は自分の方を向いている：煙の前は見える
    (bot as unknown as { aimYaw: number }).aimYaw = Math.PI;
    expect(sees()).toBe(true);
    throwIt(-0.2);
    run(60 * 3, step);
    void p;
    // 煙が自分とボットの間にある
    const sm = sim.smokes()[0];
    expect(sm).toBeTruthy();
    expect(sim.smokeBlocks(sim.eyeOf(e), sim.eyeOf(p))).toBe(true);
    (bot as unknown as { contacts: Map<number, unknown> }).contacts.clear();
    expect(sees()).toBe(false);
  });
});
