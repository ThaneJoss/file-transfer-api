# file-transfer-api

File Transfer 的生产 API，运行在 Cloudflare Worker 上。

```txt
生产 API:     https://api.file.thanejoss.com
GitHub 仓库:  https://github.com/ThaneJoss/file-transfer-api
Worker 名称: file-transfer-api
D1 数据库:    file-transfer-api-db
```

## 技术栈

- Hono：Worker 路由
- Better Auth：认证
- Cloudflare D1：认证数据存储
- Worker Secrets：运行时密钥
- Wrangler：本地开发和部署

## 生产部署

生产环境由 Cloudflare Workers Builds 连接 GitHub 自动部署。

Cloudflare 构建配置：

```txt
Repository: ThaneJoss/file-transfer-api
Production branch: main
Root directory: /
Build command: 留空
Deploy command: pnpm run deploy
Non-production branch deploy command: pnpm wrangler versions upload
```

Cloudflare Build Variables:

```txt
PNPM_VERSION=11.6.0
```

`main` 已配置 GitHub ruleset，只能通过 PR 更新。

## 运行时密钥

密钥值只配置在 Cloudflare，不写入 GitHub，也不写入 `wrangler.jsonc`。`wrangler.jsonc` 只声明必需的密钥名称。

必需密钥：

```txt
BETTER_AUTH_SECRET
test_secret
```

通过 Wrangler 设置：

```sh
openssl rand -base64 32 | pnpm wrangler secret put BETTER_AUTH_SECRET --name file-transfer-api
printf '<diagnostic-value>' | pnpm wrangler secret put test_secret --name file-transfer-api
pnpm wrangler secret list --name file-transfer-api
```

`BETTER_AUTH_SECRET` 必须使用真实随机值。`test_secret` 只用于临时部署验证，确认生产环境可读取 Worker Secret 后，应从代码和配置中移除。

## D1 数据库

生产 D1 已在 `wrangler.jsonc` 中配置：

```txt
binding: DB
database_name: file-transfer-api-db
database_id: 82649145-9ce8-4c7a-9457-4ba0db3a97cf
```

schema 变更后，把 migration 应用到生产库：

```sh
pnpm db:migrations:apply:remote
pnpm db:migrations:list:remote
```

本地开发默认使用本地 D1：

```sh
pnpm db:migrations:apply:local
pnpm dev
```

## 本地开发

安装依赖：

```sh
pnpm install
```

创建 `.dev.vars`：

```sh
BETTER_AUTH_SECRET=<local-random-secret>
test_secret=<local-diagnostic-value>
```

启动本地 Worker：

```sh
pnpm db:migrations:apply:local
pnpm dev
```

## 生产验证

部署后检查生产接口：

```sh
curl https://api.file.thanejoss.com/health
curl https://api.file.thanejoss.com/debug/secret
```

期望响应：

```json
{"ok":true,"db":"ok"}
```

```json
{"hasTestSecret":true,"testSecretLength":6}
```

`testSecretLength` 应与 Cloudflare 中配置的 `test_secret` 长度一致。`/debug/secret` 不会返回密钥值，但它仍然只是临时诊断接口，不应长期保留在生产 API 中。

## API

- `GET /`：服务元信息
- `GET /health`：D1 连通性检查
- `GET|POST /api/auth/*`：Better Auth handler
- `GET /v1/me`：当前 Better Auth session
- `GET /debug/secret`：临时 Worker Secret 读取检查

## 变更流程

所有变更从分支发起，然后通过 PR 合并到 `main`：

```sh
git checkout -b <branch-name>
git add .
git commit -m "<message>"
git push -u origin <branch-name>
```

Cloudflare 会从 `main` 部署生产环境，并为非生产分支上传 preview version。如果 Cloudflare build 在 PR 中失败，先查看 GitHub check run，再进入关联的 Cloudflare build 页面看详细日志。
