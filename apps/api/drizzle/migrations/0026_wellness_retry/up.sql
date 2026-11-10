-- 0026 · Düzenli arama güvenilirliği (gece karar 3–4): ulaşılamayan aramada tek yeniden deneme (attempts) ve atlanan
-- dönemin nedeni (outcome alanında: OPEN_EVENT / RECENT_CONTACT / NOT_PROTECTED).
ALTER TABLE event.check_call ADD COLUMN attempts int NOT NULL DEFAULT 0;
