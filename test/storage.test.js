import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 先把数据目录指到临时目录，再加载 storage（它在模块加载时就会建目录）
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xh-storage-'));
const { detectImage, saveImage } = await import('../storage.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0, 0, 0, 1]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'latin1'),
  Buffer.alloc(8)
]);

test('图片类型靠魔数识别，不看扩展名', () => {
  assert.deepEqual(detectImage(PNG), { ext: '.png', mime: 'image/png' });
  assert.deepEqual(detectImage(JPG), { ext: '.jpg', mime: 'image/jpeg' });
  assert.deepEqual(detectImage(GIF), { ext: '.gif', mime: 'image/gif' });
  assert.deepEqual(detectImage(WEBP), { ext: '.webp', mime: 'image/webp' });
});

test('伪装的文本/脚本不会被当成图片', () => {
  assert.equal(detectImage(Buffer.from('<?php echo 1; ?>')), null);
  assert.equal(detectImage(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(detectImage(Buffer.from('GIF')), null, '太短的文件直接拒绝');
  assert.equal(detectImage(null), null);
});

test('未配置 Cloudinary 时回退到本地存储', async () => {
  const saved = await saveImage(PNG);
  assert.match(saved.url, /^\/uploads\/[0-9]+-[0-9a-f]+\.png$/);
  assert.ok(saved.key.endsWith('.png'));
  assert.equal(typeof saved.key, 'string');
});

test('非法内容在保存阶段直接报错', async () => {
  await assert.rejects(() => saveImage(Buffer.from('not an image at all')), /图片格式不正确/);
});
