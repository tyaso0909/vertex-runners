/** キャラクターの顔の絵（イラストから顔のまわりを切り抜いたもの。client/assets/portraits/。作り方は assets-src/portraits/crop_portraits.py） */
import type { CharacterId } from '../../config';
import meiaImg from '../assets/portraits/meia.jpg?url';
import pearlImg from '../assets/portraits/pearl.jpg?url';
import mirandaImg from '../assets/portraits/miranda.jpg?url';
import soraImg from '../assets/portraits/sora.jpg?url';
import alexImg from '../assets/portraits/alex.jpg?url';
import ranmaruImg from '../assets/portraits/ranmaru.jpg?url';

export const PORTRAITS: Record<CharacterId, string> = {
  meia: meiaImg,
  pearl: pearlImg,
  miranda: mirandaImg,
  sora: soraImg,
  alex: alexImg,
  ranmaru: ranmaruImg,
};
