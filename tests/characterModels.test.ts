/**
 * 6人のパイロットのモデル（取り込んだモデル。assets-src/characters/build_imported.py で作る。仕様 7.2.2）。
 * glb の中身（JSON の部分）を読んで、ゲームが使う骨・動き・テクスチャがそろっているかを確かめる。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../config';

const DIR = new URL('../client/assets/characters/', import.meta.url);

interface Gltf {
  nodes: { name?: string; scale?: number[] }[];
  skins?: { joints: number[] }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: { count: number }[];
  animations?: { name?: string }[];
  images?: unknown[];
}

function readGlb(file: string): Gltf {
  const b = readFileSync(new URL(file, DIR));
  const len = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + len))) as Gltf;
}

const BONES = ['hips', 'spine', 'chest', 'neck', 'head'].concat(
  ...['L', 'R'].map((s) => ['shoulder', 'upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot'].map((b) => `${b}.${s}`)),
);
const CLIPS = ['Idle', 'Run', 'WallRun', 'Slide', 'Jump', 'Shoot', 'Ability', 'Death'];

const tris = (g: Gltf) => g.meshes.reduce((n, m) => n + m.primitives.reduce((k, p) => k + (p.indices !== undefined ? g.accessors[p.indices].count / 3 : 0), 0), 0);
const joints = (g: Gltf) => (g.skins?.[0]?.joints ?? []).map((i) => g.nodes[i].name ?? '').map((n) => n.replace(/^hand(L|R)$/, 'hand.$1'));

const GRUNT_CLIPS = ['Idle', 'Run', 'Shoot', 'Crouch', 'Jump', 'Death'];

describe('歩兵のモデル（取り込んだモデル。消耗戦・タワーディフェンスの一般兵）', () => {
  it('骨・歩兵の動き・テクスチャがそろっていて、チームの色に光らせる印がある', () => {
    const g = readGlb('grunt.glb') as Gltf & { materials?: { name?: string }[] };
    expect(g.skins?.length).toBe(1);
    expect(new Set(joints(g))).toEqual(new Set(BONES));
    expect((g.animations ?? []).map((a) => a.name).sort()).toEqual([...GRUNT_CLIPS].sort());
    expect(g.images?.length).toBe(1);
    expect(g.materials?.[0]?.name).toBe('TeamGlowMap');
    expect(tris(g)).toBeLessThanOrEqual(15000);
    const lod = readGlb('grunt_lod.glb');
    expect(new Set(joints(lod))).toEqual(new Set(BONES));
    expect(tris(lod)).toBeLessThanOrEqual(4000);
  });
});

describe('重装兵のモデル（取り込んだモデル。体と盾を1つにまとめる）', () => {
  it('骨・重装兵の動き・1枚のテクスチャがそろっていて、大きさが当たり判定に合う', () => {
    const g = readGlb('heavy.glb');
    expect(g.skins?.length).toBe(1);
    expect(new Set(joints(g))).toEqual(new Set(BONES));
    expect((g.animations ?? []).map((a) => a.name).sort()).toEqual([...GRUNT_CLIPS].sort());
    expect(g.images?.length, '体と盾のテクスチャは1枚にまとめる').toBe(1);
    expect(g.meshes.length).toBe(1);
    expect(tris(g)).toBeLessThanOrEqual(15000);
    // 骨格ごと拡大して、高さ約 2.1m（当たり判定の頭 1.96m に合わせる）
    const rig = g.nodes.find((n) => n.name === 'Rig');
    expect(rig?.scale?.[1]).toBeCloseTo(2.1 / 1.7, 2);
    const lod = readGlb('heavy_lod.glb');
    expect(new Set(joints(lod))).toEqual(new Set(BONES));
    expect(tris(lod)).toBeLessThanOrEqual(4000);
  });
});

describe('パイロットのモデル（取り込んだモデル）', () => {
  for (const id of CHARACTER_IDS) {
    it(`${id}：骨・動き・テクスチャがそろっていて、面の数が多すぎない`, () => {
      const g = readGlb(`${id}.glb`);
      expect(g.skins?.length, 'スキン（骨で曲がる皮）').toBe(1);
      expect(new Set(joints(g))).toEqual(new Set(BONES));
      expect((g.animations ?? []).map((a) => a.name).sort()).toEqual([...CLIPS].sort());
      expect(g.images?.length, 'テクスチャ').toBe(1);
      const prim = g.meshes[0].primitives[0];
      for (const a of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']) expect(prim.attributes[a], a).toBeTypeOf('number');
      expect(tris(g)).toBeLessThanOrEqual(15000);
      // 遠く用：同じ骨で、面がずっと少ない
      const lod = readGlb(`${id}_lod.glb`);
      expect(new Set(joints(lod))).toEqual(new Set(BONES));
      expect(tris(lod)).toBeLessThanOrEqual(4000);
      expect(lod.animations ?? []).toHaveLength(0);
    });
  }
});
