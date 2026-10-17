import { describe, expect, it } from 'vitest';
import { AutoQuality } from '../client/quality';

describe('画質の自動調整', () => {
  it('遅いときだけ1段下げる。一瞬止まっただけでは下げない', () => {
    let lowered = 0;
    const aq = new AutoQuality(() => {
      lowered++;
      return true;
    }, 45);
    // 60fps で動いていて、途中で 0.5 秒止まった
    for (let i = 0; i < 400; i++) aq.sample(i === 200 ? 0.5 : 1 / 60);
    expect(lowered).toBe(0);
    // 30fps が続く
    for (let i = 0; i < 200; i++) aq.sample(1 / 30);
    expect(lowered).toBe(1);
  });
});
