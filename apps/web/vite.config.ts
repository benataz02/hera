import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// Dev proxy keeps the SPA same-origin with the API, so Better Auth cookies just work
// and there's no CORS to configure. ponytail: proxy over CORS.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  server: {
    // Bind IPv4 (0.0.0.0) — lvh.me resolves to 127.0.0.1; Vite's default `localhost` bind is
    // IPv6-only (::1) on Windows, which lvh.me can't reach (connection refused).
    host: true,
    // Tenant subdomains: acme.lvh.me:5173 (lvh.me + *.lvh.me resolve to 127.0.0.1, and unlike
    // localhost a `.lvh.me` cookie is shared across subdomains). Vite blocks unknown hosts.
    allowedHosts: [".lvh.me", ".localhost"],
    proxy: {
      // changeOrigin:false keeps the tenant Host (acme.localhost) so the server resolves
      // the tenant from it — see apps/server/src/orpc/base.ts.
      "/rpc": { target: "http://localhost:3000", changeOrigin: false },
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});
