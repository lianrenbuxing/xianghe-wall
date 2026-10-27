# 免费部署到 Render（Turso + Cloudinary）

> 这套方案 **0 元**：Render 免费实例跑网站，数据存 Turso（云端 SQLite），图片存 Cloudinary。
> 代价是 Render 免费实例 15 分钟没人访问会休眠，下一次访问要等 20～30 秒冷启动。

---

## 0. 先搞清楚整体结构

```
浏览器
  ↓
Render 免费实例（只跑代码，不存数据）
  ├── 数据 → Turso（云端 SQLite，免费 5GB）
  └── 图片 → Cloudinary（图床，免费约 25GB）
```

所以 Render 重启、重新部署、休眠醒来，**帖子和图片都还在**。这也是为什么不需要买 1GB 磁盘。

| 你要做的事 | 大概耗时 |
| --- | --- |
| 注册 Turso、建库、拿 2 个值 | 5 分钟 |
| 注册 Cloudinary、拿 3 个值 | 5 分钟 |
| 改代码推到 GitHub | 3 分钟 |
| Render 里填环境变量、部署 | 5 分钟 |

> ⚠️ 切换后是一个**全新的空库**（会自动放 2 条示例表白）。你现在 Render 上临时磁盘里的旧帖子不会跟过来。如果里面有真实内容，先别急着切，告诉我，我给你写个导出/导入。

---

## 1. 注册 Turso，拿数据库地址和令牌

1. 打开 <https://turso.tech> → **Sign up** → 用 GitHub 账号登录（不用绑卡）。
2. 进入控制台，点 **Create Database**：
   - Name：`xianghe-wall`
   - Location：选 **Singapore**（离国内近）
3. 建好后进入这个库，找到 **Connect**（或 "Connect to your database"）区域，复制两样东西：

| 变量名 | 长什么样 |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://xianghe-wall-你的用户名.turso.io` |
| `TURSO_AUTH_TOKEN` | 一长串 `eyJ...` 开头的令牌（点 Create Token 生成，**只显示一次**） |

表结构不用管，网站第一次启动会自己建表。

---

## 2. 注册 Cloudinary，拿图片上传的 3 个值

1. 打开 <https://cloudinary.com> → **Sign up for free**（邮箱即可，不用绑卡）。
2. 登录后进 **Dashboard**，在 **Product Environment Credentials** 区块能看到：

| 变量名 | 对应 |
| --- | --- |
| `CLOUDINARY_CLOUD_NAME` | Cloud name |
| `CLOUDINARY_API_KEY` | API Key |
| `CLOUDINARY_API_SECRET` | API Secret（点眼睛图标显示） |

这三个是服务器端签名上传用的，**不要**写进前端代码。

---

## 3. 先在本地验证这 5 个值（强烈建议）

在项目根目录新建 `.env`（VS Code 里右键 → 新建文件 → 输入 `.env`），内容：

```ini
TURSO_DATABASE_URL=libsql://你的库.turso.io
TURSO_AUTH_TOKEN=你的令牌
CLOUDINARY_CLOUD_NAME=你的cloud名
CLOUDINARY_API_KEY=你的key
CLOUDINARY_API_SECRET=你的secret
ADMIN_PASSWORD=换成你自己的密码
```

然后运行自检：

```bash
npm run verify
```

它会逐项检查：变量是否齐全、Turso 能否连上、Cloudinary 凭据是否有效，并给出具体的错误原因（比如 `api_secret mismatch` 就是 Secret 复制错了）。

全绿之后再：

```bash
npm start          # 打开 http://localhost:3000
```

随便发一条带图的表白，右键图片复制地址，如果是 `https://res.cloudinary.com/...` 开头，说明图床生效了。

> ⚠️ 本地连了 Turso 之后，本地看到的就是**线上数据库**。在后台删帖会删线上的，别拿它当试验田。
> `.env` 已在 `.gitignore` 里，不会被推到 GitHub；也**不要**把里面的值发到群里或聊天里。

---

## 4. 把代码推到 GitHub

新版本比起旧版多了 `storage.js`、`test/storage.test.js`，`db.js` 和 `server.js` 改动较大，**建议整份替换**而不是手工改。

1. 解压 `xianghe-wall-2.0.0.zip`，VS Code → **打开文件夹** → 选里面那层（第一层要能看到 `package.json`）。
2. 左侧 **源代码管理** → 写提交信息 → **✓ 提交** → **同步/推送**。
   或终端：
   ```bash
   git add .
   git commit -m "改用 Turso + Cloudinary，支持免费部署"
   git push
   ```
3. 确认 GitHub 仓库根目录能看到 `package.json`、`render.yaml`、`storage.js`。

> **手机限制**：GitHub 手机网页不能上传整个文件夹，只能改单个文件。所以这一步必须在电脑上做一次；之后手机只需要看 Render 面板。

---

## 5. 在 Render 部署

### 方式 A：Blueprint（推荐）

1. Render 控制台 → **New +** → **Blueprint** → 选仓库 → **Connect**。
2. 它会读出 `render.yaml`，点 **Apply**。
3. 弹出环境变量表单时，把那 5 个值填进去，另外设置 `ADMIN_PASSWORD`。

### 方式 B：手动建 Web Service

1. **New +** → **Web Service** → 选仓库。
2. 填写：

| 项目 | 值 |
| --- | --- |
| Name | `xianghe-wall` |
| Language | `Node` |
| Region | `Singapore` |
| Branch | `main` |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Instance Type | `Free` |

3. **Environment** 里逐条添加：

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `22.23.4` |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `ADMIN_PASSWORD` | 你自己的密码 |
| `SECRET` | 一长串随机字符（不填也行，会自动生成） |
| `TURSO_DATABASE_URL` | 第 1 步复制的地址 |
| `TURSO_AUTH_TOKEN` | 第 1 步复制的令牌 |
| `CLOUDINARY_CLOUD_NAME` | 第 2 步的 Cloud name |
| `CLOUDINARY_API_KEY` | 第 2 步的 API Key |
| `CLOUDINARY_API_SECRET` | 第 2 步的 API Secret |

4. **不要加 Disk**。这套方案不需要磁盘，加了反而会占额度。

---

## 6. 部署完的验证清单

假设域名是 `https://xianghe-wall.onrender.com`：

1. **健康检查**：打开 `/api/health`，应该看到
   ```json
   {"ok":true,"uptime":12,"db":"turso","images":"cloudinary"}
   ```
   - `db` 不是 `turso` → 环境变量没生效，去检查 `TURSO_DATABASE_URL` 有没有拼错、改动后有没有重新部署。
   - `images` 不是 `cloudinary` → 三个 Cloudinary 变量没配全。
2. **首页**：能看到 2 条示例表白（新库自动生成的）。
3. **发一条带图的**：刷新后图片还在，右键图片复制地址应该是 `https://res.cloudinary.com/...`。
4. **后台**：`/admin.html` 用 `ADMIN_PASSWORD` 登录，置顶/隐藏/删除正常；致谢名单能加能改。
5. **重启验证**：Render 面板 → **Manual Deploy** → **Restart service**，重启完刷新，帖子还在 = 成功。

---

## 7. 以后改代码怎么更新

```bash
git add .
git commit -m "改了什么"
git push
```

Render 会自动重新部署（`render.yaml` 里 `autoDeploy: true`）。手机上打开 Render → 服务 → **Logs** 看进度。

---

## 8. 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `/api/health` 里 `db` 是 `sqlite` | 没读到最后 `TURSO_DATABASE_URL` | 环境变量拼写、是否点了 Save、是否重新部署 |
| 发帖报 `LIBSQL_...` / 401 / 403 | Turso 令牌错或过期 | 回 Turso 控制台重新生成 Token，更新变量 |
| 发帖报“图片上传失败” | Cloudinary 三个值不对（最常见是 API Secret） | 复制时别带空格；确认是同一套环境的三个值 |
| 页面能开但一条数据都没有 | 新库还没种子 | 正常，重启一次会补上示例；或直接发一条 |
| 第一次访问要等 20 秒 | 免费实例已休眠 | 正常；想要秒开就得升 Starter |
| 构建失败 `node-gyp` | 还在装 better-sqlite3 | 确认 build command 是 `npm ci --omit=dev`（它现在只是开发依赖） |
| 图片 404 | 本地模式遗留的 `/uploads/...` 地址 | 老数据里的图片不会自动搬去 Cloudinary，需要重新上传 |

---

## 9. 免费额度够不够用

| 服务 | 免费额度 | 你这个站的实际情况 |
| --- | --- | --- |
| Render Web Service | 750 小时/月，15 分钟无访问休眠 | 一个服务常驻够用 |
| Turso | 5GB 存储、每月 5 亿行读 / 1000 万行写 | 几千条帖子远用不到 1% |
| Cloudinary | 约 25GB 存储/流量额度 | 按每张压缩后 200KB 算，够放十万张 |

真到了不够用的那天，再升级也不迟，代码不用改。

---

## 10. 技术上改了什么（给以后接手的人看）

- `db.js`：抽成统一异步接口 `db.all/get/run/exec`。有 `TURSO_DATABASE_URL` 就用 `@libsql/client/web` 连云端，没有就用本地 `better-sqlite3`。业务代码只认这套接口，**将来换 Postgres / MongoDB 只需要改这一个文件**。
- `storage.js`：图片存储抽象。配了 Cloudinary 就签名上传（图床），没配就写本地 `uploads/`。上传前统一按文件头校验真实格式。
- SQL 全部改成位置参数 `?`，两种驱动通用；老库的 `images` 字段（字符串数组）和新格式（`{url,key}`）都能读。
- `better-sqlite3` 移到 `devDependencies`，线上用 `npm ci --omit=dev` 不安装，构建不再需要 C++ 工具链。
