// T-001b: commit biçimi `<alan>(<PRD-id>): <özet>` (CLAUDE.md). Örn: backend(D-03): teyit zinciri yürütücüsü
// Kapsam: PRD kimliği (A-01, D-03 …), görev kimliği (T-001b) veya çapraz görev (X-02).
const AREAS = [
  'backend',
  'console',
  'watch',
  'phone',
  'ios',
  'family',
  'web',
  'contracts',
  'rules',
  'messages',
  'simulator',
  'infra',
  'ci',
  'docs',
  'test',
  'chore',
];
const SCOPE = /^([A-E]-\d{2}|T-\d{3}[a-z]?|X-\d{2})$/;

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'scope-prd-id': ({ scope }) => [
          !!scope && SCOPE.test(scope),
          `kapsam PRD/görev kimliği olmalı (örn. D-03, T-010, X-02); gelen: "${scope ?? ''}"`,
        ],
      },
    },
  ],
  rules: {
    'type-enum': [2, 'always', AREAS],
    'scope-empty': [2, 'never'],
    'scope-case': [0],
    'scope-prd-id': [2, 'always'],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
