/**
 * フェーズ7：タワーディフェンス（軍事要塞・敵・ウェーブ・タレット・コア・味方ボット・ダウンと蘇生）のテスト
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVEMENT, type TdConfig, tdConfig } from '../config';
import { rayVsActor } from '../shared/hitbox';
import { emptyCommand } from '../shared/input';
import { buildFortress } from '../shared/levels/fortress';
import { lenH, sub, v3 } from '../shared/math';
import { buildNavGraph } from '../shared/nav';
import { Simulation, TICK_DT } from '../shared/simulation';
import { TdMatch } from '../shared/td/towerDefense';
import { ASSAULT_BODY, HEAVY_BODY, TURRET_HEIGHT } from '../shared/td/units';
import { charsCfg, weaponsCfg } from './helpers';

const fortress = buildFortress();
const nav = buildNavGraph(fortress, DEFAULT_MOVEMENT);
const td = fortress.td!;

/** 試合を作る。cfg で数値を変えられる。ボットを止めるときは quiet */
function makeMatch(opts: { cfg?: Partial<TdConfig>; human?: boolean; quiet?: boolean; difficulty?: 'easy' | 'normal' | 'hard'; seed?: number } = {}) {
  const sim = new Simulation(fortress, { ...DEFAULT_MOVEMENT }, weaponsCfg(), charsCfg());
  const cfg = { ...tdConfig, ...opts.cfg } as TdConfig;
  const m = new TdMatch(sim, nav, { difficulty: opts.difficulty ?? 'normal', humanPlayer: opts.human ?? true, seed: opts.seed ?? 7 }, cfg);
  if (opts.quiet) for (const b of m.allies.values()) b.think = () => b.idle();
  return m;
}

/** 準備時間まで進める（はじめの数秒） */
function toPrep(m: TdMatch) {
  for (let i = 0; i < 60 * 10 && m.phase !== 'prep'; i++) m.step(emptyCommand(m.sim.tick + 1));
}

describe('軍事要塞：マップ', () => {
  it('コア・3つの侵入ルート・味方の出現地点・弾薬補給所がある', () => {
    expect(td.routes.map((r) => r.id).sort()).toEqual(['front', 'left', 'right']);
    expect(lenH(sub(td.core, v3(0, 0, -20)))).toBeLessThan(0.01);
    expect((fortress.spawns ?? []).filter((s) => s.team === 0).length).toBeGreaterThanOrEqual(4);
    expect((fortress.ammoStations ?? []).length).toBeGreaterThan(0);
    for (const r of td.routes) {
      expect(r.path.length).toBeGreaterThan(2);
      expect(r.turretPoints.length).toBeGreaterThanOrEqual(4);
    }
    expect(td.droneHover.length).toBeGreaterThan(3);
  });

  it('タレットの推奨地点は、要塞の中の置ける場所', () => {
    const m = makeMatch({ quiet: true });
    toPrep(m);
    const pid = m.player!.id;
    m.participantOf(pid)!.credits = 99999;
    let ok = 0,
      all = 0;
    for (const r of td.routes)
      for (const p of r.turretPoints) {
        all++;
        if (m.placeCheck(pid, 'mg', p).ok) ok++;
      }
    expect(ok / all).toBeGreaterThan(0.8);
  });

  it('どのルートの歩兵も、道すじをたどってコアのまわりまで歩ける', () => {
    const m = makeMatch({ quiet: true, cfg: { INTRO_TIME: 1e9 } });
    for (const r of td.routes) m.spawnEnemy('grunt', r.id);
    const recs = [...m.enemies.values()];
    for (const e of recs) m.sim.entities.get(e.id)!.invuln = 1e9; // 味方・コアに倒されないように
    let t = 0;
    for (; t < 60 * 150; t++) {
      m.step(emptyCommand(m.sim.tick + 1));
      if (recs.every((r) => r.brain!.atCore)) break;
    }
    for (const r of recs) expect(r.brain!.atCore, `${r.route} の歩兵がコアに着かない`).toBe(true);
  }, 120_000);

  it('ドローンは壁を越えてコアの近くに浮かび、コアを撃つ。爆弾兵はコアで自爆する', () => {
    const m = makeMatch({ quiet: true, cfg: { INTRO_TIME: 1e9 } });
    m.spawnEnemy('drone', 'left');
    m.spawnEnemy('assault', 'right');
    const hp0 = m.core.health;
    let exploded = false,
      droneHit = false;
    for (let t = 0; t < 60 * 90 && !(exploded && droneHit); t++) {
      m.step(emptyCommand(m.sim.tick + 1));
      if (m.events.some((e) => e.type === 'assaultExplode')) exploded = true;
      for (const ev of m.sim.events) if (ev.type === 'playerDamaged' && ev.entityId === m.core.id && m.sim.entities.get(ev.attackerId ?? -1)?.kind === 'drone') droneHit = true;
    }
    expect(exploded).toBe(true);
    expect(droneHit).toBe(true);
    expect(m.core.health).toBeLessThan(hp0);
  }, 120_000);
});

describe('タワーディフェンス：タレット', () => {
  it('準備時間だけ、要塞の中の平らな所に置ける。1人 4 基まで・クレジットが減る・売ると半額', () => {
    const m = makeMatch({ quiet: true });
    const pid = m.player!.id;
    const p = m.player!;
    expect(m.placeCheck(pid, 'mg', v3(10, 0, 0)).ok).toBe(false); // まだ準備時間ではない
    toPrep(m);
    const me = m.participantOf(pid)!;
    me.credits = 3000;
    expect(m.placeCheck(pid, 'mg', v3(0, 0, 70)).reason).toBe('要塞の中に置く');
    expect(m.placeCheck(pid, 'mg', v3(3.8, 0.3, -17)).reason).toBe('コアに近すぎる');
    const spots = [v3(12, 0, 4), v3(-10, 0, 0), v3(8, 0, 8), v3(-16, 0, 12), v3(20, 0, 8)];
    const placed: boolean[] = [];
    for (const s of spots) {
      p.movement.pos = v3(s.x, 0, s.z + 3);
      placed.push(m.tryPlace(pid, 'mg', s));
    }
    expect(placed).toEqual([true, true, true, true, false]); // 5基目は置けない
    expect(me.credits).toBe(3000 - 4 * m.cfg.TURRETS.mg.COST);
    // 近すぎる場所・遠すぎる場所
    expect(m.placeCheck(pid, 'mg', v3(12.5, 0, 4.5)).ok).toBe(false);
    const id = [...m.turrets.values()].find((t) => t.ownerId === pid)!.id;
    expect(m.trySell(pid, id)).toBe(true);
    expect(me.credits).toBe(3000 - 3 * m.cfg.TURRETS.mg.COST - m.cfg.TURRETS.mg.COST * m.cfg.SELL_REFUND);
    expect(m.turretCount(pid)).toBe(3);
  });

  it('機銃タレットは近づいた敵を撃って倒し、置いた人にクレジットが入る', () => {
    const m = makeMatch({ quiet: true });
    toPrep(m);
    const pid = m.player!.id;
    const me = m.participantOf(pid)!;
    m.player!.movement.pos = v3(0, 0, 20);
    expect(m.tryPlace(pid, 'mg', v3(0, 0, 16))).toBe(true);
    const before = me.credits;
    const e = m.spawnEnemy('grunt', 'front')!;
    e.movement.pos = v3(0, 0.05, 30);
    for (let t = 0; t < 60 * 15 && !e.dead; t++) m.step(emptyCommand(m.sim.tick + 1));
    expect(e.dead).toBe(true);
    expect(me.turretKills).toBe(1);
    expect(me.credits).toBe(before + m.cfg.ENEMIES.grunt.REWARD);
  });

  it('タレットは装甲で銃弾のダメージを減らす', () => {
    const m = makeMatch({ quiet: true });
    toPrep(m);
    const pid = m.player!.id;
    m.player!.movement.pos = v3(0, 0, 20);
    m.tryPlace(pid, 'mg', v3(0, 0, 16));
    const t = [...m.turrets.values()][0];
    const e = m.sim.entities.get(t.id)!;
    const enemy = m.spawnEnemy('grunt', 'front')!;
    m.sim.damageEntity(e, 100, v3(), 'shot', enemy.id);
    expect(e.maxHealth - e.health).toBeCloseTo(100 * m.cfg.TURRET_ARMOR, 5);
    m.sim.damageEntity(e, 100, v3(), 'grenade', enemy.id);
    expect(e.maxHealth - e.health).toBeCloseTo(100 * m.cfg.TURRET_ARMOR + 100, 5);
    expect(e.movement.height).toBeCloseTo(TURRET_HEIGHT, 3);
  });
});

describe('タワーディフェンス：敵', () => {
  it('重装兵の正面の盾は弾を止め、背中は弱点', () => {
    const a = { id: 1, team: 1, pos: v3(0, 0, 0), height: 2.25, body: HEAVY_BODY, yaw: 0 };
    // 正面（-Z）から胴を撃つ → 盾に止まる
    const front = rayVsActor(v3(-0.2, 1.0, -10), v3(0, 0, 1), 50, a);
    expect(front?.blocked).toBe(true);
    // 正面から頭（盾の上）→ 弱点
    const head = rayVsActor(v3(0, 1.96, -10), v3(0, 0, 1), 50, a);
    expect(head?.head).toBe(true);
    expect(head?.blocked).toBeFalsy();
    // 後ろ（+Z）から背中 → 弱点
    const back = rayVsActor(v3(0, 1.3, 10), v3(0, 0, -1), 50, a);
    expect(back?.head).toBe(true);
    expect(back?.blocked).toBeFalsy();
  });

  it('爆弾兵（高さ 0.8m のクモ型）：胴に当たり、正面の目が弱点。人の高さには当たらない', () => {
    const a = { id: 1, team: 1, pos: v3(0, 0, 0), height: 1.8, body: ASSAULT_BODY, yaw: 0 };
    const body = rayVsActor(v3(0, 0.45, 10), v3(0, 0, -1), 50, a);
    expect(body).not.toBeNull();
    expect(body?.head).toBeFalsy();
    const eye = rayVsActor(v3(0, 0.5, -10), v3(0, 0, 1), 50, a);
    expect(eye?.head).toBe(true);
    expect(rayVsActor(v3(0, 1.4, -10), v3(0, 0, 1), 50, a)).toBeNull();
  });

  it('第5・第10ウェーブには大型兵器が出る。ウェーブごとに侵入ルートがわかる', () => {
    expect(tdConfig.WAVES.length).toBe(10);
    tdConfig.WAVES.forEach((w, i) => {
      const boss = w.groups.some((g) => g.type === 'boss');
      expect(boss, `wave ${i + 1}`).toBe(i === 4 || i === 9);
    });
    const m = makeMatch({ quiet: true });
    toPrep(m);
    expect(m.waveRoutes()).toEqual(['front']);
  });
});

describe('タワーディフェンス：ダウンと蘇生', () => {
  it('倒されるとダウンし、味方が近くで E を 3 秒押し続けると蘇生する', () => {
    const m = makeMatch({ quiet: true });
    toPrep(m);
    const p = m.player!;
    const ally = m.sim.entities.get([...m.allies.keys()][0])!;
    ally.movement.pos = v3(p.movement.pos.x + 1.2, p.movement.pos.y, p.movement.pos.z);
    m.sim.damageEntity(ally, 999, p.movement.pos, 'shot', -1);
    expect(ally.dead).toBe(false);
    expect(ally.downed).toBeGreaterThan(0);
    const hold = { ...emptyCommand(0), interactHeld: true };
    let t = 0;
    for (; t < 60 * 5 && ally.downed > 0; t++) m.step({ ...hold, tick: m.sim.tick + 1 });
    expect(ally.downed).toBe(0);
    expect(t * TICK_DT).toBeGreaterThan(m.cfg.REVIVE_TIME - 0.1);
    expect(t * TICK_DT).toBeLessThan(m.cfg.REVIVE_TIME + 0.3);
    expect(ally.health).toBeCloseTo(ally.maxHealth * m.cfg.REVIVE_HEALTH, 3);
    expect(m.participantOf(p.id)!.revives).toBe(1);
  });

  it('蘇生されなければ 10 秒で倒れ、ダウンから 15 秒で要塞の中に復活する', () => {
    const m = makeMatch({ quiet: true });
    toPrep(m);
    const p = m.player!;
    p.movement.pos = v3(30, 0, 30);
    m.sim.damageEntity(p, 999, p.movement.pos, 'shot', -1);
    let deadAt = -1,
      backAt = -1;
    for (let t = 0; t < 60 * 20; t++) {
      m.step(emptyCommand(m.sim.tick + 1));
      if (deadAt < 0 && p.dead) deadAt = t * TICK_DT;
      if (deadAt >= 0 && !p.dead) {
        backAt = t * TICK_DT;
        break;
      }
    }
    expect(deadAt).toBeGreaterThan(m.cfg.DOWN_TIME - 0.2);
    expect(deadAt).toBeLessThan(m.cfg.DOWN_TIME + 0.2);
    expect(backAt).toBeGreaterThan(m.cfg.RESPAWN_TIME - 0.3);
    expect(backAt).toBeLessThan(m.cfg.RESPAWN_TIME + 0.5);
    const a = td.buildArea;
    expect(p.movement.pos.x).toBeGreaterThan(a.min.x);
    expect(p.movement.pos.x).toBeLessThan(a.max.x);
    expect(p.movement.pos.z).toBeGreaterThan(a.min.z);
    expect(p.movement.pos.z).toBeLessThan(a.max.z);
  });
});

describe('タワーディフェンス：味方ボット（人間の穴埋め・遊撃）', () => {
  it('指示を受けず、敵の来ている複数のルートへ手分けして向かう', () => {
    const m = makeMatch({ human: true, cfg: { INTRO_TIME: 1e9 } });
    (m as unknown as { phase: string }).phase = 'wave';
    // 左と右の入り口の近くに敵を置く（倒されないように）
    for (const r of ['left', 'right'] as const) {
      for (let i = 0; i < 3; i++) {
        const e = m.spawnEnemy('grunt', r)!;
        const g = m.route(r).gate;
        e.movement.pos = v3(g.x + i, g.y + 0.05, g.z);
        e.invuln = 1e9;
      }
    }
    const seen = new Set<string>();
    for (let t = 0; t < 60 * 8; t++) {
      m.step(emptyCommand(m.sim.tick + 1));
      if (t > 60 * 4) for (const b of m.allies.values()) if (b.focus) seen.add(b.focus);
    }
    expect(seen.has('left')).toBe(true);
    expect(seen.has('right')).toBe(true);
    expect('orderHold' in m).toBe(false);
  });

  it('準備時間に、人間と同じ決まりで、次に敵が来るルートへタレットを買って置き、準備完了にする', () => {
    const m = makeMatch({ human: true, cfg: { PREP_TIME: 60 } });
    toPrep(m);
    const routes = m.waveRoutes();
    for (let t = 0; t < 60 * 40; t++) m.step(emptyCommand(m.sim.tick + 1));
    const bots = [...m.participants.values()].filter((p) => !p.isPlayer);
    expect(bots.every((p) => p.ready)).toBe(true);
    const placed = [...m.turrets.values()].filter((t) => bots.some((b) => b.id === t.ownerId));
    expect(placed.length).toBeGreaterThan(0);
    // 置いた場所は、次のウェーブのルートの推奨設置ポイントのそば
    for (const t of placed) expect(routes.some((r) => m.route(r).turretPoints.some((p) => lenH(sub(p, t.pos)) < 5))).toBe(true);
    // 払ったクレジットは人間と同じ値段（タレット・強化・設置物・アーマー）
    for (const b of bots) {
      let spent = [...m.turrets.values()].filter((t) => t.ownerId === b.id).reduce((s, t) => s + m.cfg.TURRETS[t.type].COST + t.spent, 0);
      spent += [...m.devices.values()].filter((d) => d.ownerId === b.id).reduce((s, d) => s + m.cfg.ITEMS[d.type].COST, 0);
      if (b.armorWave === m.wave) spent += m.cfg.ITEMS.armor.COST;
      expect(b.credits).toBe(m.cfg.START_CREDITS - spent);
    }
  });
});

describe('タワーディフェンス：試合', () => {
  it('全員が準備完了なら準備時間を飛ばしてウェーブが始まり、守りきるとボーナス', () => {
    const m = makeMatch({ quiet: true, human: true });
    toPrep(m);
    for (const p of m.participants.values()) m.setReady(p.id);
    m.step(emptyCommand(m.sim.tick + 1));
    expect(m.phase).toBe('wave');
    // 敵を全部すぐ倒す
    const me = m.participantOf(m.player!.id)!;
    const c0 = me.credits;
    let cleared = false;
    for (let t = 0; t < 60 * 120 && !cleared; t++) {
      for (const r of m.enemies.values()) {
        const e = m.sim.entities.get(r.id);
        if (e && !e.dead) m.sim.damageEntity(e, 9999, e.movement.pos, 'shot', -1);
      }
      m.step(emptyCommand(m.sim.tick + 1));
      if (m.events.some((e) => e.type === 'waveClear')) cleared = true;
    }
    expect(cleared).toBe(true);
    expect(m.phase).toBe('prep');
    expect(m.wave).toBe(2);
    expect(me.credits).toBe(c0 + m.cfg.WAVE_BONUS);
  }, 60_000);

  it('コアが壊れると負け', () => {
    const m = makeMatch({ quiet: true });
    toPrep(m);
    for (const p of m.participants.values()) m.setReady(p.id);
    m.step(emptyCommand(m.sim.tick + 1));
    m.sim.damageEntity(m.core, 1e6, td.core, 'shot', -1);
    for (let t = 0; t < 10; t++) m.step(emptyCommand(m.sim.tick + 1));
    expect(m.phase).toBe('defeat');
    expect(m.result?.victory).toBe(false);
    expect(m.result?.wavesCleared).toBe(0);
  });

  it('ボットだけの4人チームで、10 ウェーブを最後まで遊べる（易しい）', () => {
    const m = makeMatch({ human: false, difficulty: 'easy', seed: 3 });
    let t = 0;
    for (; t < 60 * 60 * 25 && !m.finished; t++) m.step(null);
    expect(m.finished).toBe(true);
    expect(m.result!.victory).toBe(true);
    expect(m.result!.wavesCleared).toBe(10);
    expect(m.stuckRemoved).toBe(0);
    // ボットもクレジット・タレット・蘇生の決まりを使う
    const parts = [...m.participants.values()];
    expect(parts.reduce((s, p) => s + p.turretsBuilt, 0)).toBeGreaterThan(4);
    expect(parts.every((p) => p.earned > 0)).toBe(true);
  }, 600_000);
});
