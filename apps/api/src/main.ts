import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`Yanımda API :${port}/v1 (country=${process.env.COUNTRY_CODE ?? 'TR'})`);
}
bootstrap();
