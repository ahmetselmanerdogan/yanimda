/**
 * T-081 PII log denetimi (CI): verilen log dosyalarını / dizinlerini tarar; bulgu varsa 1 ile çıkar.
 *   tsx test/e2e/pii-audit-cli.ts test-results/logs test-results-stack.log
 * Çıktıda değer yazılmaz: dosya:satır, tür ve maskeli örnek. Simülatörün sabit test konumu (40.9873, 29.0291) ve
 * sahte CPaaS'ın masa hattı test verisidir; burada istisna yok — bunlar log'a düşerse yine bulgu sayılır.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { scanPii } from '../support/pii-scan';

const files = (p: string): string[] =>
  !existsSync(p)
    ? []
    : statSync(p).isDirectory()
      ? readdirSync(p).flatMap((f) => files(join(p, f)))
      : /\.(log|out|txt)$/.test(p)
        ? [p]
        : [];

const targets = process.argv.slice(2).flatMap(files);
if (!targets.length) {
  console.error('taranacak log yok:', process.argv.slice(2).join(' '));
  process.exit(2);
}
let total = 0;
for (const f of targets) {
  const findings = scanPii(readFileSync(f, 'utf8'));
  total += findings.length;
  for (const x of findings.slice(0, 50)) console.error(`${f}:${x.line} ${x.kind} ${x.sample}`);
}
console.log(`PII log denetimi: ${targets.length} dosya, ${total} bulgu`);
process.exit(total ? 1 : 0);
