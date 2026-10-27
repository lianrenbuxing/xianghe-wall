import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, db, TAGS, ANON_NAMES, COLORS,
  randomPick, mapPost, mapComment, seedIfEmpty
} from './db.js';

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'yunian2011603';
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

seedIfEmpty();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff')
}));

const MIME_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png',  '.png'],
  ['image/webp', '.webp'],
  ['image/gif',  '.gif']
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = MIME_EXT.get(file.mimetype) || '.jpg';
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    if (!MIME_EXT.has(file.mimetype)) return cb(new Error('只支持 JPG / PNG / WEBP / GIF 图片'));
    cb(null, true);
  }
});

const cleanupFiles = files => (files || []).forEach(f => fs.unlink(f.path, () => {}));

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

app.get('/api/posts', (req, res) => {
  const tag    = clean(req.query.tag, 10);
  const q      = clean(req.query.q, 40);
  const sort   = req.query.sort === 'hot' ? 'hot' : 'new';
  const limit  = Math.min(Math.max(Number(req.query.limit) || 8, 1), 30);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = ['p.hidden = 0'];
  const params = {};
  if (TAGS.includes(tag)) { where.push('p.tag = @tag'); params.tag = tag; }
  if (q) { where.push('(p.text LIKE @q OR p.name LIKE @q)'); params.q = '%' + q + '%'; }
  const whereSql = where.join(' AND ');

  const orderSql = 'p.pinned DESC, ' + (sort === 'hot'
  ? `(p.likes + ...) DESC, p.created_at DESC`
  : 'p.created_at DESC');

    console.log('排序是:', orderSql);

  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.hidden = 0) AS comment_count
    FROM posts p
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  const totalStmt = db.prepare(`SELECT COUNT(*) AS n FROM posts p WHERE ${whereSql}`);
  const total = (Object.keys(params).length ? totalStmt.get(params) : totalStmt.get()).n;

  res.json({ total, posts: rows.map(mapPost) });
});

app.post('/api/posts',
  rateLimit({ windowMs: 60_000, max: 5, key: 'post' }),
  upload.array('images', 3),
  (req, res) => {
    try {
      const text = clean(req.body.text, 500);
      if (!text) {
        cleanupFiles(req.files);
        return res.status(400).json({ error: '先写点什么，或者上传一张照片吧' });
      }
      const tag  = TAGS.includes(req.body.tag) ? req.body.tag : '表白';
      const name = clean(req.body.name, 16) || randomPick(ANON_NAMES);
      const color = randomPick(COLORS);
      const images = (req.files || []).map(f => '/uploads/' + f.filename);

      const info = db.prepare(`
        INSERT INTO posts (name,color,tag,text,images,created_at)
        VALUES (?,?,?,?,?,?)
      `).run(name, color, tag, text, JSON.stringify(images), Date.now());

      const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
      res.json({ post: mapPost({ ...row, comment_count: 0 }) });
    } catch (e) {
      cleanupFiles(req.files);
      res.status(500).json({ error: '发布失败，请稍后再试' });
    }
  });

app.post('/api/posts/:id/like',
  rateLimit({ windowMs: 60_000, max: 90, key: 'like' }),
  (req, res) => {
    const id = toId(req.params.id);
    const delta = req.body?.delta === -1 ? -1 : 1;
    if (!id) return res.status(400).json({ error: '参数有误' });

    const info = db.prepare(
      'UPDATE posts SET likes = MAX(0, likes + ?) WHERE id = ? AND hidden = 0'
    ).run(delta, id);
    if (!info.changes) return res.status(404).json({ error: '这条表白不见了' });

    const row = db.prepare('SELECT likes FROM posts WHERE id = ?').get(id);
    res.json({ likes: row.likes });
  });

app.get('/api/posts/:id/comments', (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  const rows = db.prepare(
    'SELECT * FROM comments WHERE post_id = ? AND hidden = 0 ORDER BY created_at ASC LIMIT 200'
  ).all(id);
  res.json({ comments: rows.map(mapComment) });
});

app.post('/api/posts/:id/comments',
  rateLimit({ windowMs: 60_000, max: 15, key: 'comment' }),
  (req, res) => {
    const id = toId(req.params.id);
    const text = clean(req.body?.text, 120);
    if (!id) return res.status(400).json({ error: '参数有误' });
    if (!text) return res.status(400).json({ error: '回复内容不能为空' });

    const post = db.prepare('SELECT id FROM posts WHERE id = ? AND hidden = 0').get(id);
    if (!post) return res.status(404).json({ error: '这条表白不见了' });

    const name = clean(req.body?.name, 16) || randomPick(ANON_NAMES);
    const info = db.prepare(
      'INSERT INTO comments (post_id,name,text,created_at) VALUES (?,?,?,?)'
    ).run(id, name, text, Date.now());

    res.json({
      comment: mapComment(db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid))
    });
  });

app.get('/api/stats', (req, res) => {
  const posts = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE hidden = 0').get().n;
  const comments = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE hidden = 0').get().n;
  const likes = db.prepare('SELECT COALESCE(SUM(likes),0) AS n FROM posts WHERE hidden = 0').get().n;
  res.json({ posts, comments, likes });
});

app.post('/api/admin/login',
  rateLimit({ windowMs: 10 * 60_000, max: 8, key: 'login' }),
  (req, res) => {
    const pass = String(req.body?.password ?? '');
    const ok = crypto.timingSafeEqual(sha256(pass), sha256(ADMIN_PASSWORD));
    if (!ok) return res.status(401).json({ error: '密码不对哦' });
    res.json({ token: sign({ role: 'admin', exp: Date.now() + 12 * 3600 * 1000 }) });
  });

app.get('/api/admin/posts', adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p ORDER BY p.created_at DESC LIMIT 300
  `).all();
  res.json({ posts: rows.map(mapPost) });
});

app.post('/api/admin/posts/:id/hide', adminOnly, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  db.prepare('UPDATE posts SET hidden = 1 - hidden WHERE id = ?').run(id);
  const row = db.prepare('SELECT hidden FROM posts WHERE id = ?').get(id);
  res.json({ hidden: !!row?.hidden });
});

// 置顶 / 取消置顶
app.post('/api/admin/posts/:id/pin', adminOnly, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });
  db.prepare('UPDATE posts SET pinned = 1 - pinned WHERE id = ?').run(id);
  const row = db.prepare('SELECT pinned FROM posts WHERE id = ?').get(id);
  res.json({ pinned: !!row?.pinned });
});

app.delete('/api/admin/posts/:id', adminOnly, (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数有误' });

  const row = db.prepare('SELECT images FROM posts WHERE id = ?').get(id);
  if (row) {
    JSON.parse(row.images || '[]').forEach(src => {
      const file = path.join(UPLOAD_DIR, path.basename(src));
      fs.unlink(file, () => {});
    });
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '单张图片不能超过 5MB' });
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')
    return res.status(400).json({ error: '最多上传 3 张照片' });
  return res.status(400).json({ error: err.message || '请求出错了' });
});

app.listen(PORT, () => {
  console.log(`\n💗 祥和表白墙已启动：http://localhost:${PORT}`);
  console.log(`🔐 管理后台：http://localhost:${PORT}/admin.html`);
  console.log(`   当前管理员密码：${ADMIN_PASSWORD}\n`);
});