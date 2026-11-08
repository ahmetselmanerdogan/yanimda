import { readdirSync, readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')));
let failed = false;
for (const f of readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.yaml'))) {
  const doc = YAML.parse(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
  if (!validate(doc)) {
    failed = true;
    console.error(f, validate.errors);
  } else console.log(`${f}: ok (${doc.rules.length} kural)`);
}
process.exit(failed ? 1 : 0);
