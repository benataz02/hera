# Keycloak Setup for SAP Business One MCP Server

The following Keycloak configuration is required for OAuth mode. It applies to all MCP clients (Cline, GitHub Copilot, or custom clients).

> This configuration is intended for **testing and experimentation only**. Review and harden before production use.

## Step 1 — Register the MCP Server as a confidential client

1. Keycloak Admin Console → **Clients** → **Create client**.
2. Set **Client ID** (e.g. `b1-mcp-server`), enable **Client authentication**, click **Next**.
3. Set **Valid Redirect URIs** to your MCP server URL (e.g. `http://localhost:3000/*`) and save.
4. Open the **Credentials** tab, copy the **Client Secret**, and set it as `OAUTH_CLIENT_SECRET` in `.env`.

## Step 2 — Create the required client scope

1. **Client scopes** → **Create scope**: name exactly `b1_mcp:access`, type `Default`, enable **Include in token scope**.

## Step 3 — Add an audience mapper

1. Open the `b1_mcp:access` scope → **Mappers** → **Configure a new mapper** → **Audience**.
2. Name: `b1_mcp_audience_config`; **Included Client Audience**: your client ID (e.g. `b1-mcp-server`).

## Step 4 — Configure trusted hosts for Dynamic Client Registration (for VS Code clients and some desktop clients like Goose)

VS Code-based MCP clients such as Cline and GitHub Copilot may use **OAuth 2.0 Dynamic Client Registration** (RFC 7591) to register themselves automatically with Keycloak at runtime. Keycloak's Trusted Hosts policy controls which hosts are permitted to perform this dynamic registration. If the client's IP address is not in the trusted list, the registration request is rejected and the OAuth flow cannot start.

1. **Clients** → **Client registration** → **Trusted Hosts**.
2. Disable **Client URIs Must Match** and add the host IP(s) you are testing from (`ipconfig` on Windows, `ifconfig` on Linux/macOS).
3. If connections are rejected, check Keycloak logs for `Failed to verify remote host : <IP>` to find the bridge address used by the VS Code client (e.g. Cline may use a private bridge address such as `172.30.4.190`; GitHub Copilot may use a local or loopback address).

With this configuration, every time the authorization flow is triggered, the MCP server will receive a token that includes the `b1_mcp:access` scope and validate it against Keycloak.
