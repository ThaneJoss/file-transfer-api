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

## 后端边界

Worker 只负责：

1. Better Auth 注册、登录和 session 校验。
2. 托管 TURN、R2、SFU 长期密钥，向已登录用户提供短期或受限访问。
3. 将成功的凭证签发和 SFU 控制面调用写入 `usage_event`。

TURN 返回短期 `iceServers`。R2 返回仅限一个服务端生成对象 key 的临时 S3
凭证。Cloudflare Realtime SFU 没有可下发给浏览器的短期 App Token，因此
Worker 只代理文件传输需要的控制面接口，长期 App Token 不离开 Worker。

文件数据不经过 Worker。`usage_event` 当前记录控制面事件；TURN、SFU 和 R2
实际流量字节后续需要从 Cloudflare Analytics 对账。

## 运行时密钥

```sh
openssl rand -base64 32 | pnpm wrangler secret put BETTER_AUTH_SECRET --name file-transfer-api
pnpm wrangler secret put TURN_KEY_ID --name file-transfer-api
pnpm wrangler secret put TURN_KEY_API_TOKEN --name file-transfer-api
pnpm wrangler secret put R2_ACCOUNT_ID --name file-transfer-api
pnpm wrangler secret put R2_BUCKET --name file-transfer-api
pnpm wrangler secret put R2_PARENT_API_TOKEN --name file-transfer-api
pnpm wrangler secret put R2_PARENT_ACCESS_KEY_ID --name file-transfer-api
pnpm wrangler secret put SFU_APP_ID --name file-transfer-api
pnpm wrangler secret put SFU_APP_TOKEN --name file-transfer-api
pnpm wrangler secret list --name file-transfer-api
```

R2 parent token 至少需要目标 bucket 的 Object Read & Write 权限。所有值只放在
Cloudflare Worker Runtime Secrets，不写入 GitHub。

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
- `GET /v1/me`，需要 Better Auth session
- `GET /v1/usage`，返回当前用户的事件汇总
- `POST /v1/turn/credentials`
- `POST /v1/r2/credentials`
- `POST|PUT /v1/sfu/*`，仅允许文件传输所需的 SFU 控制面操作

浏览器跨域调用必须携带 cookie：

```ts
await fetch("https://api.file.thanejoss.com/v1/turn/credentials", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ttlSeconds: 3600 }),
});
```

TURN 请求体：

```json
{"ttlSeconds":3600}
```

R2 请求体：

```json
{"fileName":"example.bin","ttlSeconds":900}
```

R2 响应包含 `accountId`、`bucket`、`endpoint`、服务端生成的 `objectKey`，
以及 `accessKeyId`、`secretAccessKey`、`sessionToken`、`expiresAt`。前端的
S3 签名实现必须同时发送 `sessionToken`。

SFU 代理路径与 Cloudflare Realtime 的应用内路径一致，例如：

```txt
POST /v1/sfu/sessions/new
POST /v1/sfu/sessions/{sessionId}/datachannels/establish
PUT  /v1/sfu/sessions/{sessionId}/renegotiate
POST /v1/sfu/sessions/{sessionId}/datachannels/new
```
