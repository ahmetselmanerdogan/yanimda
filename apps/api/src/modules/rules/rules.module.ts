import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { safeError } from '../../common/safe-error';
import { RULES } from '../event/rules.loader';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

/** Açılışta paketi yükler; diğer örneklerin yüklediği sürümleri periyodik olarak alır. */
@Injectable()
class RulesLifecycle implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('RulesService');
  private timer?: NodeJS.Timeout;
  constructor(@Inject(RulesService) private readonly rules: RulesService) {}
  async onModuleInit() {
    await this.rules.init();
  }
  onApplicationBootstrap() {
    const every = Number(process.env.RULES_REFRESH_MS ?? 30_000);
    if (every > 0)
      this.timer = setInterval(
        () => void this.rules.refresh().catch((e) => this.log.warn(`Kural yenileme: ${safeError(e)}`)),
        every,
      );
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
}

@Global()
@Module({
  controllers: [RulesController],
  providers: [RulesService, { provide: RULES, useExisting: RulesService }, RulesLifecycle],
  exports: [RulesService, RULES],
})
export class RulesModule {}
