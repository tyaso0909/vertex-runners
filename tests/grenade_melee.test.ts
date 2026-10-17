import { describe, expect, it } from 'vitest';
import { v3 } from '../shared/math';
import { blastDamage } from '../shared/grenades';
import { buildCollisionWorld } from '../shared/level';
import { driver, flatLevel, weaponsCfg } from './helpers';

const c = weaponsCfg().COMMON;

/** 押して離す（グレネードを投げる） */
function throwGrenade(d: ReturnType<typeof driver>, pitch = 0, hold = 6) {
  d.run(hold, { grenadeHeld: true, pitch });
  d.run(1, { pitch });
}

describe('弾薬', () => {
  it('予備弾は無限：何度リロードしても予備弾が減らず、撃ち続けられる', () => {
    const w = weaponsCfg().ar;
    const d = driver(flatLevel());
    d.run(20, {});
    const mags = 5;
    // 弾倉5本分を撃つ（弾切れ → 自動リロード → また撃つ）
    const ticks = Math.ceil(mags * ((w.MAG_SIZE * 60 * 60) / w.RPM + w.RELOAD_TIME * 60)) + 60;
    d.run(ticks, { fireHeld: true, pitch: 0.4 });
    const shots = d.events.filter((e) => e === 'shot').length;
    expect(shots).toBeGreaterThanOrEqual(w.MAG_SIZE * mags);
    expect(d.p.arsenal.slots[0].reserve).toBe(w.RESERVE);
    expect(d.events.filter((e) => e === 'reloadEnd').length).toBeGreaterThanOrEqual(mags - 1);
  });

  it('リロードはそのまま必要（弾倉が空のあいだは撃てない）', () => {
    const w = weaponsCfg().ar;
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(Math.ceil((w.MAG_SIZE * 60 * 60) / w.RPM) + 2, { fireHeld: true, pitch: 0.4 });
    expect(d.p.arsenal.slots[0].ammo).toBe(0);
    const before = d.events.filter((e) => e === 'shot').length;
    d.run(Math.floor(w.RELOAD_TIME * 60) - 15, { fireHeld: true, pitch: 0.4 });
    expect(d.events.filter((e) => e === 'shot').length).toBe(before);
  });
});

describe('グレネード', () => {
  it('押している間は構え、離すと投げる。所持数が1つ減る', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(10, { grenadeHeld: true });
    expect(d.p.arsenal.cooking).toBe(true);
    expect(d.sim.grenades.length).toBe(0);
    d.run(1, {});
    expect(d.p.arsenal.cooking).toBe(false);
    expect(d.sim.grenades.length).toBe(1);
    expect(d.p.arsenal.grenades).toBe(c.GRENADE_COUNT - 1);
  });

  it('前方へ放物線を描いて飛び、地面で跳ねて止まり、GRENADE_FUSE 秒で爆発する', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    throwGrenade(d, 0.15);
    const g = d.sim.grenades[0];
    let maxY = 0;
    let t = 0;
    while (d.sim.grenades.length && t < 600) {
      d.run(1, {});
      if (d.sim.grenades.length) maxY = Math.max(maxY, d.sim.grenades[0].pos.y);
      t++;
    }
    expect(t / 60).toBeCloseTo(c.GRENADE_FUSE, 1);
    expect(maxY).toBeGreaterThan(2.5);
    expect(d.events).toContain('sim:grenadeBounce');
    expect(d.events).toContain('sim:explosion');
    // 前方（-Z）へ十数メートル飛んでいる
    expect(g.pos.z).toBeLessThan(-10);
    expect(g.pos.y).toBeLessThan(0.3);
  });

  it('爆風は中心ほど強く、半径の外には届かない', () => {
    const world = buildCollisionWorld(flatLevel());
    const center = v3(0, 0.1, 0);
    expect(blastDamage(center, v3(0.5, 0, 0), world, c)).toBe(c.GRENADE_MAX_DAMAGE);
    const mid = blastDamage(center, v3(4, 0, 0), world, c);
    expect(mid).toBeLessThan(c.GRENADE_MAX_DAMAGE);
    expect(mid).toBeGreaterThan(c.GRENADE_MIN_DAMAGE);
    expect(blastDamage(center, v3(c.GRENADE_BLAST_RADIUS + 1, 0, 0), world, c)).toBe(0);
  });

  it('壁の向こうには爆風が届かない', () => {
    const world = buildCollisionWorld(flatLevel((b) => b.boxRange(1.5, 0, -5, 2, 4, 5, 'wall')));
    expect(blastDamage(v3(0, 0.1, 0), v3(3, 0, 0), world, c)).toBe(0);
    expect(blastDamage(v3(0, 0.1, 0), v3(-3, 0, 0), world, c)).toBeGreaterThan(0);
  });

  it('的の足元で爆発すると的を倒せる', () => {
    const d = driver(flatLevel((b) => b.target(0, 0, -3, 0)));
    d.run(20, {});
    throwGrenade(d, -0.6);
    d.run(Math.ceil(c.GRENADE_FUSE * 60) + 5, {});
    expect(d.events).toContain('sim:explosion');
    expect(d.events).toContain('sim:blastKill');
    expect(d.sim.targets[0].alive).toBe(false);
  });

  it('所持数を使い切ると投げられず、時間で1つずつ回復する', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    for (let i = 0; i < c.GRENADE_COUNT; i++) {
      throwGrenade(d, 0.3);
      d.run(Math.ceil(c.GRENADE_COOLDOWN * 60) + 2, {});
    }
    expect(d.p.arsenal.grenades).toBe(0);
    throwGrenade(d, 0.3);
    expect(d.events).toContain('grenadeEmpty');
    expect(d.p.arsenal.grenades).toBe(0);
    d.run(Math.ceil(c.GRENADE_REGEN_TIME * 60) + 2, {});
    expect(d.p.arsenal.grenades).toBe(1);
  });

  it('構えている間は撃てない', () => {
    const d = driver(flatLevel());
    d.run(20, {});
    d.run(30, { grenadeHeld: true, fireHeld: true, pitch: 0.4 });
    expect(d.events).not.toContain('shot');
  });
});

describe('格闘', () => {
  it('目の前の的を殴ると MELEE_DAMAGE を与える', () => {
    const d = driver(flatLevel((b) => b.target(0, 0, -1.4, 0)));
    d.run(20, {});
    d.run(1, { meleePressed: true });
    const ev = d.p.arsenal.events.find((e) => e.type === 'melee');
    expect(ev && ev.type === 'melee' && ev.hit?.kind).toBe('target');
    expect(d.sim.targets[0].health).toBe(Math.max(0, 100 - c.MELEE_DAMAGE));
  });

  it('少し離れた的には踏み込んで殴る', () => {
    const d = driver(flatLevel((b) => b.target(0, 0, -2.9, 0)));
    d.run(20, {});
    d.run(1, { meleePressed: true });
    const ev = d.p.arsenal.events.find((e) => e.type === 'melee');
    expect(ev && ev.type === 'melee' && ev.lunge).toBe(true);
    expect(d.p.movement.vel.z).toBeLessThan(-c.MELEE_LUNGE_SPEED + 0.5);
  });

  it('遠すぎる的・横や後ろの的には当たらない', () => {
    const far = driver(flatLevel((b) => b.target(0, 0, -6, 0)));
    far.run(20, {});
    far.run(1, { meleePressed: true });
    expect(far.sim.targets[0].health).toBe(100);

    const side = driver(flatLevel((b) => b.target(1.5, 0, 0, 0)));
    side.run(20, {});
    side.run(1, { meleePressed: true });
    expect(side.sim.targets[0].health).toBe(100);
  });

  it('連打はできない（MELEE_COOLDOWN）。殴った直後は撃てない', () => {
    const d = driver(flatLevel((b) => b.target(0, 0, -1.4, 0)));
    const wc = weaponsCfg();
    d.run(20, {});
    d.run(1, { meleePressed: true });
    d.run(5, {});
    d.run(1, { meleePressed: true });
    expect(d.events.filter((e) => e === 'melee').length).toBe(1);
    d.run(Math.floor(wc.COMMON.MELEE_LOCK * 60) - 10, { fireHeld: true, pitch: 0.4 });
    expect(d.events).not.toContain('shot');
  });
});
