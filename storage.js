import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');

const CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
const API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();

// 三个变量都配了才走云端，否则退回本地 uploads/（本地开发用）
export const IS_CLOUD_IMAGES = Boolean(CLOUD_NAME && API_KEY && API_SECRET);

if (!IS_CLOUD_IMAGES) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 只看文件头，不信任客户端声明的 Content-Type
export function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { ext: '.gif', mime: 'image/gif' };
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

function cloudinarySignature(params, secret) {
  const toSign = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + secret).digest('hex');
}

async function uploadToCloudinary(buffer, mime) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder: 'xianghe-wall', timestamp };

  const form = new FormData();
  form.append('file', `data:${mime};base64,${buffer.toString('base64')}`);
  form.append('api_key', API_KEY);
  form.append('folder', params.folder);
  form.append('timestamp', String(timestamp));
  form.append('signature', cloudinarySignature(params, API_SECRET));

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20000)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.secure_url) {
    throw new Error(data?.error?.message || '图片上传失败，请稍后再试');
  }
  return { url: data.secure_url, key: data.public_id };
}

/**
 * 保存一张图片，返回 { url, key }：
 * - 云端：url 是 Cloudinary 地址，key 是 public_id（删除时用）
 * - 本地：url 是 /uploads/xxx，key 是文件名
 */
export async function saveImage(buffer) {
  const kind = detectImage(buffer);
  if (!kind) throw new Error('图片格式不正确，请上传 JPG / PNG / WEBP / GIF');

  if (IS_CLOUD_IMAGES) {
    return uploadToCloudinary(buffer, kind.mime);
  }

  const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + kind.ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return { url: '/uploads/' + name, key: name };
}

/** 删除图片；失败不影响主流程 */
export async function deleteImage(key) {
  if (!key) return;

  if (!IS_CLOUD_IMAGES) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(key)), () => {});
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: key, timestamp };

  const form = new FormData();
  form.append('public_id', key);
  form.append('api_key', API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('signature', cloudinarySignature(params, API_SECRET));

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/destroy`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('云端图片删除失败');
}
