/**
 * 迫撃砲兵（仕様 5.3.3）：降下後に少し高い所（前哨陣地の屋上・砲撃陣地・防壁の上・テラス）へ上り、そこからコアへ迫撃砲を撃ち続ける
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVEMENT, TD_ENEMY_TYPES, type TdConfig, tdConfig, tdNum } from '../config';
import { emptyCommand } from '../shared/input';
import { buildFortress } from '../shared/levels/fortress';
import { lenH, sub, v3 } from '../shared/math';
import { buildNavGraph, findPath, nearestNode } from '../shared/nav';
import { Simulation } from '../shared/simulation';
import { mortarAllow } from '../shared/td/enemyBot';
import { TdMatch } from '../shared/td/towerDefense';
import { charsCfg, weaponsCfg } from './helpers';

const fortress = buildFortress();
const nav = buildNavGraph(fortress, DEFAULT_MOVEMENT);
const td = fortress.td!;
const def = tdConfig.ENEMIES.mortar;

function makeMatch(opts: { cfg?: Partial<TdConfig>; human?: boolean; noAllies?: boolean; seed?: number } = {}) {
  const sim = new Simulation(fortress, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
  const cfg = { ...tdConfig, ...opts.cfg } as TdConfig;
  const m = new TdMatch(sim, nav, { difficulty: 'normal', humanPlayer: opts.human ?? true, seed: opts.seed ?? 3 }, cfg);
  if (opts.noAllies)
    for (const id of [...m.allies.keys()]) {
      m.allies.get(id)!.dispose();
      m.allies.delete(id);
      m.sim.despawn(id);
    }
  return m;
}
const priv = (m: TdMatch) => m as unknown as { dropPod: (z: (typeof td.dropZones)[number], t: 'mortar', n: number) => { id: number } };

describe('迫撃砲兵', () => {
  it('敵の種類にあり、数値がそろっている。3 ウェーブ目から出てくる', () => {
    expect(TD_ENEMY_TYPES).toContain('mortar');
    for (const k of ['HEALTH', 'REWARD', 'FIRE_INTERVAL', 'SETUP_TIME', 'SHELL_CORE_DAMAGE', 'SHELL_RADIUS', 'SHELL_DAMAGE', 'MIN_RANGE', 'MAX_RANGE']) expect(tdNum(def, k, -1), k).toBeGreaterThan(0);
    const first = tdConfig.WAVES.findIndex((w) => w.groups.some((g) => g.type === 'mortar'));
    expect(first).toBe(2);
    // 後半のウェーブには、外・防壁の上・要塞の中に降りる迫撃砲兵がいる
    const drops = new Set(tdConfig.WAVES.flatMap((w) => w.groups.filter((g) => g.type === 'mortar').map((g) => g.drop)));
    for (const k of ['outer', 'wall', 'inner']) expect(drops.has(k), k).toBe(true);
  });

  it('据える所：少し高い所にあり、コアまでの距離が射程の中。どの降下地点からも、歩いて（段差は跳んで）行ける所がある', () => {
    const spots = td.mortarSpots;
    expect(spots.filter((s) => s.area === 'outer').length).toBeGreaterThanOrEqual(10);
    expect(spots.filter((s) => s.area === 'inner').length).toBeGreaterThanOrEqual(6);
    const allow = mortarAllow(nav);
    for (const s of spots) {
      expect(s.pos.y, s.name).toBeGreaterThan(1);
      const d = lenH(sub(s.pos, td.core));
      expect(d, s.name).toBeGreaterThan(tdNum(def, 'MIN_RANGE'));
      expect(d, s.name).toBeLessThan(tdNum(def, 'MAX_RANGE'));
      expect(nearestNode(nav, s.pos, 2.5), s.name).toBeGreaterThanOrEqual(0);
    }
    for (const z of td.dropZones) {
      const area = z.kind === 'outer' ? 'outer' : 'inner';
      const a = nearestNode(nav, z.center, 6);
      const ok = spots.some((s) => s.area === area && !!findPath(nav, a, nearestNode(nav, s.pos, 2.5), allow, 60000));
      expect(ok, `${z.id} から行ける据える所がない`).toBe(true);
    }
  });

  it('降下ポッドで降りると、据える所へ上って据え、コアへ砲撃する（コアが削られる。コアの「攻撃されている」には数えない）', () => {
    const m = makeMatch({ noAllies: true, cfg: { INTRO_TIME: 1e9 } });
    m.player!.movement.pos = v3(0, 0.05, -60); // 迫撃砲兵から遠く
    const zones = ['north_west', 'east_far', 'wall_w', 'dock'];
    for (const z of zones) priv(m).dropPod(td.dropZones.find((x) => x.id === z)!, 'mortar', 1);
    const h0 = m.core.health;
    const deployed = new Map<number, { x: number; y: number; z: number }>();
    let fires = 0,
      coreHits = 0,
      attacked = false;
    for (let i = 0; i < 60 * 75; i++) {
      m.step(emptyCommand(m.sim.tick + 1));
      for (const e of m.events) {
        if (e.type === 'mortarDeploy') deployed.set(e.id, e.pos);
        if (e.type === 'mortarFire') fires++;
        if (e.type === 'mortarExplode' && e.core) coreHits++;
      }
      if (m.coreUnderAttack()) attacked = true;
    }
    expect(deployed.size).toBe(4);
    // 決められた据える所（少し高い所）に据えている
    for (const [id, p] of deployed) {
      const r = m.enemies.get(id)!;
      const sp = td.mortarSpots[r.spot!];
      expect(lenH(sub(p, sp.pos)), sp.name).toBeLessThan(1.5);
      expect(p.y).toBeGreaterThan(1);
      expect(m.sim.entities.get(id)!.movement.pos.y).toBeCloseTo(sp.pos.y, 0);
    }
    expect(fires).toBeGreaterThan(8);
    expect(coreHits).toBeGreaterThan(2);
    expect(m.core.health).toBeLessThan(h0);
    expect(attacked).toBe(false);
  }, 60_000);

  it('据えた所に近づいたパイロットには、砲撃をやめて応戦する', () => {
    const m = makeMatch({ noAllies: true, cfg: { INTRO_TIME: 1e9 } });
    m.player!.movement.pos = v3(0, 0.05, -60);
    priv(m).dropPod(td.dropZones.find((x) => x.id === 'north_west')!, 'mortar', 1);
    let id = -1;
    for (let i = 0; i < 60 * 60 && id < 0; i++) {
      m.step(emptyCommand(m.sim.tick + 1));
      for (const e of m.events) if (e.type === 'mortarDeploy') id = e.id;
    }
    expect(id).toBeGreaterThan(0);
    const e = m.sim.entities.get(id)!;
    // パイロットを、迫撃砲兵のすぐそばに立たせる（体力は減らないようにする）
    const p = m.player!;
    p.maxHealth = p.health = 1e9;
    p.movement.pos = v3(e.movement.pos.x + 4, e.movement.pos.y + 0.05, e.movement.pos.z + 2);
    let fires = 0,
      busy = false;
    for (let i = 0; i < 60 * 15; i++) {
      p.movement.pos = v3(e.movement.pos.x + 4, e.movement.pos.y + 0.05, e.movement.pos.z + 2);
      m.step(emptyCommand(m.sim.tick + 1));
      fires += m.events.filter((x) => x.type === 'mortarFire').length;
      if (m.enemies.get(id)?.brain?.busy) busy = true;
    }
    expect(busy).toBe(true);
    expect(fires).toBe(0);
  }, 60_000);

  it('砲弾は高い放物線で飛び、まわりの味方にもダメージを与える', () => {
    const m = makeMatch({ noAllies: true, cfg: { INTRO_TIME: 1e9 } });
    const p = m.player!;
    priv(m).dropPod(td.dropZones.find((x) => x.id === 'east_far')!, 'mortar', 1);
    let maxY = 0,
      shot = false;
    const hp0 = p.health;
    let hurt = false;
    for (let i = 0; i < 60 * 70; i++) {
      // コアの脇（砲弾の落ちる所）に立つ
      p.movement.pos = v3(td.core.x, 0.05, td.core.z + 6.5);
      m.step(emptyCommand(m.sim.tick + 1));
      for (const s of m.shells.values()) {
        shot = true;
        maxY = Math.max(maxY, s.pos.y);
      }
      if (p.health < hp0 || p.downed > 0) hurt = true;
    }
    expect(shot).toBe(true);
    expect(maxY).toBeGreaterThan(20);
    expect(hurt).toBe(true);
  }, 60_000);

  it('味方のボットは、据えた迫撃砲兵を倒しに行く', () => {
    const waves = [{ groups: [{ type: 'mortar' as const, count: 2, route: 'left' as const, delay: 0, squad: 2, interval: 1, drop: 'north_west' }] }];
    const m = makeMatch({ human: false, cfg: { INTRO_TIME: 0.1, PREP_TIME: 1, WAVES: waves, END_DELAY: 1 } });
    let deployed = 0,
      killed = 0,
      hunted = false;
    for (let i = 0; i < 60 * 200 && killed < 2; i++) {
      m.step(null);
      for (const e of m.events) {
        if (e.type === 'mortarDeploy') deployed++;
        if (e.type === 'enemyKilled' && e.enemy === 'mortar') killed++;
      }
      if ([...m.allies.values()].some((b) => b.hunting >= 0)) hunted = true;
    }
    expect(deployed).toBeGreaterThan(0);
    expect(hunted).toBe(true);
    expect(killed).toBe(2);
  }, 120_000);
});
