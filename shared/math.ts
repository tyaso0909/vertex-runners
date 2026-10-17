/**
 * ゲームロジック用の最小限のベクトル演算。
 * shared/ 以下は描画ライブラリ（three.js）に依存させない。将来サーバーでも同じコードを動かすため。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const set = (o: Vec3, x: number, y: number, z: number): Vec3 => {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
};
export const copy = (o: Vec3, a: Vec3): Vec3 => set(o, a.x, a.y, a.z);
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const lenH = (a: Vec3): number => Math.hypot(a.x, a.z);
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3();
};
/** 水平成分（y=0）だけを取り出す */
export const horiz = (a: Vec3): Vec3 => v3(a.x, 0, a.z);

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerpNum = (a: number, b: number, t: number): number => a + (b - a) * t;
export const moveTowards = (cur: number, target: number, maxDelta: number): number =>
  Math.abs(target - cur) <= maxDelta ? target : cur + Math.sign(target - cur) * maxDelta;
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
export const DEG = Math.PI / 180;

/** 水平ベクトル v を、目標 target に向けて最大 maxDelta だけ近づける */
export const moveTowardsVec = (v: Vec3, target: Vec3, maxDelta: number): Vec3 => {
  const d = sub(target, v);
  const l = len(d);
  if (l <= maxDelta || l < 1e-9) return clone(target);
  return addScaled(v, d, maxDelta / l);
};

/** 3x3 回転行列（行優先）。m[r*3+c] */
export type Mat3 = number[];

/** オイラー角（度、Y→X→Z の順。three.js の 'YXZ' と同じ）から回転行列を作る */
export const mat3FromEulerYXZ = (rxDeg: number, ryDeg: number, rzDeg: number): Mat3 => {
  const x = rxDeg * DEG,
    y = ryDeg * DEG,
    z = rzDeg * DEG;
  const a = Math.cos(x),
    b = Math.sin(x);
  const c = Math.cos(y),
    d = Math.sin(y);
  const e = Math.cos(z),
    f = Math.sin(z);
  // three.js Matrix4.makeRotationFromEuler の 'YXZ' と同じ式
  const ce = c * e,
    cf = c * f,
    de = d * e,
    df = d * f;
  return [
    ce + df * b, de * b - cf, a * d,
    a * f, a * e, -b,
    cf * b - de, df + ce * b, a * c,
  ];
};

export const mat3MulVec = (m: Mat3, v: Vec3): Vec3 =>
  v3(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z, m[6] * v.x + m[7] * v.y + m[8] * v.z);
/** 転置（回転行列なので逆行列と同じ）を掛ける */
export const mat3TMulVec = (m: Mat3, v: Vec3): Vec3 =>
  v3(m[0] * v.x + m[3] * v.y + m[6] * v.z, m[1] * v.x + m[4] * v.y + m[7] * v.z, m[2] * v.x + m[5] * v.y + m[8] * v.z);

/** 視点の向き（yaw）から、水平の前方向・右方向を得る。yaw=0 で -Z 方向を向く（three.js のカメラと同じ） */
export const forwardFromYaw = (yaw: number): Vec3 => v3(-Math.sin(yaw), 0, -Math.cos(yaw));
export const rightFromYaw = (yaw: number): Vec3 => v3(Math.cos(yaw), 0, -Math.sin(yaw));
/** 視線方向（yaw と pitch から）。pitch>0 で上を向く */
export const lookDir = (yaw: number, pitch: number): Vec3 =>
  v3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
