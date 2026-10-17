/**
 * タワーディフェンスの購入メニューのアイテム（設置物・タレットの強化・アーマー）のテスト
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVEMENT, type TdConfig, tdConfig } from '../config';
import { emptyCommand } from '../shared/input';
import { buildFortress } from '../shared/levels/fortress';
import { len, lenH, sub, v3 } from '../shared/math';
import { buildNavGraph } from '../shared/nav';
import { Simulation } from '../shared/simulation';
import { TdMatch } from '../shared/td/towerDefense';
import { segDist2D, trapNodes } from '../shared/td/devices';
import { charsCfg, weaponsCfg } from './helpers';

const fortress = buildFortress();
const nav = buildNavGraph(fortress, DEFAULT_MOVEMENT);
const PI = Math.PI;

function makeMatch(cfg: Partial<TdConfig> = {}) {
  const sim = new Simulation(fortress, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
  const m = new TdMatch(sim, nav, { difficulty: 'normal', humanPlayer: true, seed: 7 }, { ...tdConfig, ...cfg } as TdConfig);
  for (const b of m.allies.values()) b.think = () => b.idle();
  for (let i = 0; i < 60 * 10 && m.phase !== 'prep'; i++) m.step(emptyCommand(m.sim.tick + 1));
  const pid = m.player!.id;
  m.participantOf(pid)!.credits = 8000;
  return { m, pid };
}
const run = (m: TdMatch, secs: number, until?: () => boolean) => {
  for (let t = 0; t < secs * 60; t++) {
    m.step(emptyCommand(m.sim.tick + 1));
    if (until?.()) return true;
  }
  return false;
};
/** 置く人をそばへ動かしてから置く */
function place(m: TdMatch, pid: number, kind: Parameters<TdMatch['tryPlace']>[1], x: number, z: number, yaw = PI) {
  m.player!.movement.pos = v3(x + 2.5, 0, z - 2.5);
  return m.tryPlace(pid, kind, v3(x, 0, z), yaw);
}
/** 地上の敵を出して、道すじの途中（index 番の点へ向かう所）から歩かせる */
function grunt(m: TdMatch, type: 'grunt' | 'assault' | 'heavy', x: number, z: number, wp = 3) {
  const e = m.spawnEnemy(type, 'front')!;
  e.movement.pos = v3(x, 0.05, z);
  const r = m.enemies.get(e.id)!;
  r.brain!.waypoint = wp;
  return e;
}

describe('購入メニュー：設置物', () => {
  it('準備時間に置ける。値段・1人の数の上限・売ると半額。ウェーブ中は置けない', () => {
    const { m, pid } = makeMatch();
    const me = m.participantOf(pid)!;
    const c0 = me.credits;
    expect(place(m, pid, 'decoy', 6, 20)).toBe(true);
    expect(place(m, pid, 'decoy', -6, 20)).toBe(true);
    expect(place(m, pid, 'decoy', 10, 10)).toBe(false); // 2つまで
    expect(m.placeCheck(pid, 'decoy', v3(10, 0, 10)).reason).toContain('2 つまで');
    expect(place(m, pid, 'barricade', 4, 28)).toBe(true);
    expect(place(m, pid, 'wiretrap', 0, 16)).toBe(true);
    expect(place(m, pid, 'jumppad', -8, 8)).toBe(true);
    const I = m.cfg.ITEMS;
    expect(me.credits).toBe(c0 - 2 * I.decoy.COST - I.barricade.COST - I.wiretrap.COST - I.jumppad.COST);
    // ほかの物と重ならない
    expect(m.placeCheck(pid, 'jumppad', v3(-8.5, 0, 8.5)).ok).toBe(false);
    const pad = [...m.devices.values()].find((d) => d.type === 'jumppad')!;
    const before = me.credits;
    expect(m.trySell(pid, pad.id)).toBe(true);
    expect(me.credits).toBe(before + Math.floor(I.jumppad.COST * m.cfg.SELL_REFUND));
    m.phase = 'wave';
    expect(m.placeCheck(pid, 'jumppad', v3(-8, 0, 8)).reason).toBe('準備時間中だけ置ける');
  });

  it('ワイヤートラップ：3つの機雷が左右に広がり、壁があれば手前で止まる', () => {
    const { m } = makeMatch();
    const nodes = trapNodes(m.sim.world, v3(0, 0, 16), PI, 3.6, 0.62)!;
    expect(nodes.length).toBe(3);
    expect(lenH(sub(nodes[0], nodes[2]))).toBeCloseTo(7.2, 1);
    // 向きに直角な線（yaw = π なら X の方向）
    expect(Math.abs(nodes[0].z - nodes[2].z)).toBeLessThan(0.01);
    // 狭い所（左右に壁）では短くなるか、置けない
    const narrow = trapNodes(m.sim.world, v3(0, 0, 40), PI, 30, 0.62);
    if (narrow) expect(lenH(sub(narrow[0], narrow[2]))).toBeLessThan(60);
  });

  it('ダミーバルーン：兵士がパイロットと思って撃つ', () => {
    const { m, pid } = makeMatch();
    expect(place(m, pid, 'decoy', 0, 22)).toBe(true);
    m.player!.movement.pos = v3(-30, 0, -30); // プレイヤーは遠く
    const d = [...m.devices.values()][0];
    const balloon = m.sim.entities.get(d.entityId)!;
    expect(balloon.kind).toBe('decoy');
    grunt(m, 'grunt', 0, 36);
    run(m, 12, () => balloon.health < balloon.maxHealth - 20);
    expect(balloon.health).toBeLessThan(balloon.maxHealth - 20);
  });

  it('ダミーバルーン：近くの突撃兵は囮へ走って自爆する（コアは無事）。壊れると無くなる', () => {
    const { m, pid } = makeMatch();
    expect(place(m, pid, 'decoy', 0, 22)).toBe(true);
    m.player!.movement.pos = v3(-30, 0, -30);
    const core0 = m.core.health;
    const a = grunt(m, 'assault', 4, 32);
    const exploded = run(m, 10, () => !m.sim.entities.has(a.id));
    expect(exploded).toBe(true);
    expect(m.core.health).toBe(core0);
    const d = [...m.devices.values()].find((x) => x.type === 'decoy');
    const b = d ? m.sim.entities.get(d.entityId) : undefined;
    expect(!b || b.health < b.maxHealth).toBe(true);
    // 囮を壊す
    if (b && !b.dead) m.sim.damageEntity(b, 9999, v3(), 'shot', grunt(m, 'grunt', 0, 60).id);
    run(m, 0.2);
    expect([...m.devices.values()].some((x) => x.type === 'decoy')).toBe(false);
  });

  it('バリケード：道をふさがれた兵士は足を止めて壊そうとする（引っかかりとして消されない）。突撃兵はぶつかって自爆する', () => {
    const { m, pid } = makeMatch();
    expect(place(m, pid, 'barricade', 0, 24)).toBe(true);
    m.player!.movement.pos = v3(-30, 0, -30);
    const d = [...m.devices.values()][0];
    const bar = m.sim.entities.get(d.entityId)!;
    const g = grunt(m, 'grunt', 0.5, 32);
    run(m, 20);
    expect(g.movement.pos.z).toBeGreaterThan(24); // 越えていない
    expect(bar.health).toBeLessThan(bar.maxHealth);
    expect(m.enemies.get(g.id)!.brain!.blockedBy).toBe(bar.id);
    expect(m.stuckRemoved).toBe(0);
    // 突撃兵
    const hp = bar.health;
    const a = grunt(m, 'assault', -1, 32);
    run(m, 8, () => !m.sim.entities.has(a.id));
    expect(m.sim.entities.has(a.id)).toBe(false);
    expect(bar.health).toBeLessThan(hp - 100);
  });

  it('ワイヤートラップ：地上の敵がレーザーを横切ると、機雷が続けて爆発する。倒した分は置いた人のもの', () => {
    const { m, pid } = makeMatch();
    expect(place(m, pid, 'wiretrap', 0, 24)).toBe(true);
    m.player!.movement.pos = v3(-30, 0, -30);
    const me = m.participantOf(pid)!;
    const trap = [...m.devices.values()][0];
    expect(trap.nodes.length).toBe(3);
    run(m, 1.5); // 展開してから
    m.phase = 'wave';
    const g = grunt(m, 'grunt', 0.3, 30);
    const kills0 = me.kills;
    let blasts = 0;
    for (let t = 0; t < 60 * 15 && m.devices.has(trap.id); t++) {
      m.step(emptyCommand(m.sim.tick + 1));
      blasts += m.events.filter((e) => e.type === 'trapExplode').length;
    }
    expect(m.devices.has(trap.id)).toBe(false); // 1回きり
    expect(blasts).toBe(3);
    expect(g.dead || !m.sim.entities.has(g.id)).toBe(true);
    expect(me.kills).toBe(kills0 + 1);
  });

  it('ジャンプパッド：味方のパイロットが乗ると高く跳ね上がる', () => {
    const { m, pid } = makeMatch();
    expect(place(m, pid, 'jumppad', -8, 8)).toBe(true);
    run(m, 0.6);
    const p = m.player!;
    p.movement.pos = v3(-8, 0, 8);
    let top = 0;
    for (let t = 0; t < 120; t++) {
      m.step(emptyCommand(m.sim.tick + 1));
      top = Math.max(top, p.movement.pos.y);
    }
    const v = m.cfg.ITEMS.jumppad.LAUNCH_UP as number;
    expect(top).toBeGreaterThan(v * v / (2 * DEFAULT_MOVEMENT.GRAVITY) * 0.8);
  });
});

describe('購入メニュー：タレットの強化', () => {
  it('レベル 3 まで上がり、威力・射程・体力が増える。値段はタレットの値段から。売ると強化の分も半分戻る', () => {
    const { m, pid } = makeMatch();
    const me = m.participantOf(pid)!;
    expect(place(m, pid, 'mg', 12, 4)).toBe(true);
    const t = [...m.turrets.values()].find((x) => x.ownerId === pid)!;
    const e = m.sim.entities.get(t.id)!;
    const r1 = m.turretStat(t, 'RANGE');
    const d1 = m.turretStat(t, 'DAMAGE');
    const hp1 = e.maxHealth;
    const c2 = m.upgradeCost(t.id)!;
    expect(c2).toBe(Math.round((m.cfg.TURRETS.mg.COST * m.cfg.UPGRADE.COST_MUL[0]) / 10) * 10);
    const cr = me.credits;
    expect(m.tryUpgrade(pid, t.id)).toBe(true);
    expect(t.level).toBe(2);
    expect(me.credits).toBe(cr - c2);
    expect(m.turretStat(t, 'RANGE')).toBeGreaterThan(r1);
    expect(m.turretStat(t, 'DAMAGE')).toBeGreaterThan(d1);
    expect(e.maxHealth).toBeGreaterThan(hp1);
    expect(e.health).toBe(e.maxHealth);
    const c3 = m.upgradeCost(t.id)!;
    expect(m.tryUpgrade(pid, t.id)).toBe(true);
    expect(t.level).toBe(3);
    expect(m.upgradeCost(t.id)).toBeNull();
    expect(m.tryUpgrade(pid, t.id)).toBe(false);
    expect(m.refundOf(t.id)).toBe(Math.floor((m.cfg.TURRETS.mg.COST + c2 + c3) * m.cfg.SELL_REFUND));
    // ほかの人のタレットは強化できない
    const other = [...m.participants.values()].find((p) => !p.isPlayer)!;
    expect(m.upgradeCheck(other.id, t.id).ok).toBe(false);
    // ウェーブ中は強化できない
    expect(place(m, pid, 'slow', -10, 0)).toBe(true);
    const s = [...m.turrets.values()].find((x) => x.type === 'slow')!;
    m.phase = 'wave';
    expect(m.upgradeCheck(pid, s.id).ok).toBe(false);
    m.phase = 'prep';
    expect(m.tryUpgrade(pid, s.id)).toBe(true);
    expect(m.turretStat(s, 'SLOW')).toBeLessThan(m.cfg.TURRETS.slow.SLOW as number);
    expect(m.turretStat(s, 'RADIUS')).toBeGreaterThan(m.cfg.TURRETS.slow.RADIUS as number);
  });
});

describe('購入メニュー：アーマー', () => {
  it('買うとすぐ装甲が付き、先にダメージを受ける。1 ラウンドに 1 回。ウェーブ中も買える。ウェーブが終わると無くなる', () => {
    const { m, pid } = makeMatch();
    const p = m.player!;
    const me = m.participantOf(pid)!;
    const amount = m.cfg.ITEMS.armor.AMOUNT as number;
    const cr = me.credits;
    expect(m.buyArmor(pid)).toBe(true);
    expect(me.credits).toBe(cr - m.cfg.ITEMS.armor.COST);
    expect(p.armor).toBe(amount);
    expect(m.buyArmor(pid)).toBe(false); // このラウンドは買った
    const enemy = grunt(m, 'grunt', 0, 60);
    m.sim.damageEntity(p, 30, v3(), 'shot', enemy.id);
    expect(p.armor).toBe(amount - 30);
    expect(p.health).toBe(p.maxHealth);
    m.sim.damageEntity(p, 30, v3(), 'shot', enemy.id);
    expect(p.armor).toBe(0);
    expect(p.health).toBe(p.maxHealth - (60 - amount));
    // ウェーブ中も買える（次のラウンドとして）
    m.phase = 'wave';
    m.wave++;
    expect(m.armorCheck(pid).ok).toBe(true);
    expect(m.buyArmor(pid)).toBe(true);
    // ウェーブを片付けると無くなる
    for (const r of [...m.enemies.values()]) m.sim.despawn(r.id);
    run(m, 0.5);
    expect(m.phase).toBe('prep');
    expect(p.armor).toBe(0);
    expect(p.maxArmor).toBe(0);
  });
});

describe('味方ボットの買い物', () => {
  it('タレットが足りたら、設置物・強化・アーマーも買う（同じ値段・同じ決まりで）', () => {
    const sim = new Simulation(fortress, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
    const m = new TdMatch(sim, nav, { difficulty: 'normal', humanPlayer: true, seed: 3 }, { ...tdConfig, PREP_TIME: 60 } as TdConfig);
    for (let i = 0; i < 60 * 10 && m.phase !== 'prep'; i++) m.step(emptyCommand(m.sim.tick + 1));
    for (const p of m.participants.values()) if (!p.isPlayer) p.credits = 3000;
    run(m, 45);
    const bots = [...m.participants.values()].filter((p) => !p.isPlayer);
    const devices = [...m.devices.values()].filter((d) => bots.some((b) => b.id === d.ownerId));
    expect(devices.some((d) => d.type === 'wiretrap')).toBe(true);
    expect([...m.turrets.values()].some((t) => t.level > 1)).toBe(true);
    // トラップはルートの道の上（道すじの線の近く）
    for (const d of devices.filter((x) => x.type === 'wiretrap')) {
      const near = m.td.routes.some((r) => {
        const pts = [r.gate, ...r.path];
        for (let i = 0; i < pts.length - 1; i++) if (segDist2D(d.pos, pts[i], pts[i + 1]) < 1.5) return true;
        return false;
      });
      expect(near).toBe(true);
    }
    void len;
  });
});
