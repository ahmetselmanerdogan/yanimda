import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureHttpSecurity } from './common/http-security';
import { ProblemFilter } from './common/problem.filter';
import { assertAdminTokenPolicy } from './modules/rules/admin-token.guard';

async function bootstrap() {
  // T-081 G-4: üretimde paylaşılan yönetici anahtarı yasak; veritabanına bağlanmadan önce düşer.
  assertAdminTokenPolicy();
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
    rawBody: true, // T-060: ödeme webhook imzası ham gövde üzerinden
  });
  configureHttpSecurity(app); // T-081: güvenlik başlıkları, korelasyon kimliği, trust proxy
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`Yanımda API :${port}/v1 (country=${process.env.COUNTRY_CODE ?? 'TR'})`);
}
bootstrap();
