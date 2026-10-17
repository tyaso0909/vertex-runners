import { describe, expect, it } from 'vitest';
import type { WeaponId } from '../config';
import { v3 } from '../shared/math';
import { falloffMul } from '../shared/weapons';
import { driver, flatLevel, weaponsCfg } from './helpers';

/** 原点に立ち、-Z 方向 dist m 先に的を1体置いた射撃場 */
function range(dist: number, loadout: [WeaponId, WeaponId] = ['ar', 'shotgun'], moving = false) {
  const lvl = flatLevel((b) => {
    if (moving) b.target(-3, 0, -dist, 0, v3(3, 0, -dist), 3);
    else b.target(0, 0, -dist, 0);
  });
  const d = driver(lvl);
  d.sim.setLoadout(d.p.id, loadout);
  d.run(20, {}); // 着地
  return d;
}

function rangeWith(dist: number, wc: ReturnType<typeof weaponsCfg>, loadout: [WeaponId, WeaponId] = ['ar', 'shotgun']) {
  const lvl = flatLevel((b) => b.target(0, 0, -dist, 0));
  const d = driver(lvl, undefined, wc);
  d.sim.setLoadout(d.p.id, loadout);
  d.run(20, {});
  return d;
}

/** 体の中心・頭の中心を狙う pitch */
const aimBody = (dist: number) => Math.atan2(0.78 - 1.66, dist);
const aimHead = (dist: number) => Math.atan2(1.6 - 1.66, dist);

const shots = (d: ReturnType<typeof driver>) => d.events.filter((e) => e === 'shot').length;

describe('連射速度と弾数', () => {
  it('アサルトライフルは 600発/分（1秒で10発）', () => {
    const d = range(10);
    d.run(60, { fireHeld: true, pitch: aimBody(10) });
    expect(shots(d)).toBeGreaterThanOrEqual(10);
    expect(shots(d)).toBeLessThanOrEqual(11);
  });

  it('ライトマシンガンは 700発/分（3秒で約35発。ティックの刻みで連射が遅くならない）', () => {
    const d = range(10, ['lmg', 'ar']);
    d.run(180, { fireHeld: true, pitch: 0.5 });
    expect(shots(d)).toBeGreaterThanOrEqual(34);
    expect(shots(d)).toBeLessThanOrEqual(36);
  });

  it('単発の武器（スナイパー）は押しっぱなしでも1発だけ', () => {
    const d = range(10, ['sniper', 'ar']);
    d.run(150, { fireHeld: true, pitch: 0.5 });
    expect(shots(d)).toBe(1);
  });

  it('弾切れで自動リロードし、リロード時間のあと弾が戻る（予備弾を有限にした場合は予備弾が減る）', () => {
    const wc = weaponsCfg();
    wc.COMMON.INFINITE_RESERVE = false;
    const w = wc.ar;
    const d = rangeWith(10, wc);
    d.run(Math.ceil((w.MAG_SIZE * 60 * 60) / w.RPM) + 5, { fireHeld: true, pitch: 0.5 });
    expect(shots(d)).toBe(w.MAG_SIZE);
    expect(d.events).toContain('reloadStart');
    const slot = d.p.arsenal.slots[0];
    expect(slot.ammo).toBe(0);
    d.run(Math.ceil(w.RELOAD_TIME * 60) + 2, {});
    expect(slot.ammo).toBe(w.MAG_SIZE);
    expect(slot.reserve).toBe(w.RESERVE - w.MAG_SIZE);
  });

  it('ショットガンは1発ずつ込め、撃てば込めるのを中断できる', () => {
    const w = weaponsCfg().shotgun;
    const d = range(10, ['shotgun', 'ar']);
    // 3発撃つ
    for (let i = 0; i < 3; i++) {
      d.run(1, { fireHeld: true, pitch: 0.5 });
      d.run(45, {});
    }
    expect(d.p.arsenal.slots[0].ammo).toBe(w.MAG_SIZE - 3);
    d.run(1, { reloadPressed: true });
    d.run(Math.ceil((w.RELOAD_START_DELAY + w.RELOAD_TIME) * 60) + 2, {});
    expect(d.p.arsenal.slots[0].ammo).toBe(w.MAG_SIZE - 2); // 1発込めた
    d.run(1, { fireHeld: true, pitch: 0.5 }); // 撃って中断
    expect(d.p.arsenal.reloading).toBe(false);
    expect(shots(d)).toBe(4);
  });
});

describe('ダメージ', () => {
  it('アサルトライフルは体に4発で倒せる（ADS で確実に当てる）', () => {
    const d = range(15);
    d.run(20, { adsHeld: true, pitch: aimBody(15) });
    d.run(60, { adsHeld: true, fireHeld: true, pitch: aimBody(15) });
    expect(d.events).toContain('targetKilled');
    const firstKill = d.events.indexOf('targetKilled');
    const shotsBeforeKill = d.events.slice(0, firstKill).filter((e) => e === 'shot').length;
    expect(shotsBeforeKill).toBe(4);
  });

  it('ヘッドショットは 1.5倍、スナイパーは頭に当たれば 2倍（1発で倒せる）', () => {
    const d = range(30, ['sniper', 'ar']);
    d.run(30, { adsHeld: true, pitch: aimHead(30) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: aimHead(30) });
    const shot = d.p.arsenal.events.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.hits[0].head).toBe(true);
    expect(shot && shot.type === 'shot' && shot.hits[0].damage).toBeCloseTo(150);
    expect(d.events).toContain('targetKilled');
  });

  it('スナイパーは胴に当たると 75（体力 100 の相手は1発では倒れない）', () => {
    const d = range(30, ['sniper', 'ar']);
    d.run(30, { adsHeld: true, pitch: aimBody(30) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: aimBody(30) });
    const shot = d.p.arsenal.events.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.hits[0].head).toBe(false);
    expect(shot && shot.type === 'shot' && shot.hits[0].damage).toBeCloseTo(75);
    expect(d.sim.targets[0].alive).toBe(true);
  });

  it('ショットガンの距離減衰：8m までは減らず、22m で 35% まで下がる', () => {
    const w = weaponsCfg().shotgun;
    expect(falloffMul(w, 8)).toBe(1);
    expect(falloffMul(w, 15)).toBeCloseTo(1 - 0.65 * 0.5);
    expect(falloffMul(w, 22)).toBeCloseTo(0.35);
    expect(falloffMul(w, 40)).toBeCloseTo(0.35);
  });

  it('距離で威力が下がる（SMG は 30m 以上で 45%）', () => {
    const w = weaponsCfg().smg;
    expect(falloffMul(w, 5)).toBe(1);
    expect(falloffMul(w, 20)).toBeCloseTo(1 - 0.55 * 0.5);
    expect(falloffMul(w, 40)).toBeCloseTo(0.45);
    const d = range(40, ['smg', 'ar']);
    d.run(20, { adsHeld: true, pitch: aimBody(40) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: aimBody(40) });
    const shot = d.p.arsenal.events.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.hits[0].damage).toBeCloseTo(18 * 0.45);
  });

  it('ショットガンは8粒が近距離でまとまって当たり、至近距離ならほぼ一撃', () => {
    const d = range(3, ['shotgun', 'ar']);
    d.run(1, { fireHeld: true, pitch: aimBody(3) });
    const shot = d.p.arsenal.events.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.dirs.length).toBe(8);
    const dmg = shot && shot.type === 'shot' ? shot.hits.reduce((s, h) => s + (h.damage ?? 0), 0) : 0;
    expect(dmg).toBeGreaterThanOrEqual(70);
  });

  it('倒した的は少しして復活し、撃たれなければ体力が戻る', () => {
    const c = weaponsCfg().COMMON;
    const d = range(15);
    d.run(20, { adsHeld: true, pitch: aimBody(15) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: aimBody(15) });
    const t = d.sim.targets[0];
    expect(t.health).toBe(75);
    d.run(Math.ceil(c.TARGET_REGEN_DELAY * 60) + 2, {});
    expect(t.health).toBe(100);
    d.run(60, { adsHeld: true, fireHeld: true, pitch: aimBody(15) });
    expect(t.alive).toBe(false);
    d.run(Math.ceil(c.TARGET_RESPAWN_TIME * 60) + 2, {});
    expect(t.alive).toBe(true);
    expect(t.health).toBe(100);
  });
});

describe('ばらつき・エイム', () => {
  it('スナイパーの腰だめは 50m 先にほとんど当たらず、ADS なら必ず当たる', () => {
    let hipHits = 0;
    for (let i = 0; i < 20; i++) {
      const d = range(50, ['sniper', 'ar']);
      d.p.arsenal.rng = 1000 + i;
      d.run(1, { fireHeld: true, pitch: aimBody(50) });
      const shot = d.p.arsenal.events.find((e) => e.type === 'shot');
      if (shot && shot.type === 'shot' && shot.hits[0].kind === 'target') hipHits++;
    }
    expect(hipHits).toBeLessThanOrEqual(4);
    const d = range(50, ['sniper', 'ar']);
    d.run(30, { adsHeld: true, pitch: aimBody(50) });
    d.run(1, { adsHeld: true, fireHeld: true, pitch: aimBody(50) });
    const shot = d.p.arsenal.events.find((e) => e.type === 'shot');
    expect(shot && shot.type === 'shot' && shot.hits[0].kind).toBe('target');
  });

  it('LMG は撃ち続けるほど集弾が良くなる', async () => {
    const { currentSpread } = await import('../shared/weapons');
    const d = range(10, ['lmg', 'ar']);
    const w = weaponsCfg();
    const s0 = currentSpread(d.p.arsenal, d.p.movement, w);
    d.run(120, { fireHeld: true, pitch: 0.5 });
    const s1 = currentSpread(d.p.arsenal, d.p.movement, w);
    expect(s1).toBeLessThan(s0 * 0.75);
  });

  it('空中・壁走り中はばらつきが増える', async () => {
    const { currentSpread } = await import('../shared/weapons');
    const w = weaponsCfg();
    const d = range(10);
    const ground = currentSpread(d.p.arsenal, d.p.movement, w);
    d.p.movement.state = 'air';
    const air = currentSpread(d.p.arsenal, d.p.movement, w);
    d.p.movement.state = 'wallrun';
    const wall = currentSpread(d.p.arsenal, d.p.movement, w);
    expect(air).toBeGreaterThan(ground * 1.4);
    expect(wall).toBeGreaterThan(ground * 1.2);
  });

  it('エイム中は移動が遅くなり、ダッシュできない', () => {
    const d = range(10);
    d.run(60, { moveForward: 1, sprintHeld: true });
    const sprint = Math.hypot(d.p.movement.vel.x, d.p.movement.vel.z);
    d.run(60, { moveForward: 1, sprintHeld: true, adsHeld: true });
    const ads = Math.hypot(d.p.movement.vel.x, d.p.movement.vel.z);
    expect(sprint).toBeCloseTo(8, 1);
    expect(ads).toBeCloseTo(5 * weaponsCfg().ar.ADS_MOVE_MUL, 1);
  });

  it('SMG を持つと速く、LMG を持つと遅く走る', () => {
    const speed = (id: WeaponId) => {
      const d = range(10, [id, 'ar']);
      d.run(60, { moveForward: 1, sprintHeld: true });
      return Math.hypot(d.p.movement.vel.x, d.p.movement.vel.z);
    };
    expect(speed('smg')).toBeGreaterThan(speed('ar') + 0.4);
    expect(speed('lmg')).toBeLessThan(speed('ar') - 0.6);
  });
});

describe('持ち替え', () => {
  it('持ち替えている間は撃てず、SWAP_TIME 後に撃てる', () => {
    const w = weaponsCfg().shotgun;
    const d = range(10);
    d.run(1, { switchTo: 1 });
    expect(d.p.arsenal.active).toBe(1);
    d.run(Math.floor(w.SWAP_TIME * 60) - 3, { fireHeld: true, pitch: 0.5 });
    expect(shots(d)).toBe(0);
    d.run(5, {});
    d.run(6, { fireHeld: true, pitch: 0.5 });
    expect(shots(d)).toBe(1);
  });

  it('ホイールでもう一方へ切り替わる', () => {
    const d = range(10);
    d.run(1, { switchNext: true });
    expect(d.p.arsenal.active).toBe(1);
    d.run(1, { switchNext: true });
    expect(d.p.arsenal.active).toBe(0);
  });
});

describe('ハンドガン', () => {
  it('単発：押しっぱなしでも1発、押すたびに1発（400発/分ほどまで）', () => {
    const d = range(10, ['pistol', 'ar']);
    d.run(60, { fireHeld: true, pitch: aimBody(10) });
    expect(shots(d)).toBe(1);
    const d2 = range(10, ['pistol', 'ar']);
    d2.run(120, (t) => ({ fireHeld: t % 6 < 3, pitch: aimBody(10) }));
    expect(shots(d2)).toBeGreaterThanOrEqual(10);
    expect(shots(d2)).toBeLessThanOrEqual(15);
  });

  it('体に4発で倒せ（1 発 25）、持ち替え・エイムが一番速い', () => {
    const wc = weaponsCfg();
    const p = wc.pistol;
    expect(p.DAMAGE).toBe(25);
    expect(p.DAMAGE * 4).toBeGreaterThanOrEqual(100);
    expect(p.DAMAGE * 3).toBeLessThan(100);
    for (const id of ['ar', 'lmg', 'smg', 'shotgun', 'sniper'] as const) {
      expect(p.SWAP_TIME).toBeLessThan(wc[id].SWAP_TIME);
      expect(p.ADS_TIME).toBeLessThan(wc[id].ADS_TIME);
      expect(p.MOVE_SPEED_MUL).toBeGreaterThan(wc[id].MOVE_SPEED_MUL);
    }
  });

  it('ダッシュしたまま撃てる（ほかの武器は撃つとダッシュが止まる）', () => {
    const speed = (w: 'pistol' | 'ar') => {
      const d = range(40, [w, 'smg']);
      d.run(60, { moveForward: 1, sprintHeld: true });
      let shotsFired = 0;
      d.run(60, (t) => ({ moveForward: 1, sprintHeld: true, fireHeld: t % 8 < 4 }));
      shotsFired = shots(d);
      return { v: Math.hypot(d.p.movement.vel.x, d.p.movement.vel.z), shotsFired };
    };
    const p = speed('pistol');
    const a = speed('ar');
    expect(p.shotsFired).toBeGreaterThan(3);
    expect(p.v).toBeGreaterThan(7.5);
    expect(a.v).toBeLessThan(p.v - 1);
  });
});
