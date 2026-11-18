# Keycloak sürümünün TEK kaynağı (kurulmaz; yalnız sürüm sabiti). Dependabot (docker, /infra/keycloak; ana sürüm
# atlanır) bu satırı günceller. Okuyanlar: ci.yml console-e2e ve security.yml ZAP (`sed -n 's/^FROM //p'`).
# Aynı değeri taşıması ZORUNLU yerler (infra/keycloak/keycloak.test.mjs eşliği denetler; Dependabot PR'ı bunlar
# güncellenmeden kırmızı kalır): infra/helm/yanimda/values.yaml keycloak.image, infra/docker-compose.yml,
# infra/docker-compose.prod.yml KEYCLOAK_IMAGE varsayılanı, infra/.env.prod.example KEYCLOAK_IMAGE.
FROM quay.io/keycloak/keycloak:26.0
