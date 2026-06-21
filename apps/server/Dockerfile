FROM oven/bun:1.3
WORKDIR /app

# Install deps against the committed lockfile, then build the SPA the server will serve.
COPY . .
RUN bun install --frozen-lockfile
# Bake the subdomain base domain into the SPA (apps/web/src/lib/tenant.ts). Defaults to
# localhost for a bare build; compose passes hera.local for the wildcard prod profile.
ARG VITE_APP_BASE_DOMAIN=localhost
RUN VITE_APP_BASE_DOMAIN="$VITE_APP_BASE_DOMAIN" bun run build:web

EXPOSE 3000
# Run migrations once per deploy:  docker compose run --rm server bun run db:migrate
# cwd = apps/server so the server's default WEB_DIST (../web/dist) resolves to the SPA build.
CMD ["bun", "run", "--cwd", "apps/server", "start"]
