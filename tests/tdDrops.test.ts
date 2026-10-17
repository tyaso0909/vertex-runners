/**
 * タワーディフェンスの作り直し（仕様 5.3.3・6.2）：広くなった軍事要塞、降下ポッド（外・防壁の上・屋上・要塞の中に降りてくる）、
 * ジャンプパッドを置かないこと、ウェーブの敵の数
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVEMENT, type TdConfig, tdConfig } from '../config';
import { emptyCommand } from '../shared/input';
import { buildFortress } from '../shared/levels/fortress';
import { lenH, sub, v3 } from '../shared/math';
import { buildNavGraph, findPath, nearestNode } from '../shared/nav';
import { Simulation } from '../shared/simulation';
import { TdMatch } from '../shared/td/towerDefense';
import { charsCfg, weaponsCfg } from './helpers';

const fortress = buildFortress();
const nav = buildNavGraph(fortress, DEFAULT_MOVEMENT);
const td = fortress.td!;

function makeMatch(opts: { cfg?: Partial<TdConfig>; human?: boolean; quiet?: boolean; seed?: number; noAllies?: boolean } = {}) {
  const sim = new Simulation(fortress, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
  const cfg = { ...tdConfig, ...opts.cfg } as TdConfig;
  const m = new TdMatch(sim, nav, { difficulty: 'normal', humanPlayer: opts.human ?? true, seed: opts.seed ?? 11 }, cfg);
  if (opts.quiet) for (const b of m.allies.values()) b.think = () => b.idle();
  if (opts.noAllies)
    for (const id of [...m.allies.keys()]) {
      m.allies.get(id)!.dispose();
      m.allies.delete(id);
      m.sim.despawn(id);
    }
  return m;
}
const step = (m: TdMatch, n: number) => {
  for (let i = 0; i < n; i++) m.step(emptyCommand(m.sim.tick + 1));
};
/** private のメソッドを呼ぶ（テスト用） */
const priv = (m: TdMatch) => m as unknown as { dropPod: (z: (typeof td.dropZones)[number], t: 'grunt' | 'heavy' | 'assault', n: number) => { id: number; pos: { x: number; y: number; z: number } }; pickLanding: (z: (typeof td.dropZones)[number]) => { x: number; y: number; z: number } };

describe('広くなった軍事要塞', () => {
  it('要塞のまわりの草原が広い（東西 260m 以上・南北 200m 以上）。外にも前哨陣地・見張り台・崩れた壁がある', () => {
    const b = fortress.bounds!;
    expect(b.max.x - b.min.x).toBeGreaterThanOrEqual(260);
    expect(b.max.z - b.min.z).toBeGreaterThanOrEqual(200);
    const tags = new Set(fortress.boxes.map((x) => x.tag));
    expect(tags.has('ruin')).toBe(true);
    const shells = new Set(fortress.boxes.filter((x) => x.tag === 'shell').map((x) => String(x.vis?.name)));
    for (const n of ['outpost_sw', 'outpost_e', 'outpost_n']) expect(shells.has(n)).toBe(true);
    // 外にも弾薬補給所がある
    expect((fortress.ammoStations ?? []).some((a) => Math.abs(a.x) > 62 || a.z > 40 || a.z < -50)).toBe(true);
  });

  it('降下地点：外・高い所（防壁の上・屋上）・要塞の中が、どの方面にもある。要塞の中の降下地点はコアから離れている', () => {
    for (const r of ['front', 'left', 'right'] as const) {
      const zs = td.dropZones.filter((z) => z.sector === r);
      for (const k of ['outer', 'wall', 'inner'] as const) expect(zs.some((z) => z.kind === k), `${r} に ${k} がない`).toBe(true);
      // 遠くの草原（ルートの道すじに合流する）が1つ
      expect(zs.filter((z) => z.kind === 'outer' && z.join === 0).length).toBe(1);
    }
    for (const z of td.dropZones.filter((z) => z.kind !== 'outer')) expect(lenH(sub(z.center, td.core)), z.id).toBeGreaterThan(28);
    expect(new Set(td.dropZones.map((z) => z.id)).size).toBe(td.dropZones.length);
  });

  it('どの降下地点にも、上が開けた平らな着地点があり、そこからコアまで（敵の通れる道で）行ける', () => {
    const m = makeMatch({ quiet: true });
    const nodes = nav.nodes;
    const ring = nearestNode(nav, v3(td.core.x + 10, 0, td.core.z + 3), 6);
    for (const z of td.dropZones) {
      const p = priv(m).pickLanding(z);
      expect(Math.abs(p.y - z.center.y), z.id).toBeLessThan(0.7);
      expect(lenH(sub(p, z.center)), z.id).toBeLessThanOrEqual(z.radius + 0.01);
      const high = z.center.y > 2;
      const allow = high ? (l: { kind: string; from?: unknown }) => l.kind === 'walk' || (l.kind === 'drop' && !l.from) : (l: { kind: string; a: number; b: number }) => (l.kind === 'walk' || l.kind === 'drop') && nodes[l.a].pos.y < 2 && nodes[l.b].pos.y < 2;
      const a = nearestNode(nav, v3(p.x + 1.8, p.y, p.z), 4);
      const path = findPath(nav, a, ring, allow as never, 60000);
      expect(path, `${z.id} からコアへ行けない`).not.toBeNull();
    }
  });
});

describe('降下ポッド', () => {
  it('着地の前に知らせが出て、着地するとまわりを吹き飛ばし、扉が開くと分隊が出てくる。しばらくすると飛び去る', () => {
    const m = makeMatch({ noAllies: true, cfg: { INTRO_TIME: 1e9 } });
    const zone = td.dropZones.find((z) => z.id === 'yard_w')!;
    const pod = priv(m).dropPod(zone, 'grunt', 4);
    // 降りてくる場所の近くにプレイヤーを立たせる
    const p = m.player!;
    p.movement.pos = v3(pod.pos.x + 1.2, pod.pos.y + 0.05, pod.pos.z);
    const hp0 = p.health;
    const ev: string[] = [];
    let landT = -1,
      openT = -1;
    for (let i = 0; i < 60 * 10; i++) {
      m.step(emptyCommand(m.sim.tick + 1));
      for (const e of m.events) {
        if (e.type === 'podLand') landT = m.sim.time;
        if (e.type === 'podOpen') openT = m.sim.time;
        ev.push(e.type);
      }
    }
    expect(landT).toBeGreaterThan(tdConfig.POD.WARN - 0.1);
    expect(openT - landT).toBeCloseTo(tdConfig.POD.OPEN, 1);
    expect(p.health).toBeLessThan(hp0); // 着地の衝撃
    const spawned = [...m.enemies.values()].filter((r) => r.zone === 'yard_w');
    expect(spawned.length).toBe(4);
    expect(ev).toContain('podLeave');
    expect(m.pods.size).toBe(0);
  });

  it('防壁の上・屋上に降りた敵は、飛び降りて中へ入り、コアまで来る', () => {
    const m = makeMatch({ noAllies: true, cfg: { INTRO_TIME: 1e9 } });
    m.core.maxHealth = m.core.health = 1e9;
    for (const id of ['wall_w', 'roof_e', 'wall_sw']) priv(m).dropPod(td.dropZones.find((z) => z.id === id)!, 'grunt', 2);
    let ok = false;
    for (let i = 0; i < 60 * 70 && !ok; i++) {
      m.step(emptyCommand(m.sim.tick + 1));
      const recs = [...m.enemies.values()];
      ok = recs.length === 6 && recs.every((r) => r.brain!.atCore || lenH(sub(m.sim.entities.get(r.id)!.movement.pos, td.core)) < 15);
    }
    expect(ok).toBe(true);
    for (const r of m.enemies.values()) expect(m.sim.entities.get(r.id)!.movement.pos.y).toBeLessThan(1);
  }, 120_000);

  it('ウェーブの地上の敵はポッドで降りてくる。グループの drop は、準備時間に降下地点が決まる', () => {
    const waves = [{ groups: [{ type: 'grunt' as const, count: 8, route: 'left' as const, delay: 0, squad: 4, interval: 3, drop: 'wall' }, { type: 'grunt' as const, count: 4, route: 'front' as const, delay: 0, squad: 4, interval: 3 }] }];
    const m = makeMatch({ quiet: true, cfg: { INTRO_TIME: 0.1, PREP_TIME: 0.5, WAVES: waves } });
    step(m, 20);
    expect(m.phase).toBe('prep');
    const plan = m.plannedDrops();
    expect(plan.length).toBe(2);
    expect(plan[0].zone.kind).toBe('wall');
    expect(plan[0].zone.sector).toBe('left');
    expect(plan[1].zone.id).toBe('south_far'); // 決めていなければ、ルートの遠くの草原
    let pods = 0;
    for (let i = 0; i < 60 * 2 && m.phase !== 'wave'; i++) m.step(emptyCommand(m.sim.tick + 1));
    expect(m.pendingEnemies).toBe(12);
    for (let i = 0; i < 60 * 4; i++) {
      m.step(emptyCommand(m.sim.tick + 1));
      pods += m.events.filter((e) => e.type === 'podIncoming').length;
    }
    expect(pods).toBe(3); // 8 体 → 4 体ずつ 2 つ、4 体 → 1 つ
    expect(m.waveDropKinds()).toEqual(['outer', 'wall']);
  });

  it('ポッドの中の敵も、同時にいられる敵の数（MAX_ALIVE）に数える', () => {
    const waves = [{ groups: [{ type: 'grunt' as const, count: 40, route: 'front' as const, delay: 0, squad: 4, interval: 0.1 }] }];
    const m = makeMatch({ quiet: true, cfg: { INTRO_TIME: 0.1, PREP_TIME: 0.2, MAX_ALIVE: 10, WAVES: waves } });
    let maxIn = 0;
    for (let i = 0; i < 60 * 8; i++) {
      m.step(emptyCommand(m.sim.tick + 1));
      let flying = 0;
      for (const p of m.pods.values()) if (!p.opened) flying += p.count;
      maxIn = Math.max(maxIn, m.aliveEnemies + flying);
    }
    expect(maxIn).toBeLessThanOrEqual(10);
    expect(maxIn).toBeGreaterThanOrEqual(8);
  });

  it('タレットのすぐ近くには降りない', () => {
    const m = makeMatch({ quiet: true });
    for (let i = 0; i < 60 * 10 && m.phase !== 'prep'; i++) m.step(emptyCommand(m.sim.tick + 1));
    const pid = m.player!.id;
    m.participantOf(pid)!.credits = 99999;
    const zone = td.dropZones.find((z) => z.id === 'yard_w')!;
    const at = v3(zone.center.x, 0, zone.center.z);
    m.player!.movement.pos = v3(at.x + 3, 0.05, at.z);
    expect(m.tryPlace(pid, 'mg', at)).toBe(true);
    for (let k = 0; k < 20; k++) expect(lenH(sub(priv(m).pickLanding(zone), at))).toBeGreaterThan(tdConfig.POD.CLEARANCE - 0.01);
  });
});

describe('ジャンプパッドを置かない', () => {
  it('マップには据え付けのジャンプパッドがなく、防壁の上へは歩き・壁走り・ジャンプで登れる', () => {
    expect((td as unknown as { pads?: unknown }).pads).toBeUndefined();
    expect(nav.links.some((l) => (l.kind as string) === 'pad')).toBe(false);
    const a = nearestNode(nav, v3(-26, 0, -6), 4);
    for (const top of [v3(-60.2, 7, 4), v3(60.2, 7, -20), v3(-38, 7, 38.2)]) {
      const b = nearestNode(nav, top, 4);
      expect(b, `${top.x},${top.z}`).toBeGreaterThanOrEqual(0);
      expect(findPath(nav, a, b), `${top.x},${top.z}`).not.toBeNull();
    }
  });
});

describe('ウェーブの敵の数', () => {
  it('どのウェーブも前より敵が多く、後半のウェーブには防壁の上・要塞の中に降りる分隊がある', () => {
    const counts = tdConfig.WAVES.map((w) => w.groups.reduce((s, g) => s + g.count, 0));
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(600);
    expect(counts[0]).toBeGreaterThanOrEqual(18);
    expect(counts[9]).toBeGreaterThanOrEqual(90);
    for (const w of tdConfig.WAVES.slice(1)) expect(w.groups.some((g) => g.drop === 'wall' || g.drop === 'inner')).toBe(true);
    // 降下地点の指定は、降下地点の id か種類
    const ids = new Set(td.dropZones.map((z) => z.id));
    for (const w of tdConfig.WAVES) for (const g of w.groups) if (g.drop) expect(ids.has(g.drop) || ['outer', 'wall', 'inner'].includes(g.drop), g.drop).toBe(true);
  });
});
