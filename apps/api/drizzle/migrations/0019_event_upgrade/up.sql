-- 0019 · İnceleme bulgusu 1: alarm olmayan açık olaya (TEST, CALLBACK, FOLLOW_UP …) gerçek alarm gelince olay yükseltilir.
-- Zincir hangi tür/test bayrağı için planlandığını tutar; olay türü değişince bekleyen adımlar atlanıp yeni plan eklenir.
-- NULL = eski satır (yeniden planlanmaz).
ALTER TABLE chain.chain_run ADD COLUMN event_type text, ADD COLUMN is_test boolean;
