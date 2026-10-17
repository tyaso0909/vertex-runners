/**
 * ボット用の経路（shared/nav.ts）を、確認のために画面に描く。
 * 点＝立てる場所、線＝移動できるつながり（白：歩く、黄：飛び降り、橙：跳び移り・よじ登り、桃：壁走り）
 */
import * as THREE from 'three';
import type { MovementConfig } from '../../config';
import type { LevelData } from '../../shared/level';
import { type NavGraph, buildNavGraph } from '../../shared/nav';

const COLORS: Record<string, THREE.Color> = {
  walk: new THREE.Color('#ffffff'),
  drop: new THREE.Color('#ffe14f'),
  jump: new THREE.Color('#ff9a3c'),
  wallrun: new THREE.Color('#ff3cf0'),
};

export class NavDebugView {
  readonly group = new THREE.Group();
  readonly graph: NavGraph;

  constructor(level: LevelData, cfg: MovementConfig) {
    this.graph = buildNavGraph(level, cfg);
    const g = this.graph;
    const lift = 0.15;
    // つながり
    const pos: number[] = [];
    const col: number[] = [];
    for (const l of g.links) {
      const a = g.nodes[l.a].pos;
      const b = g.nodes[l.b].pos;
      const c = COLORS[l.kind] ?? COLORS.walk;
      const k = l.kind === 'walk' ? 0.35 : 1.6;
      if (l.kind === 'wallrun' && l.via) {
        // 壁走りは、壁の点を通る折れ線にする
        const pts = [a, { x: l.via.x, y: l.via.y, z: l.via.z }, b];
        for (let i = 0; i < 2; i++) {
          pos.push(pts[i].x, pts[i].y + lift, pts[i].z, pts[i + 1].x, pts[i + 1].y + lift, pts[i + 1].z);
          col.push(c.r * k, c.g * k, c.b * k, c.r * k, c.g * k, c.b * k);
        }
        continue;
      }
      // 片道のつながりは、行き先側を明るくする
      pos.push(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z);
      col.push(c.r * k * 0.4, c.g * k * 0.4, c.b * k * 0.4, c.r * k, c.g * k, c.b * k);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false }));
    lines.frustumCulled = false;
    // 点
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(g.nodes.flatMap((n) => [n.pos.x, n.pos.y + lift, n.pos.z]), 3));
    const points = new THREE.Points(pg, new THREE.PointsMaterial({ color: new THREE.Color('#4fd1ff').multiplyScalar(1.5), size: 0.18, toneMapped: false }));
    points.frustumCulled = false;
    this.group.add(lines, points);
    this.group.visible = false;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    this.group.removeFromParent();
  }
}
