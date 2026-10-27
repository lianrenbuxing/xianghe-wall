import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'wall.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
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
  
);
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_posts_created  ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post  ON comments(post_id);
`);

// 给旧数据库补上 pinned 列（如果还没有）
const postCols = db.prepare("PRAGMA table_info(posts)").all();
if (!postCols.some(c => c.name === 'pinned')) {
  db.exec("ALTER TABLE posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
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
export function mapPost(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    tag: row.tag,
    text: row.text,
    images: JSON.parse(row.images || '[]'),
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

export function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  if (n > 0) return;

  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO posts (name,color,tag,text,images,likes,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  insert.run('匿名的同学', '#ff5f8d', '表白',
    '致三班那个总在图书馆靠窗位置的女孩：\n每次路过都假装在看手机，其实余光全是你。\n如果你也在看这条，可以对我笑一下吗？',
    '[]', 32, now - 1000 * 60 * 42);
  insert.run('心动当事人', '#7b6cff', '祝福',
    '毕业季快乐。\n没能说出口的话，就留在这面墙上吧。\n希望你以后遇到的人，都比我勇敢。',
    '[]', 58, now - 1000 * 60 * 60 * 20);

  const p1 = db.prepare('SELECT id FROM posts ORDER BY id ASC LIMIT 1').get();
  db.prepare('INSERT INTO comments (post_id,name,text,created_at) VALUES (?,?,?,?)')
    .run(p1.id, '路过的小可爱', '磕到了磕到了！冲啊！', now - 1000 * 60 * 30);
}