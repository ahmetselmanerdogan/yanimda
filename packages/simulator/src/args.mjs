// CLI argümanları (saf; args.test.mjs). `pnpm --filter @yanimda/simulator start -- fall …` çıplak `--`'yı da
// iletir: o ayraç atılır, yoksa komut sanılıp atlanır ve komut değeri bir seçenek değerine kayardı.

/** Değer almayan bayraklar (sonraki argüman komut olabilir). */
export const FLAGS = new Set(['--dry', '--no-cancel', '--off']);

export function parseArgs(argv) {
  const args = argv.filter((a) => a !== '--');
  const cmd =
    args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !FLAGS.has(args[i - 1]))) ??
    'heartbeat';
  const opt = (k, d) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? (args[i + 1] ?? true) : d;
  };
  const has = (flag) => args.includes(flag);
  return { args, cmd, opt, has };
}
