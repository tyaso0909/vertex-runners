/**
 * フェーズ1 用のテスト部屋。箱だけで、移動アクションを一通り試せるように作ってある。
 *
 * 上から見た配置（-Z が北＝スタート時に向いている方向）
 *
 *        北
 *   [段差ジャンプ]  [よじ登り台]  [ジグザグ登り]
 *   [壁走り通路]    [柱][弧の壁]  [斜めの壁] [スライディング坂]
 *   [スタート台]     [低いトンネル]  ★スタート  [坂を上る道・階段]
 *   [長い壁]
 *        南
 *
 * 西の端（壁走り通路のさらに西、x < -43）は「アビリティ訓練場」（フェーズ3）。
 * 南の入口から北へ：ダメージ床 → ソナーの壁 → 高い足場（ワイヤー） → タレットの射撃場
 */
import { LevelBuilder, type LevelData } from '../level';
import { v3 } from '../math';

export function buildTestRoom(): LevelData {
  const b = new LevelBuilder();

  // --- 床と外壁 ---
  b.boxTop(0, 0, 0, 130, 1, 130, 'floor', { noWallrun: true });
  const H = 14;
  b.boxRange(-64, 0, -64, -62, H, 64, 'boundary');
  b.boxRange(62, 0, -64, 64, H, 64, 'boundary');
  b.boxRange(-62, 0, -64, 62, H, -62, 'boundary');
  b.boxRange(-62, 0, 62, 62, H, 64, 'boundary');

  // --- A. 壁走り通路（西） ---
  b.boxRange(-42, 0, 26, -28, 4, 36, 'platform'); // スタート台（高さ4）
  b.ramp(v3(-16, 0, 31), v3(-28, 4, 31), 5); // スタート台へ上る坂
  b.boxRange(-42, 0, -14, -40.5, 11, 26, 'wall'); // 西の壁
  b.boxRange(-33.5, 0, -14, -32, 11, 26, 'wall'); // 東の壁（内側の幅は7m）
  b.boxRange(-42, 0, -24, -28, 4, -14, 'platform'); // ゴール台
  b.label('壁走り通路', -37, 7.5, 36.2, 0, '壁走り → 壁ジャンプで反対の壁へ', '#4fd1ff');

  // --- B. 段差ジャンプ（北西） ---
  b.boxRange(-38, 0, -34, -32, 4, -29, 'platform'); // 隙間5m
  b.boxRange(-38, 0, -45, -32, 5, -40, 'platform'); // 隙間6m・1m上
  b.boxRange(-38, 0, -58, -32, 4, -53, 'platform'); // 隙間8m（2段ジャンプ）
  b.boxRange(-32, 0, -61, -20, 10, -59.5, 'wall'); // 東の台へ渡るための壁
  b.boxRange(-26, 0, -58, -20, 7, -52, 'platform'); // 高さ7（壁走りか2段ジャンプで）
  b.label('段差ジャンプ', -35, 7, -23.8, 0, '2段ジャンプ・壁走りで台を渡る', '#8a5cff');

  // --- C. よじ登り台（北） ---
  const heights = [1.0, 1.4, 2.0, 2.6, 3.2, 4.0];
  heights.forEach((h, i) => {
    const x0 = -14 + i * 4.5;
    b.boxRange(x0, 0, -34, x0 + 3, h, -31, 'block', { noWallrun: h < 2.5 });
    b.label(`${h.toFixed(1)}m`, x0 + 1.5, h + 0.45, -30.95, 0, undefined, '#ffb45c');
  });
  b.label('よじ登り', -1.5, 6, -31, 0, '前に進みながらジャンプして縁へ', '#ffb45c');

  // --- D. 柱（北の中央） ---
  for (const [x, z] of [
    [-10, -18],
    [-4, -22],
    [2, -18],
    [8, -22],
  ])
    b.boxTop(x, 9, z, 1.6, 9, 1.6, 'pillar');

  // --- E. 弧を描く壁（中央）：曲がった壁に沿って壁走りできるか ---
  {
    const cx = -4,
      cz = 12,
      R = 12,
      seg = 11;
    const a0 = 20,
      a1 = 160;
    const step = (a1 - a0) / (seg - 1);
    for (let i = 0; i < seg; i++) {
      const th = (a0 + step * i) * (Math.PI / 180);
      const x = cx + R * Math.cos(th),
        z = cz - R * Math.sin(th);
      const w = 2 * R * Math.sin(((step * Math.PI) / 180) / 2) + 0.35;
      b.boxRotY(x, 4.5, z, w, 9, 1, step * i + a0 + 90, 'wall');
    }
    b.label('弧の壁', cx, 10.2, cz - R + 0.6, 0, '曲がった壁に沿って走る', '#ff4fd8');
  }

  // --- F. 斜めの壁（中央東） ---
  b.boxRotY(12, 4, 6, 1, 8, 10, 30, 'wall');
  b.boxRotY(19, 4, -1, 1, 8, 10, -45, 'wall');

  // --- G. スライディング坂（東） ---
  b.boxRange(30, 0, 21, 48, 6, 29, 'platform'); // 坂の上の台（高さ6）
  b.ramp(v3(34, 0, 45), v3(34, 6, 29), 6); // 上る坂
  b.stairs(44, 41, 0, 24, 0.25, 0.5, 4); // 階段（1段 25cm）
  b.ramp(v3(34, 0, -9), v3(34, 6, 21), 6); // ゆるい下り坂（約11°）
  b.ramp(v3(43, 0, 5), v3(43, 6, 21), 6); // 急な下り坂（約21°）
  b.label('スライディング坂', 39, 9, 29.1, 0, '下り坂でスライディングすると加速', '#4fd1ff');

  // --- H. ジグザグ登り（北東）：左右の壁を壁ジャンプで登る ---
  b.boxRange(18, 0, -30, 19.5, 7, -20, 'wall');
  b.boxRange(26.5, 2, -40, 28, 10, -30, 'wall');
  b.boxRange(18, 4, -50, 19.5, 13, -40, 'wall');
  b.boxRange(18, 0, -60, 28, 8, -50, 'platform');
  b.label('ジグザグ登り', 23, 9.5, -19.9, 0, '左右の壁を壁ジャンプで登る', '#8a5cff');

  // --- I. 低いトンネル（スタートの西）：しゃがみ・スライディングでくぐる ---
  b.boxRange(6, 1.25, 30, 10, 1.75, 40, 'prop', { noWallrun: true });
  b.boxRange(5, 0, 30, 6, 1.75, 40, 'prop', { noWallrun: true });
  b.boxRange(10, 0, 30, 11, 1.75, 40, 'prop', { noWallrun: true });
  b.label('低いトンネル', 8, 2.6, 40.1, 0, 'スライディングでくぐる（高さ1.25m）', '#ffb45c');

  // --- J. 長い壁（南西） ---
  b.boxRange(-52, 0, 50, -8, 9, 51.5, 'wall');
  b.label('長い壁', -30, 10, 49.9, 180, '1枚の壁でどこまで走れるか', '#4fd1ff');

  // --- K. 小さな障害物（よじ登り・遮蔽物の確認） ---
  b.boxTop(-6, 1.2, 30, 1.2, 1.2, 1.2, 'prop', { noWallrun: true });
  b.boxTop(-8, 1.2, 33, 2.4, 1.2, 1.2, 'prop', { noWallrun: true });
  b.boxTop(16, 1.6, 36, 2.5, 1.6, 2.5, 'prop', { noWallrun: true });

  // --- L. 射撃場（南側の細長いレーン。東端から西へ撃つ） ---
  {
    const fx = 56; // 射撃位置の x
    const z = 57;
    b.boxRange(fx - 0.2, 0, 52.5, fx + 0.2, 0.06, 61.5, 'prop', { noWallrun: true }); // 射撃位置の線
    b.boxRange(fx + 3, 0, 52, fx + 5, 1.1, 53, 'prop', { noWallrun: true }); // 台
    b.ammoStations.push(v3(fx + 2.5, 0, 54));
    b.label('弾薬補給', fx + 2.5, 2.2, 53.2, 180, '近づくと補給', '#ffb45c');
    b.label('射撃場', fx - 1, 4.2, 61.9, 180, '1 / 2 で持ち替え・Esc で装備変更', '#ff4fd8');
    // 距離ごとの的（立っている的・頭も狙える）
    for (const d of [10, 25, 50, 80]) {
      b.target(fx - d, 0, z, 90);
      b.label(`${d}m`, fx - d + 0.01, 2.6, z, 90, undefined, '#4fd1ff');
      b.boxRange(fx - d - 0.05, 0, 52.5, fx - d + 0.05, 0.04, 61.5, 'prop', { noWallrun: true }); // 床の線
    }
    // 横に動く的
    b.target(fx - 18, 0, 53.5, 90, v3(fx - 18, 0, 60.5), 3.0);
    b.target(fx - 40, 0, 60.5, 90, v3(fx - 40, 0, 53.5), 4.5);
    // 2m 先の近い的（ショットガン確認用）
    b.target(fx - 4, 0, 54, 90);
  }

  // --- M. 部屋のあちこちの的（動きながら撃つ練習用） ---
  b.target(-35, 4, -20, 0); // 壁走り通路のゴール台
  b.target(-4, 0, -27, 0); // 柱の奥
  b.target(39, 6, 23, 0); // スライディング坂の上
  b.target(34, 0, -14, 0, v3(43, 0, -14), 2.5); // 坂の下（動く）
  b.target(23, 8, -55, 0); // ジグザグ登りの上

  // --- N. アビリティ訓練場（西の端） ---
  {
    const X0 = -62; // 西の外壁の内側
    const X1 = -43; // 壁走り通路の西の壁の外側
    // 北の壁走り台（段差ジャンプ）と仕切る壁：タレットの弾がほかの場所へ飛ばないように
    b.boxRange(X0, 0, -28, X1 + 1, 7, -26.8, 'wall');
    b.boxRange(X1, 0, -28, X1 + 1.2, 7, -14, 'wall');
    b.label('アビリティ訓練場', -42.4, 5.2, 42, 90, 'Q でアビリティ・Esc でキャラクター変更', '#ff4fd8');

    // 入口のそば：ダメージ床（体力の回復・オーバードライブ・フェイズシフトの確認）
    b.hazards.push({ min: v3(-60, 0, 30), max: v3(-52, 1.5, 38), dps: 15 });
    b.label('ダメージ床', -56, 2.6, 38.2, 0, '1秒に15ダメージ（回復の速さを試す）', '#ff4f6a');

    // ソナー：壁の向こうに的を隠す
    b.boxRange(-61, 0, 22, -50, 3.6, 22.8, 'wall');
    b.boxRange(-54, 0, 15, -44, 3.6, 15.8, 'wall');
    b.boxRange(-61, 0, 8.5, -52, 3.6, 9.3, 'wall');
    b.target(-56, 0, 19.5, 0);
    b.target(-47.5, 0, 12.5, 0, v3(-52, 0, 12.5), 1.5);
    b.target(-58.5, 0, 5.5, 0);
    b.label('ソナー', -55.5, 4.6, 22.9, 0, '壁の向こうの的を見つける', '#ffd21f');

    // ワイヤーフック：高い塔と、宙に浮いた足場
    b.boxRange(-61.5, 0, -3, -55.5, 12, 3, 'platform');
    b.target(-58.5, 12, 0, 90);
    b.boxTop(-48, 13, 0, 3, 0.8, 3, 'platform');
    b.boxTop(-52, 9, 4, 0.8, 0.8, 0.8, 'block'); // 途中の小さな足場
    b.label('ワイヤーフック', -50, 7.6, 7.2, 0, '高い塔・浮いた足場へ／的に当てると引き寄せる', '#e8202e');

    // タレットの射撃場（低い仕切り壁の北）
    b.boxRange(X0, 0, -6.5, -47, 3.2, -5.5, 'wall');
    b.boxTop(-56, 1.3, -11, 2.6, 1.3, 1, 'prop', { noWallrun: true });
    b.boxTop(-49, 1.3, -13, 2.6, 1.3, 1, 'prop', { noWallrun: true });
    b.boxTop(-53, 2.2, -17, 1, 2.2, 3, 'prop', { noWallrun: true });
    b.turret(-58, 0, -23, 0);
    b.turret(-50, 0, -24.5, 0);
    b.boxRange(-47, 0, -21, -44, 3, -18, 'platform');
    b.turret(-45.5, 3, -19.5, 0);
    b.label('タレット', -54.5, 4.2, -5.4, 0, '撃ってくる：シールド・迷彩・フェイズを試す', '#ff7a1a');
  }

  return {
    name: 'テスト部屋',
    boxes: b.boxes,
    labels: b.labels,
    targets: b.targets,
    ammoStations: b.ammoStations,
    hazards: b.hazards,
    spawn: v3(0, 0.05, 44),
    spawnYaw: 0,
    killY: -30,
  };
}
