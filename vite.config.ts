import { dirname, resolve } from 'node:path';
import { type Plugin, defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:single`   ダブルクリックで開ける1ファイルの HTML（3D モデルも埋め込む。配布・確認用）
// `npm run build:artifact` claude.ai の公開ページ用。スクリプトと CSS は HTML に入れ、3D モデル・画像は横に置くファイルにする
//   （公開ページでは、埋め込んだデータ（data: URL）を fetch で読めないため）。マップは meshopt 圧縮なしの版を使う
/** マップのモデルを、meshopt 圧縮なしの版（*_plain.glb）に差し替える */
function plainMaps(): Plugin {
  return {
    name: 'plain-maps',
    enforce: 'pre',
    resolveId(source, importer) {
      const m = /^(.*\/maps\/)(neon_city|fortress)\.glb\?url$/.exec(source);
      if (!m || !importer) return null;
      return resolve(dirname(importer), `${m[1]}${m[2]}_plain.glb`) + '?url';
    },
  };
}

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  const artifact = mode === 'artifact';
  return {
    base: './',
    plugins: single ? [viteSingleFile()] : artifact ? [plainMaps(), viteSingleFile({ useRecommendedBuildConfig: false, removeViteModuleLoader: true })] : [],
    assetsInclude: ['**/*.glb'],
    build: {
      outDir: single ? 'dist-single' : artifact ? 'dist-artifact' : 'dist',
      assetsInlineLimit: single ? 100 * 1024 * 1024 : artifact ? 0 : 4096,
      // 公開ページ用：ファイルは全部ページと同じ場所に置く（HTML に入れたスクリプトから相対 URL で読む）
      assetsDir: artifact ? '' : 'assets',
      cssCodeSplit: artifact ? false : undefined,
      modulePreload: artifact ? false : undefined,
      chunkSizeWarningLimit: 2000,
    },
    test: {
      include: ['tests/**/*.test.ts'],
    },
  };
});
