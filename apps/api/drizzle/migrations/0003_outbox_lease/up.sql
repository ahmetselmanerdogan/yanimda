-- 0003 · Outbox işçisi kirası (lease). Tek aktif işçi (sıra garantisi) uzun transaction tutmadan sağlanır:
-- işçi kirayı alır/yeniler, teslimleri transaction dışında yapar. Süreç ölürse kira süresi dolunca başkası devralır.
CREATE TABLE event.outbox_lease (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  owner text NOT NULL,
  until timestamptz NOT NULL
);
