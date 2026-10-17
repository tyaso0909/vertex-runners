import { describe, expect, it } from 'vitest';
import { buildNeonCity } from '../shared/levels/neonCity';
import { buildNavGraph, findPath, nearestNode, reachable } from '../shared/nav';
import { type Vec3, lenH, sub, v3 } from '../shared/math';
import type { NavLinkDef } from '../shared/level';
import { cfg, driver } from './helpers';

const level = buildNeonCity();
const c = cfg();
const nav = buildNavGraph(level, c);

/** マップの主な場所 */
const PLACES: Record<string, Vec3> = {
  西の駅: v3(-72, 0, 0),
  駅の2階: v3(-70, 5, 5),
  駅の屋上: v3(-70, 10, -4),
  倉庫の屋上: v3(-68, 5, 45),
  西の大通り: v3(-46, 0, -2),
  集合住宅のテラス: v3(-46, 10, -43),
  集合住宅の屋上: v3(-40, 15, -60),
  ゲームセンターの1階: v3(-43, 0, -20),
  ゲームセンターの2階: v3(-44, 5, -22),
  ゲームセンターの屋上: v3(-48, 10, -14),
  パチンコ店の1階: v3(-41, 0, 10),
  パチンコ店の2階: v3(-42, 5, 10),
  パチンコ店の屋上: v3(-44, 10, 12),
  コンテナ置き場: v3(-44, 0, 52),
  'コンテナの山（西）': v3(-52, 5.2, 48.5),
  'コンテナの山（東）': v3(-32, 5.2, 48.5),
  円形広場: v3(-4, 1, -5),
  空中デッキ: v3(-4, 5, 7),
  高架道路: v3(-20, 10, -45),
  鯉の塔の基壇: v3(-4, 10, -54),
  ラーメン屋の中: v3(-28, 0, -59),
  屋台: v3(20, 0, -55),
  東のホテル: v3(70, 0, 6),
  ホテルの2階: v3(70, 5, 10),
  ホテルの屋上: v3(70, 10, 16),
  東の大通り: v3(40, 0, -6),
  オフィスの1階: v3(45, 0, -25),
  オフィスの2階: v3(48, 5, -25),
  オフィスの屋上: v3(46, 10, -20),
  オフィスの基壇: v3(40, 10, -46),
  オフィスタワーの屋上: v3(52, 15, -55),
  カフェの1階: v3(27, 0, -22),
  カフェの2階: v3(31, 5, -24),
  カフェの屋上: v3(25, 10, -21),
  駐車場の1階: v3(50, 0, 20),
  駐車場の2階: v3(52, 5, 10),
  駐車場の3階: v3(52, 10, 18),
  駐車場の屋上: v3(52, 15, 14),
  銭湯の中: v3(24, 0, 9),
  銭湯の屋上: v3(26, 5, 13),
  商店街: v3(0, 0, 46),
  店の中: v3(-14, 0, 53),
  北の列の屋上: v3(-14, 5, 38),
  南の列の屋上: v3(5, 5, 55),
  低いビルの屋上: v3(44, 5, 44),
  コンビニの中: v3(66, 0, 37),
  コンビニの屋上: v3(70, 5, 36),
  地上の駐車場: v3(70, 0, 52),
};

describe('ネオン都市：形', () => {
  it('東西・南北で鏡写しになっていない（形が違う）', () => {
    const inner = level.boxes.filter((b) => b.tag !== 'barrier' && b.tag !== 'ground' && !b.vis?.boundary);
    const key = (x: number, y: number, z: number, b: (typeof level.boxes)[number]) =>
      `${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)},${b.size.x.toFixed(1)},${b.size.y.toFixed(1)},${b.size.z.toFixed(1)},${b.tag}`;
    const all = new Set(inner.map((b) => key(b.center.x, b.center.y, b.center.z, b)));
    const mirroredX = inner.filter((b) => Math.abs(b.center.x) > 3 && all.has(key(-b.center.x, b.center.y, b.center.z, b))).length;
    const mirroredZ = inner.filter((b) => Math.abs(b.center.z) > 3 && all.has(key(b.center.x, b.center.y, -b.center.z, b))).length;
    expect(mirroredX / inner.length).toBeLessThan(0.1);
    expect(mirroredZ / inner.length).toBeLessThan(0.1);
  });

  it('大きさはおよそ 150m 四方。足場は 0・5・10・15m の4層（仕様 6.1）', () => {
    const tops = level.boxes.filter((b) => b.tag !== 'barrier').map((b) => b.center.y + b.size.y / 2);
    const xs = nav.nodes.map((n) => n.pos.x);
    const zs = nav.nodes.map((n) => n.pos.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(140);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(120);
    expect(Math.max(...tops)).toBeGreaterThanOrEqual(30);
    const ys = new Set(nav.nodes.map((n) => Math.round(n.pos.y)));
    for (const y of [0, 5, 10, 15]) expect(ys.has(y)).toBe(true);
  });

  it('地面がマップ全体にあり、落ちる場所がない', () => {
    const ground = level.boxes.find((b) => b.tag === 'ground')!;
    const b = level.bounds!;
    expect(ground.center.y + ground.size.y / 2).toBe(0);
    expect(ground.center.x - ground.size.x / 2).toBeLessThanOrEqual(b.min.x);
    expect(ground.center.x + ground.size.x / 2).toBeGreaterThanOrEqual(b.max.x);
    expect(ground.center.z - ground.size.z / 2).toBeLessThanOrEqual(b.min.z);
    expect(ground.center.z + ground.size.z / 2).toBeGreaterThanOrEqual(b.max.z);
    // マップの中のどこでも、真下に床がある
    const d = driver(level, c);
    for (let x = b.min.x + 1; x < b.max.x; x += 7)
      for (let z = b.min.z + 1; z < b.max.z; z += 7) {
        const hit = d.sim.world.raycast(v3(x, 60, z), v3(0, -1, 0), 80);
        expect(hit, `${x},${z}`).not.toBeNull();
        expect(hit!.point.y).toBeGreaterThanOrEqual(-0.01);
      }
    // 見えない壁より外へは出られない（屋上から外へ跳んでも）
    expect(level.boxes.filter((x) => x.tag === 'barrier').length).toBe(4);
  });

  it('中に入れる建物がある（大通りから中や屋上へ、階段・坂を歩いて行ける）', () => {
    const rooms = new Set(level.boxes.filter((b) => b.tag === 'shell').map((b) => String(b.vis?.name)));
    for (const n of ['station', 'arcade', 'pachinko', 'office', 'cafe', 'hotel', 'ramen', 'bathhouse', 'store', 'shop_a', 'shop_b', 'shop_c', 'shop_d'])
      expect(rooms.has(n), n).toBe(true);
    // 大通りから建物の中まで、歩くつながりだけで行ける
    const walkOnly = (from: Vec3, to: Vec3) => {
      const a = nearestNode(nav, from),
        goal = nearestNode(nav, to);
      const seen = new Set([a]);
      const q = [a];
      while (q.length) {
        const n = q.pop()!;
        if (n === goal) return true;
        for (const li of nav.out[n]) {
          const l = nav.links[li];
          // 歩く、または低い段差（1.5m まで）をよじ登る。跳び移り・壁走り・2段ジャンプは使わない
          const dy = nav.nodes[l.b].pos.y - nav.nodes[n].pos.y;
          const ok = l.kind === 'walk' || (l.kind === 'jump' && dy > 0 && dy <= 1.5);
          if (!ok || seen.has(l.b)) continue;
          seen.add(l.b);
          q.push(l.b);
        }
      }
      return false;
    };
    for (const k of ['西の駅', '駅の2階', '駅の屋上', 'ゲームセンターの2階', 'ゲームセンターの屋上', 'パチンコ店の2階', 'パチンコ店の屋上', '集合住宅の屋上', '高架道路', 'ラーメン屋の中', '店の中'])
      expect(walkOnly(PLACES['西の大通り'], PLACES[k]), k).toBe(true);
    for (const k of ['東のホテル', 'ホテルの2階', 'ホテルの屋上', 'オフィスの2階', 'オフィスの屋上', 'オフィスタワーの屋上', 'カフェの2階', 'カフェの屋上', '駐車場の屋上', '銭湯の中', '銭湯の屋上', 'コンビニの中', 'コンビニの屋上', '低いビルの屋上'])
      expect(walkOnly(PLACES['東の大通り'], PLACES[k]), k).toBe(true);
  });

  it('両チームの出現地点がマップの両端にある', () => {
    const t0 = level.spawns!.filter((s) => s.team === 0 && !s.field);
    const t1 = level.spawns!.filter((s) => s.team === 1 && !s.field);
    expect(t0.length).toBeGreaterThanOrEqual(4);
    expect(t1.length).toBe(t0.length);
    for (const s of t0) expect(s.pos.x).toBeLessThan(-60);
    for (const s of t1) expect(s.pos.x).toBeGreaterThan(60);
    // 出現地点はターミナルの中（屋根の下）
    const d = driver(level, c);
    for (const s of level.spawns!.filter((x) => !x.field)) {
      const up = d.sim.world.raycast(v3(s.pos.x, s.pos.y + 1, s.pos.z), v3(0, 1, 0), 10);
      expect(up).not.toBeNull();
    }
  });

  it('途中で復活する地点は、床の上で体が収まる場所にあり、両チームの側に同じくらいある', () => {
    const field = level.spawns!.filter((s) => s.field);
    expect(field.filter((s) => s.team === 0).length).toBeGreaterThanOrEqual(5);
    expect(field.filter((s) => s.team === 1).length).toBeGreaterThanOrEqual(5);
    const d = driver(level, c);
    for (const s of field) {
      const g = d.sim.world.raycast(v3(s.pos.x, s.pos.y + 0.5, s.pos.z), v3(0, -1, 0), 1);
      expect(g, JSON.stringify(s.pos)).not.toBeNull();
      expect(d.sim.world.blocked(v3(s.pos.x, s.pos.y + 0.75, s.pos.z), v3(s.pos.x, s.pos.y + 1.4, s.pos.z), c.PLAYER_RADIUS), JSON.stringify(s.pos)).toBe(false);
    }
  });
});

describe('ネオン都市：ボット用の経路', () => {
  it('点とつながりが作られ、壁走り・飛び降り・跳び移りを含む', () => {
    expect(nav.nodes.length).toBeGreaterThan(800);
    const kinds = new Set(nav.links.map((l) => l.kind));
    for (const k of ['walk', 'drop', 'wallrun']) expect(kinds.has(k as never)).toBe(true);
    // ステージに書いた壁走りが、すべてつながりになっている
    const wallruns = nav.links.filter((l) => l.kind === 'wallrun').length;
    const expected = (level.navLinks ?? []).filter((l) => l.kind === 'wallrun').reduce((n, l) => n + (l.both ? 2 : 1), 0);
    expect(wallruns).toBe(expected);
  });

  it('すべての主な場所が、どちらの出現地点からも行き来できる', () => {
    const s0 = nearestNode(nav, PLACES['西の駅']);
    const s1 = nearestNode(nav, PLACES['東のホテル']);
    const from0 = reachable(nav, s0);
    const from1 = reachable(nav, s1);
    for (const [name, p] of Object.entries(PLACES)) {
      const n = nearestNode(nav, p);
      expect(n, name).toBeGreaterThanOrEqual(0);
      expect(from0.has(n), `西から ${name}`).toBe(true);
      expect(from1.has(n), `東から ${name}`).toBe(true);
      expect(reachable(nav, n).has(s0), `${name} から西へ`).toBe(true);
    }
  });

  it('経路を探せる（西の出現地点 → 東のオフィスタワーの屋上）', () => {
    const path = findPath(nav, nearestNode(nav, PLACES['西の駅']), nearestNode(nav, PLACES['オフィスタワーの屋上']));
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(10);
  });

  it('ほとんどの点がつながっている（孤立した点が少ない）', () => {
    const main = reachable(nav, nearestNode(nav, PLACES['円形広場']));
    expect(main.size / nav.nodes.length).toBeGreaterThan(0.97);
  });
});

/**
 * 壁走りの経路を、実際の移動の計算で走ってみる。
 * 助走 → 縁でジャンプ → 壁に寄って壁走り → 向こう側に着地、ができること。
 */
function tryWallrun(link: NavLinkDef, reverse = false) {
  const from = reverse ? link.to : link.from;
  const to = reverse ? link.from : link.to;
  const via = link.via!;
  const dir = sub(to, from);
  const L = lenH(dir);
  const fx = dir.x / L,
    fz = dir.z / L;
  // 助走のための開始位置（最大 8m 手前。足場が短ければ足場の上の一番遠い所）
  const tmp = driver(level, c);
  let start = v3(from.x, from.y + 0.05, from.z);
  for (let k = 8; k >= 2; k -= 0.5) {
    const p = v3(from.x - fx * k, from.y + 0.05, from.z - fz * k);
    const g = tmp.sim.world.raycast(v3(p.x, p.y + 1, p.z), v3(0, -1, 0), 1.5);
    // 立てる場所（床が同じ高さで、手すりなどにぶつからない）
    const free = !tmp.sim.world.blocked(v3(p.x, p.y + 0.8, p.z), v3(p.x, p.y + 1.4, p.z), c.PLAYER_RADIUS + 0.1);
    if (g && Math.abs(g.point.y - from.y) < 0.2 && free) {
      start = p;
      break;
    }
  }
  const lv = { ...level, spawn: start, spawnYaw: Math.atan2(-fx, -fz) };
  const d = driver(lv, c);
  const m = d.p.movement;
  // 壁はどちら側か（進む向きの右側なら +1）
  const rx = Math.cos(lv.spawnYaw),
    rz = -Math.sin(lv.spawnYaw);
  const side = Math.sign((via.x - from.x) * rx + (via.z - from.z) * rz) || 1;
  const yaw = lv.spawnYaw;
  let jumped = false;
  let wallran = false;
  let t = 0;
  for (; t < 60 * 6; t++) {
    const ground = d.sim.world.raycast(v3(m.pos.x + fx * 1.2, m.pos.y + 0.5, m.pos.z + fz * 1.2), v3(0, -1, 0), 2);
    const onGround = m.state === 'ground';
    const jumpNow = onGround && !ground && !jumped;
    if (jumpNow) jumped = true;
    if (m.state === 'wallrun') wallran = true;
    d.run(1, {
      yaw,
      moveForward: 1,
      // 空中では壁の方へ寄る（壁走りが始まったら前だけ）
      moveRight: jumped && !wallran ? side : 0,
      sprintHeld: true,
      jumpHeld: jumpNow,
    });
    // 着地して、目的地に近づいたら終わり
    const rest = lenH(sub(to, m.pos));
    if (wallran && m.state === 'ground' && (rest < 3 || (m.pos.x - to.x) * fx + (m.pos.z - to.z) * fz > 0)) break;
    if (m.pos.y < from.y - 4) break; // 落ちた
  }
  return { wallran, pos: { ...m.pos }, to, from };
}

describe('ネオン都市：壁走りで建物の間を渡れる', () => {
  for (const link of (level.navLinks ?? []).filter((l) => l.kind === 'wallrun')) {
    it(link.note ?? 'wallrun', () => {
      const r = tryWallrun(link);
      expect(r.wallran).toBe(true);
      expect(r.pos.y).toBeGreaterThan(r.to.y - 0.5);
      expect(Math.abs(r.pos.y - r.to.y)).toBeLessThan(1.5);
    });
    if (link.both)
      it(`${link.note}（逆向き）`, () => {
        const r = tryWallrun(link, true);
        expect(r.wallran).toBe(true);
        expect(r.pos.y).toBeGreaterThan(r.to.y - 0.5);
      });
  }
});

/** 跳び移りの経路を、実際の移動の計算で跳んでみる（助走 → 縁でジャンプ → 頂点で2段ジャンプ → 着地） */
function tryJump(link: NavLinkDef, reverse = false) {
  const from = reverse ? link.to : link.from;
  const to = reverse ? link.from : link.to;
  const dir = sub(to, from);
  const L = lenH(dir);
  const fx = dir.x / L,
    fz = dir.z / L;
  const tmp = driver(level, c);
  let start = v3(from.x, from.y + 0.05, from.z);
  for (let k = 8; k >= 2; k -= 0.5) {
    const p = v3(from.x - fx * k, from.y + 0.05, from.z - fz * k);
    const g = tmp.sim.world.raycast(v3(p.x, p.y + 1, p.z), v3(0, -1, 0), 1.5);
    // 立てる場所（床が同じ高さで、手すりなどにぶつからない）
    const free = !tmp.sim.world.blocked(v3(p.x, p.y + 0.8, p.z), v3(p.x, p.y + 1.4, p.z), c.PLAYER_RADIUS + 0.1);
    if (g && Math.abs(g.point.y - from.y) < 0.2 && free) {
      start = p;
      break;
    }
  }
  const lv = { ...level, spawn: start, spawnYaw: Math.atan2(-fx, -fz) };
  const d = driver(lv, c);
  const m = d.p.movement;
  let jumped = 0;
  let airT = 0;
  for (let t = 0; t < 60 * 5; t++) {
    const ground = d.sim.world.raycast(v3(m.pos.x + fx * 0.9, m.pos.y + 0.5, m.pos.z + fz * 0.9), v3(0, -1, 0), 2);
    let jump = false;
    if (jumped === 0 && m.state === 'ground' && !ground) {
      jump = true;
      jumped = 1;
    } else if (jumped === 1 && m.state !== 'ground') {
      airT++;
      if (m.vel.y < 0.5) {
        jump = true;
        jumped = 2;
      }
    }
    d.run(1, { yaw: lv.spawnYaw, moveForward: 1, sprintHeld: true, jumpHeld: jump });
    if (jumped === 2 && m.state === 'ground') break;
    if (m.pos.y < from.y - 4) break;
  }
  return { pos: { ...m.pos }, to };
}

describe('ネオン都市：2段ジャンプで建物の間を跳び移れる', () => {
  for (const link of (level.navLinks ?? []).filter((l) => l.kind === 'jump')) {
    it(link.note ?? 'jump', () => {
      const r = tryJump(link);
      expect(Math.abs(r.pos.y - r.to.y)).toBeLessThan(0.5);
      expect(lenH(sub(r.pos, r.to))).toBeLessThan(4);
    });
    if (link.both)
      it(`${link.note}（逆向き）`, () => {
        const r = tryJump(link, true);
        expect(Math.abs(r.pos.y - r.to.y)).toBeLessThan(0.5);
        expect(lenH(sub(r.pos, r.to))).toBeLessThan(4);
      });
  }
});

describe('ボット用の経路の前提', () => {
  it('高さ 2.6m のコンテナには、2段ジャンプしてよじ登れる（経路の「よじ登り」）', async () => {
    const { flatLevel } = await import('./helpers');
    const lv = flatLevel((b) => b.boxRange(-3, 0, -6, 3, 2.6, -3.5, 'block'), v3(0, 0.02, 0), 0);
    const d = driver(lv, c);
    let t = 0;
    d.run(40, (i) => {
      t = i;
      return { moveForward: 1, jumpHeld: i === 12 || i === 26, sprintHeld: false };
    });
    expect(t).toBe(39);
    d.run(40, { moveForward: 1 });
    expect(d.p.movement.pos.y).toBeGreaterThan(2.5);
  });
});
