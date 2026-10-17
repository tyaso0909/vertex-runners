/**
 * ネオン都市（仕様 6.1）。消耗戦・タイムアタック用のマップ。
 *
 * 夕暮れのビル街。地面（道路）があり、落ちて死ぬ場所はない。
 * 建物の高さは 4 段階にそろえてあり、階段・坂・橋・壁走りで上り下りする。
 *   0m   道路・広場・コンテナ置き場・商店街・建物の1階
 *   5m   2階・広場を囲む空中デッキ・低い屋上（倉庫・商店街・銭湯・コンビニ）
 *   10m  屋上の道（駅・ゲームセンター・パチンコ店・カフェ・オフィス・ホテル）、北の高架道路、駐車場の3階
 *   15m  集合住宅の屋上（西）、オフィスタワーの屋上と駐車場の屋上（東）
 *
 * 東西・南北で形が違う（鏡写しではない）。西がチーム0（駅）、東がチーム1（ホテル）。
 *
 * 上から見た配置（-Z が北）
 *
 *  [北西の高層ビル] [集合住宅15] [ラーメン屋]═[鯉の塔の基壇10]═ [屋台]   [オフィスタワー15] [北東の高層ビル]
 *                  [テラス10]════════════ 北の高架道路（10m）═══════════════[基壇10]
 *   [駅（西の出現）] [ゲームセンター]          ║階段          [カフェ]┊看板  [オフィス]
 *    2階建て         2階建て  ═橋═〔空中デッキ 5m・円形広場と桜〕═橋═     2階建て ┊看板
 *   ═西の大通り════看板（壁走り）═══          ════東の大通り═══════════════════  [ホテル（東の出現）]
 *   [倉庫5]  [パチンコ店]                 [銭湯]  [立体駐車場 0/5/10/15]          2階建て
 *            [コンテナ置き場：積んだコンテナの壁を壁走り] [商店街（ガラスの屋根）] [低いビル5]═橋═[コンビニ]
 *                                                                          [駐車場（車）]
 */
import type { LevelData } from '../level';
import { v3 } from '../math';
import { CityBuilder } from './cityBuilder';

export function buildNeonCity(): LevelData {
  const b = new CityBuilder();
  const EAST = -Math.PI / 2; // 東を向く（視線の向き）
  const WEST = Math.PI / 2;

  // =====================================================================
  // 地面と、マップを囲むビル（場所ごとに高さを変える）
  // =====================================================================
  b.boxRange(-84, -2, -72, 84, 0, 72, 'floor', { tag: 'ground', noWallrun: true });
  b.solid(-94, -80, -80, 80, 30, { boundary: true });
  b.solid(80, -80, 94, 80, 28, { boundary: true });
  b.solid(-84, -80, -40, -68, 32, { boundary: true });
  b.solid(-40, -80, -16, -68, 24, { boundary: true });
  b.solid(-16, -80, 8, -68, 20, { boundary: true });
  b.solid(8, -80, 40, -68, 28, { boundary: true });
  b.solid(40, -80, 84, -68, 34, { boundary: true });
  b.solid(-84, 68, -44, 80, 26, { boundary: true });
  b.solid(-44, 68, -20, 80, 22, { boundary: true });
  b.solid(-20, 68, 20, 80, 30, { boundary: true });
  b.solid(20, 68, 84, 80, 24, { boundary: true });
  b.sign('screen', 0, 15, 67.9, 180, 22, 16, { style: 'silver' });

  // =====================================================================
  // 西：駅（チーム0の出現）・倉庫・北西の高層ビル
  // =====================================================================
  b.solid(-80, -68, -64, -24, 22, { name: 'nw_tower' });
  b.sign('screen', -63.9, 13, -46, 90, 14, 16, { style: 'nexus' });
  b.ac(-77, 0, -20, 2.2, 1.8, 1.5);
  b.crate(-67, 0, -22, 1.2, 10);
  b.crate(-68.3, 0, -22.3, 1.2, -12);
  b.crate(-67.6, 1.2, -22.1, 1.2, 30);

  // 駅（2階建て。屋上 10m）
  {
    const h1 = b.flight(-78.1, 10, 0, 0); // 1階 → 2階（西の壁ぞい）
    const h2 = b.flight(-66, -14.1, 90, 5); // 2階 → 屋上（北の壁ぞい）
    b.shell(-80, -16, -64, 14, {
      name: 'station',
      floors: [0, 5],
      roof: 10,
      openings: [
        { side: 'e', floor: 0, a: -12, b: -7, h: 3.4 },
        { side: 'e', floor: 0, a: -2.5, b: 2.5, h: 3.4 },
        { side: 'e', floor: 0, a: 7, b: 11, h: 3.4 },
        { side: 'e', floor: 1, a: -11, b: -5, sill: 0.9, h: 2.4 },
        { side: 'e', floor: 1, a: 5, b: 11, sill: 0.9, h: 2.4 },
        { side: 'n', floor: 0, a: -72, b: -68 },
        { side: 's', floor: 0, a: -70, b: -66 },
        { side: 's', floor: 1, a: -79, b: -74, h: 3 },
      ],
      holes: { 1: [h1], 2: [h2] },
    });
    b.deck(-79, 14, -73, 17, 5); // 2階のバルコニー
    b.deck(-79, 17, -75, 22, 5); // 倉庫の屋上への踊り場
    b.flight(-65, 19.5, 90, 0); // 路地から踊り場へ
    for (const [x, z] of [
      [-72, -4],
      [-72, 4],
      [-68, -10],
      [-68, 9],
      [-74, -8],
    ])
      b.spawns.push({ team: 0, pos: v3(x, 0.05, z), yaw: EAST });
    b.ammoStations.push(v3(-78.5, 0, 12));
    b.furniture('counter', -71, 0, -13, 6, 1.2);
    b.furniture('counter', -71, 5, 10, 5, 1.2);
    b.lowWall(-70, 0, -68, 3, 5, 1.1);
    b.sign('screen', -79.55, 2.6, -9, 90, 7, 2.6, { style: 'silver' });
    b.sign('neon', -79.55, 4.35, -9, 90, 5, 0.7, { text: '出発 DEPARTURES', color: '#4fd1ff' });
    b.sign('logo', -63.9, 7.5, 0.5, 90, 10, 3.6, { style: 'kaze' });
    b.sign('neon', -63.9, 3.9, -9.5, 90, 4.6, 0.9, { text: '銀河線 西口', color: '#4fd1ff' });
    b.light(-71, 4, 0, '#ffd2a8', 26, 20);
    b.ac(-77, 10, 6, 2.4, 2, 1.6);
    b.ac(-77, 10, 9.5, 2.4, 2, 1.6);
    b.decor.push({ type: 'helipad', pos: v3(-71, 10, 3), yaw: 0, size: v3(10, 0, 10) });
  }

  // 倉庫（屋上 5m）
  b.solid(-80, 22, -64, 68, 5, { name: 'warehouse' });
  b.container(-71, 5, 34, 0, 'orange');
  b.container(-75, 5, 50, 90, 'blue');
  b.ac(-68, 5, 60, 2.6, 2, 1.8);
  b.crate(-70, 5, 42, 1.2, 15);
  b.sign('vneon', -63.9, 2.6, 40, 90, 2.4, 4.2, { text: '倉庫', sub: 'DEPOT 7', color: '#ffb45c' });

  // =====================================================================
  // 西の中ほど：集合住宅・ゲームセンター・パチンコ店・コンテナ置き場
  // =====================================================================

  // 集合住宅（屋上 15m）と南のテラス（10m）
  b.solid(-56, -68, -36, -48, 15, { name: 'apartment' });
  b.solid(-56, -48, -36, -40, 10, { name: 'apt_terrace' });
  b.flight(-54, -46.5, -90, 10); // テラス → 屋上
  b.ac(-50, 15, -60, 2.4, 2, 1.6);
  b.ac(-42, 15, -64, 2.4, 2, 1.6, 90);
  b.lowWall(-46, -57, -42, -56.4, 15, 1.1);
  b.crate(-40, 10, -41.4, 1.2, 10);
  b.sign('vneon', -45, 4.6, -39.9, 0, 2.8, 8.4, { text: 'ネオンの先へ', sub: 'BEYOND', color: '#ff4fd8' });

  // ゲームセンター（2階建て。屋上 10m）
  {
    const h1 = b.flight(-54.1, -10, 0, 0);
    const h2 = b.flight(-39.9, -28, 180, 5);
    b.shell(-56, -30, -38, -8, {
      name: 'arcade',
      floors: [0, 5],
      roof: 10,
      openings: [
        { side: 'w', floor: 0, a: -26, b: -22 },
        { side: 'w', floor: 1, a: -20, b: -14, sill: 0.9, h: 2.4 },
        { side: 'e', floor: 0, a: -27, b: -23 },
        { side: 'e', floor: 0, a: -14, b: -10 },
        { side: 'e', floor: 1, a: -17, b: -13, h: 3 },
        { side: 'n', floor: 0, a: -49, b: -45 },
        { side: 'n', floor: 1, a: -50, b: -44, sill: 0.9, h: 2.4 },
        { side: 's', floor: 0, a: -52, b: -47 },
        { side: 's', floor: 1, a: -46, b: -41, sill: 0.9, h: 2.4 },
      ],
      holes: { 1: [h1], 2: [h2] },
    });
    for (let i = 0; i < 4; i++) {
      b.furniture('cabinet', -49.5, 0, -26 + i * 1.6, 0.9, 1.2, 90);
      b.furniture('cabinet', -46.5, 0, -26 + i * 1.6, 0.9, 1.2, -90);
      b.furniture('cabinet', -48, 5, -14 + i * 1.6, 0.9, 1.2, 90);
    }
    b.furniture('counter', -42.5, 0, -12.5, 1.2, 4);
    b.sign('screen', -53, 2.6, -29.55, 0, 4, 2.2, { style: 'koi2' });
    b.sign('neon', -56.1, 3.8, -16, -90, 5, 1.1, { text: 'ゲームセンター', color: '#ff4fd8' });
    b.ac(-50, 10, -24, 2.2, 1.8, 1.5);
  }
  b.skybridge(-52, -40, -47, -30, 10, 'z'); // ゲームセンターの屋上 ⇄ 集合住宅のテラス
  b.deck(-38, -17, -25, -13, 5); // ゲームセンターの2階 ⇄ 空中デッキ

  // パチンコ店（2階建て。屋上 10m）
  {
    const h1 = b.flight(-40, 20.1, 90, 0);
    const h2 = b.flight(-54.1, 6, 180, 5);
    b.shell(-56, 4, -38, 22, {
      name: 'pachinko',
      floors: [0, 5],
      roof: 10,
      openings: [
        { side: 'n', floor: 0, a: -50, b: -44, h: 3.4 },
        { side: 'n', floor: 1, a: -52, b: -48, sill: 0.9, h: 2.4 },
        { side: 'e', floor: 0, a: 8, b: 12 },
        { side: 'e', floor: 1, a: 13, b: 19, sill: 0.9, h: 2.4 },
        { side: 'w', floor: 0, a: 15, b: 19 },
        { side: 's', floor: 0, a: -55, b: -52 },
        { side: 's', floor: 1, a: -48, b: -42, sill: 0.9, h: 2.4 },
      ],
      holes: { 1: [h1], 2: [h2] },
    });
    for (let i = 0; i < 5; i++) {
      b.furniture('cabinet', -51, 0, 8 + i * 1.4, 0.9, 1.2, 90);
      b.furniture('cabinet', -47.5, 0, 8 + i * 1.4, 0.9, 1.2, -90);
      b.furniture('cabinet', -45.5, 0, 8 + i * 1.4, 0.9, 1.2, 90);
      b.furniture('cabinet', -46, 5, 8 + i * 1.4, 0.9, 1.2, 90);
    }
    b.sign('neon', -47, 4.4, 3.9, 180, 6, 1.2, { text: 'パチンコ 銀河', color: '#ffb45c' });
    b.ac(-48, 10, 16, 2.2, 1.8, 1.5);
  }

  // 西の大通りの看板：ゲームセンターの屋上 ⇄ パチンコ店の屋上を壁走りで渡る（12m）
  b.billboard(-38, -9, -37.6, 5, 8.5, 14, 'kaze_holo');
  b.navLinks.push({
    kind: 'wallrun',
    from: v3(-38.7, 10, -11),
    to: v3(-38.7, 10, 7),
    via: v3(-38.2, 11, -2),
    both: true,
    note: 'ゲームセンターの屋上 ⇄ パチンコ店の屋上（西の大通りの看板を壁走り）',
  });
  // 跳び移り：駅の屋上 → ゲームセンターの屋上（8m。2段ジャンプ）
  b.navLinks.push({ kind: 'jump', from: v3(-65, 10, -12), to: v3(-54.5, 10, -12), note: '駅の屋上 → ゲームセンターの屋上' });

  // コンテナ置き場：3段に積んだコンテナの壁の横を、2段のコンテナの山から山へ壁走りで渡る（14m）
  for (const y of [0, 2.6, 5.2]) {
    b.container(-45.05, y, 46, 90, y === 2.6 ? 'teal' : 'red');
    b.container(-38.95, y, 46, 90, y === 2.6 ? 'orange' : 'blue');
  }
  for (const y of [0, 2.6]) {
    b.container(-52.05, y, 48.5, 90, y === 0 ? 'blue' : 'orange');
    b.container(-31.95, y, 48.5, 90, y === 0 ? 'red' : 'teal');
  }
  b.container(-52.05, 0, 51, 90, 'teal'); // 山へ登る段
  b.container(-31.95, 0, 51, 90, 'orange');
  b.crate(-53, 0, 53.2, 1.2, 5);
  b.crate(-31, 0, 53.2, 1.2, -8);
  b.navLinks.push({
    kind: 'wallrun',
    from: v3(-51, 5.2, 48.4),
    to: v3(-33, 5.2, 48.4),
    via: v3(-42, 6.2, 47.3),
    both: true,
    note: 'コンテナの山 ⇄ コンテナの山（積んだコンテナの壁を壁走り）',
  });
  b.container(-50, 0, 36, 0, 'orange');
  b.container(-41, 0, 35, 90, 'teal');
  b.container(-33, 0, 38, 0, 'red');
  b.container(-46, 0, 59, 90, 'blue');
  b.container(-46, 2.6, 59, 90, 'orange');
  b.container(-37, 0, 61, 0, 'teal');
  b.container(-46, 0, 62.5, 90, 'red'); // 山へ登る段
  b.crate(-43, 0, 65, 1.2, 12);
  b.container(-53, 0, 63, 0, 'red');
  b.crate(-36, 0, 42, 1.2, 20);
  b.crate(-36, 1.2, 42, 1.2, 45);

  // =====================================================================
  // 中央：円形広場と桜、空中デッキ、北の高架道路、鯉の塔
  // =====================================================================
  const PX = -4,
    PZ = -12;
  b.octagon(PX, PZ, 11, -0.5, 1, 'plaza');
  b.stairs(PX, PZ - 13, 180, 4, 0.25, 0.5, 6, 0);
  b.stairs(PX, PZ + 13, 0, 4, 0.25, 0.5, 6, 0);
  b.stairs(PX - 13, PZ, -90, 4, 0.25, 0.5, 6, 0);
  b.stairs(PX + 13, PZ, 90, 4, 0.25, 0.5, 6, 0);
  b.octagon(PX, PZ, 3, 1, 1.9, 'planter', 'block');
  b.boxRange(PX - 0.5, 1.9, PZ - 0.5, PX + 0.5, 6, PZ + 0.5, 'pillar', { tag: 'trunk', noWallrun: true });
  b.decor.push({ type: 'sakura', pos: v3(PX, 1.9, PZ), yaw: 0 });
  b.light(PX, 7, PZ, '#ff6fc8', 60, 32);
  for (const [x, z] of [
    [7, 7],
    [-7, 7],
    [7, -7],
    [-7, -7],
  ])
    b.lamp(PX + x, 1, PZ + z, '#ff9ad8');

  // 広場を囲む空中デッキ（5m。八角形の輪）
  const R = 19;
  const segL = 2 * R * Math.tan(Math.PI / 8) + 0.6;
  for (let k = 0; k < 8; k++) {
    const th = (k * Math.PI) / 4;
    b.boxRotY(PX + R * Math.cos(th), 4.7, PZ + R * Math.sin(th), 4, 0.6, segL, -(k * 45), 'platform', { tag: 'deck', noWallrun: true, vis: { ring: k } });
    const pa = th + Math.PI / 8;
    b.pillar(PX + R * Math.cos(pa), PZ + R * Math.sin(pa), 0, 4.4, 1.0);
  }
  b.flight(-35, -8, -90, 0, 4); // 西：地面 → デッキ
  b.flight(PX, 19, 0, 0, 4); // 南：地面 → デッキ
  b.flight(PX, -33, 0, 5, 4); // 北：デッキ → 高架道路

  // 北の高架道路（10m）。西は集合住宅のテラス、東はオフィスの基壇につながる
  b.deck(-36, -51, 36, -43, 10, { truss: true });
  for (const x of [-28, -14, 0, 14, 28])
    for (const z of [-50, -44]) b.pillar(x, z, 0, 9.4, 1.2);
  b.rail(-36, -50.9, -16, -50.9, 10);
  b.rail(8, -50.9, 36, -50.9, 10);
  b.rail(-36, -43.1, -6, -43.1, 10);
  b.rail(-2, -43.1, 18, -43.1, 10);
  b.rail(24, -43.1, 36, -43.1, 10);
  b.lowWall(-26, -48, -22, -47.4, 10, 1.2);
  b.lowWall(10, -46.6, 14, -46, 10, 1.2);
  b.lowWall(28, -49, 32, -48.4, 10, 1.2);
  b.car(-12, 10, -47, 90, 'white');
  b.sign('neon', -20, 11.6, -42.95, 0, 6, 0.9, { text: '首都高 銀河線', color: '#4fd1ff' });

  // 鯉の塔（基壇は 10m。高架道路とつながる）
  b.solid(-16, -68, 8, -51, 10, { name: 'koi_base' });
  b.boxRange(-12, 10, -68, 4, 36, -58, 'wall', { tag: 'tower', vis: { name: 'koi_tower' } });
  b.sign('screen', -4, 23, -57.9, 0, 14, 20, { style: 'koi' });
  b.ac(-13, 10, -55, 2.4, 2, 1.5);
  b.ac(5, 10, -55, 2.4, 2, 1.5);
  b.crate(-8, 10, -53, 1.2, 20);
  b.crate(-8, 11.2, -53, 1.2, 35);

  // ラーメン屋（高架道路の北。中に入れる）
  b.shell(-34, -66, -22, -56, {
    name: 'ramen',
    floors: [0],
    roof: 5,
    openings: [
      { side: 's', floor: 0, a: -30, b: -26, h: 3 },
      { side: 'e', floor: 0, a: -63, b: -60, sill: 0.9, h: 1.8 },
    ],
  });
  b.furniture('counter', -28, 0, -62, 7, 1);
  b.sign('neon', -28, 3.9, -55.9, 0, 4.4, 1, { text: 'ラーメン 龍', color: '#ff4fd8' });

  // 屋台（北東）
  for (const [x0, z0] of [
    [11, -62],
    [19, -64],
    [27, -61],
  ])
    b.boxRange(x0, 0, z0, x0 + 4, 2.8, z0 + 3, 'block', { tag: 'kiosk' });

  // =====================================================================
  // 東：ホテル（チーム1の出現）・オフィス・カフェ・立体駐車場・銭湯
  // =====================================================================
  b.solid(64, -68, 80, -14, 26, { name: 'ne_tower' });
  b.sign('screen', 63.9, 14, -40, -90, 12, 16, { style: 'silver' });
  b.ac(76, 0, -10, 2.2, 1.8, 1.5);
  b.crate(67, 0, -8, 1.2, 15);

  // ホテル（2階建て。屋上 10m）
  {
    const h1 = b.flight(78.1, -2, 180, 0); // 1階 → 2階（東の壁ぞい）
    const h2 = b.flight(66, 22.1, -90, 5); // 2階 → 屋上（南の壁ぞい）
    b.shell(64, -4, 80, 24, {
      name: 'hotel',
      floors: [0, 5],
      roof: 10,
      openings: [
        { side: 'w', floor: 0, a: 0, b: 4, h: 3.4 },
        { side: 'w', floor: 0, a: 9, b: 14, h: 3.4 },
        { side: 'w', floor: 0, a: 18, b: 22, h: 3.4 },
        { side: 'w', floor: 1, a: -2, b: 4, sill: 0.9, h: 2.4 },
        { side: 'w', floor: 1, a: 8, b: 14, sill: 0.9, h: 2.4 },
        { side: 'n', floor: 0, a: 70, b: 74 },
        { side: 's', floor: 0, a: 66, b: 70 },
        { side: 's', floor: 1, a: 77, b: 79.5, sill: 0.9, h: 2.4 },
      ],
      holes: { 1: [h1], 2: [h2] },
    });
    for (const [x, z] of [
      [70, 2],
      [70, 11],
      [70, 18],
      [74, 6],
      [74, 15],
    ])
      b.spawns.push({ team: 1, pos: v3(x, 0.05, z), yaw: WEST });
    b.ammoStations.push(v3(67, 0, 22.5));
    b.furniture('counter', 76, 0, 18, 1.2, 5);
    b.furniture('counter', 68, 0, -1, 4, 1);
    b.furniture('counter', 72, 5, 2, 4, 1.2);
    b.sign('screen', 79.55, 2.8, 13, -90, 5, 2.4, { style: 'nexus' });
    b.sign('logo', 63.9, 7.5, 10, -90, 10, 3.6, { style: 'arcadia' });
    b.sign('neon', 63.9, 3.9, 6.5, -90, 5, 0.9, { text: 'HOTEL ARCADIA', color: '#ff4fd8' });
    b.light(72, 4, 10, '#ffc8e8', 26, 20);
    b.plant(68, 10, 0);
    b.plant(68, 10, 6);
    b.plant(76, 10, 12, 'shrub');
    b.ac(77, 10, 17, 2.4, 2, 1.6);
    b.lowWall(72, 5, 75, 10.6, 10, 1.1);
  }
  // 跳び移り：ホテルの屋上 → 駐車場の3階（8m。2段ジャンプ）
  b.navLinks.push({ kind: 'jump', from: v3(65, 10, 18), to: v3(54.5, 10, 18), both: true, note: 'ホテルの屋上 ⇄ 駐車場の3階' });

  // オフィスタワー（屋上 15m）と基壇（10m）
  b.solid(36, -68, 56, -53, 15, { name: 'office_tower' });
  b.boxRange(40, 15, -68, 56, 26, -60, 'wall', { tag: 'tower', vis: { name: 'office_top' } });
  b.solid(36, -53, 56, -40, 10, { name: 'office_base' });
  b.flight(44, -43, 0, 10); // 基壇 → タワーの屋上
  b.ac(51, 10, -47, 2.4, 2, 1.6);
  b.ac(48, 15, -57, 2.4, 2, 1.6);
  b.lowWall(38, -56, 41, -55.4, 15, 1.1);
  b.sign('vneon', 39.9, 20, -64, -90, 3, 8, { text: '流星', sub: 'METEOR', color: '#4fd1ff' });

  // オフィス（2階建て。屋上 10m）
  {
    const h1 = b.flight(38, -30.1, -90, 0);
    const h2 = b.flight(54.1, -14, 0, 5);
    b.shell(36, -32, 56, -12, {
      name: 'office',
      floors: [0, 5],
      roof: 10,
      openings: [
        { side: 's', floor: 0, a: 40, b: 44 },
        { side: 's', floor: 0, a: 47, b: 51 },
        { side: 'w', floor: 0, a: -28, b: -24 },
        { side: 'e', floor: 0, a: -21, b: -17 },
        { side: 'n', floor: 0, a: 50, b: 54 },
        { side: 'n', floor: 1, a: 37, b: 43, sill: 0.9, h: 2.4 },
        { side: 'w', floor: 1, a: -22, b: -16, sill: 0.9, h: 2.4 },
        { side: 'e', floor: 1, a: -31, b: -26, sill: 0.9, h: 2.4 },
        { side: 's', floor: 1, a: 40, b: 48, sill: 0.9, h: 2.4 },
      ],
      holes: { 1: [h1], 2: [h2] },
    });
    for (const [x, z] of [
      [42, -20],
      [42, -16],
      [48, -20],
      [48, -16],
    ])
      b.furniture('counter', x, 0, z, 3, 1.2);
    b.furniture('counter', 44, 5, -22, 3, 1.2);
    b.furniture('counter', 44, 5, -17, 3, 1.2);
    b.furniture('shelf', 39, 5, -24, 0.7, 4);
    b.sign('neon', 46, 4.4, -11.9, 0, 6, 0.9, { text: 'NEXUS OFFICE', color: '#4fd1ff' });
    b.ac(42, 10, -26, 2.2, 1.8, 1.5);
  }

  // 東の大通りの看板：オフィスの屋上 ⇄ 駐車場の3階を壁走りで渡る（12m）
  b.billboard(56, -13, 56.4, 1, 8.5, 14, 'nexus_holo');
  b.navLinks.push({
    kind: 'wallrun',
    from: v3(55.3, 10, -14),
    to: v3(55.3, 10, 2),
    via: v3(55.9, 11, -6),
    both: true,
    note: 'オフィスの屋上 ⇄ 駐車場の3階（東の大通りの看板を壁走り）',
  });

  // カフェ（2階建て。屋上 10m）。2階から空中デッキへ橋
  {
    const h1 = b.flight(21.9, -18, 0, 0);
    const h2 = b.flight(23.6, -28.1, -90, 5);
    b.shell(20, -30, 34, -16, {
      name: 'cafe',
      floors: [0, 5],
      roof: 10,
      openings: [
        { side: 's', floor: 0, a: 27, b: 31 },
        { side: 'e', floor: 0, a: -24, b: -20 },
        { side: 's', floor: 1, a: 25, b: 29, h: 3 },
        { side: 'w', floor: 1, a: -24, b: -18, sill: 0.9, h: 2.4 },
        { side: 'e', floor: 1, a: -24, b: -18, sill: 0.9, h: 2.4 },
      ],
      holes: { 1: [h1], 2: [h2] },
    });
    b.furniture('counter', 29, 0, -27.5, 5, 1);
    b.furniture('counter', 30, 5, -20, 1.2, 1.2);
    b.furniture('counter', 26.5, 5, -22, 1.2, 1.2);
    b.sign('neon', 31.5, 3.9, -15.9, 0, 3.6, 0.9, { text: 'CAFE 月', color: '#ffb45c' });
    b.ac(30, 10, -20, 2.2, 1.8, 1.5);
  }
  b.deck(17, -16, 29, -12, 5); // 空中デッキ ⇄ カフェの2階

  // 北の通りの看板：カフェの屋上 ⇄ 高架道路を壁走りで渡る（13m）
  b.billboard(19.6, -42.6, 20, -29.4, 8.5, 14, 'kaze_holo');
  b.navLinks.push({
    kind: 'wallrun',
    from: v3(20.7, 10, -28),
    to: v3(20.7, 10, -45),
    via: v3(20.1, 11, -36),
    both: true,
    note: 'カフェの屋上 ⇄ 高架道路（北の通りの看板を壁走り）',
  });

  // 立体駐車場（0・5・10m の3層と、15m の屋上）。車路は 西の列（0→5、10→15）と真ん中の列（5→10）
  {
    const gx0 = 36,
      gx1 = 56,
      gz0 = 0,
      gz1 = 26;
    const W = { x0: 37, x1: 41 },
      C = { x0: 44, x1: 48 };
    const slabs = (y: number, lane: { x0: number; x1: number }) => {
      const g = { garage: true, level: y };
      b.slab(gx0, gz0, lane.x0, gz1, y, g);
      b.slab(lane.x1, gz0, gx1, gz1, y, g);
      b.slab(lane.x0, gz0, lane.x1, 6, y, g);
      b.slab(lane.x0, 22, lane.x1, gz1, y, g);
    };
    slabs(5, W);
    slabs(10, C);
    slabs(15, W);
    b.carRamp(v3(39, 0, 22), v3(39, 5, 6), 4);
    b.carRamp(v3(46, 5, 6), v3(46, 10, 22), 4);
    b.carRamp(v3(39, 10, 22), v3(39, 15, 6), 4);
    for (const x of [36.6, 42.5, 49.5, 55.4])
      for (const z of [0.6, 13, 25.4]) {
        if (x === 55.4 && z === 0.6) continue; // 看板の壁走りの着地点
        b.pillar(x, z, 0, 14.5, 0.6);
      }
    for (const y of [5, 10]) {
      b.parapet(gx0, gz0, gx0 + 0.3, gz1, y);
      if (y === 10) {
        // 東：看板からの着地（北の端）と、ホテルの屋上からの跳び込み（14〜22）をあける
        b.parapet(gx1 - 0.3, 6, gx1, 14, y);
        b.parapet(gx1 - 0.3, 22, gx1, gz1, y);
        b.parapet(gx0, gz0, 50, gz0 + 0.3, y);
      } else {
        b.parapet(gx1 - 0.3, gz0, gx1, gz1, y);
        b.parapet(gx0, gz0, gx1, gz0 + 0.3, y);
      }
      b.parapet(gx0, gz1 - 0.3, gx1, gz1, y);
    }
    b.rail(gx0 + 0.1, gz0 + 0.1, gx1 - 0.1, gz0 + 0.1, 15);
    b.rail(gx0 + 0.1, gz1 - 0.1, gx1 - 0.1, gz1 - 0.1, 15);
    b.rail(gx0 + 0.1, gz0 + 0.1, gx0 + 0.1, gz1 - 0.1, 15);
    b.rail(gx1 - 0.1, gz0 + 0.1, gx1 - 0.1, gz1 - 0.1, 15);
    b.car(46, 0, 14, 0, 'red');
    b.car(52, 0, 8, 0, 'white');
    b.car(52, 5, 18, 0, 'blue');
    b.car(52, 10, 10, 0, 'black');
    b.car(46, 15, 14, 0, 'white');
    b.sign('neon', 46, 5.5, -0.15, 180, 4.2, 1.1, { text: 'P 駐車場', color: '#4fd1ff' });
    b.light(46, 8.5, 13, '#9fe0ff', 30, 24);
  }

  // 銭湯（1階建て。屋上 5m）
  b.shell(20, 6, 32, 20, {
    name: 'bathhouse',
    floors: [0],
    roof: 5,
    openings: [
      { side: 'n', floor: 0, a: 24, b: 28 },
      { side: 'w', floor: 0, a: 12, b: 16 },
    ],
  });
  b.flight(31, 21.5, 90, 0); // 屋上へ
  b.furniture('counter', 29, 0, 9, 1.2, 3);
  b.furniture('shelf', 30.5, 0, 15.5, 0.7, 5);
  b.lowWall(22, 12, 27, 12.4, 0, 0.7);
  b.lowWall(22, 17.5, 27, 17.9, 0, 0.7);
  b.sign('neon', 26, 3.6, 5.9, 180, 2.4, 1.2, { text: '湯', color: '#4fd1ff' });

  // =====================================================================
  // 南：商店街（ガラスの屋根）、南の広場、コンビニ、低いビル、駐車場
  // =====================================================================
  b.boxRange(-20, 6.5, 42, 20, 6.8, 50, 'platform', { tag: 'roof', noWallrun: true, vis: { arcade: true } });
  b.sign('neon', -21, 7.6, 46, -90, 7, 1.4, { text: '銀河通り商店街', color: '#ffb45c' });
  b.light(0, 5, 46, '#ffb45c', 30, 26);
  b.lamp(-10, 0, 46, '#ffb45c');
  b.lamp(10, 0, 46, '#ff4fd8');
  // 北の列
  b.shell(-20, 34, -8, 42, { name: 'shop_a', floors: [0], roof: 5, openings: [{ side: 's', floor: 0, a: -17, b: -11, h: 3 }] });
  b.shell(-6, 34, 6, 42, { name: 'shop_b', floors: [0], roof: 5, openings: [{ side: 's', floor: 0, a: -3, b: 3, h: 3 }] });
  b.solid(8, 34, 20, 42, 5, { name: 'shop_row' });
  b.flight(-21.5, 32, 180, 0); // 北の列の屋上へ
  b.furniture('shelf', -14, 0, 37.5, 0.7, 5, 90);
  b.furniture('counter', 0, 0, 37, 6, 1);
  b.sign('neon', -14, 4.0, 42.1, 0, 4.4, 1, { text: '古着', color: '#4fd1ff' });
  b.sign('neon', 0, 4.0, 42.1, 0, 4.4, 1, { text: '電器', color: '#ff4fd8' });
  // 南の列
  b.shell(-18, 50, -6, 60, { name: 'shop_c', floors: [0], roof: 5, openings: [{ side: 'n', floor: 0, a: -15, b: -9, h: 3 }] });
  b.shell(-4, 50, 12, 60, { name: 'shop_d', floors: [0], roof: 5, openings: [{ side: 'n', floor: 0, a: 2, b: 8, h: 3 }] });
  b.solid(14, 50, 24, 60, 5, { name: 'shop_row2' });
  b.flight(-19.5, 62, 0, 0); // 南の列の屋上へ
  b.furniture('counter', -12, 0, 56, 6, 1);
  for (let i = 0; i < 3; i++) b.furniture('cabinet', 1 + i * 1.6, 0, 57.5, 0.9, 1.2, 180);
  b.sign('neon', -12, 4.0, 49.9, 180, 4.4, 1, { text: '寿司', color: '#ffb45c' });
  b.sign('neon', 5, 4.0, 49.9, 180, 4.4, 1, { text: 'GAME', color: '#ff4fd8' });

  // 南の広場（植え込み・ヤシ）
  for (const [x0, z0, x1, z1] of [
    [-24, 14, -18, 16],
    [8, 14, 14, 16],
    [-14, 26, -8, 28],
    [4, 24, 10, 26],
  ]) {
    b.boxRange(x0, 0, z0, x1, 0.9, z1, 'block', { tag: 'planter', noWallrun: true });
    b.plant((x0 + x1) / 2, 0.9, (z0 + z1) / 2);
  }

  // 低いビル（屋上 5m）とコンビニ（屋上 5m）。橋でつながる
  b.solid(38, 34, 54, 48, 5, { name: 'se_block' });
  b.flight(36.5, 48, 0, 0); // 屋上へ
  b.billboard(42, 40, 50, 40.4, 5, 9.5, 'kaze_holo');
  b.deck(54, 36, 64, 40, 5);
  b.shell(64, 30, 78, 44, {
    name: 'store',
    floors: [0],
    roof: 5,
    openings: [
      { side: 'w', floor: 0, a: 33, b: 41, h: 3 },
      { side: 'n', floor: 0, a: 70, b: 74 },
    ],
  });
  for (let i = 0; i < 3; i++) b.furniture('shelf', 67.5 + i * 2.6, 0, 37, 0.7, 6);
  b.furniture('counter', 75.5, 0, 40, 1, 3.5);
  b.flight(66, 45.5, -90, 0); // 屋上へ
  b.sign('neon', 63.9, 3.6, 37, -90, 5.5, 1.1, { text: '24H ストア', color: '#4fd1ff' });

  // 駐車場（地上）
  b.car(60, 0, 57, 0, 'white');
  b.car(64, 0, 57, 0, 'red');
  b.car(68, 0, 57, 180, 'black');
  b.car(74, 0, 61, 0, 'blue');
  b.car(66, 0, 65, 90, 'white');
  b.boxRange(57, 0, 49, 60, 2.8, 52, 'block', { tag: 'kiosk' });

  // =====================================================================
  // 道路の模様
  // =====================================================================
  b.road(-64, -68, -56, 68, 'z', [-35, -2, 26]);
  b.road(-64, -40, -36, -30, 'x');
  b.road(-64, -8, -27, 4, 'x', [-34]);
  b.road(-64, 22, -20, 30, 'x', [-50]);
  b.road(-38, -40, -30, -8, 'z');
  b.road(-28, 22, -20, 68, 'z', [40]);
  b.road(-36, -51, 36, -43, 'x');
  b.road(56, -68, 64, 68, 'z', [-8, 30]);
  b.road(19, -12, 64, 0, 'x', [24, 60]);
  b.road(19, -40, 64, -32, 'x');
  b.road(19, 26, 64, 34, 'x', [30]);
  b.road(56, 48, 80, 68, 'x');

  // =====================================================================
  // 練習用の的
  // =====================================================================
  b.target(-46, 0, -2, 90);
  b.target(-32, 0, -20, 90, v3(-32, 0, -34), 2);
  b.target(-46, 10, -14, 0);
  b.target(-40, 0, 40, 0);
  b.target(8, 10, -47, 0);
  b.target(46, 10, 12, 90);
  b.target(46, 0, -24, 90);
  b.target(27, 5, -20, 0);
  b.target(70, 5, 37, 90);
  b.target(0, 0, 46, 90, v3(14, 0, 46), 2.5);
  b.target(-28, 5, -61, 0);
  b.target(PX + 19, 5, PZ, -90);

  // マップの外へ出ないための見えない壁（屋上から外へ跳ばないように）
  const BH = 70;
  b.boxRange(-84, 0, -72, -80, BH, 72, 'boundary', { tag: 'barrier', noWallrun: true });
  b.boxRange(80, 0, -72, 84, BH, 72, 'boundary', { tag: 'barrier', noWallrun: true });
  b.boxRange(-84, 0, -72, 84, BH, -68, 'boundary', { tag: 'barrier', noWallrun: true });
  b.boxRange(-84, 0, 68, 84, BH, 72, 'boundary', { tag: 'barrier', noWallrun: true });

  // 試合の途中で復活する地点（建物の中・路地。敵から離れた所が選ばれる）。西半分はチーム0、東半分はチーム1 の側
  for (const [x, y, z] of [
    [-43, 0, -20], // ゲームセンターの1階
    [-41, 0, 10], // パチンコ店の1階
    [-28, 0, -59], // ラーメン屋の中
    [-44, 0, 52], // コンテナ置き場
    [-14, 0, 53], // 南の商店街の店
    [-70, 5, 5], // 駅の2階
    [-68, 5, 45], // 倉庫の屋上
    [45, 0, -25], // オフィスの1階
    [27, 0, -22], // カフェの1階
    [50, 0, 20], // 駐車場の1階
    [24, 0, 9], // 銭湯の中
    [66, 0, 37], // コンビニの中
    [70, 0, 52], // 地上の駐車場
    [20, 0, -55], // 屋台
    [70, 5, 10], // ホテルの2階
  ])
    b.spawns.push({ team: x < 0 ? 0 : 1, pos: v3(x, y + 0.05, z), yaw: Math.atan2(x - -4, z - -12), field: true });

  const spawn0 = b.spawns.find((s) => s.team === 0)!;
  return {
    name: 'ネオン都市',
    style: 'neon',
    visual: 'neon_city',
    boxes: b.boxes,
    labels: [],
    targets: b.targets,
    ammoStations: b.ammoStations,
    decor: b.decor,
    spawns: b.spawns,
    navLinks: b.navLinks,
    spawn: spawn0.pos,
    spawnYaw: spawn0.yaw,
    killY: -20,
    bounds: { min: v3(-80, -5.5, -68), max: v3(80, 18, 68) },
  };
}
