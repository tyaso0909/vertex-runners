/**
 * マップの配置（当たり判定の箱・飾り・出現地点・経路）を JSON に書き出す。
 * Blender のスクリプト（assets-src/maps/build_map.py・build_fortress.py）がこれを読んで、見た目のモデルを作る。
 *   npx tsx scripts/export-map.ts            ネオン都市と軍事要塞の両方
 *   npx tsx scripts/export-map.ts fortress   軍事要塞だけ
 */
import { writeFileSync } from 'node:fs';
import { buildNeonCity } from '../shared/levels/neonCity';
import { buildFortress } from '../shared/levels/fortress';
import { buildNavGraph } from '../shared/nav';
import { movementConfig } from '../config';
import type { LevelData } from '../shared/level';

const which = process.argv[2];
const jobs: Array<[string, () => LevelData, string]> = [
  ['neon', buildNeonCity, 'assets-src/maps/neon_city_layout.json'],
  ['fortress', buildFortress, 'assets-src/maps/fortress_layout.json'],
];
for (const [id, build, path] of jobs) {
  if (which && which !== id) continue;
  const level = build();
  const nav = buildNavGraph(level, movementConfig);
  const out = { name: level.name, boxes: level.boxes, decor: level.decor, spawns: level.spawns, navLinks: level.navLinks, td: level.td, nav };
  writeFileSync(path, JSON.stringify(out, null, 1));
  console.log(`書き出し: ${path}（箱 ${level.boxes.length}・飾り ${level.decor?.length}・経路の点 ${nav.nodes.length}・つながり ${nav.links.length}）`);
}
