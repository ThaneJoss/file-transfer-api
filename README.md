# file-transfer-api

Cloudflare Worker API for `api.file.thanejoss.com`, built with Hono, Better Auth, Cloudflare D1, and Worker Secrets.

## Local setup

```sh
pnpm install
cp .dev.vars.example .dev.vars
openssl rand -base64 32
pnpm db:migrations:apply:local
pnpm dev
```

Put the generated secret in `.dev.vars` as `BETTER_AUTH_SECRET`.

For local secret-read checks, you can also add:

```sh
test_secret=123456
```

## Cloudflare setup

```sh
pnpm wrangler d1 create file-transfer-api-db
```

Copy the returned `database_id` into `wrangler.jsonc`, then set the production secrets and apply migrations:

```sh
openssl rand -base64 32 | pnpm wrangler secret put BETTER_AUTH_SECRET
printf '123456' | pnpm wrangler secret put test_secret
pnpm db:migrations:apply:remote
pnpm deploy
```

The Worker route is configured as a Custom Domain:

```txt
https://api.file.thanejoss.com
```

## API

- `GET /` service metadata
- `GET /health` D1 smoke check
- `GET|POST /api/auth/*` Better Auth handler
- `GET /v1/me` current Better Auth session
- `GET /debug/secret` secret-read smoke check without returning the secret value
