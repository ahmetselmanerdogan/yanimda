# T-007: çok aşamalı API imajı (node:26-alpine, LTS). Repo kökünden kurulur:
#   docker build -f apps/api/Dockerfile -t yanimda-api .
# Çalışma anı düzeni monorepo ile aynıdır: dist/ kural paketini (packages/rules/*.yaml) ve
# sinyal şemasını (packages/contracts/schemas) göreli yoldan okur.

FROM node:26-alpine AS build
WORKDIR /repo
# Node 25+ corepack içermez: pnpm sürümü package.json packageManager ile aynı.
RUN npm install -g pnpm@9.12.0
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @yanimda/api... build \
 && pnpm --filter @yanimda/api deploy --prod /out/apps/api \
 && cp -r apps/api/dist /out/apps/api/dist \
 && mkdir -p /out/packages/contracts /out/packages/rules \
 && cp -r packages/contracts/schemas /out/packages/contracts/schemas \
 && cp packages/rules/*.yaml packages/rules/schema.json /out/packages/rules/

FROM node:26-alpine AS runtime
ENV NODE_ENV=production PORT=3000
# Güvenlik (Trivy): işletim sistemi paketlerini yamala; çalışma anında gerekmeyen npm/corepack/yarn'ı kaldır
# (açıkların çoğu npm'in kendi paketlerindeydi: tar, glob, minimatch, cross-spawn …).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
