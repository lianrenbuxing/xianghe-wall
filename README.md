# 祥和表白墙 💗

校园匿名表白墙：发帖（文字 + 最多 3 张图）、点赞、匿名评论、话题筛选、搜索、热门排序、置顶、**致谢名单专区（支持头像）**，以及带密码的管理后台。

技术栈很轻：**Node.js + Express 4 + SQLite/Turso + 原生前端**，没有构建步骤，克隆下来 `npm start` 就能跑。

- 本地开发：数据存 `data/wall.db`，图片存 `data/uploads/`，零外部依赖。
- 线上免费部署：数据存 **Turso**（云端 SQLite，免费 5GB），图片存 **Cloudinary**（图床）。配置见 [DEPLOY.md](DEPLOY.md)。

---

## 快速开始

```bash
# Node.js >= 20
npm install
npm start                 # http://localhost:3000
```

- 前台：<http://localhost:3000>
- 后台：<http://localhost:3000/admin.html>
- 默认管理员密码：`yunian2011603`（**上线前务必在环境变量里改掉**）

首次启动会自动建库、建表，并塞入 2 条示例表白，方便你看效果。想清空就删掉 `data/` 目录。

### 开发模式

```bash
npm run dev     # node --watch，改后端代码自动重启
npm test        # 24 个接口/存储/回归测试，自动起临时服务，不污染 data/
npm run check   # 语法检查
```

---

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `ADMIN_PASSWORD` | `yunian2011603` | 管理后台密码，**必须改** |
| `SECRET` | 自动生成并存到 `data/.secret` | 管理员 token 签名密钥 |
| `TURSO_DATABASE_URL` | 空 | 填了就走云端 Turso；不填用本地 SQLite |
| `TURSO_AUTH_TOKEN` | 空 | Turso 访问令牌 |
| `CLOUDINARY_CLOUD_NAME` | 空 | 三个都填才启用图床 |
| `CLOUDINARY_API_KEY` | 空 | 同上 |
| `CLOUDINARY_API_SECRET` | 空 | 同上 |
| `DATA_DIR` | `./data` | 本地数据库 / 上传目录 |
| `UPLOAD_DIR` | `$DATA_DIR/uploads` | 本地图片目录（仅本地模式） |
| `TRUST_PROXY` | 关闭 | 部署在 Nginx / Render 后面时设为 `1` |
| `NODE_ENV` | 空 | 设为 `production` 后控制台不再打印密码 |

`.env` 由内置的 `env.js` 读取（10 行代码，不引入 dotenv），已加入 `.gitignore`。

---

## 目录结构

```
server.js            Express 应用：路由、鉴权、限流、上传、静态资源
db.js                数据库抽象：Turso / 本地 SQLite 二选一，建表、种子数据、行 → JSON
storage.js           图片存储抽象：Cloudinary / 本地 uploads 二选一，含文件头校验
env.js               极简 .env 加载
public/index.html    表白墙前台
public/app.js        前台交互（发布 / 点赞 / 评论 / 无限滚动 / 灯箱 / 主题）
public/thanks.html   致谢名单页
public/thanks.js     致谢名单渲染与主题切换
public/style.css     样式（浅色 + 深色主题）
public/admin.html    管理后台（登录 / 隐藏 / 置顶 / 删除 / 维护致谢名单）
test/api.test.js     接口与 HTML 回归测试
test/storage.test.js 图片格式识别与存储回退测试
data/                本地模式运行时生成：wall.db + uploads/ + .secret（已 gitignore）
```

---

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/posts` | 列表，参数 `tag` / `q` / `sort=new\|hot` / `limit`(≤30) / `offset` |
| POST | `/api/posts` | 发布，`multipart/form-data`：`text`、`name`、`tag`、`images`(≤3) |
| POST | `/api/posts/:id/like` | 点赞，JSON `{ "delta": 1 \| -1 }` |
| GET | `/api/posts/:id/comments` | 评论列表 |
| POST | `/api/posts/:id/comments` | 发表评论，JSON `{ "text": "...", "name": "..." }` |
| GET | `/api/stats` | 公开统计（帖子数 / 评论数 / 总赞数） |
| GET | `/api/thanks` | 致谢名单（公开，仅未隐藏，按排序值降序） |
| GET | `/api/health` | 健康检查，部署探活用 |
| POST | `/api/admin/login` | 管理员登录，返回 12 小时有效的 Bearer token |
| GET | `/api/admin/posts` | 后台列表（含已隐藏，最多 300 条） |
| POST | `/api/admin/posts/:id/hide` | 隐藏 / 取消隐藏（软删除） |
| POST | `/api/admin/posts/:id/pin` | 置顶 / 取消置顶 |
| DELETE | `/api/admin/posts/:id` | 彻底删除，连带删除图片文件 |
| GET | `/api/admin/thanks` | 致谢名单（含已隐藏） |
| POST | `/api/admin/thanks` | 新增致谢：`multipart/form-data`，字段 `name`、`note`、`link`、`sort`、可选 `avatar` 图片；也兼容纯 JSON |
| PUT | `/api/admin/thanks/:id` | 修改致谢；带 `avatar` 文件则替换头像，`removeAvatar=1` 则移除 |
| POST | `/api/admin/thanks/:id/hide` | 隐藏 / 显示致谢 |
| DELETE | `/api/admin/thanks/:id` | 删除致谢（连带删除头像文件） |

限流（按 IP，内存计数）：发帖 5 次/分钟、评论 15 次/分钟、点赞 90 次/分钟、登录 8 次/10 分钟。

---

## 本次接手做了哪些改动

### 修复的真实 Bug

1. **「最热门」排序直接报错**（原代码 SQL 里留了 `(p.likes + ...)` 占位符）——一选热门就 `400 near ".": syntax error`。现改为 `点赞 + 3×评论数` 的热度公式。
2. **图片灯箱彻底失效**：`index.html` 里写成了 `< img id="lightboxImg">`（`<` 后有空格），浏览器把它当纯文本，`document.getElementById('lightboxImg')` 拿到 `null`，点图片直接抛 TypeError。已修复。
3. **后台缩略图不显示**：`admin.html` 模板里同样是 `< img src=...>`，管理后台看到的是字面量文本而不是图片。已修复。
4. **「管理入口」链接指错**：`href=" "`，点了没反应。已改为 `/admin.html`。
5. 多处 `</p >`、`</a >` 这类被空格拆坏的闭合标签，一并修正。

### 新增：致谢名单专区

- 独立页面 `/thanks.html`，卡片式展示名字、贡献说明、可选链接，支持深浅主题，手机单列自适应。
- 首页页脚新增「💝 致谢名单」入口。
- 后台新增管理区：添加 / 编辑 / 隐藏 / 删除，支持排序值控制先后；首次启动自带 2 条示例，可自行改或删。
- **支持头像**：后台上传图片作为该条致谢的头像，替换时自动删除旧图，也可以一键移除；没传头像时自动回退成「首字 + 配色」的圆形头像。
- 链接只接受 `http(s)`，前端渲染统一转义，`javascript:` 之类的注入在服务端就被挡掉。
- 数据存在 `thanks` 表，随 `data/wall.db` 一起备份即可。

### 架构升级：数据库与图片存储可切换（v2.0）

- `db.js` 抽出统一异步接口（`db.all / get / run / exec`）：配了 `TURSO_DATABASE_URL` 就连云端 Turso，没配就用本地 `better-sqlite3`。业务路由只认接口，不关心底层是谁。
- `storage.js` 抽出图片存储：配了 Cloudinary 三件套就签名上传到图床，没配就写本地 `uploads/`。删除帖子时会同步删掉云端图片。
- 全部 SQL 改成位置参数 `?`，两种驱动通用；`images` 字段同时兼容老格式（字符串数组）和新格式（`{url, key}`）。
- `better-sqlite3` 降为开发依赖，线上 `npm ci --omit=dev` 不再触发 native 编译——Render 构建从"拼运气"变成 20 秒稳定完成。
- `/api/health` 会返回当前用的数据库和图片来源，部署后一眼就能确认配置生效。

### 健壮性 / 安全

- 上传增加**文件头魔数校验**：客户端把 PHP/HTML 改名成 `.png` 或伪装 `Content-Type` 都写不进 `uploads/`，失败时清理已落盘文件。
- 新增安全响应头（`nosniff`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、CSP），并关闭 `X-Powered-By`。
- `trust proxy` 改为显式开关，默认关闭——否则直连部署时任何人伪造 `X-Forwarded-For` 就能绕过限流。
- 管理员 token 密钥**落盘持久化**，服务重启不再把所有人踢下线。
- `images` 字段 JSON 解析加兜底，脏数据不会再让整个列表 500。
- 数据目录固定相对项目根，从别的目录启动也不会写错位置；补齐优雅退出（`SIGINT/SIGTERM` 关闭 HTTP 与数据库连接）。
- 列表排序补 `id` 兜底，同时间戳的帖子翻页不会重复或漏条。

### 前端体验

- 切换筛选 / 排序时用请求序号丢弃过期结果——原来 `state.loading` 期间点标签会被**静默忽略**，出现"标签选中了、列表还是旧的"。
- 点赞失败会回滚本地状态，不再出现界面已点心、刷新后变回去。
- 发布加防重入，连点两次不会重复发帖；加载列表时不再禁用发布按钮。

### 工程化

- `better-sqlite3` 从 `"latest"` 改为 `^13.0.3`（`latest` 会让每次 `npm install` 装到不同版本）。
- 新增 `test/api.test.js` 与 `test/storage.test.js`（`node:test`，零额外依赖）覆盖 26 个场景：排序、翻页、上传校验、后台鉴权与置顶/隐藏/删除、致谢名单增删改查与头像替换、图片格式识别、HTML 合法性回归、安全头。
- 新增 `.env.example`、`.gitignore`（`.env`、`data/`）、`npm run check`。

---

## 部署

完整步骤见 **[DEPLOY.md](DEPLOY.md)**，其中包含 Turso / Cloudinary 的注册与取值、Render 环境变量表、手机端的操作边界、以及常见报错对照。

简要版本：

1. Turso 建库 → 拿 `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`
2. Cloudinary 注册 → 拿 `CLOUDINARY_CLOUD_NAME` / `API_KEY` / `API_SECRET`
3. Render 建 Web Service：Build `npm ci --omit=dev`，Start `npm start`，把上面 5 个值填进 Environment
4. 打开 `/api/health`，看到 `{"db":"turso","images":"cloudinary"}` 就成功了

### 自建服务器（不用 Render）

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 20m;
}
```

配合 `pm2 start server.js --name xianghe-wall`，并设置 `TRUST_PROXY=1`。这种场景下可以不配 Turso/Cloudinary，直接备份 `data/` 目录即可。

---

## 还可以继续做（按优先级）

- [ ] 管理员回复 / 评论审核，评论举报
- [ ] 发帖前接入内容安全（敏感词 / 审核队列）
- [ ] 图片压缩改到服务端（sharp），前端压缩在部分老安卓上不稳
- [ ] 点赞去重改成服务端记录（目前只靠浏览器 localStorage，换设备可重复点）
- [ ] 后台分页 + 搜索（现在固定最多 300 条）
- [ ] 旧数据迁移脚本（本地 SQLite → Turso）
