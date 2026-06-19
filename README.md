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

## 密钥

密钥值只放在 Cloudflare Worker 的 Runtime Secrets，不写入 GitHub。`wrangler.jsonc` 只声明必需密钥名。

```sh
openssl rand -base64 32 | pnpm wrangler secret put BETTER_AUTH_SECRET --name file-transfer-api
printf '<diagnostic-value>' | pnpm wrangler secret put test_secret --name file-transfer-api
pnpm wrangler secret list --name file-transfer-api
```

`test_secret` 仅用于临时部署验证，确认后应从代码和配置中移除。

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
test_secret=<local-diagnostic-value>
```

## 验证

```sh
curl https://api.file.thanejoss.com/health
curl https://api.file.thanejoss.com/debug/secret
```

期望：

```json
{"ok":true,"db":"ok"}
```

```json
{"hasTestSecret":true,"testSecretLength":6}
```

## API

- `GET /`
- `GET /health`
- `GET|POST /api/auth/*`
- `GET /v1/me`
- `GET /debug/secret`
