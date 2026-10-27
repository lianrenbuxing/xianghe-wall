// 部署前自检：Turso 能不能连、Cloudinary 能不能用、参数有没有填全
// 用法：npm run verify
import '../env.js';
import { createClient } from '@libsql/client/web';

const ok = msg => console.log('  \x1b[32m✓\x1b[0m ' + msg);
const bad = msg => console.log('  \x1b[31m✗\x1b[0m ' + msg);
const warn = msg => console.log('  \x1b[33m!\x1b[0m ' + msg);
const title = msg => console.log('\n' + msg);

const env = process.env;
let failed = false;

const has = key => Boolean((env[key] || '').trim());
const mask = value => {
  const v = (value || '').trim();
  if (!v) return '(空)';
  if (v.length <= 8) return v[0] + '***';
  return v.slice(0, 4) + '***' + v.slice(-4);
};

// ---------- 1. 变量是否齐全 ----------
title('1) 环境变量');
const required = [
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET'
];

for (const key of required) {
  if (has(key)) ok(`${key} = ${mask(env[key])}`);
  else { bad(`${key} 没有配置`); failed = true; }
}

if (has('ADMIN_PASSWORD')) {
  if (env.ADMIN_PASSWORD === 'yunian2011603') warn('ADMIN_PASSWORD 还是默认值，上线前务必改掉');
  else ok('ADMIN_PASSWORD 已自定义');
} else {
  warn('ADMIN_PASSWORD 未设置，将使用公开的默认密码');
}

if (has('SECRET')) ok('SECRET 已设置');
else warn('SECRET 未设置：线上每次重启都会让管理员登录态失效（不影响数据）');

if (!has('TURSO_DATABASE_URL')) {
  console.log('\n提示：没有 TURSO_DATABASE_URL 时网站会用本地 SQLite，数据在 Render 上会丢。');
}

// ---------- 2. Turso 连通性 ----------
if (has('TURSO_DATABASE_URL')) {
  title('2) Turso 数据库');
  try {
    const client = createClient({
      url: env.TURSO_DATABASE_URL.trim(),
      authToken: env.TURSO_AUTH_TOKEN?.trim()
    });

    const ping = await client.execute('SELECT 1 AS ok');
    if (ping.rows[0]?.ok === 1) ok('连接成功');

    const url = env.TURSO_DATABASE_URL.trim();
    if (!/^libsql:\/\//.test(url) && !/^https:\/\//.test(url)) {
      warn(`地址看起来不太对，通常以 libsql:// 开头，当前是 ${url.slice(0, 12)}…`);
    }

    for (const table of ['posts', 'comments', 'thanks']) {
      const res = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [table]
      });
      if (res.rows.length) ok(`表 ${table} 已存在`);
      else warn(`表 ${table} 还不存在（首次启动会自动创建，属于正常）`);
    }

    client.close();
  } catch (err) {
    bad('连接失败：' + (err?.message || err));
    console.log('    常见原因：令牌复制不全 / 令牌已删除 / 数据库地址多了空格');
    failed = true;
  }
}

// ---------- 3. Cloudinary 连通性 ----------
if (has('CLOUDINARY_CLOUD_NAME') && has('CLOUDINARY_API_KEY') && has('CLOUDINARY_API_SECRET')) {
  title('3) Cloudinary 图床');
  try {
    const cloud = env.CLOUDINARY_CLOUD_NAME.trim();
    const auth = Buffer
      .from(`${env.CLOUDINARY_API_KEY.trim()}:${env.CLOUDINARY_API_SECRET.trim()}`)
      .toString('base64');

    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/ping`, {
      headers: { Authorization: 'Basic ' + auth },
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.status === 'ok') {
      ok(`凭据有效（cloud: ${cloud}）`);
    } else {
      bad(`凭据无效：HTTP ${res.status} ${data?.error?.message || ''}`);
      console.log('    常见原因：API Secret 复制错 / 三个值不是同一个 cloud');
      failed = true;
    }
  } catch (err) {
    bad('请求失败：' + (err?.message || err));
    console.log('    可能是网络问题，稍后重试或换个网络');
    failed = true;
  }
}

// ---------- 总结 ----------
console.log('');
if (failed) {
  console.log('\x1b[31m自检未通过\x1b[0m，修好上面标 ✗ 的项再继续。');
  process.exit(1);
} else {
  console.log('\x1b[32m自检通过\x1b[0m，可以 npm start 跑起来，然后推到 GitHub / Render 了。');
}
