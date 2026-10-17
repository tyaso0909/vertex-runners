// 公開ページ用（npm run build:artifact）：公開するときに外側の <!doctype>・<html>・<head>・<body> が付けられるので、
// それらを外して中身だけにする（<title>・スタイル・スクリプト・画面の HTML）
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';

const dir = 'dist-artifact';
const path = `${dir}/index.html`;
let html = readFileSync(path, 'utf8');
// 公開ページは .glb を置けないので、3D モデルは base64 の文字のファイル（*.glb.txt）にする（client/assets.ts の loadGltfFrom が読む）
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.glb')) continue;
  writeFileSync(`${dir}/${f}.txt`, readFileSync(`${dir}/${f}`).toString('base64'));
  unlinkSync(`${dir}/${f}`);
  const n = html.split(f).length - 1;
  if (n === 0) throw new Error(`${f} がページの中で見つからない`);
  html = html.split(f).join(`${f}.txt`);
}
const head = /<head>([\s\S]*?)<\/head>/i.exec(html);
const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
if (!head || !body) throw new Error('index.html の head / body が見つからない');
// 文字コードと画面の幅の meta は外側に付くので外す。<title> は先頭に置く（公開ページの名前になる）
let h = head[1].replace(/<meta\s+charset[^>]*>/i, '').replace(/<meta\s+name="viewport"[^>]*>/i, '');
const title = /<title>[\s\S]*?<\/title>/i.exec(h);
if (title) h = h.replace(title[0], '');
const out = `${title ? title[0] : '<title>VERTEX RUNNERS</title>'}\n${h.trim()}\n${body[1].trim()}\n`;
writeFileSync(path, out);
console.log(`公開ページ用に書き直した: ${path}（${(out.length / 1024).toFixed(0)} KB）`);
