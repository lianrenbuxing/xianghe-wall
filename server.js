import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './env.js';

// 数据库与图片存储要在读取环境变量之后再加载
const { db, TAGS, ANON_NAMES, COLORS, randomPick, parseImages, mapPost, mapComment, mapThanks,
  seedIfEmpty, seedThanksIfEmpty, IS_REMOTE_DB } = await import('./db.js');
const { UPLOAD_DIR, IS_CLOUD_IMAGES, saveImage, deleteImage } = await import('./storage.js');

const { default: express } = await import('express');
const { default: multer } = await import('multer');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'yunian2011603';
const IS_PROD = process.env.NODE_ENV === 'production';

// 签名密钥：优先环境变量；否则落盘保存，重启后管理员登录态不会失效
function loadSecret() {
  if (process.env.SECRET) return process.env.SECRET;
  const dir = process.env.DATA_DIR || path.join(ROOT, 'data');
  const file = path.join(dir, '.secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {}
  return secret;
}
const SECRET = loadSecret();

await seedIfEmpty();
await seedThanksIfEmpty();

const app = express();
app.disable('x-powered-by');
// 只有反向代理后面才信任 X-Forwarded-For，否则限流可以伪造 IP 绕过
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
// 本地模式才会把图片存到 uploads；云端模式图片走 Cloudinary
if (!IS_CLOUD_IMAGES) {
  app.use('/uploads', express.static(UPLOAD_DIR, {
    maxAge: '7d',
    setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff')
  }));
}

const MIME_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png',  '.png'],
  ['image/webp', '.webp'],
  ['image/gif',  '.gif']
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    if (!MIME_EXT.has(file.mimetype)) return cb(new Error('只支持 JPG / PNG / WEBP / GIF 图片'));
    cb(null, true);
  }
});

// 异步路由统一包一层，Express 4 不会自动捕获 Promise 里的异常
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const buckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const k = key + ':' + (req.ip || 'unknown');
    const now = Date.now();
    const b = buckets.get(k);
    if (!b || now > b.reset) {
      buckets.set(k, { count: 1, reset: now + windowMs });
      return next();
    }
    if (b.count >= max) {
      const wait = Math.ceil((b.reset - now) / 1000);
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `操作太频繁啦，${wait} 秒后再试~` });
    }
    b.count++;
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

function adminOnly(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyToken(token)) return res.status(401).json({ error: '请先登录管理后台' });
  next();
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const toId = v => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// 内容被隐藏/删除后，把指向它的待处理举报一并结案
const closeReports = (type, id) => db.run(
  'UPDATE reports SET status = 1 WHERE status = 0 AND target_type = ? AND target_id = ?',
  [type, id]
);

// 只接受 http/https 链接，挡掉 javascript: 之类的注入
function safeHttpUrl(v) {
  const raw = clean(v, 300);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

// 致谢名单的统一校验：名字必填，链接必须是 http(s)，排序值限制在 ±999
function parseThanksBody(body) {
  const name = clean(body?.name, 20);
  if (!name) return { error: '名字不能为空' };

  const rawLink = clean(body?.link, 300);
  const link = safeHttpUrl(rawLink);
  if (rawLink && !link) return { error: '链接需要以 http:// 或 https:// 开头' };

  const sortRaw = Number(body?.sort);
  const sort = Number.isFinite(sortRaw) ? Math.min(Math.max(Math.trunc(sortRaw), -999), 999) : 0;

  return { name, note: clean(body?.note, 60), link, sort };
}

app.get('/api/posts', h(async (req, res) => {
  const tag    = clean(req.query.tag, 10);
  const q      = clean(req.query.q, 40);
  const sort   = req.query.sort === 'hot' ? 'hot' : 'new';
  const limit  = Math.min(Math.max(Number(req.query.limit) || 8, 1), 30);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = ['p.hidden = 0'];
  const args = [];
  if (TAGS.includes(tag)) { where.push('p.tag = ?'); args.push(tag); }
  if (q) {
    where.push('(p.text LIKE ? OR p.name LIKE ?)');
    args.push('%' + q + '%', '%' + q + '%');
  }
  const whereSql = where.join(' AND ');

  // 热度 = 点赞 + 3×评论数；再用 id 兜底，保证翻页时顺序稳定不重复
  const HOT_SQL = '(p.likes + 3 * (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.hidden = 0))';
  const orderSql = 'p.pinned DESC, ' + (sort === 'hot'
    ? `${HOT_SQL} DESC, p.created_at DESC, p.id DESC`
    : 'p.created_at DESC, p.id DESC');

  const rows = await db.all(`
    SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.hidden = 0) AS comment_count
    FROM posts p
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `, [...args, limit, offset]);

  const totalRow = await db.get(`SELECT COUNT(*) AS n FROM posts p WHERE ${whereSql}`, args);

  res.json({ total: totalRow.n, posts: rows.map(mapPost) });
}));

app.post('/api/posts',
  rateLimit({ windowMs: 60_000, max: 5, key: 'post' }),
  upload.array('images', 3),
  h(async (req, res) => {
    const text = clean(req.body.text, 500);
    if (!text) return res.status(400).json({ error: '先写点什么再发布吧～' });

    const tag  = TAGS.includes(req.body.tag) ? req.body.tag : '表白';
    const name = clean(req.body.name, 16) || randomPick(ANON_NAMES);
    const color = randomPick(COLORS);

    const saved = [];
    try {
      for (const file of req.files || []) {
        saved.push(await saveImage(file.buffer, file.mimetype));
      }

      const info = await db.run(
        'INSERT INTO posts (name,color,tag,text,images,created_at) VALUES (?,?,?,?,?,?)',
        [name, color, tag, text, JSON.stringify(saved), Date.now()]
      );
      const row = await db.get('SELECT * FROM posts WHERE id = ?', [info.lastInsertRowid]);
      res.json({ post: mapPost({ ...row, comment_count: 0 }) });
    } catch (e) {
      // 发布失败时把已经传上去的图片删掉，避免残留
      for (const img of saved) deleteImage(img.key).catch(() => {});
      res.status(400).json({ error: e.message || '发布失败，请稍后再试' });
    }
  }));

app.post('/api/posts/:id/like',
  rateLimit({ windowMs: 60_000, max: 90, key: 'like' }),
  h(async (req, res) => {
    const id = toId(req.params.id);
    const delta = req.body?.delta === -1 ? -1 : 1;
    if (!id) return res.status(400).json({ error: '参数有误' });

    const info = await db.run(
      'UPDATE posts SET likes = MAX(0, likes + ?) WHERE id = ? AND hidden = 0',
      [delta, id]
    );
    if (!info.changes) return res.status(404).json({ error: '这条表白不见了' });

    const row = await db.get('SELECT likes FROM posts WHERE id = ?', [id]);
    res.json({ likes: row.likes });
  }));

app.get('/api/posts/:id/comments', h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  const rows = await db.all(
    'SELECT * FROM comments WHERE post_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 200',
    [id]
  );
  res.json({ comments: rows.map(mapComment) });
}));

app.post('/api/posts/:id/comments',
  rateLimit({ windowMs: 60_000, max: 15, key: 'comment' }),
  h(async (req, res) => {
    const id = toId(req.params.id);
    const text = clean(req.body?.text, 120);
    if (!id) return res.status(400).json({ error: '参数有误' });
    if (!text) return res.status(400).json({ error: '回复内容不能为空' });

    const post = await db.get('SELECT id FROM posts WHERE id = ? AND hidden = 0', [id]);
    if (!post) return res.status(404).json({ error: '这条表白不见了' });

    const name = clean(req.body?.name, 16) || randomPick(ANON_NAMES);
    const info = await db.run(
      'INSERT INTO comments (post_id,name,text,created_at) VALUES (?,?,?,?)',
      [id, name, text, Date.now()]
    );
    const row = await db.get('SELECT * FROM comments WHERE id = ?', [info.lastInsertRowid]);
    res.json({ comment: mapComment(row) });
  }));

app.get('/api/stats', h(async (req, res) => {
  const posts = (await db.get('SELECT COUNT(*) AS n FROM posts WHERE hidden = 0')).n;
  const comments = (await db.get('SELECT COUNT(*) AS n FROM comments WHERE hidden = 0')).n;
  const likes = (await db.get('SELECT COALESCE(SUM(likes),0) AS n FROM posts WHERE hidden = 0')).n;
  res.json({ posts, comments, likes });
}));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    db: IS_REMOTE_DB ? 'turso' : 'sqlite',
    images: IS_CLOUD_IMAGES ? 'cloudinary' : 'local'
  });
});

// 公开：致谢名单（只返回未隐藏的，排序值大的靠前）
app.get('/api/thanks', h(async (req, res) => {
  const rows = await db.all('SELECT * FROM thanks WHERE hidden = 0 ORDER BY sort DESC, id ASC');
  res.json({ thanks: rows.map(mapThanks) });
}));

// ---------- 举报（前台提交） ----------

const REPORT_REASONS = ['广告', '辱骂', '隐私', '其它'];

// 举报一条帖子或评论：只记录，不自动下架，等管理员处理
app.post('/api/reports',
  rateLimit({ windowMs: 60_000, max: 10, key: 'report' }),
  h(async (req, res) => {
    const type = req.body?.target_type;
    if (type !== 'post' && type !== 'comment') return res.status(400).json({ error: '参数有误' });

    const id = toId(req.body?.target_id);
    if (!id) return res.status(400).json({ error: '参数有误' });

    const reason = REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : '其它';
    const detail = clean(req.body?.detail, 100);

    const table = type === 'post' ? 'posts' : 'comments';
    const target = await db.get(`SELECT id FROM ${table} WHERE id = ?`, [id]);
    if (!target) return res.status(404).json({ error: '这条内容已经不见了' });

    // 同一条内容 5 分钟内只记一次，避免有人狂点刷屏
    const dup = await db.get(
      'SELECT id FROM reports WHERE target_type = ? AND target_id = ? AND created_at > ?',
      [type, id, Date.now() - 5 * 60_000]
    );
    if (dup) return res.json({ ok: true, duplicated: true });

    await db.run(
      'INSERT INTO reports (target_type, target_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?)',
      [type, id, reason, detail, Date.now()]
    );
    res.json({ ok: true });
  }));

app.post('/api/admin/login',
  rateLimit({ windowMs: 10 * 60_000, max: 8, key: 'login' }),
  (req, res) => {
    const pass = String(req.body?.password ?? '');
    const ok = crypto.timingSafeEqual(sha256(pass), sha256(ADMIN_PASSWORD));
    if (!ok) return res.status(401).json({ error: '密码不对哦' });
    res.json({ token: sign({ role: 'admin', exp: Date.now() + 12 * 3600 * 1000 }) });
  });

app.get('/api/admin/posts', adminOnly, h(async (req, res) => {
  const rows = await db.all(`
    SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p ORDER BY p.created_at DESC LIMIT 300
  `);
  res.json({ posts: rows.map(mapPost) });
}));

app.post('/api/admin/posts/:id/hide', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  await db.run('UPDATE posts SET hidden = 1 - hidden WHERE id = ?', [id]);
  const row = await db.get('SELECT hidden FROM posts WHERE id = ?', [id]);
  if (row?.hidden) await closeReports('post', id);
  res.json({ hidden: !!row?.hidden });
}));

// 置顶 / 取消置顶
app.post('/api/admin/posts/:id/pin', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  await db.run('UPDATE posts SET pinned = 1 - pinned WHERE id = ?', [id]);
  const row = await db.get('SELECT pinned FROM posts WHERE id = ?', [id]);
  res.json({ pinned: !!row?.pinned });
}));

app.delete('/api/admin/posts/:id', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });

  const row = await db.get('SELECT images FROM posts WHERE id = ?', [id]);
  if (row) {
    for (const img of parseImages(row.images)) {
      await deleteImage(img.key).catch(() => {});
    }
  }
  // 评论没有外键级联，删帖时手动清理，避免留下孤儿评论
  await db.run(
    `UPDATE reports SET status = 1 WHERE status = 0 AND target_type = 'comment'
      AND target_id IN (SELECT id FROM comments WHERE post_id = ?)`, [id]
  );
  await closeReports('post', id);
  await db.run('DELETE FROM comments WHERE post_id = ?', [id]);
  await db.run('DELETE FROM posts WHERE id = ?', [id]);
  res.json({ ok: true });
}));

// ---------- 评论管理（后台） ----------

app.get('/api/admin/comments', adminOnly, h(async (req, res) => {
  const onlyHidden = req.query.filter === 'hidden';
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);

  const rows = await db.all(`
    SELECT c.*, p.name AS post_name, p.text AS post_text, p.hidden AS post_hidden
    FROM comments c LEFT JOIN posts p ON p.id = c.post_id
    ${onlyHidden ? 'WHERE c.hidden = 1' : ''}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ?
  `, [limit]);

  const total = (await db.get('SELECT COUNT(*) AS n FROM comments')).n;
  const hidden = (await db.get('SELECT COUNT(*) AS n FROM comments WHERE hidden = 1')).n;

  res.json({
    total,
    hidden,
    comments: rows.map(r => ({
      ...mapComment(r),
      post: {
        id: r.post_id,
        name: r.post_name || '',
        text: r.post_text || '',
        hidden: !!r.post_hidden
      }
    }))
  });
}));

// 隐藏 / 取消隐藏一条评论：只影响前台可见性和计数，数据保留
app.post('/api/admin/comments/:id/hide', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });

  const info = await db.run('UPDATE comments SET hidden = 1 - hidden WHERE id = ?', [id]);
  if (!info.changes) return res.status(404).json({ error: '这条评论不见了' });

  const row = await db.get('SELECT hidden FROM comments WHERE id = ?', [id]);
  if (row?.hidden) await closeReports('comment', id);
  res.json({ hidden: !!row?.hidden });
}));

app.delete('/api/admin/comments/:id', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  await closeReports('comment', id);
  await db.run('DELETE FROM comments WHERE id = ?', [id]);
  res.json({ ok: true });
}));

// ---------- 举报（后台处理） ----------

app.get('/api/admin/reports', adminOnly, h(async (req, res) => {
  const showAll = req.query.status === 'all';

  const rows = await db.all(`
    SELECT r.*,
           p.text AS post_text, p.name AS post_name, p.tag AS post_tag, p.hidden AS post_hidden,
           c.text AS comment_text, c.name AS comment_name, c.hidden AS comment_hidden, c.post_id AS comment_post_id,
           (SELECT COUNT(*) FROM reports r2
             WHERE r2.target_type = r.target_type AND r2.target_id = r.target_id AND r2.status = 0) AS pending_count
    FROM reports r
    LEFT JOIN posts p    ON r.target_type = 'post'    AND p.id = r.target_id
    LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
    ${showAll ? '' : 'WHERE r.status = 0'}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 300
  `);

  const total = (await db.get('SELECT COUNT(*) AS n FROM reports')).n;
  const pending = (await db.get('SELECT COUNT(*) AS n FROM reports WHERE status = 0')).n;

  res.json({
    total,
    pending,
    reports: rows.map(r => ({
      id: r.id,
      target_type: r.target_type,
      target_id: r.target_id,
      reason: r.reason,
      detail: r.detail,
      status: !!r.status,
      created_at: r.created_at,
      pending_count: r.pending_count,
      target: r.target_type === 'post'
        ? {
            id: r.target_id,
            text: r.post_text || '',
            name: r.post_name || '',
            tag: r.post_tag || '',
            hidden: !!r.post_hidden,
            exists: r.post_text !== null,
            post_id: null
          }
        : {
            id: r.target_id,
            text: r.comment_text || '',
            name: r.comment_name || '',
            tag: '',
            hidden: !!r.comment_hidden,
            exists: r.comment_text !== null,
            post_id: r.comment_post_id
          }
    }))
  });
}));

app.post('/api/admin/reports/:id/handle', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  const info = await db.run('UPDATE reports SET status = 1 WHERE id = ?', [id]);
  if (!info.changes) return res.status(404).json({ error: '这条举报不见了' });
  res.json({ ok: true });
}));

// ---------- 致谢名单（后台管理） ----------

app.get('/api/admin/thanks', adminOnly, h(async (req, res) => {
  const rows = await db.all('SELECT * FROM thanks ORDER BY sort DESC, id ASC');
  res.json({ thanks: rows.map(mapThanks) });
}));

app.post('/api/admin/thanks', adminOnly, upload.single('avatar'), h(async (req, res) => {
  const data = parseThanksBody(req.body);
  if (data.error) return res.status(400).json({ error: data.error });

  let avatarUrl = '';
  let avatarKey = '';
  if (req.file) {
    try {
      const saved = await saveImage(req.file.buffer);
      avatarUrl = saved.url;
      avatarKey = saved.key;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const info = await db.run(
    'INSERT INTO thanks (name,note,link,avatar,avatar_key,sort,created_at) VALUES (?,?,?,?,?,?,?)',
    [data.name, data.note, data.link, avatarUrl, avatarKey, data.sort, Date.now()]
  );
  const row = await db.get('SELECT * FROM thanks WHERE id = ?', [info.lastInsertRowid]);
  res.json({ item: mapThanks(row) });
}));

app.put('/api/admin/thanks/:id', adminOnly, upload.single('avatar'), h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });

  const data = parseThanksBody(req.body);
  if (data.error) return res.status(400).json({ error: data.error });

  const current = await db.get('SELECT avatar, avatar_key FROM thanks WHERE id = ?', [id]);
  if (!current) return res.status(404).json({ error: '这条致谢不存在' });

  let avatarUrl = current.avatar || '';
  let avatarKey = current.avatar_key || '';

  if (req.file) {
    try {
      const saved = await saveImage(req.file.buffer);
      if (avatarKey) await deleteImage(avatarKey).catch(() => {});
      avatarUrl = saved.url;
      avatarKey = saved.key;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } else if (String(req.body.removeAvatar) === '1' && avatarKey) {
    await deleteImage(avatarKey).catch(() => {});
    avatarUrl = '';
    avatarKey = '';
  }

  await db.run(
    'UPDATE thanks SET name=?, note=?, link=?, avatar=?, avatar_key=?, sort=? WHERE id=?',
    [data.name, data.note, data.link, avatarUrl, avatarKey, data.sort, id]
  );
  const row = await db.get('SELECT * FROM thanks WHERE id = ?', [id]);
  res.json({ item: mapThanks(row) });
}));

app.post('/api/admin/thanks/:id/hide', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  await db.run('UPDATE thanks SET hidden = 1 - hidden WHERE id = ?', [id]);
  const row = await db.get('SELECT hidden FROM thanks WHERE id = ?', [id]);
  res.json({ hidden: !!row?.hidden });
}));

app.delete('/api/admin/thanks/:id', adminOnly, h(async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });

  const row = await db.get('SELECT avatar_key FROM thanks WHERE id = ?', [id]);
  if (row?.avatar_key) await deleteImage(row.avatar_key).catch(() => {});

  await db.run('DELETE FROM thanks WHERE id = ?', [id]);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '单张图片不能超过 5MB' });
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')
    return res.status(400).json({ error: '最多上传 3 张照片' });
  if (IS_PROD) console.error(err);
  return res.status(400).json({ error: err.message || '请求出错了' });
});

const server = app.listen(PORT, () => {
  const addr = server.address();
  console.log(`\n💗 祥和表白墙已启动：http://localhost:${addr.port}`);
  console.log(`🔐 管理后台：http://localhost:${addr.port}/admin.html`);
  console.log(`🗄  数据库：${IS_REMOTE_DB ? 'Turso（云端）' : '本地 SQLite'}`);
  console.log(`🖼  图片：${IS_CLOUD_IMAGES ? 'Cloudinary' : '本地 uploads/'}`);
  if (ADMIN_PASSWORD === 'yunian2011603') {
    console.warn('⚠️  正在使用默认管理员密码，正式部署请设置环境变量 ADMIN_PASSWORD');
  }
  if (!IS_PROD) console.log(`   当前管理员密码：${ADMIN_PASSWORD}\n`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在关闭服务…`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
