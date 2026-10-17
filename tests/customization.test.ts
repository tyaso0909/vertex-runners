import { describe, expect, it } from 'vitest';
import { ATTACHMENT_IDS, SIGHT_IDS, WEAPON_IDS, attachmentsConfig } from '../config';
import { checkLoadout, customOf, defaultLoadouts, loadoutCustoms, repairLoadout, withCustom, withWeapon } from '../shared/loadout';
import { v3 } from '../shared/math';
import { allowedAttachments, allowedSights, checkCustom, customDef, defaultCustom, invalidateWeaponDefs, magnification, randomCustom, repairCustom, slotDef, withAttachment } from '../shared/weaponCustom';
import { driver, flatLevel, weaponsCfg } from './helpers';

const shots = (d: ReturnType<typeof driver>) => d.events.filter((e) => e === 'shot').length;

describe('武器のカスタマイズ（サイト・アタッチメント）', () => {
  it('どの武器も、最初のサイトが付けられる物の中にあり、付けられる物はすべて定義されている', () => {
    const wc = weaponsCfg();
    for (const id of WEAPON_IDS) {
      const w = wc[id];
      expect(allowedSights(w)).toContain(defaultCustom(w).sight);
      expect((w.SIGHTS as string[]).every((s) => (SIGHT_IDS as readonly string[]).includes(s))).toBe(true);
      expect((w.ATTACHMENTS as string[]).every((a) => (ATTACHMENT_IDS as readonly string[]).includes(a))).toBe(true);
      expect(allowedAttachments(w).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('付けられない物・3 つ以上・同じ物・銃口の部品 2 つは通さない', () => {
    const wc = weaponsCfg();
    expect(checkCustom({ sight: 'holo', attachments: ['extmag', 'stock'] }, wc.ar).ok).toBe(true);
    expect(checkCustom({ sight: 'variable', attachments: [] }, wc.ar).ok).toBe(false); // AR に可変スコープは付かない
    expect(checkCustom({ sight: 'iron', attachments: [] }, wc.sniper).ok).toBe(false);
    expect(checkCustom({ sight: 'holo', attachments: ['laser'] }, wc.sniper).ok).toBe(false);
    expect(checkCustom({ sight: 'holo', attachments: ['extmag', 'stock', 'laser'] }, wc.ar).ok).toBe(false);
    expect(checkCustom({ sight: 'holo', attachments: ['extmag', 'extmag'] }, wc.ar).ok).toBe(false);
    expect(checkCustom({ sight: 'holo', attachments: ['suppressor', 'compensator'] }, wc.ar).ok).toBe(false);
    expect(checkCustom({ sight: 'nope', attachments: [] }, wc.ar).ok).toBe(false);
    // 壊れた保存は直す
    const r = repairCustom({ sight: 'variable', attachments: ['suppressor', 'compensator', 'laser'] }, wc.ar);
    expect(r).toEqual({ sight: 'iron', attachments: ['suppressor', 'laser'] });
  });

  it('アタッチメントの枠：もう一方と同じ物・同じ場所の物を選ぶと入れ替わり、null で外せる', () => {
    const c = { sight: 'iron' as const, attachments: ['suppressor' as const, 'stock' as const] };
    expect(withAttachment(c, 1, 'compensator').attachments).toEqual(['compensator']);
    expect(withAttachment(c, 1, 'suppressor').attachments).toEqual(['suppressor']);
    expect(withAttachment(c, 0, 'laser').attachments).toEqual(['laser', 'stock']);
    expect(withAttachment(c, 0, null).attachments).toEqual(['stock']);
  });

  it('アタッチメントの効き目が数値に入る', () => {
    const wc = weaponsCfg();
    const ar = wc.ar;
    const base = customDef(ar, defaultCustom(ar));
    expect(base.MAG_SIZE).toBe(ar.MAG_SIZE);
    expect(customDef(ar, { sight: 'iron', attachments: ['extmag'] }).MAG_SIZE).toBe(Math.round(ar.MAG_SIZE * 1.4));
    expect(customDef(wc.sniper, { sight: 'sniper', attachments: ['extmag'] }).MAG_SIZE).toBe(7);
    expect(customDef(ar, { sight: 'iron', attachments: ['fastreload'] }).RELOAD_TIME).toBeCloseTo(ar.RELOAD_TIME * 0.7);
    const st = customDef(ar, { sight: 'iron', attachments: ['stock'] });
    expect(st.ADS_TIME).toBeCloseTo(ar.ADS_TIME * 0.7);
    expect(st.SWAP_TIME).toBeCloseTo(ar.SWAP_TIME * 0.7);
    expect(customDef(ar, { sight: 'iron', attachments: ['compensator'] }).RECOIL_PITCH).toBeCloseTo(ar.RECOIL_PITCH * 0.65);
    expect(customDef(ar, { sight: 'iron', attachments: ['laser'] }).HIP_SPREAD).toBeCloseTo(ar.HIP_SPREAD * 0.6);
    const sup = customDef(ar, { sight: 'iron', attachments: ['suppressor'] });
    expect(sup.SUPPRESSED).toBe(true);
    expect(sup.FALLOFF_END).toBeCloseTo(ar.FALLOFF_END * 0.85);
    const run = customDef(ar, { sight: 'iron', attachments: ['gunrunner'] });
    expect(ar.FIRE_WHILE_SPRINT).toBe(false);
    expect(run.FIRE_WHILE_SPRINT).toBe(true);
    expect(run.ADS_MOVE_MUL).toBeCloseTo(ar.ADS_MOVE_MUL);
    // 2 つ付けると両方効く
    const two = customDef(ar, { sight: 'x3', attachments: ['longbarrel', 'stock'] });
    expect(two.FALLOFF_START).toBeCloseTo(ar.FALLOFF_START * 1.3);
    expect(two.ADS_TIME).toBeCloseTo(ar.ADS_TIME * attachmentsConfig.SIGHTS.x3.ADS_TIME_MUL * 1.1 * 0.7);
  });

  it('サイト：倍率（視野角）・のぞく速さ・画面いっぱいのスコープか', () => {
    const wc = weaponsCfg();
    const iron = customDef(wc.ar, { sight: 'iron', attachments: [] });
    const x3 = customDef(wc.ar, { sight: 'x3', attachments: [] });
    expect(iron.ADS_FOV_MUL).toBe(wc.ar.ADS_FOV_MUL);
    expect(x3.ADS_FOV_MUL).toBeLessThan(iron.ADS_FOV_MUL);
    expect(magnification(x3.ADS_FOV_MUL)).toBeCloseTo(3, 0);
    expect(x3.ADS_TIME).toBeGreaterThan(iron.ADS_TIME);
    expect(x3.SCOPE).toBe(false);
    expect(customDef(wc.sniper, { sight: 'sniper', attachments: [] }).SCOPE).toBe(true);
    expect(customDef(wc.sniper, { sight: 'x3', attachments: [] }).SCOPE).toBe(false);
    const v = customDef(wc.sniper, { sight: 'variable', attachments: [] });
    expect(v.ZOOMS.length).toBe(2);
    expect(magnification(v.ZOOMS[1])).toBeCloseTo(8, 0);
    expect(customDef(wc.ar, { sight: 'threat', attachments: [] }).THREAT).toBe(true);
  });

  it('調整パネルで数値を変えると、作り置きの数値も作り直す', () => {
    const wc = weaponsCfg();
    const c = { sight: 'iron' as const, attachments: ['extmag' as const] };
    expect(customDef(wc.smg, c).MAG_SIZE).toBe(49);
    wc.smg.MAG_SIZE = 50;
    invalidateWeaponDefs();
    expect(customDef(wc.smg, c).MAG_SIZE).toBe(70);
  });

  it('試合：拡張マガジンなら弾切れまでに多く撃て、クイックリロードなら早く弾が戻る', () => {
    const lvl = flatLevel((b) => b.target(0, 0, -10, 0));
    const a = driver(lvl);
    a.sim.setLoadout(a.p.id, ['smg', 'ar'], [{ sight: 'iron', attachments: ['extmag', 'fastreload'] }]);
    a.run(20, {});
    const def = slotDef(a.sim.wcfg, a.p.arsenal.slots[0]);
    expect(def.MAG_SIZE).toBe(49);
    expect(a.p.arsenal.slots[0].ammo).toBe(49);
    a.run(Math.ceil((49 * 3600) / def.RPM) + 4, { fireHeld: true, pitch: 0.5 });
    expect(shots(a)).toBe(49);
    expect(a.p.arsenal.reloading).toBe(true);
    // 素の SMG のリロード（1.6 秒）より早く終わる
    a.run(Math.ceil(1.6 * 0.7 * 60) + 2, {});
    expect(a.p.arsenal.slots[0].ammo).toBe(49);
  });

  it('試合：サプレッサーを付けた銃声は、敵のボットに聞こえる距離が短い（撃った出来事にも印が付く）', () => {
    const lvl = flatLevel();
    const d = driver(lvl);
    d.sim.setLoadout(d.p.id, ['ar', 'smg'], [{ sight: 'iron', attachments: ['suppressor'] }]);
    d.run(20, {});
    let suppressed: boolean | null = null;
    for (let i = 0; i < 30 && suppressed === null; i++) {
      d.run(1, { fireHeld: true });
      const ev = d.p.arsenal.events.find((e) => e.type === 'shot');
      if (ev && ev.type === 'shot') suppressed = ev.suppressed;
    }
    expect(suppressed).toBe(true);
    expect(slotDef(d.sim.wcfg, d.p.arsenal.slots[0]).SUPPRESSED).toBe(true);
    expect(slotDef(d.sim.wcfg, d.p.arsenal.slots[1]).SUPPRESSED).toBe(false);
  });

  it('試合：ガンランナーを付けると、走りながらでも撃てる（撃ってもダッシュが止まらない）', () => {
    const lvl = flatLevel(undefined, v3(0, 0.02, 0));
    const run = (att: 'gunrunner' | null) => {
      const d = driver(lvl);
      d.sim.setLoadout(d.p.id, ['ar', 'smg'], [{ sight: 'iron', attachments: att ? [att] : [] }]);
      d.run(60, { moveForward: 1, sprintHeld: true });
      d.run(60, { moveForward: 1, sprintHeld: true, fireHeld: true, pitch: 0.3 });
      return { v: Math.hypot(d.p.movement.vel.x, d.p.movement.vel.z), shots: d.events.filter((e) => e === 'shot').length };
    };
    const g = run('gunrunner');
    const n = run(null);
    expect(g.shots).toBeGreaterThan(5);
    expect(g.v).toBeGreaterThan(n.v + 1);
  });

  it('ハンドガンは最初から走りながら撃てるので、ガンランナーは付けられない', () => {
    const w = weaponsCfg();
    expect(w.pistol.ATTACHMENTS).not.toContain('gunrunner');
    expect(w.revolver.ATTACHMENTS).not.toContain('gunrunner');
  });
});

describe('ロードアウトとカスタマイズ', () => {
  it('最初の 5 つは、カスタマイズも含めて正しい', () => {
    for (const l of defaultLoadouts()) {
      expect(checkLoadout(l).ok).toBe(true);
      const [p, s] = loadoutCustoms(l);
      expect(checkCustom(p, weaponsCfg()[l.primary]).ok).toBe(true);
      expect(checkCustom(s, weaponsCfg()[l.secondary]).ok).toBe(true);
    }
  });

  it('武器ごとに覚えていて、メイン武器を替えて戻すと前のカスタマイズに戻る', () => {
    let l = defaultLoadouts()[0]; // AR（ホロ・コンペンセイター・ストック）
    l = withCustom(l, 'ar', { sight: 'x2', attachments: ['laser'] });
    l = withWeapon(l, 'primary', 'lmg');
    expect(customOf(l, 'lmg')).toEqual({ sight: 'iron', attachments: [] });
    l = withWeapon(l, 'primary', 'ar');
    expect(customOf(l, 'ar')).toEqual({ sight: 'x2', attachments: ['laser'] });
  });

  it('正しくないカスタマイズの入ったロードアウトは通さず、保存が壊れていても直す', () => {
    const l = { ...defaultLoadouts()[0], custom: { ar: { sight: 'variable', attachments: [] } } };
    expect(checkLoadout(l).ok).toBe(false);
    const r = repairLoadout(l, defaultLoadouts()[0]);
    expect(r.custom.ar?.sight).toBe('iron');
    // 前の版の保存（カスタマイズなし）は、最初の組み合わせのカスタマイズを使う
    const old = repairLoadout({ name: '突撃', character: 'meia', primary: 'ar', secondary: 'shotgun' }, defaultLoadouts()[0]);
    expect(old.custom.ar).toEqual({ sight: 'holo', attachments: ['compensator', 'stock'] });
  });
});

describe('ボットのサイト・アタッチメント', () => {
  it('ランダムに選んでも、いつもその武器に付けられる正しい組み合わせになる', () => {
    const wc = weaponsCfg();
    let s = 12345;
    const next = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    const seen = new Set<string>();
    for (const id of WEAPON_IDS) {
      for (let i = 0; i < 200; i++) {
        const c = randomCustom(wc[id], next);
        expect(checkCustom(c, wc[id]).ok).toBe(true);
        seen.add(`${id}:${c.sight}`);
        for (const a of c.attachments) seen.add(`${id}:${a}`);
      }
      // いろいろな物が選ばれる
      for (const sg of allowedSights(wc[id])) expect(seen.has(`${id}:${sg}`)).toBe(true);
      for (const a of allowedAttachments(wc[id])) expect(seen.has(`${id}:${a}`)).toBe(true);
    }
  });

});
