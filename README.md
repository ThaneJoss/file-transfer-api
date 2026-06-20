# file-transfer-api

File Transfer 的 Cloudflare Worker API。

```txt
生产 API:     https://api.file.thanejoss.com
GitHub 仓库:  https://github.com/ThaneJoss/file-transfer-api
Worker:      file-transfer-api
D1:          file-transfer-api-db
```

## 技术栈

Hono + Better Auth 1.6.19 + `@better-auth/passkey` 1.6.19 + Cloudflare D1 +
Worker Secrets。鉴权只启用 Passkey，不提供 email/password 注册或登录。

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

1. Better Auth Passkey 注册、登录和 session 校验。
2. 托管 TURN、R2、SFU 长期密钥，向已登录用户提供短期或受限访问。
3. 将后端可确认的用户流量字节写入 `usage_event`。

TURN 返回短期 `iceServers`。R2 返回仅限一个服务端生成对象 key 的临时 S3
凭证。Cloudflare Realtime SFU 没有可下发给浏览器的短期 App Token，因此
Worker 只代理文件传输需要的控制面接口，长期 App Token 不离开 Worker。

文件数据不经过 Worker。`usage_event.bytes` 只记录后端能确认的流量字节；
`credential.issued`、`session.create` 等控制面次数不作为额度依据。R2 凭证接口
可接收 `fileSizeBytes` 记录上传文件大小。TURN relay 和 SFU data channel 的精确
per-user bytes 需要 Cloudflare 侧可归属的流量回传或后续专门埋点；在没有可信来源前，
API 不用发证/会话次数冒充流量。

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

Passkey 使用的 migration 是 `migrations/0003_passkey_auth.sql`，其中包含 Better
Auth 的 `passkey` 表和一次性注册上下文表。部署新代码前先执行：

```sh
pnpm db:migrations:apply:remote
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
BETTER_AUTH_URL=http://localhost:8787
APP_ORIGIN=http://localhost:5173
```

本地完整调用 TURN、R2、SFU API 时，还需要按 `.dev.vars.example` 配置相应的
Cloudflare 凭证。纯 Passkey 注册和登录只需要上面的三个变量与本地 D1 migration。

## Passkey 与 WebAuthn

WebAuthn RP 必须是前端站点，不能是 API 域名：

| 环境 | `APP_ORIGIN` / WebAuthn origin | RP ID |
| --- | --- | --- |
| 生产 | `https://file.thanejoss.com` | `file.thanejoss.com` |
| 本地 | `http://localhost:5173` | `localhost` |

Worker 从 `APP_ORIGIN` 的 hostname 得到 RP ID。生产 API 仍为
`https://api.file.thanejoss.com`，Better Auth 路径仍为 `/api/auth/*`。

首次注册先获取服务端注册上下文：

```http
POST /v1/passkey/registration-context
Content-Type: application/json

{"name":"用户名称"}
```

成功响应为 `201`：

```json
{"context":"短期、签名且一次性使用的注册上下文"}
```

请求体只能包含 `name`，长度为 1 到 80 个字符。context 有效期 5 分钟，成功
注册后立即失效。用户 ID 和 Better Auth 必需的内部占位 email 均由服务端生成；
前端不能提交 email 或用户 ID。WebAuthn display name 和 `/v1/me` 中的主要显示字段
均为用户提交的 `name`，不是内部 email。

前端 Better Auth client 需要配置 `passkeyClient()`，调用契约为：

```ts
const { context } = await fetch(
  "https://api.file.thanejoss.com/v1/passkey/registration-context",
  {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  },
).then((response) => response.json());

await authClient.passkey.addPasskey({ name, context });
await authClient.signIn.passkey();
```

注册和登录成功后，服务端都会自动设置 Better Auth session cookie；之后跨域访问
`/v1/*` 仍需使用 `credentials: "include"`。

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
- `POST /v1/passkey/registration-context`，公开，仅签发短期一次性注册上下文
- `GET /v1/me`，需要 Better Auth session
- `GET /v1/usage`，返回当前用户 UTC 当月 TURN/SFU/R2 bytes 汇总
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

`GET /v1/usage` 返回结构：

```json
{
  "period": {
    "start": "2026-06-01T00:00:00.000Z",
    "end": "2026-06-20T04:40:00.000Z",
    "timezone": "UTC"
  },
  "summary": [
    { "service": "turn", "bytes": 0, "quotaBytes": null },
    { "service": "sfu", "bytes": 0, "quotaBytes": null },
    { "service": "r2", "bytes": 0, "quotaBytes": null }
  ],
  "totalBytes": 0,
  "totalQuotaBytes": null
}
```

`quotaBytes` 字段保留给前端稳定渲染；当前没有后端额度来源时返回 `null`。

TURN 请求体：

```json
{"ttlSeconds":3600}
```

R2 请求体：

```json
{"fileName":"example.bin","ttlSeconds":900,"fileSizeBytes":123456}
```

R2 响应包含 `accountId`、`bucket`、`endpoint`、服务端生成的 `objectKey`，
以及 `accessKeyId`、`secretAccessKey`、`sessionToken`、`expiresAt`。前端的
S3 签名实现必须同时发送 `sessionToken`。`fileSizeBytes` 可省略；省略时后端
无法确认本次上传大小，因此不会写入 R2 bytes 用量。

SFU 代理路径与 Cloudflare Realtime 的应用内路径一致，例如：

```txt
POST /v1/sfu/sessions/new
POST /v1/sfu/sessions/{sessionId}/datachannels/establish
PUT  /v1/sfu/sessions/{sessionId}/renegotiate
POST /v1/sfu/sessions/{sessionId}/datachannels/new
```
