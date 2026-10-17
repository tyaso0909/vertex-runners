/**
 * 武器の追加（仕様 11.1 → 7.1）：トライデント（3点射）・ニードル・サイクロン（回転式）・テンペスト（全自動の散弾銃）・
 * ファルコン（半自動の狙撃銃）・ガベル（リボルバー）と、武器の固有の名前・武器種・一言の説明
 */
import { describe, expect, it } from 'vitest';
import { WEAPON_CLASSES, WEAPON_IDS, type WeaponId, classOf } from '../config';
import { checkLoadout, defaultLoadouts } from '../shared/loadout';
import { v3 } from '../shared/math';
import { currentRpm, sustainedRpm } from '../shared/weapons';
import { driver, flatLevel, weaponsCfg } from './helpers';

function range(dist: number, loadout: [WeaponId, WeaponId]) {
  const d = driver(flatLevel((b) => b.target(0, 0, -dist, 0)));
  d.sim.setLoadout(d.p.id, loadout);
  d.run(20, {});
  return d;
}
const aimBody = (dist: number) => Math.atan2(0.78 - 1.66, dist);
const aimHead = (dist: number) => Math.atan2(1.6 - 1.66, dist);
const shots = (d: ReturnType<typeof driver>) => d.events.filter((e) => e === 'shot').length;
/** 倒すまでに撃った弾数 */
const shotsToKill = (d: ReturnType<typeof driver>) => d.events.slice(0, d.events.indexOf('targetKilled')).filter((e) => e === 'shot').length;

describe('武器の名前・武器種・説明', () => {
  it('12 丁すべてに固有の名前・短い名前・武器種・一言の説明があり、名前は重ならない', () => {
    const w = weaponsCfg();
    const names = new Set<string>();
    const shorts = new Set<string>();
    for (const id of WEAPON_IDS) {
      expect(w[id].NAME.length).toBeGreaterThan(1);
      expect(w[id].BRIEF.length).toBeGreaterThan(5);
      expect(w[id].BRIEF.length).toBeLessThanOrEqual(26);
      expect(WEAPON_CLASSES).toContain(classOf(id, w));
      names.add(w[id].NAME);
      shorts.add(w[id].SHORT);
    }
    expect(names.size).toBe(WEAPON_IDS.length);
    expect(shorts.size).toBe(WEAPON_IDS.length);
    // どの武器種にも 2 丁ずつ
    for (const c of WEAPON_CLASSES) expect(WEAPON_IDS.filter((id) => classOf(id, w) === c).length).toBe(2);
  });

  it('新しい武器もロードアウトに入れられる', () => {
    const lo = { ...defaultLoadouts()[0], primary: 'spinlmg', secondary: 'revolver', custom: { marksman: { sight: 'x3', attachments: ['suppressor'] } } };
    const r = checkLoadout(lo);
    expect(r.ok).toBe(true);
    // ファルコンは最初から 2 倍のサイト
    expect(weaponsCfg().marksman.DEFAULT_SIGHT).toBe('x2');
  });
});

describe('トライデント（3点射）', () => {
  it('1 回押すと 3 発をまとめて撃ち、離しても点射は最後まで撃つ', () => {
    const d = range(10, ['burst', 'ar']);
    d.run(1, { fireHeld: true, firePressed: true, pitch: 0.5 });
    d.run(30, {});
    expect(shots(d)).toBe(3);
  });

  it('押し続けると、点射の間に待ちを入れて次の点射を撃つ', () => {
    const w = weaponsCfg().burst;
    const d = range(10, ['burst', 'ar']);
    d.run(120, { fireHeld: true, pitch: 0.5 });
    const n = shots(d);
    expect(n % 3 === 0 || n % 3 === 1).toBe(true);
    // 2 秒で撃てる弾数は点射の待ちを入れた速さに近い
    expect(n).toBeGreaterThanOrEqual(Math.floor((sustainedRpm(w) / 60) * 2) - 3);
    expect(n).toBeLessThanOrEqual(Math.ceil((sustainedRpm(w) / 60) * 2) + 3);
  });

  it('体に 3 発（1 回の点射）で倒せる', () => {
    const d = range(15, ['burst', 'ar']);
    d.run(25, { adsHeld: true, pitch: aimBody(15) });
    d.run(40, { adsHeld: true, fireHeld: true, pitch: aimBody(15) });
    expect(d.events).toContain('targetKilled');
    expect(shotsToKill(d)).toBeLessThanOrEqual(4);
  });
});

describe('サイクロン（回転式）', () => {
  it('撃ち始めは遅く、撃ち続けると速くなる。止めると回転はゆっくり落ちる', () => {
    const w = weaponsCfg().spinlmg;
    expect(currentRpm(w, 0)).toBe(w.RPM_MIN);
    expect(currentRpm(w, 1)).toBe(w.RPM);
    const d = range(10, ['spinlmg', 'ar']);
    d.run(30, { fireHeld: true, pitch: 0.5 });
    const first = shots(d); // 最初の 0.5 秒
    d.run(60, { fireHeld: true, pitch: 0.5 });
    const before = shots(d);
    d.run(30, { fireHeld: true, pitch: 0.5 });
    const last = shots(d) - before; // 回りきった後の 0.5 秒
    expect(last).toBeGreaterThan(first * 1.45);
    expect(d.p.arsenal.spin).toBe(1);
    expect(d.events).toContain('spinUp');
    d.run(30, {});
    expect(d.p.arsenal.spin).toBeGreaterThan(0.4);
    d.run(150, {});
    expect(d.p.arsenal.spin).toBe(0);
    expect(d.events).toContain('spinDown');
  });
});

describe('テンペスト・ファルコン・ガベル・ニードル', () => {
  it('テンペストは押し続けると続けて撃てる散弾銃（8 粒）', () => {
    const w = weaponsCfg().autosg;
    const d = range(6, ['autosg', 'ar']);
    d.run(60, { fireHeld: true, pitch: aimBody(6) });
    expect(shots(d)).toBeGreaterThanOrEqual(Math.floor(w.RPM / 60) - 1);
    expect(w.PELLETS).toBe(8);
    expect(w.RELOAD_PER_SHELL).toBe(false);
  });

  it('ファルコンは半自動：押しっぱなしでは 1 発。体なら 3 発、頭なら 2 発で倒せる', () => {
    const d = range(25, ['marksman', 'ar']);
    d.run(100, { fireHeld: true, pitch: 0.5 });
    expect(shots(d)).toBe(1);
    const b = range(25, ['marksman', 'ar']);
    b.run(30, { adsHeld: true, pitch: aimBody(25) });
    for (let i = 0; i < 6 && !b.events.includes('targetKilled'); i++) {
      b.run(1, { adsHeld: true, fireHeld: true, firePressed: true, pitch: aimBody(25) });
      b.run(20, { adsHeld: true, pitch: aimBody(25) });
    }
    expect(shotsToKill(b)).toBe(3);
    const hd = range(25, ['marksman', 'ar']);
    hd.run(30, { adsHeld: true, pitch: aimHead(25) });
    for (let i = 0; i < 6 && !hd.events.includes('targetKilled'); i++) {
      hd.run(1, { adsHeld: true, fireHeld: true, firePressed: true, pitch: aimHead(25) });
      hd.run(20, { adsHeld: true, pitch: aimHead(25) });
    }
    expect(shotsToKill(hd)).toBe(2);
  });

  it('ガベルは体に 2 発で倒せ、走りながら撃てる。シリンダーは 6 発', () => {
    const w = weaponsCfg().revolver;
    expect(w.FIRE_WHILE_SPRINT).toBe(true);
    expect(w.MAG_SIZE).toBe(6);
    const d = range(10, ['revolver', 'ar']);
    d.run(20, { adsHeld: true, pitch: aimBody(10) });
    for (let i = 0; i < 4 && !d.events.includes('targetKilled'); i++) {
      d.run(1, { adsHeld: true, fireHeld: true, firePressed: true, pitch: aimBody(10) });
      d.run(40, { adsHeld: true, pitch: aimBody(10) });
    }
    expect(shotsToKill(d)).toBe(2);
  });

  it('ニードルは ワスプより遠くで威力が落ちにくく、反動が小さい', () => {
    const w = weaponsCfg();
    expect(w.psmg.FALLOFF_END).toBeGreaterThan(w.smg.FALLOFF_END);
    expect(w.psmg.RECOIL_PITCH).toBeLessThan(w.smg.RECOIL_PITCH);
    expect(w.psmg.RPM).toBeLessThan(w.smg.RPM);
    void v3;
  });
});
