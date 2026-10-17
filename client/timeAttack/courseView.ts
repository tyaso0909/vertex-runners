/**
 * タイムアタックのコースの見た目。
 * - コース用の足場・壁・ゲート（ホログラム）
 * - チェックポイントの目印（光の柱と床の輪）。次に通る所だけ明るく光らせる
 * - 次のチェックポイントの方向を指す、光る矢印（画面の少し下、目の前に浮かぶ）
 * - 動く的のレール
 */
import * as THREE from 'three';
import type { LevelData } from '../../shared/level';
import type { TimeAttackRun } from '../../shared/timeAttack';

const KIND_COLOR: Record<string, string> = { panel: '#4fd1ff', wall: '#ff4fd8', gate: '#ffb45c', platform: '#4fd1ff' };

/** ホログラムの質感：縁が明るく、面は半透明で横の走査線が流れる */
function holoMaterial(color: string, time: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: time },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vW;
      void main() {
        vUv = uv;
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vW;
      void main() {
        vec2 e = min(vUv, 1.0 - vUv);
        float edge = 1.0 - smoothstep(0.0, 0.035, min(e.x, e.y));
        float scan = 0.5 + 0.5 * sin(vW.y * 9.0 - uTime * 3.0);
        float grid = max(1.0 - smoothstep(0.0, 0.03, abs(fract(vW.x * 0.5 + vW.z * 0.5) - 0.5)), 0.0);
        float a = 0.12 + 0.1 * scan + 0.65 * edge + 0.08 * grid;
        gl_FragColor = vec4(uColor * (1.4 + 1.6 * edge), a);
      }`,
  });
}

interface Marker {
  group: THREE.Group;
  beam: THREE.Mesh;
  ring: THREE.Mesh;
  beamMat: THREE.MeshBasicMaterial;
  ringMat: THREE.MeshBasicMaterial;
  goal: boolean;
}

export class CourseView {
  readonly group = new THREE.Group();
  private readonly time = { value: 0 };
  private readonly markers: Marker[] = [];
  private readonly arrow: THREE.Mesh;
  private readonly arrowMat: THREE.MeshBasicMaterial;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(level: LevelData) {
    const course = level.course!;
    // コース用の足場・壁・ゲート
    for (const b of level.boxes) {
      if (b.tag !== 'course') continue;
      const kind = String(b.vis?.kind ?? 'wall');
      const mat = holoMaterial(KIND_COLOR[kind] ?? '#4fd1ff', this.time);
      const geo = new THREE.BoxGeometry(b.size.x, b.size.y, b.size.z);
      this.disposables.push(mat, geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.center.x, b.center.y, b.center.z);
      if (b.rot) mesh.rotation.set((b.rot.x * Math.PI) / 180, (b.rot.y * Math.PI) / 180, (b.rot.z * Math.PI) / 180, 'YXZ');
      mesh.renderOrder = 5;
      this.group.add(mesh);
      // 縁の線
      const eg = new THREE.EdgesGeometry(geo);
      const em = new THREE.LineBasicMaterial({ color: new THREE.Color(KIND_COLOR[kind] ?? '#4fd1ff').multiplyScalar(2.5), toneMapped: false });
      this.disposables.push(eg, em);
      const lines = new THREE.LineSegments(eg, em);
      lines.position.copy(mesh.position);
      lines.rotation.copy(mesh.rotation);
      this.group.add(lines);
    }

    // チェックポイントの目印
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true).translate(0, 0.5, 0);
    const ringGeo = new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2);
    this.disposables.push(beamGeo, ringGeo);
    const beamTex = (() => {
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 128;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.6, 'rgba(255,255,255,0.35)');
      grad.addColorStop(1, 'rgba(255,255,255,0.9)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 128);
      const t = new THREE.CanvasTexture(c);
      return t;
    })();
    this.disposables.push(beamTex);
    course.checkpoints.forEach((cp, i) => {
      const goal = i === course.checkpoints.length - 1;
      const color = new THREE.Color(goal ? '#ffd166' : '#4fd1ff');
      const r = cp.radius ?? 3.5;
      const beamMat = new THREE.MeshBasicMaterial({
        color: color.clone().multiplyScalar(2),
        map: beamTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const ringMat = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(3), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      this.disposables.push(beamMat, ringMat);
      const g = new THREE.Group();
      g.position.set(cp.pos.x, cp.pos.y + 0.03, cp.pos.z);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.scale.set(r * 0.9, goal ? 30 : 22, r * 0.9);
      beam.renderOrder = 6;
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.scale.setScalar(r);
      ring.renderOrder = 6;
      g.add(beam, ring);
      this.group.add(g);
      this.markers.push({ group: g, beam, ring, beamMat, ringMat, goal });
    });

    // 次のチェックポイントを指す矢印（山形）
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.42);
    shape.lineTo(0.36, -0.08);
    shape.lineTo(0.22, -0.08);
    shape.lineTo(0, 0.22);
    shape.lineTo(-0.22, -0.08);
    shape.lineTo(-0.36, -0.08);
    shape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    this.arrowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#4fd1ff').multiplyScalar(2.6),
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.disposables.push(arrowGeo, this.arrowMat);
    this.arrow = new THREE.Mesh(arrowGeo, this.arrowMat);
    this.arrow.renderOrder = 999;
    this.arrow.frustumCulled = false;
    this.group.add(this.arrow);

    // 動く的のレール
    const railMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4fd8').multiplyScalar(2), toneMapped: false });
    this.disposables.push(railMat);
    for (const t of course.targets) {
      if (!t.rail || !t.moveTo) continue;
      const a = new THREE.Vector3(t.pos.x, t.pos.y + 0.03, t.pos.z);
      const b = new THREE.Vector3(t.moveTo.x, t.moveTo.y + 0.03, t.moveTo.z);
      const len = a.distanceTo(b) + 1.0;
      const geo = new THREE.BoxGeometry(0.12, 0.04, len);
      this.disposables.push(geo);
      const rail = new THREE.Mesh(geo, railMat);
      rail.position.copy(a).add(b).multiplyScalar(0.5);
      rail.lookAt(b.x, rail.position.y, b.z);
      this.group.add(rail);
      for (const e of [a, b]) {
        const capGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.06, 12);
        this.disposables.push(capGeo);
        const cap = new THREE.Mesh(capGeo, railMat);
        cap.position.copy(e);
        this.group.add(cap);
      }
    }
  }

  /** run が null のときは目印をすべて出す（スタート前など） */
  update(dt: number, camera: THREE.Camera, run: TimeAttackRun | null): void {
    this.time.value += dt;
    const next = run ? run.next : 0;
    const pulse = 0.75 + 0.25 * Math.sin(this.time.value * 5);
    const cam = camera.getWorldPosition(new THREE.Vector3());
    this.markers.forEach((m, i) => {
      const passed = i < next;
      const isNext = i === next;
      m.group.visible = !passed;
      // 近くでは光の柱を薄くする（視界をふさがないように）
      const near = Math.min(1, Math.max(0.15, (Math.hypot(cam.x - m.group.position.x, cam.z - m.group.position.z) - 2) / 12));
      const k = (isNext ? pulse : 0.18) * near;
      m.beamMat.opacity = k;
      m.ringMat.opacity = isNext ? 0.9 : 0.25;
      m.ring.rotation.y += dt * (isNext ? 1.2 : 0.3);
      // 次の目印は少し大きく
      m.beam.scale.y = (m.goal ? 30 : 22) * (isNext ? 1 : 0.6);
    });

    // 矢印：目の前の少し下に浮かべ、次のチェックポイントの方を向ける
    const cp = run && run.phase !== 'finished' ? run.course.checkpoints[run.next] : null;
    this.arrow.visible = !!cp;
    if (cp) {
      const camPos = camera.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      this.arrow.position.copy(camPos).addScaledVector(fwd, 2.6).add(new THREE.Vector3(0, -0.85, 0));
      const to = new THREE.Vector3(cp.pos.x - this.arrow.position.x, 0, cp.pos.z - this.arrow.position.z);
      const yaw = Math.atan2(to.x, to.z);
      // 矢印の先（形の +Y を -Z に回したもの）を、向かう方へ
      this.arrow.rotation.set(0, yaw + Math.PI, 0);
      // 上下の差が大きいときは、少し上・下を向ける
      const dy = cp.pos.y - camPos.y + 1.6;
      const dist = Math.max(1, Math.hypot(to.x, to.z));
      this.arrow.rotateX(Math.max(-0.6, Math.min(0.6, Math.atan2(dy, dist))));
      this.arrowMat.opacity = 0.65 + 0.3 * pulse;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
