// scripts/gen-mc-skin.mjs
// 生成 MC 内置皮肤（64×64 PNG：玩家 default-skin / 猫 default-cat / 狗 default-dog，
// 标准 64×64 皮肤 UV 布局，猫/狗 UV 与 src/mc/model.ts 的 CAT/DOG_MODEL 对齐）。
// 无第三方依赖：手写 PNG 编码（IHDR/IDAT/IEND，zlib 用 node 内置）。
// 用法：node scripts/gen-mc-skin.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const W = 64;
const H = 64;

// —— 通用机制：每张皮肤独立像素缓冲（初始全透明） ——

/** 新建 64×64 RGBA 全透明像素缓冲。 */
function newSkin() {
  return new Uint8Array(W * H * 4);
}

/** 在指定缓冲上作画的 fillRect。 */
function painter(px) {
  return function fillRect(x, y, w, h, [r, g, b, a = 255]) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = ((y + j) * W + x + i) * 4;
        px[k] = r; px[k + 1] = g; px[k + 2] = b; px[k + 3] = a;
      }
    }
  };
}

function drawSteve(p) {
  // —— Steve 风格调色板（RGB）——
  const HAIR = [58, 42, 26];
  const SKIN = [198, 134, 66];
  const SKIN_D = [161, 102, 47];
  const EYE_W = [240, 240, 240];
  const EYE = [70, 52, 150];
  const MOUTH = [110, 66, 40];
  const SHIRT = [0, 168, 168];
  const SHIRT_D = [0, 140, 140];
  const PANTS = [60, 68, 170];
  const PANTS_D = [48, 55, 140];
  const SHOE = [72, 58, 50];

  // —— 头（贴图区 y 0-16）——
  p(8, 0, 8, 8, HAIR);            // 头顶
  p(16, 0, 8, 8, SKIN_D);         // 头底
  p(0, 8, 8, 8, HAIR);            // 右侧：上半头发下半脸
  p(0, 10, 8, 6, SKIN);
  p(16, 8, 8, 8, HAIR);           // 左侧
  p(16, 10, 8, 6, SKIN);
  p(24, 8, 8, 8, HAIR);           // 后脑勺
  p(24, 10, 8, 6, SKIN);
  // 正脸（8,8 起 8×8）：发型 2 行 + 脸 + 眼 + 鼻 + 嘴
  p(8, 8, 8, 8, SKIN);
  p(8, 8, 8, 2, HAIR);
  p(8, 9, 1, 1, HAIR);            // 鬓角
  p(15, 9, 1, 1, HAIR);
  p(10, 12, 1, 1, EYE_W);         // 眼（白+瞳，M2 会被程序化眼型覆盖）
  p(11, 12, 1, 1, EYE);
  p(13, 12, 1, 1, EYE);
  p(14, 12, 1, 1, EYE_W);
  p(11, 13, 2, 1, SKIN_D);        // 鼻
  p(11, 14, 2, 1, MOUTH);         // 嘴

  // —— 躯干（贴图区 y 16-40）——
  p(20, 16, 8, 4, SKIN);          // 顶：颈部
  p(24, 16, 4, 4, SHIRT);
  p(28, 16, 8, 4, SHIRT_D);       // 底
  p(20, 20, 8, 12, SHIRT);        // 正面
  p(32, 20, 8, 12, SHIRT);        // 背面
  p(16, 20, 4, 12, SHIRT_D);      // 右侧
  p(28, 20, 4, 12, SHIRT_D);      // 左侧
  // 躯干 overlay（jacket 区，16,32 起）：留空（alpha=0），验证空面跳过路径

  // —— 右臂（贴图区 40,16 起 16×16）——
  p(44, 16, 4, 4, SKIN);          // 顶（肩）
  p(48, 16, 4, 4, SKIN_D);        // 底（手）
  p(40, 20, 4, 12, SKIN);         // 外侧（观察者可见面）
  p(44, 20, 4, 12, SKIN);         // 正面
  p(48, 20, 4, 12, SKIN_D);       // 内侧
  p(52, 20, 4, 12, SKIN);         // 背面
  p(44, 28, 4, 4, SKIN_D);        // 手部阴影（正面下段）

  // —— 左臂（64×64 专属区 32,48 起 16×16）——
  p(36, 48, 4, 4, SKIN);
  p(40, 48, 4, 4, SKIN_D);
  p(32, 52, 4, 12, SKIN_D);       // 外侧
  p(36, 52, 4, 12, SKIN);         // 正面
  p(40, 52, 4, 12, SKIN);         // 内侧（观察者可见面）
  p(44, 52, 4, 12, SKIN);         // 背面
  p(36, 60, 4, 4, SKIN_D);

  // —— 右腿（贴图区 0,16 起 16×16）——
  p(4, 16, 4, 4, PANTS);          // 顶
  p(8, 16, 4, 4, SHOE);           // 底（脚掌）
  p(0, 20, 4, 12, PANTS_D);       // 外侧（观察者可见面）
  p(4, 20, 4, 12, PANTS);         // 正面
  p(8, 20, 4, 12, PANTS_D);       // 内侧
  p(12, 20, 4, 12, PANTS);        // 背面
  p(0, 29, 4, 3, SHOE);           // 鞋（各面下段）
  p(4, 29, 4, 3, SHOE);
  p(8, 29, 4, 3, SHOE);
  p(12, 29, 4, 3, SHOE);

  // —— 左腿（64×64 专属区 16,48 起 16×16）——
  p(20, 48, 4, 4, PANTS);
  p(24, 48, 4, 4, SHOE);
  p(16, 52, 4, 12, PANTS_D);      // 外侧
  p(20, 52, 4, 12, PANTS);        // 正面
  p(24, 52, 4, 12, PANTS_D);      // 内侧（观察者可见面）
  p(28, 52, 4, 12, PANTS);        // 背面
  p(16, 61, 4, 3, SHOE);
  p(20, 61, 4, 3, SHOE);
  p(24, 61, 4, 3, SHOE);
  p(28, 61, 4, 3, SHOE);
}

// —— 猫（橘猫）：UV 与 src/mc/model.ts 的 CAT_MODEL 对齐 ——
const FUR = [222, 148, 58];
const FUR_D = [190, 118, 40];
const BELLY = [244, 220, 186];
const PINK = [232, 150, 160];

function drawCat(p) {
  // 头：顶/侧/正脸（正脸 8,8 起 8×8，眼由程序化眼型覆盖）
  p(8, 0, 8, 8, FUR);           // 头顶
  p(10, 0, 1, 8, FUR_D);        // 头顶条纹（沿纵深）
  p(13, 0, 1, 8, FUR_D);
  p(0, 8, 8, 8, FUR);           // 头侧
  p(8, 8, 8, 8, FUR);           // 正脸
  p(9, 8, 1, 2, FUR_D);         // 额头三条纹
  p(12, 8, 1, 2, FUR_D);
  p(15, 8, 1, 2, FUR_D);
  p(11, 12, 2, 1, PINK);        // 鼻
  p(11, 14, 2, 1, FUR_D);       // 嘴
  // 躯干（front 4,16 8×6 / top 4,22 8×16 / left 12,16 16×6）
  p(4, 16, 8, 6, FUR);
  p(6, 17, 4, 5, BELLY);        // 正面胸腹
  p(4, 22, 8, 16, FUR);         // 背（长 16）
  for (let z = 2; z < 16; z += 4) p(4, 22 + z, 8, 2, FUR_D); // 背部虎斑
  p(12, 16, 16, 6, FUR);        // 侧面
  p(12, 22, 2, 6, FUR_D);       // 侧斑
  p(22, 22, 2, 6, FUR_D);
  // 腿（36/40/44/48：front 2×6 / left +2 / top 2×2；下段白袜）
  for (const sx of [36, 40, 44, 48]) {
    p(sx, 16, 2, 6, FUR_D);
    p(sx + 2, 16, 2, 6, FUR_D);
    p(sx, 22, 2, 2, FUR);
    p(sx, 20, 2, 2, BELLY);
    p(sx + 2, 20, 2, 2, BELLY);
  }
  // 耳（右 16,0 / 左 22,0：front/left/top 各 2×2，front 内点粉）
  p(16, 0, 2, 2, FUR); p(18, 0, 2, 2, FUR); p(20, 0, 2, 2, FUR_D);
  p(22, 0, 2, 2, FUR); p(24, 0, 2, 2, FUR); p(26, 0, 2, 2, FUR_D);
  p(17, 0, 1, 1, PINK); p(23, 0, 1, 1, PINK);
  // 尾（tail-1 16,4 / tail-2 22,4；尾尖深色）
  p(16, 4, 2, 2, FUR); p(18, 4, 2, 2, FUR); p(20, 4, 2, 2, FUR);
  p(22, 4, 2, 2, FUR_D); p(24, 4, 2, 2, FUR_D); p(26, 4, 2, 2, FUR_D);
}

// —— 狗（柴犬）：UV 与 DOG_MODEL 对齐（躯干长 20、无耳区） ——
const DFUR = [226, 192, 142];
const DFUR_D = [198, 162, 112];
const DCREAM = [246, 234, 214];
const DDARK = [92, 70, 52];

function drawDog(p) {
  p(8, 0, 8, 8, DFUR);          // 头顶
  p(0, 8, 8, 8, DFUR);          // 头侧
  p(8, 8, 8, 8, DFUR);          // 正脸
  p(8, 13, 8, 3, DCREAM);       // 白口鼻（下半）
  p(11, 11, 1, 1, DDARK);       // 眉点（柴犬标配）
  p(14, 11, 1, 1, DDARK);
  p(11, 13, 2, 1, DDARK);       // 鼻
  // 躯干（front 4,16 8×6 / top 4,22 8×20 / left 12,16 20×6）
  p(4, 16, 8, 6, DFUR);
  p(6, 17, 4, 5, DCREAM);       // 胸
  p(4, 22, 8, 20, DFUR);        // 背（长 20）
  p(4, 30, 8, 8, DDARK);        // 背鞍斑
  p(12, 16, 20, 6, DFUR);       // 侧面（长 20）
  p(12, 24, 8, 2, DDARK);       // 侧鞍延伸
  // 腿（同猫布局；白袜）
  for (const sx of [36, 40, 44, 48]) {
    p(sx, 16, 2, 6, DFUR_D);
    p(sx + 2, 16, 2, 6, DFUR_D);
    p(sx, 22, 2, 2, DFUR);
    p(sx, 20, 2, 2, DCREAM);
    p(sx + 2, 20, 2, 2, DCREAM);
  }
  // 尾（一节 16,4；尾尖白）
  p(16, 4, 2, 2, DFUR); p(18, 4, 2, 2, DFUR); p(20, 4, 2, 2, DCREAM);
}

/** RGBA 像素缓冲 → PNG 文件字节（8bit、无滤波、无隔行）。 */
function encodePng(px) {
  const CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (1 + W * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, draw] of [
  ["default-skin.png", drawSteve],
  ["default-cat.png", drawCat],
  ["default-dog.png", drawDog],
]) {
  const px = newSkin();
  draw(painter(px));
  const out = fileURLToPath(new URL(`../src/mc/assets/${name}`, import.meta.url));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, encodePng(px));
  console.log(`已生成 ${out}`);
}
