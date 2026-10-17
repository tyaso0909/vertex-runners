/**
 * 画面全体にかける効果（最後に重ねる。色は画面に出す値＝ sRGB で扱う）。
 * - フェイズシフト：準備中は紫のひび割れが走り、入ると色が反転して紫がかり、像がずれて揺らぐ
 * - オーバードライブ：画面の縁が青く脈打ち、縁の色がずれる（加速感）
 * - 光学迷彩：画面の縁が青緑にゆらぎ、少し色が薄くなる
 * - 被弾：縁が赤くにじむ（HUD の赤い縁と合わせて）
 * - 電撃（アークグレネード）：画面が青白くちらつき、横にずれるノイズの筋が走る
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const ScreenFxShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 16 / 9 },
    uPhase: { value: 0 },
    uWindup: { value: 0 },
    uOverdrive: { value: 0 },
    uCloak: { value: 0 },
    uHurt: { value: 0 },
    uShock: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect, uPhase, uWindup, uOverdrive, uCloak, uHurt, uShock;
    varying vec2 vUv;

    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453);
    }
    // ボロノイの境界（ひび割れの線）
    float cracks(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float d1 = 8.0, d2 = 8.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = hash2(i + g);
        float d = length(g + o - f);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      return d2 - d1;
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      c.x *= uAspect;
      float r = length(c);
      float edge = smoothstep(0.35, 0.95, r);

      // フェイズ中は画面がゆらぐ
      float ph = uPhase;
      uv += ph * 0.006 * vec2(sin(uv.y * 30.0 + uTime * 6.0), cos(uv.x * 24.0 + uTime * 5.0));
      // 電撃：横に走るずれの筋（ときどき大きく跳ねる）
      if (uShock > 0.0) {
        float band = floor(uv.y * 48.0 + floor(uTime * 24.0) * 7.0);
        float j = hash2(vec2(band, floor(uTime * 24.0))).x;
        uv.x += (j > 0.82 ? (j - 0.82) * 0.12 : 0.0) * uShock;
      }

      // 色のずれ（フェイズ・オーバードライブ・準備中）
      float ca = 0.004 * ph + 0.006 * uOverdrive * edge + 0.004 * uWindup;
      vec2 dir = normalize(c + 1e-5) * ca;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir).b;

      // --- フェイズシフト：反転して紫に寄せる ---
      if (ph > 0.0) {
        // 明るさを反転し、暗い紫〜明るい藤色の2色に写す（白くなりすぎないよう、反転した明るさを絞る）
        float l = 1.0 - dot(col, vec3(0.299, 0.587, 0.114));
        l = pow(clamp(l, 0.0, 1.0), 2.2) * 0.85;
        vec3 purple = mix(vec3(0.04, 0.0, 0.1), vec3(0.78, 0.6, 1.0), l);
        col = mix(col, purple, ph * 0.8);
        col += vec3(0.45, 0.2, 1.0) * edge * ph * 0.3;
      }
      // --- 準備中：紫のひび割れが画面の縁から広がる ---
      if (uWindup > 0.0) {
        vec2 q = c * 7.0 + vec2(uTime * 0.3, 0.0);
        float k = smoothstep(0.06, 0.0, cracks(q));
        // 縁から内側へ広がる（準備が進むほど内側まで）
        float reach = clamp((edge + 0.25 - (1.0 - uWindup * 1.2)) / max(0.05, uWindup * 1.2), 0.0, 1.0);
        col += vec3(0.75, 0.45, 1.0) * k * reach * uWindup * (0.6 + 0.4 * sin(uTime * 40.0));
        col = mix(col, col * vec3(0.8, 0.7, 1.1), uWindup * 0.5);
      }
      // --- オーバードライブ：青い縁 ---
      if (uOverdrive > 0.0) {
        float pulse = 0.6 + 0.4 * sin(uTime * 9.0);
        col += vec3(0.15, 0.4, 1.0) * edge * edge * uOverdrive * pulse * 0.7;
        col = mix(col, col * 1.08, uOverdrive * 0.3);
      }
      // --- 光学迷彩：青緑のゆらぎと、少しの色抜け ---
      if (uCloak > 0.0) {
        float g = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(g) * vec3(0.85, 1.05, 0.95), uCloak * 0.35);
        float scan = 0.5 + 0.5 * sin(vUv.y * 600.0 + uTime * 20.0);
        col += vec3(0.3, 0.9, 0.7) * edge * uCloak * (0.18 + 0.1 * scan);
      }
      // --- 電撃：青白いちらつきと細かいノイズ。縁に稲妻のような光 ---
      if (uShock > 0.0) {
        float n = hash2(floor(vUv * vec2(320.0, 180.0)) + floor(uTime * 30.0)).x;
        float flick = step(0.5, fract(sin(floor(uTime * 18.0) * 12.9898) * 43758.5)) * 0.5 + 0.5;
        float g = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(col, vec3(g) * vec3(0.75, 0.95, 1.15), uShock * 0.45);
        col += vec3(0.35, 0.8, 1.0) * (n - 0.5) * 0.16 * uShock;
        vec2 q = c * 9.0 + vec2(0.0, uTime * 2.0);
        float k = smoothstep(0.05, 0.0, cracks(q));
        col += vec3(0.6, 0.95, 1.0) * k * edge * edge * uShock * flick * 0.45;
      }
      // --- 被弾：赤くにじむ ---
      col = mix(col, vec3(0.6, 0.0, 0.05), edge * uHurt * 0.45);

      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class ScreenFx {
  readonly pass: ShaderPass;

  constructor() {
    this.pass = new ShaderPass(ScreenFxShader);
  }

  set(values: { phase: number; windup: number; overdrive: number; cloak: number; hurt: number; shock?: number }, dt: number, aspect: number): void {
    const u = this.pass.uniforms as typeof ScreenFxShader.uniforms;
    // ほとんど 0 の値は 0 にする（少しずつ減る値がいつまでも残らないように）
    const z = (x: number) => (x < 0.003 ? 0 : x);
    values = { phase: z(values.phase), windup: z(values.windup), overdrive: z(values.overdrive), cloak: z(values.cloak), hurt: z(values.hurt), shock: z(values.shock ?? 0) };
    u.uTime.value += dt;
    u.uAspect.value = aspect;
    u.uPhase.value = values.phase;
    u.uWindup.value = values.windup;
    u.uOverdrive.value = values.overdrive;
    u.uCloak.value = values.cloak;
    u.uHurt.value = values.hurt;
    u.uShock.value = values.shock ?? 0;
    // 何も効いていなければ処理を省く
    this.pass.enabled = values.phase + values.windup + values.overdrive + values.cloak + values.hurt + (values.shock ?? 0) > 0.001;
  }
}
