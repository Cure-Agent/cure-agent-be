# cure-agent-be 런타임 이미지 (docs/specs/16)
# multi-stage: 빌드 도구·devDependencies가 런타임 이미지에 남지 않게 한다.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 비-root 실행 (node:alpine 기본 제공 사용자)
USER node
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# 마이그레이션은 컨테이너에서 실행할 수 있어야 한다 — drizzle-kit은 devDep이라
# 프로덕션에서는 scripts/migrate.mjs(drizzle-orm 내장 migrator)를 쓴다 (deploy.sh 참조)
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=node:node /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 3000
# graceful shutdown은 앱의 enableShutdownHooks가 담당한다 (main.ts)
CMD ["node", "dist/main"]
