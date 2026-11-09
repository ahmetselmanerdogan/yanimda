import { readdirSync, readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const schema = (f) => ajv.compile(JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')));
const validateRules = schema('schema.json');
const validateProcedures = schema('procedures.schema.json');
const catalog = JSON.parse(readFileSync(new URL('../messages/tr.json', import.meta.url), 'utf8'));
const read = (f) => YAML.parse(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));

let failed = false;
const fail = (...m) => {
  failed = true;
  console.error(...m);
};
const yamls = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.yaml'));
const procedures = new Map();
for (const f of yamls.filter((f) => f.startsWith('procedures.'))) {
  const doc = read(f);
  if (!validateProcedures(doc)) fail(f, validateProcedures.errors);
  else {
    for (const [kind, s] of Object.entries(doc.steps))
      for (const code of [s.label, s.script].filter(Boolean))
        if (!catalog[code]) fail(`${f}: ${kind} → ${code} mesaj kataloğunda yok`);
    procedures.set(doc.country, doc);
    console.log(`${f}: ok (${Object.keys(doc.steps).length} adım türü)`);
  }
}
for (const f of yamls.filter((f) => !f.startsWith('procedures.'))) {
  const doc = read(f);
  if (!validateRules(doc)) {
    fail(f, validateRules.errors);
    continue;
  }
  const proc = procedures.get(doc.country);
  if (!proc) fail(`${f}: ${doc.country} için procedures.*.yaml yok`);
  else
    for (const r of doc.rules)
      for (const step of r.chain)
        if (!proc.steps[step.split(':')[0]]) fail(`${f}: ${r.type} zincirindeki ${step} prosedürde tanımlı değil`);
  console.log(`${f}: ok (${doc.rules.length} kural)`);
}
process.exit(failed ? 1 : 0);
