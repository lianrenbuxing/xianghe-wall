import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = 'test-password-123';

let child;
let base = '';
let dataDir = '';

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '0',
        DATA_DIR: dataDir,
        ADMIN_PASSWORD,
        SECRET: 'test-secret-'.repeat(4),
        NODE_ENV: 'test'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let buf = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + buf)), 20000);

    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      const m = buf.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve('http://127.0.0.1:' + m[1]);
      }
    });
    child.stderr.on('data', chunk => { buf += chunk.toString(); });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error('服务进程提前退出，code=' + code + '\n' + buf));
    });
  });
}

const api = async (p, options) => {
  const res = await fetch(base + '/api' + p, options);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const json = body => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// 只骗过魔数校验的最小 PNG 头
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0, 0, 0, 1]);
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function postForm(fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('images', new Blob([f.buf], { type: f.type }), f.name);
  return { method: 'POST', body: fd };
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'xh-wall-test-'));
  base = await startServer(dataDir);
});

after(() => {
  if (child && !child.killed) child.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('健康检查', async () => {
  const { status, data } = await api('/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.db, 'sqlite', '测试环境没有 TURSO_DATABASE_URL，应走本地库');
  assert.equal(data.images, 'local', '测试环境没有 Cloudinary 配置，应走本地存储');
});

test('列表接口返回种子数据', async () => {
  const { status, data } = await api('/posts');
  assert.equal(status, 200);
  assert.ok(data.total >= 2);
  assert.equal(data.posts.length, 2); // 默认 limit=8，种子只有 2 条
});

test('按标签和关键词筛选', async () => {
  const byTag = await api('/posts?tag=' + encodeURIComponent('表白'));
  assert.equal(byTag.status, 200);
  assert.ok(byTag.data.posts.every(p => p.tag === '表白'));

  const byQuery = await api('/posts?q=' + encodeURIComponent('图书馆'));
  assert.equal(byQuery.status, 200);
  assert.equal(byQuery.data.total, 1);
});

test('热门排序可用且按热度降序（回归：曾因 SQL 语法错误 400）', async () => {
  const { status, data } = await api('/posts?sort=hot');
  assert.equal(status, 200, 'sort=hot 不应该报错');
  assert.ok(data.posts.length >= 2);
  const scores = data.posts.map(p => p.likes);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i], '热度应递减');
});

test('翻页不重复、不遗漏', async () => {
  const all = await api('/posts?limit=30');
  const page1 = await api('/posts?limit=1&offset=0');
  const page2 = await api('/posts?limit=1&offset=1');
  assert.equal(page1.data.posts.length, 1);
  assert.equal(page2.data.posts.length, 1);
  assert.notEqual(page1.data.posts[0].id, page2.data.posts[0].id);
  assert.equal(page1.data.total, all.data.total);
});

test('发布表白（带图）并校验返回结构', async () => {
  const res = await fetch(base + '/api/posts', postForm(
    { text: '自动化测试表白', tag: '祝福', name: '测试机器人' },
    [{ buf: PNG_HEAD, type: 'image/png', name: 'a.png' }]
  ));
  assert.equal(res.status, 200);
  const { post } = await res.json();
  assert.equal(post.tag, '祝福');
  assert.equal(post.name, '测试机器人');
  assert.equal(post.images.length, 1);
  assert.match(post.images[0], /^\/uploads\/.+\.png$/);
  assert.equal(post.likes, 0);
  assert.equal(post.hidden, false);
});

test('空内容发布被拒绝', async () => {
  const res = await fetch(base + '/api/posts', postForm({ text: '   ', tag: '日常' }));
  assert.equal(res.status, 400);
});

test('伪装成图片的文件被拒绝', async () => {
  const res = await fetch(base + '/api/posts', postForm(
    { text: '假图片', tag: '日常' },
    [{ buf: Buffer.from('<?php echo 1; ?> this is not an image'), type: 'image/png', name: 'evil.png' }]
  ));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /图片格式/);
});

test('点赞递增，且不会减成负数', async () => {
  const { data: list } = await api('/posts?limit=1');
  const id = list.posts[0].id;

  const up = await api(`/posts/${id}/like`, json({ delta: 1 }));
  assert.equal(up.status, 200);

  const down = await api(`/posts/${id}/like`, json({ delta: -1 }));
  assert.equal(down.status, 200);
  assert.ok(down.data.likes >= 0);
});

test('评论发布与计数', async () => {
  const { data: list } = await api('/posts?limit=1');
  const id = list.posts[0].id;

  const created = await api(`/posts/${id}/comments`, json({ text: '测试评论' }));
  assert.equal(created.status, 200);
  assert.equal(created.data.comment.text, '测试评论');

  const { data } = await api(`/posts/${id}/comments`);
  assert.ok(data.comments.some(c => c.text === '测试评论'));

  const after = await api('/posts?limit=30');
  const target = after.data.posts.find(p => p.id === id);
  assert.ok(target.comment_count >= 1);
});

test('不存在的帖子返回 404', async () => {
  const like = await api('/posts/999999/like', json({ delta: 1 }));
  assert.equal(like.status, 404);
  const comment = await api('/posts/999999/comments', json({ text: 'hi' }));
  assert.equal(comment.status, 404);
});

test('管理后台鉴权：错误密码拒绝，正确密码签发 token', async () => {
  assert.equal((await api('/admin/posts')).status, 401);

  const bad = await api('/admin/login', json({ password: 'wrong-password' }));
  assert.equal(bad.status, 401);

  const good = await api('/admin/login', json({ password: ADMIN_PASSWORD }));
  assert.equal(good.status, 200);
  assert.ok(good.data.token);
});

test('管理后台：置顶 / 隐藏 / 删除', async () => {
  const login = await api('/admin/login', json({ password: ADMIN_PASSWORD }));
  const auth = { Authorization: 'Bearer ' + login.data.token };

  const created = await api('/posts', postForm({ text: '待管理的内容', tag: '日常' }));
  const id = created.data.post.id;

  const pin = await api(`/admin/posts/${id}/pin`, { method: 'POST', headers: auth });
  assert.equal(pin.data.pinned, true);

  const list = await api('/posts?limit=30');
  assert.equal(list.data.posts[0].id, id, '置顶内容应排在最前面');

  const hide = await api(`/admin/posts/${id}/hide`, { method: 'POST', headers: auth });
  assert.equal(hide.data.hidden, true);

  const afterHide = await api('/posts?limit=30');
  assert.ok(!afterHide.data.posts.some(p => p.id === id), '隐藏后前台不可见');

  const del = await api(`/admin/posts/${id}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);

  const afterDel = await api('/posts?limit=30');
  assert.ok(!afterDel.data.posts.some(p => p.id === id), '删除后彻底消失');
});

test('首页灯箱图片与管理入口是合法 HTML（回归）', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<img id="lightboxImg" alt="预览"\s*\/?>/, '灯箱必须存在 img 元素');
  assert.match(html, /href="\/admin\.html"/, '管理入口必须指向 /admin.html');
  assert.doesNotMatch(html, /< img/, '不能出现被空格拆坏的标签');
  assert.doesNotMatch(html, /<\/p\s+>/, '不能出现带空格的闭合标签');

  const admin = readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
  assert.doesNotMatch(admin, /< img src=/, '后台缩略图标签不能是坏的');
});

test('安全响应头已设置', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('上传目录中的图片可访问且带 nosniff', async () => {
  const { data } = await api('/posts?limit=30');
  const withImg = data.posts.find(p => p.images.length);
  assert.ok(withImg, '应存在带图帖子');

  const res = await fetch(base + withImg.images[0]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-type'), 'image/png');
});

// ---------- 致谢名单 ----------

test('致谢名单：公开接口返回种子条目', async () => {
  const { status, data } = await api('/thanks');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.thanks));
  assert.ok(data.thanks.length >= 2, '首次启动应有示例条目');
  assert.ok(data.thanks.every(t => !t.hidden));
  const sorts = data.thanks.map(t => t.sort);
  for (let i = 1; i < sorts.length; i++) assert.ok(sorts[i - 1] >= sorts[i], '排序值应递减');
});

test('致谢名单：后台新增 / 编辑 / 隐藏 / 删除', async () => {
  const login = await api('/admin/login', json({ password: ADMIN_PASSWORD }));
  const auth = {
    Authorization: 'Bearer ' + login.data.token,
    'Content-Type': 'application/json'
  };

  const created = await api('/admin/thanks', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: '测试同学', note: '一起测试', link: 'https://github.com/', sort: 5 })
  });
  assert.equal(created.status, 200);
  const id = created.data.item.id;
  assert.equal(created.data.item.link, 'https://github.com/');
  assert.equal(created.data.item.hidden, false);

  let pub = await api('/thanks');
  assert.ok(pub.data.thanks.some(t => t.id === id), '新增后公开接口可见');

  const updated = await api('/admin/thanks/' + id, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ name: '测试同学2', note: '改过了', link: '', sort: 7 })
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.item.name, '测试同学2');
  assert.equal(updated.data.item.link, '');
  assert.equal(updated.data.item.sort, 7);

  const hid = await api('/admin/thanks/' + id + '/hide', { method: 'POST', headers: auth });
  assert.equal(hid.data.hidden, true);
  pub = await api('/thanks');
  assert.ok(!pub.data.thanks.some(t => t.id === id), '隐藏后公开接口不可见');

  const del = await api('/admin/thanks/' + id, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);
  const admin = await api('/admin/thanks', { headers: auth });
  assert.ok(!admin.data.thanks.some(t => t.id === id), '删除后后台也消失');
});

test('致谢名单：非法链接、空名字、未登录都被拒绝', async () => {
  const login = await api('/admin/login', json({ password: ADMIN_PASSWORD }));
  const auth = {
    Authorization: 'Bearer ' + login.data.token,
    'Content-Type': 'application/json'
  };

  const badLink = await api('/admin/thanks', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: '坏人', link: 'javascript:alert(1)' })
  });
  assert.equal(badLink.status, 400, 'javascript: 链接必须被拒绝');

  const noName = await api('/admin/thanks', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: '   ', note: '没名字' })
  });
  assert.equal(noName.status, 400);

  assert.equal((await api('/admin/thanks')).status, 401, '未登录不能读后台名单');
});

test('致谢头像：上传、替换、移除', async () => {
  const login = await api('/admin/login', json({ password: ADMIN_PASSWORD }));
  const auth = { Authorization: 'Bearer ' + login.data.token };

  const fd = new FormData();
  fd.append('name', '头像测试');
  fd.append('note', '带头像');
  fd.append('sort', '50');
  fd.append('avatar', new Blob([PNG_HEAD], { type: 'image/png' }), 'avatar.png');

  const created = await api('/admin/thanks', { method: 'POST', headers: auth, body: fd });
  assert.equal(created.status, 200);
  const id = created.data.item.id;
  const firstAvatar = created.data.item.avatar;
  assert.match(firstAvatar, /^\/uploads\/.+\.png$/);

  // 公开接口能拿到头像
  const pub = await api('/thanks');
  assert.ok(pub.data.thanks.some(t => t.id === id && t.avatar === firstAvatar));

  // 头像文件可访问
  assert.equal((await fetch(base + firstAvatar)).status, 200);

  // 换成 jpg 头像
  const fd2 = new FormData();
  fd2.append('name', '头像测试');
  fd2.append('note', '换头像了');
  fd2.append('avatar', new Blob([JPG_HEAD], { type: 'image/jpeg' }), 'new.jpg');

  const updated = await api('/admin/thanks/' + id, { method: 'PUT', headers: auth, body: fd2 });
  assert.equal(updated.status, 200);
  assert.match(updated.data.item.avatar, /\.jpg$/);
  assert.notEqual(updated.data.item.avatar, firstAvatar);

  // 旧头像应当被删除
  assert.equal((await fetch(base + firstAvatar)).status, 404, '替换头像后旧文件应删除');

  // 移除头像
  const fd3 = new FormData();
  fd3.append('name', '头像测试');
  fd3.append('removeAvatar', '1');
  const removed = await api('/admin/thanks/' + id, { method: 'PUT', headers: auth, body: fd3 });
  assert.equal(removed.data.item.avatar, '');
  assert.equal((await fetch(base + updated.data.item.avatar)).status, 404, '移除后头像文件应删除');

  await api('/admin/thanks/' + id, { method: 'DELETE', headers: auth });
});

test('致谢头像：非图片文件被拒绝', async () => {
  const login = await api('/admin/login', json({ password: ADMIN_PASSWORD }));
  const auth = { Authorization: 'Bearer ' + login.data.token };

  const fd = new FormData();
  fd.append('name', '坏头像');
  fd.append('avatar', new Blob([Buffer.from('definitely not an image')], { type: 'image/png' }), 'evil.png');

  const res = await api('/admin/thanks', { method: 'POST', headers: auth, body: fd });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /图片格式/);
});

test('致谢页可以访问且结构正确', async () => {
  const res = await fetch(base + '/thanks.html');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="thanksList"/);
  assert.match(html, /\/thanks\.js/);
  assert.match(html, /href="\/"/);

  // 首页要有入口
  const home = await (await fetch(base + '/')).text();
  assert.match(home, /href="\/thanks\.html"/);
});

