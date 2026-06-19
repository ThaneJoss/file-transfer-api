# file-transfer-api

File Transfer 的 Cloudflare Worker API。

```txt
生产 API:     https://api.file.thanejoss.com
GitHub 仓库:  https://github.com/ThaneJoss/file-transfer-api
Worker:      file-transfer-api
D1:          file-transfer-api-db
```

## 技术栈

Hono + Better Auth + Cloudflare D1 + Worker Secrets。

## Cloudflare 部署

通过 Cloudflare Workers Builds 连接 GitHub 自动部署。

```txt
Repository: ThaneJoss/file-transfer-api
Production branch: main
Root directory: /
Build command: 留空
Deploy command: pnpm run deploy
Non-production branch deploy command: pnpm wrangler versions upload
```

Build Variables:

```txt
PNPM_VERSION=11.6.0
```

`main` 已配置 GitHub ruleset，只能通过 PR 更新。

## 运行时密钥

只需要一个生产密钥：

```sh
openssl rand -base64 32 | pnpm wrangler secret put BETTER_AUTH_SECRET --name file-transfer-api
pnpm wrangler secret list --name file-transfer-api
```

密钥值只放在 Cloudflare Worker Runtime Secrets，不写入 GitHub。

## D1

生产 D1 binding 为 `DB`，数据库 ID 已写在 `wrangler.jsonc`。

```sh
pnpm db:migrations:apply:remote
pnpm db:migrations:list:remote
```

本地开发：

```sh
pnpm install
pnpm db:migrations:apply:local
pnpm dev
```

本地 `.dev.vars`：

```sh
BETTER_AUTH_SECRET=<local-random-secret>
```

## 验证

```sh
curl https://api.file.thanejoss.com/health
```

期望：

```json
{"ok":true,"db":"ok"}
```

## API

- `GET /`
- `GET /health`
- `GET|POST /api/auth/*`
- `GET /v1/me`
