/**
 * サイトの照準（レティクル）を画面の中央に重ねて描く。エイムするとサイトの中心が画面の中央に来るので、
 * 照準はサイトのレンズの中に浮かんで見える。画面いっぱいのスコープ（狙撃用）は #scope で描く。
 */
import * as THREE from 'three';
import type { CustomWeaponDef } from '../../shared/weaponCustom';

/** 照準の形（SVG。200×200 の中に描く） */
const RETICLES: Record<string, string> = {
  dot: '<circle cx="100" cy="100" r="50" class="f"/>',
  holo: '<circle cx="100" cy="100" r="68" class="s" stroke-width="7"/><circle cx="100" cy="100" r="7" class="f"/>' +
    '<path d="M100 22v18M100 160v18M22 100h18M160 100h18" class="s" stroke-width="7"/>',
  chevron: '<path d="M64 136 100 100 136 136" class="s" stroke-width="8" stroke-linejoin="miter"/>' +
    '<path d="M8 100h46M146 100h46" class="s" stroke-width="5"/><circle cx="100" cy="100" r="3.5" class="f"/>',
  ranged: '<path d="M78 112 100 90 122 112" class="s" stroke-width="7"/><path d="M100 112v74" class="s" stroke-width="3.5"/>' +
    '<path d="M88 128h24M90 144h20M92 160h16M94 176h12" class="s" stroke-width="3.5"/><path d="M14 100h44M142 100h44" class="s" stroke-width="3"/>',
  threat: '<circle cx="100" cy="100" r="86" class="s" stroke-width="2.5"/><circle cx="100" cy="100" r="5" class="f"/>' +
    '<path d="M100 60v22M100 118v22M60 100h22M118 100h22" class="s" stroke-width="2.5"/>' +
    '<path d="M22 50v-24h24M178 50v-24h-24M22 150v24h24M178 150v24h-24" class="s" stroke-width="3"/>',
};

export class SightHud {
  private readonly el: HTMLElement;
  private readonly scopeEl: HTMLElement | null;
  private readonly zoomEl: HTMLElement;
  private shown = '';

  constructor(hud: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'sight-reticle';
    hud.appendChild(this.el);
    this.scopeEl = document.getElementById('scope');
    this.zoomEl = document.createElement('div');
    this.zoomEl.className = 'scope-zoom';
    this.scopeEl?.appendChild(this.zoomEl);
  }

  /** zoomMag：倍率を切り替えられるスコープの、いまの倍率（なければ 0） */
  update(w: CustomWeaponDef, ads: number, scoped: boolean, busy: boolean, zoomMag: number): void {
    const r = w.SIGHT_KIND === 'iron' || w.SIGHT_KIND === 'scope' ? 'none' : w.RETICLE;
    if (r !== this.shown) {
      this.shown = r;
      this.el.dataset.reticle = r;
      this.el.innerHTML = RETICLES[r] ? `<svg viewBox="0 0 200 200">${RETICLES[r]}</svg>` : '';
    }
    // のぞききる少し前から浮かび上がる
    const k = busy || scoped ? 0 : Math.max(0, Math.min(1, (ads - 0.72) / 0.22));
    this.el.style.opacity = k.toFixed(3);
    if (this.scopeEl) {
      this.scopeEl.dataset.reticle = w.RETICLE;
      this.zoomEl.textContent = zoomMag > 0 ? `${zoomMag.toFixed(0)}×　ホイールで切替` : '';
    }
  }
}

/** レーザーサイトの赤い点（世界に置く） */
export function makeLaserDot(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,240,1)');
  grad.addColorStop(0.18, 'rgba(255,60,70,0.95)');
  grad.addColorStop(0.5, 'rgba(255,30,50,0.25)');
  grad.addColorStop(1, 'rgba(255,0,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(2.2, 1.2, 1.2), transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
  const s = new THREE.Sprite(mat);
  s.visible = false;
  s.renderOrder = 10;
  return s;
}
