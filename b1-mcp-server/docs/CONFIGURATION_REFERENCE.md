# Configuration Reference

All server behaviour is controlled through environment variables in the `.env` file in the project root. Copy `.env.example` to `.env` as a starting point.

Variables marked **Yes** in the **Required** column have no built-in default and must be supplied. The **Mode** column indicates which authentication mode the variable applies to: `direct`, `oauth`, or `both`.

## Authentication

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `AUTHENTICATION_MODE` | both | No | `direct` | `direct` (B1 username/password) or `oauth` (Keycloak/OIDC token validation) |
| `NODE_ENV` | both | No | `production` | Runtime environment: `production` (minimal error exposure) or `development` (verbose errors) |
| `AUTH_ALLOW_SELF_SIGNED` | both | No | `false` | Bypass SSL certificate verification — dev/testing only. Never enable in production |

## SAP Business One Connection

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `SERVICE_LAYER_ROOT_URL` | both | Yes | — | B1 Service Layer host only — server appends `/b1s/v2/` internally (e.g. `https://servicelayer.b1.example.com:50000`) |
| `B1_COMPANY_DB` | direct | Yes | — | Company database name |
| `B1_USERNAME` | direct | Yes | — | B1 user name |
| `B1_PASSWORD` | direct | Yes | — | B1 user password |
| `SLD_ROOT_URL` | oauth | Yes | — | SAP System Landscape Directory URL |

## OAuth / Token Validation

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `OAUTH_BASE_URL` | oauth | Yes | — | OAuth provider base URL used to derive token, introspection, and JWKS endpoints (e.g. `https://keycloak.b1.example.com/auth/realms/sapb1`) |
| `OAUTH_CLIENT_ID` | oauth | Yes | — | OAuth client ID registered on the provider |
| `OAUTH_CLIENT_SECRET` | oauth | Yes | — | OAuth client secret (from Keycloak Credentials tab) |
| `OAUTH_REQUIRED_SCOPES` | oauth | No | `b1_mcp:access` | Comma-separated OAuth scopes required on incoming bearer tokens; also advertised via OAuth metadata |
| `OAUTH_VERIFY_SCOPES` | oauth | No | `true` | Enable/disable OAuth scope enforcement for MCP bearer tokens |
| `VALIDATE_AUDIENCE` | oauth | No | `true` | Validate token `aud` claim against `OAUTH_CLIENT_ID`. Set to `false` only if your OAuth provider cannot issue audience-restricted tokens |
| `TOKEN_VALIDATION_MODE` | oauth | No | `introspection-with-jwt-fallback` | How incoming access tokens are verified: `introspection` (remote only, fails closed), `jwt` (local signature only, no revocation check), or `introspection-with-jwt-fallback` (remote first, local fallback on AS unavailability) |

## HTTPS / Transport

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `PORT` | both | No | `3000` | HTTP/HTTPS server port |
| `HTTPS_ENABLED` | both | No | `true` | `true` uses HTTPS (requires key + cert); `false` uses plain HTTP |
| `HTTPS_KEY_PATH` | both | No | `./certs/server.key` | Path to PEM-encoded TLS private key file |
| `HTTPS_CERT_PATH` | both | No | `./certs/server.crt` | Path to PEM-encoded TLS certificate file (may include the full chain) |
| `HTTPS_CA_PATH` | both | No | — | Optional CA bundle path for HTTPS chain |
| `HTTPS_PASSPHRASE` | both | No | — | Optional passphrase for encrypted private keys |
| `MCP_BASE_URL` | oauth | No | localhost-derived | Public base URL advertised in OAuth/MCP metadata. Leave unset for local development; set when the server is behind a reverse proxy or deployed at a public hostname (e.g. `https://mcp.example.com`) |
| `MCP_ALLOWED_HOSTS` | both | No | `127.0.0.1,localhost` | Comma-separated hostnames accepted in the HTTP `Host` header — DNS rebinding protection |
| `CORS_ALLOWED_ORIGINS` | both | No | _(empty — CORS disabled)_ | Comma-separated origins allowed for cross-origin requests. Use `*` to allow all (not recommended for production) |

## Session & Rate Limiting

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `SESSION_TIMEOUT_MINUTES` | both | No | `30` | MCP HTTP session idle timeout in minutes. Expired sessions are cleaned up and audited |
| `REQUEST_BODY_LIMIT` | both | No | `1mb` | Max request body size (e.g. `2mb`, `512kb`). Keep small to limit memory use and mitigate DoS risk |
| `MCP_RATE_LIMIT_WINDOW_MINUTES` | both | No | `1` | Rate limit window size for `/mcp` in minutes |
| `MCP_RATE_LIMIT_MAX` | both | No | `120` | Max requests allowed per client per window (keyed by session ID, falls back to IP) |

## Human Confirmation

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `MCP_HUMAN_CONFIRMATION_ENABLED` | both | No | `true` | Require MCP elicitation for human confirmation before write operations (POST/PATCH/DELETE). Set to `false` to bypass in automated pipelines |

## Caching

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `COMPANY_LIST_CACHE_TTL_MINUTES` | oauth | No | `5` | Minutes to cache the SLD company list per access token. Increase to reduce SLD load |
| `METADATA_CACHE_TTL_MINUTES` | both | No | `30` | Minutes to cache SAP B1 OData metadata (entity list and per-entity schemas). Increase to reduce Service Layer load; decrease to pick up schema changes (UDFs, UDOs) faster |

## Application Logging

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `APP_LOG_LEVEL` | both | No | `info` | Log verbosity: `error`, `warn`, `info`, `debug` |
| `APP_LOG_FILE_ENABLED` | both | No | `true` | Write application logs to a rotating file |
| `APP_LOG_CONSOLE_ENABLED` | both | No | `false` | Write application logs to stdout |
| `APP_LOG_MAX_SIZE_BYTES` | both | No | `10485760` | Maximum log file size before rotation (default 10 MB) |
| `APP_LOG_RETENTION_DAYS` | both | No | `90` | Days to retain rotated application log files |

## Audit Logging

| Variable | Mode | Required | Default | Description |
| -------- | ---- | -------- | ------- | ----------- |
| `AUDIT_LOG_FILE_ENABLED` | both | No | `true` | Write audit events to a rotating file. Keep enabled in production |
| `AUDIT_LOG_CONSOLE_ENABLED` | both | No | `false` | Write audit events to stdout |
| `AUDIT_LOG_MAX_SIZE_BYTES` | both | No | `10485760` | Maximum audit log file size before rotation (default 10 MB) |
| `AUDIT_LOG_RETENTION_DAYS` | both | No | `365` | Days to retain rotated audit log files. Tune to meet compliance requirements |

## Integration Tests

These variables are only used when running `npm run test:integration`. They are not read by the server at runtime.

| Variable | Required | Default | Description |
| -------- | -------- | ------- | ----------- |
| `TEST_MCP_CLIENT_ID` | Yes | — | OAuth client ID used by integration tests. Must have Authorization Code + PKCE enabled and `http://127.0.0.1:*/callback` as an allowed redirect URI in Keycloak |
| `TEST_OAUTH_SCOPES` | No | `email b1_mcp:access profile` | Space-separated OAuth scopes requested during integration tests |
| `TEST_OAUTH_INTERACTIVE` | No | `true` | Set to `true` to trigger a browser-based OAuth PKCE login flow when running integration tests |
