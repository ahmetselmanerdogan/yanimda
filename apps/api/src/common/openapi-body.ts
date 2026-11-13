import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BadRequestException, type PipeTransform } from '@nestjs/common';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

/**
 * T-081 (ASVS 5.1.4, 13.2.2) istek gövdesi OpenAPI şemasıyla doğrulanır: `packages/contracts/openapi.yaml` tek kaynak
 * (`operationId` → `requestBody.content.application/json.schema`, JSON Schema 2020-12 / OpenAPI 3.1). Servisteki
 * elle doğrulama (iş kuralları) yerinde kalır; şema önce yapıyı (tür, zorunlu alan, uzunluk, desen, enum) keser.
 * Hata ayrıntısı yalnız alan yolu + kural adı (değer yok, PII yok).
 */
const SPEC_PATH = join(__dirname, '../../../../packages/contracts/openapi.yaml');
const BASE = 'https://yanimda.local/openapi.json';

interface Operation {
  validate: ValidateFunction;
  required: boolean;
}

type Spec = {
  paths: Record<string, Record<string, { operationId?: string; requestBody?: RequestBody }>>;
  components?: unknown;
};
type RequestBody = { required?: boolean; content?: Record<string, { schema?: unknown }> };

let ajv: Ajv2020 | undefined;
let operations: Map<string, { schema: unknown; required: boolean }> | undefined;
const compiled = new Map<string, Operation>();

/**
 * `$ref` düzeltmesi: `#/components/...` → bileşenlerin yüklendiği temel kimlik (işlem şeması ayrı derlenir);
 * `./schemas/<dosya>` (ör. sinyal şeması) → o dosyanın kendi `$id`'si.
 */
function rebase(v: unknown, files: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(v)) return v.map((x) => rebase(x, files));
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => {
      if (k !== '$ref' || typeof x !== 'string') return [k, rebase(x, files)];
      if (x.startsWith('#/')) return [k, `${BASE}${x}`];
      return [k, files.get(x) ?? x];
    }),
  );
}

const externalIds = new Map<string, string>();

function load(specPath = SPEC_PATH) {
  if (ajv && operations) return { ajv, operations };
  const spec = parse(readFileSync(specPath, 'utf8')) as Spec;
  // strict: false — OpenAPI ek anahtarları (example, x-…) JSON Schema'da bilinmiyor.
  const a = new Ajv2020({ strict: false, allErrors: true });
  addFormats(a);
  for (const file of ['signal.schema.json']) {
    const s = JSON.parse(readFileSync(join(dirname(specPath), 'schemas', file), 'utf8')) as { $id: string };
    a.addSchema(s);
    externalIds.set(`./schemas/${file}`, s.$id);
  }
  a.addSchema({ $id: BASE, components: rebase(spec.components, externalIds) });
  const ops = new Map<string, { schema: unknown; required: boolean }>();
  for (const methods of Object.values(spec.paths))
    for (const op of Object.values(methods)) {
      const schema = op?.requestBody?.content?.['application/json']?.schema;
      if (op?.operationId && schema) ops.set(op.operationId, { schema, required: !!op.requestBody?.required });
    }
  ajv = a;
  operations = ops;
  return { ajv: a, operations: ops };
}

/** Sözleşmedeki tüm JSON gövdeli işlemler (test: hepsi derlenebilir). */
export function jsonBodyOperations(): string[] {
  return [...load().operations.keys()];
}

export function bodyValidator(operationId: string): Operation {
  const hit = compiled.get(operationId);
  if (hit) return hit;
  const { ajv: a, operations: ops } = load();
  const op = ops.get(operationId);
  if (!op) throw new Error(`OpenAPI: ${operationId} için application/json requestBody yok`);
  const v = { validate: a.compile(rebase(op.schema, externalIds) as object), required: op.required };
  compiled.set(operationId, v);
  return v;
}

/** Değer içermeyen hata özeti: `/contacts/0/phone pattern; / required(displayName)`. */
export function describeErrors(errors: ErrorObject[] | null | undefined): string {
  const seen = new Set<string>();
  for (const e of errors ?? []) {
    const extra = e.keyword === 'required' ? `(${(e.params as { missingProperty?: string }).missingProperty})` : '';
    seen.add(`${e.instancePath || '/'} ${e.keyword}${extra}`);
    if (seen.size >= 10) break;
  }
  return [...seen].join('; ');
}

/**
 * `@Body(new OpenApiBody('createProtectedPerson'))`. Şema derlemesi sınıf tanımında (açılışta) yapılır: sözleşmede
 * olmayan `operationId` API'yi açmaz. Gövde yoksa ve sözleşmede zorunlu değilse servis karar verir.
 */
export class OpenApiBody implements PipeTransform {
  private readonly op: Operation;
  constructor(readonly operationId: string) {
    this.op = bodyValidator(operationId);
  }

  transform(value: unknown): unknown {
    if (value === undefined && !this.op.required) return value;
    if (!this.op.validate(value))
      throw new BadRequestException(`Gövde şemaya uymuyor: ${describeErrors(this.op.validate.errors)}`);
    return value;
  }
}
