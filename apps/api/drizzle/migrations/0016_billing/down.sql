DROP TABLE IF EXISTS profile.payment_webhook;
DROP INDEX IF EXISTS profile.subscription_due_idx;
DROP INDEX IF EXISTS profile.subscription_checkout_ref_idx;
DROP INDEX IF EXISTS profile.subscription_provider_ref_idx;
ALTER TABLE profile.subscription
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS explicit_consent_at,
  DROP COLUMN IF EXISTS kvkk_notice_version,
  DROP COLUMN IF EXISTS last_provider_event_at,
  DROP COLUMN IF EXISTS suspended_at,
  DROP COLUMN IF EXISTS grace_until,
  DROP COLUMN IF EXISTS past_due_since,
  DROP COLUMN IF EXISTS trial_ends_at,
  DROP COLUMN IF EXISTS checkout_ref,
  DROP COLUMN IF EXISTS provider_subscription_ref,
  DROP COLUMN IF EXISTS provider_customer_ref,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS country_code;
