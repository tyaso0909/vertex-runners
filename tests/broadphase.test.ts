import { describe, expect, it } from 'vitest';
import { buildNeonCity } from '../shared/levels/neonCity';
import { buildCollisionWorld } from '../shared/level';
import { capsuleVsBox, rayVsBox } from '../shared/collision';
import { v3 } from '../shared/math';

/** 格子で絞り込んだ結果が、すべての箱を順に調べた結果と同じになること */
describe('当たり判定の絞り込み（格子）', () => {
  const level = buildNeonCity();
  const world = buildCollisionWorld(level);
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  it('光線：一番近い箱と距離が同じ', () => {
    for (let i = 0; i < 3000; i++) {
      const o = v3(-85 + rnd() * 170, -1 + rnd() * 40, -75 + rnd() * 150);
      let d = v3(rnd() - 0.5, (rnd() - 0.5) * (i % 5 === 0 ? 4 : 0.6), rnd() - 0.5);
      if (i % 50 === 0) d = v3(0, -1, 0);
      const L = Math.hypot(d.x, d.y, d.z);
      d = v3(d.x / L, d.y / L, d.z / L);
      const maxT = i % 3 === 0 ? 400 : 1 + rnd() * 30;
      let best: ReturnType<typeof rayVsBox> = null;
      for (const b of world.boxes) {
        const h = rayVsBox(o, d, best ? best.t : maxT, b);
        if (h && (!best || h.t < best.t)) best = h;
      }
      const got = world.raycast(o, d, maxT);
      expect(got?.boxId ?? -1).toBe(best?.boxId ?? -1);
      if (best) expect(got!.t).toBeCloseTo(best.t, 9);
    }
  });

  it('カプセル：重なる箱が同じ（同じ順）', () => {
    for (let i = 0; i < 3000; i++) {
      const a = v3(-82 + rnd() * 164, rnd() * 16, -70 + rnd() * 140);
      const b = v3(a.x + (rnd() - 0.5), a.y + 1.2, a.z + (rnd() - 0.5));
      const r = 0.4;
      const brute = world.boxes.map((bx) => capsuleVsBox(a, b, r, bx)).filter((c) => c);
      const got = world.overlaps(a, b, r);
      expect(got.map((c) => c.boxId)).toEqual(brute.map((c) => c!.boxId));
      expect(world.blocked(a, b, r)).toBe(brute.some((c) => c!.depth > 0.005));
    }
  });
});
