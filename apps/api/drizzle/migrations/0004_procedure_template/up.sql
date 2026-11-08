-- 0004 · T-012 (D-02) kural paketi sürümleri. Her yüklenen paket (ülke, sürüm) bir kez kaydedilir;
-- aynı sürüm farklı içerikle yüklenemez (sürüm artırılmalı). Tüm API örnekleri en yeni sürümü buradan alır.
CREATE TABLE chain.procedure_template (
  country text NOT NULL,
  version int NOT NULL,
  checksum text NOT NULL,
  content jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  loaded_by text,
  PRIMARY KEY (country, version)
);
