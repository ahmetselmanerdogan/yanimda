# T-007: çok aşamalı API imajı (node:20-alpine). Repo kökünden kurulur:
#   docker build -f apps/api/Dockerfile -t yanimda-api .
# Çalışma anı düzeni monorepo ile aynıdır: dist/ kural paketini (packages/rules/*.yaml) ve
# sinyal şemasını (packages/contracts/schemas) göreli yoldan okur.

FROM node:20-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @yanimda/api... build \
 && pnpm --filter @yanimda/api deploy --prod /out/apps/api \
 && cp -r apps/api/dist /out/apps/api/dist \
 && mkdir -p /out/packages/contracts /out/packages/rules \
 && cp -r packages/contracts/schemas /out/packages/contracts/schemas \
 && cp packages/rules/*.yaml packages/rules/schema.json /out/packages/rules/

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
