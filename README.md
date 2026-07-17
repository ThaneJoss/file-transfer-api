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
Durable Objects + Worker Secrets。鉴权只启用 Passkey，不提供 email/password 注册或登录。

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
2. 托管 TURN、R2、SFU 长期密钥，向已登录发送方或绑定单个取件码的访客接收方提供短期、受限访问。
3. 使用 Durable Object 保存 Direct/STUN/TURN/SFU/R2 的短期取件码信令，不保存文件内容。
4. 将流量字节和 Durable 请求次数写入 `usage_event`，并提供用户额度与管理统计。
5. 接收不包含文件名、取件码、Offer/Answer 或密钥的传输诊断事件，并写入 Cloudflare 结构化日志。

TURN 返回短期 `iceServers`。R2 返回仅限一个服务端生成对象 key 的临时 S3
凭证。Cloudflare Realtime SFU 没有可下发给浏览器的短期 App Token，因此
Worker 只代理文件传输需要的控制面接口，长期 App Token 不离开 Worker。

文件数据不经过 Worker 或 Durable Object。`usage_event.quantity` 配合 `unit` 记录
`bytes` 或 `requests`；
`credential.issued`、`session.create` 等控制面次数不作为额度依据。TURN 与 R2
凭证接口为兼容旧客户端仍可接收 `fileSizeBytes`，但签发凭证不计文件流量。五种传输方式
只在文件完成校验后，通过幂等的 `/v1/usage/transfers` 上报真实完成字节。

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

`R2_PARENT_ACCESS_KEY_ID` 使用 R2 token 的 Access Key ID。`R2_PARENT_API_TOKEN`
使用同一个 R2 token 的 Secret Access Key；也兼容原始 API token value，Worker 会先
派生对应的 Secret Access Key。Worker 在本地签发仅限目标对象的短期 S3 凭证，不调用
需要 Bearer Token 的 Cloudflare REST API。该 R2 token 至少需要目标 bucket 的 Object
Read & Write 权限。所有敏感值只放在 Cloudflare Worker Runtime Secrets，不写入 GitHub。

## R2 CORS

浏览器会直接向 R2 发送单次 `PUT`，或使用 `POST` / `PUT` 完成 multipart 上传，并从
预签名 URL 执行 `GET`。bucket CORS 需要允许生产前端 origin、`GET` / `PUT` / `POST` /
`DELETE`，以及上传请求实际发送的签名头：

```sh
pnpm r2:cors:apply
pnpm r2:cors:list
```

当前仓库的 Wrangler CORS 文件是 `config/r2-cors.json`，等价策略为：

```json
{
  "AllowedOrigins": ["https://file.thanejoss.com"],
  "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
  "AllowedHeaders": [
    "Authorization",
    "Content-Type",
    "x-amz-content-sha256",
    "x-amz-date",
    "x-amz-security-token"
  ],
  "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
  "MaxAgeSeconds": 3600
}
```

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

`migrations/0005_billing_quotas.sql` 将用量扩展为带单位的通用计费事件，并新增
`user_quota`。`migrations/0006_guest_claim_rate_limit.sql` 新增访客取件兑换的按分钟限流表；
发布访客接收前必须先应用。`PickupSession` Durable Object migration 随 `wrangler deploy`
自动应用。

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
- `GET /v1/usage`，返回当前用户 UTC 当月六类用量与额度
- `POST /v1/usage/transfers`，幂等记录五种方式已完成并校验的传输字节
- `POST /v1/pickups`，创建 8 位取件码；可省略 `offer` 先进入准备状态
- `POST /v1/pickups/{code}/guest`，公开且限流；签发只绑定该取件码、随取件码过期的访客 JWT
- `PUT /v1/pickups/{code}/offer`，发送方为已预留取件码一次性发布 Offer
- `GET /v1/pickups/{code}`，读取 Offer；尚未发布时返回 `202 pending`，可用 `?wait=20000` 长轮询
- `PUT /v1/pickups/{code}/answer`，写入 Answer
- `GET /v1/pickups/{code}/answer`，发送方读取 Answer，支持 `?wait=0..25000`
- `PUT /v1/pickups/{code}/selection`，发送方发布或更新当前激活的多路传输路线
- `GET /v1/pickups/{code}/selection`，已绑定接收方读取选定路线，支持 `?wait=0..25000`
- `PUT /v1/pickups/{code}/winner`，已绑定接收方一次性确认完成校验的获胜路线
- `GET /v1/pickups/{code}/winner`，发送方读取获胜路线和完整性结果，支持 `?wait=0..25000`
- `PUT /v1/pickups/{code}/cancel`，发送方或已绑定接收方取消传输
- `GET /v1/pickups/{code}/status`，发送方或已绑定接收方读取取消状态和过期时间，支持 `?wait=0..25000`
- `POST /v1/turn/credentials`
- `POST /v1/r2/credentials`
- `POST /v1/diagnostics/transfers`，接收脱敏、定长的线路结果与能力诊断
- `POST|PUT /v1/sfu/*`，仅允许文件传输所需的 SFU 控制面操作

多路协调接口在状态尚未产生时返回 `404`。写入 selection 或 winner 成功时返回
`{"accepted":true}`。selection 在 winner 产生前可更新，同一路线重试幂等；完全相同的 winner
重试也幂等成功，冲突 winner 或 winner 产生后再更新 selection 返回 `409`。selection 读取结果为 `{"route":"direct"}`；
winner 读取结果为 `{"route":"direct","bytes":123,"sha256":"..."}`。Pickup 的 Offer 和
Answer 最多各为 384 KiB（按 UTF-8 字节计）。
取消接口可幂等重试。取消后，Offer、Answer、selection 和 winner 的读写都返回 `410`，接收端可通过
status 接口及时停止正在进行的多路传输；winner 已确认后再取消返回 `409`。

访客令牌通过 `X-Pickup-Guest-Token` 发送。它只允许读取同一取件码的 Offer、selection、
status，写入 Answer、winner、cancel，以及调用接收端所需的 TURN、SFU 和诊断接口；不能
创建取件码、读取发送方 Answer/winner、访问用量或申请 R2 上传凭据。兑换接口按客户端
地址每分钟最多 12 次尝试，只保存由服务端 secret 加盐的地址哈希，并定期清理旧 bucket。

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
    { "service": "direct", "unit": "bytes", "usage": 0, "quota": null },
    { "service": "stun", "unit": "bytes", "usage": 0, "quota": null },
    { "service": "turn", "unit": "bytes", "usage": 0, "quota": null },
    { "service": "sfu", "unit": "bytes", "usage": 0, "quota": null },
    { "service": "r2", "unit": "bytes", "usage": 0, "quota": null },
    { "service": "durable", "unit": "requests", "usage": 0, "quota": null }
  ],
  "totals": { "bytes": 0, "requests": 0 },
  "quotas": { "bytes": null, "requests": null },
  "totalBytes": 0,
  "totalQuotaBytes": null
}
```

`bytes`、`quotaBytes`、`totalBytes` 和 `totalQuotaBytes` 作为旧前端兼容字段保留。

## 管理页

`https://api.file.thanejoss.com/admin/` 提供按类别、用户和时间聚合的统计，以及
逐用户、逐计费项的额度调整。该路径没有应用层鉴权，必须由 Cloudflare Zero Trust
Access 策略保护；`/admin/api/*` 同样依赖该策略。

TURN 请求体：

```json
{"ttlSeconds":3600}
```

R2 请求体：

```json
{"fileName":"example.bin","ttlSeconds":900,"fileSizeBytes":10485760}
```

断点续传时，已登录发送方可以额外提交上一次响应中的 `objectKey`。Worker 只接受
`users/{当前 userId}/` 前缀且没有路径穿越片段的 key，并重新签发仍只允许该单对象的短期
凭据；其他用户的 key 返回 `403`。

R2 响应包含 `accountId`、`bucket`、`endpoint`、服务端生成的 `objectKey`，
以及 `accessKeyId`、`secretAccessKey`、`sessionToken`、`expiresAt`。前端的
S3 签名实现必须同时发送 `sessionToken`。TURN 与 R2 的 `fileSizeBytes` 可省略；
该兼容字段不参与用量记录，实际完成字节统一由 `/v1/usage/transfers` 上报。

所有 API 响应统一设置 CSP、防嵌入、`nosniff`、HSTS、COOP、CORP、Permissions Policy
和 Referrer Policy；`/v1/*` 与 `/api/auth/*` 额外使用 `Cache-Control: no-store`。

## 代码验证

```sh
pnpm check
pnpm test
```

测试覆盖访客权限边界与限流数据、对象 key 所有权、Offer/Answer/selection/winner/status
长轮询唤醒、取消、幂等 winner 和五类已验证用量。Cloudflare Worker 测试池首次启动较重，
在低内存主机上应串行执行并给初始化预留时间。

SFU 代理路径与 Cloudflare Realtime 的应用内路径一致，例如：

```txt
POST /v1/sfu/sessions/new
POST /v1/sfu/sessions/{sessionId}/datachannels/establish
PUT  /v1/sfu/sessions/{sessionId}/renegotiate
POST /v1/sfu/sessions/{sessionId}/datachannels/new
```
