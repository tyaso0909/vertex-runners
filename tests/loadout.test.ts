import { describe, expect, it } from 'vitest';
import { LOADOUT_NAME_MAX, LOADOUT_SLOTS, checkLoadout, cleanLoadoutName, defaultLoadouts, repairLoadout, withWeapon } from '../shared/loadout';

describe('ロードアウト', () => {
  it('最初から 5 つあり、どれも正しい組み合わせ', () => {
    const d = defaultLoadouts();
    expect(d).toHaveLength(LOADOUT_SLOTS);
    for (const l of d) expect(checkLoadout(l).ok).toBe(true);
  });

  it('存在しないキャラクター・武器、同じ武器 2 つ、長すぎる名前は通さない（サーバーでの確認用）', () => {
    const ok = { name: '突撃', character: 'meia', primary: 'ar', secondary: 'shotgun' };
    expect(checkLoadout(ok).ok).toBe(true);
    expect(checkLoadout({ ...ok, character: 'nobody' }).ok).toBe(false);
    expect(checkLoadout({ ...ok, primary: 'railgun' }).ok).toBe(false);
    expect(checkLoadout({ ...ok, secondary: 'ar' }).ok).toBe(false);
    expect(checkLoadout({ ...ok, name: 'あ'.repeat(LOADOUT_NAME_MAX + 1) }).ok).toBe(false);
    expect(checkLoadout({ ...ok, name: ' 前後に空白 ' }).ok).toBe(false);
    expect(checkLoadout(null).ok).toBe(false);
    expect(checkLoadout('meia').ok).toBe(false);
  });

  it('壊れた保存は、使える形に直す', () => {
    const fb = defaultLoadouts()[0];
    expect(repairLoadout(undefined, fb)).toEqual(fb);
    const r = repairLoadout({ name: '', character: 'pearl', primary: 'sniper', secondary: 'sniper' }, fb);
    expect(r.character).toBe('pearl');
    expect(r.primary).toBe('sniper');
    expect(r.secondary).not.toBe('sniper');
    expect(r.name).toBe(fb.name);
    expect(checkLoadout(r).ok).toBe(true);
    // fallback のサブがメインと同じでも、別の武器になる
    const r2 = repairLoadout({ primary: 'shotgun', secondary: 'shotgun' }, fb);
    expect(r2.primary).toBe('shotgun');
    expect(r2.secondary).not.toBe('shotgun');
  });

  it('名前：改行・制御文字を取り、上限で切る', () => {
    expect(cleanLoadoutName('  強襲\n', 'x')).toBe('強襲');
    expect(cleanLoadoutName('', '既定')).toBe('既定');
    expect([...cleanLoadoutName('🔥'.repeat(20), 'x')]).toHaveLength(LOADOUT_NAME_MAX);
  });

  it('もう一方と同じ武器を選ぶと、入れ替わる', () => {
    const l = defaultLoadouts()[0]; // AR ＋ SG
    expect(withWeapon(l, 'primary', 'shotgun')).toMatchObject({ primary: 'shotgun', secondary: 'ar' });
    expect(withWeapon(l, 'secondary', 'sniper')).toMatchObject({ primary: 'ar', secondary: 'sniper' });
    expect(withWeapon(l, 'secondary', 'ar')).toMatchObject({ primary: 'shotgun', secondary: 'ar' });
  });
});
