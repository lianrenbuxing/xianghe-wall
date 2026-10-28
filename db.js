import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 数据目录：本地开发时放 SQLite 文件；线上（Turso）只用来放临时文件
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// 有 TURSO_DATABASE_URL 就连云端，否则用本地 SQLite 文件
export const IS_REMOTE_DB = Boolean(process.env.TURSO_DATABASE_URL);

let driver;

if (IS_REMOTE_DB) {
  const { createClient } = await import('@libsql/client/web');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined
  });

  driver = {
    async all(sql, args = []) {
      const res = await client.execute({ sql, args });
      return res.rows;
    },
    async get(sql, args = []) {
      const res = await client.execute({ sql, args });
      return res.rows[0];
    },
    async run(sql, args = []) {
      const res = await client.execute({ sql, args });
      return {
        changes: Number(res.rowsAffected || 0),
        lastInsertRowid: Number(res.lastInsertRowid || 0)
      };
    },
    async exec(sql) {
      await client.execute(sql);
    },
    close() {
      client.close();
    }
  };
} else {
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    throw new Error(
      '本地模式需要 better-sqlite3（开发依赖）。请执行 npm install，' +
      '或在线上配置 TURSO_DATABASE_URL 使用云端数据库。'
    );
  }
  const sqlite = new Database(path.join(DATA_DIR, 'wall.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  driver = {
    async all(sql, args = []) {
      return sqlite.prepare(sql).all(...args);
    },
    async get(sql, args = []) {
      return sqlite.prepare(sql).get(...args);
    },
    async run(sql, args = []) {
      const info = sqlite.prepare(sql).run(...args);
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
    close() {
      sqlite.close();
    }
  };
}

// 统一的异步接口：所有业务代码只认这四个方法，换数据库时不用动业务逻辑
export const db = {
  all: (sql, args) => driver.all(sql, args),
  get: (sql, args) => driver.get(sql, args),
  run: (sql, args) => driver.run(sql, args),
  exec: sql => driver.exec(sql),
  close: () => driver.close()
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS posts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT    NOT NULL,
     color      TEXT    NOT NULL,
     tag        TEXT    NOT NULL,
     text       TEXT    NOT NULL,
     images     TEXT    NOT NULL DEFAULT '[]',
     likes      INTEGER NOT NULL DEFAULT 0,
     hidden     INTEGER NOT NULL DEFAULT 0,
     pinned     INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS comments (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id    INTEGER NOT NULL,
     name       TEXT    NOT NULL,
     text       TEXT    NOT NULL,
     hidden     INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS thanks (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT    NOT NULL,
     note       TEXT    NOT NULL DEFAULT '',
     link       TEXT    NOT NULL DEFAULT '',
     avatar     TEXT    NOT NULL DEFAULT '',
     avatar_key TEXT    NOT NULL DEFAULT '',
     sort       INTEGER NOT NULL DEFAULT 0,
     hidden     INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_posts_created  ON posts(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_post  ON comments(post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_thanks_order   ON thanks(sort DESC, id ASC)`
];

for (const statement of SCHEMA) {
  await db.exec(statement);
}

// 老库补列：pinned、致谢头像都是后来加的
await ensureColumn('posts', 'pinned', 'ALTER TABLE posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
await ensureColumn('thanks', 'avatar', "ALTER TABLE thanks ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
await ensureColumn('thanks', 'avatar_key', "ALTER TABLE thanks ADD COLUMN avatar_key TEXT NOT NULL DEFAULT ''");

async function ensureColumn(table, column, ddl) {
  try {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    if (cols.some(c => c.name === column)) return;
  } catch {
    // PRAGMA 不支持时直接尝试 ALTER，重复报错会被忽略
  }
  try {
    await db.exec(ddl);
  } catch (err) {
    if (!/duplicate column|already exists/i.test(String(err && err.message))) throw err;
  }
}

export const TAGS = ['表白', '寻人', '祝福', '吐槽', '日常'];

export const ANON_NAMES = [
  '匿名的同学', '路过的小可爱', '不敢留名的人', '一个胆小鬼', '心动当事人',
  '神秘校友', '暗恋中的人', '偷偷喜欢你的我', '食堂常客', '教室后排的某人',
  '星河里的猫', '晚自习的梦', '喜欢你的第 N 天', '小路口的晚风'
];

export const COLORS = [
  '#ff5f8d', '#7b6cff', '#4f9dff', '#33c58e',
  '#ffab4f', '#ff6b6b', '#2bb6d6', '#e0b840'
];

export const randomPick = arr => arr[Math.floor(Math.random() * arr.length)];

/**
 * images 字段的兼容解析：
 * - 老数据是 ["/uploads/a.jpg"]
 * - 新数据是 [{ url, key }]，key 用于云端删除
 */
export function parseImages(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map(item => {
      if (typeof item === 'string') return { url: item, key: null };
      if (item && typeof item.url === 'string') {
        return { url: item.url, key: typeof item.key === 'string' ? item.key : null };
      }
      return null;
    })
    .filter(Boolean);
}

export function mapPost(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    tag: row.tag,
    text: row.text,
    images: parseImages(row.images).map(img => img.url),
    likes: row.likes,
    hidden: !!row.hidden,
    pinned: !!row.pinned,
    created_at: row.created_at,
    comment_count: row.comment_count ?? 0
  };
}

export function mapComment(row) {
  return {
    id: row.id,
    post_id: row.post_id,
    name: row.name,
    text: row.text,
    created_at: row.created_at
  };
}

export function mapThanks(row) {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    link: row.link,
    avatar: row.avatar || '',
    sort: row.sort,
    hidden: !!row.hidden,
    created_at: row.created_at
  };
}

export async function seedIfEmpty() {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM posts');
  if (n > 0) return;

  const now = Date.now();
  const insert = (name, color, tag, text, likes, createdAt) =>
    db.run(
      'INSERT INTO posts (name,color,tag,text,images,likes,created_at) VALUES (?,?,?,?,?,?,?)',
      [name, color, tag, text, '[]', likes, createdAt]
    );

  await insert('匿名的同学', '#ff5f8d', '表白',
    '致三班那个总在图书馆靠窗位置的女孩：\n每次路过都假装在看手机，其实余光全是你。\n如果你也在看这条，可以对我笑一下吗？',
    32, now - 1000 * 60 * 42);
  await insert('心动当事人', '#7b6cff', '祝福',
    '毕业季快乐。\n没能说出口的话，就留在这面墙上吧。\n希望你以后遇到的人，都比我勇敢。',
    58, now - 1000 * 60 * 60 * 20);

  const first = await db.get('SELECT id FROM posts ORDER BY id ASC LIMIT 1');
  if (first) {
    await db.run(
      'INSERT INTO comments (post_id,name,text,created_at) VALUES (?,?,?,?)',
      [first.id, '路过的小可爱', '磕到了磕到了！冲啊！', now - 1000 * 60 * 30]
    );
  }
}

// 致谢名单为空时给两条示例，方便后台直接看到效果（可删可改）
export async function seedThanksIfEmpty() {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM thanks');
  if (n > 0) return;

  const now = Date.now();
  await db.run(
    'INSERT INTO thanks (name,note,link,sort,created_at) VALUES (?,?,?,?,?)',
    ['余念大王', '设计与开发', '', 100, now]
  );
  await db.run(
    'INSERT INTO thanks (name,note,link,sort,created_at) VALUES (?,?,?,?,?)',
    ['第一位留言的同学', '让这面墙从空白变成了故事', '', 90, now]
  );
}
