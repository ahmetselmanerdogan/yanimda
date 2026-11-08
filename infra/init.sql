-- Postgres ilk açılışta (docker-entrypoint-initdb.d) süper kullanıcıyla çalışır: yalnız uzantılar.
-- Şema ve tablolar migration'dadır: apps/api/drizzle/migrations (pnpm --filter @yanimda/api db:migrate).
-- Demo verisi: pnpm --filter @yanimda/api db:seed
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
