# ---- build: compile TypeScript with dev dependencies ----
FROM node:22.12.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY loadtest ./loadtest
RUN npm run build

# ---- dev: sources + dev deps, used by `docker compose run test` ----
FROM build AS dev
COPY vitest.config.ts ./
COPY test ./test
COPY migrations ./migrations
COPY shared ./shared
CMD ["npm", "test"]

# ---- runtime: production deps + compiled output only ----
FROM node:22.12.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY shared/mock-data/generate.mjs ./shared/mock-data/generate.mjs
USER node
CMD ["node", "dist/src/main/api.js"]