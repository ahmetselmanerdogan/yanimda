output "vps_public_ip" {
  description = "VPS EIP (DNS kayıtları bu adrese)"
  value       = huaweicloud_vpc_eip.vps.address
}

output "vps_private_ip" {
  value = huaweicloud_compute_instance.vps.access_ip_v4
}

output "db_private_ip" {
  description = "DATABASE_URL için RDS iç adresi"
  value       = try(huaweicloud_rds_instance.db.private_ips[0], null)
}

output "redis_address" {
  description = "REDIS_URL için DCS iç adresi (host:port)"
  value       = "${huaweicloud_dcs_instance.redis.private_ip}:${huaweicloud_dcs_instance.redis.port}"
}

output "recordings_bucket" {
  value = huaweicloud_obs_bucket.recordings.bucket
}

output "backups_bucket" {
  value = huaweicloud_obs_bucket.backups.bucket
}

output "obs_endpoint" {
  description = "S3_ENDPOINT (OBS S3 uyumlu uç)"
  value       = "https://${huaweicloud_obs_bucket.backups.bucket_domain_name}"
}

output "dns_nameservers" {
  description = "Alan adı kayıt firmasına verilecek NS'ler (bölge burada oluşturulduysa)"
  value       = var.dns_create_zone ? huaweicloud_dns_zone.this[0].masters : []
}

output "hostnames" {
  value = [for r in var.dns_records : "${r}.${var.dns_zone}"]
}

output "recordings_retention_days" {
  description = "API RECORDING_RETENTION_DAYS ile aynı tutulmalı"
  value       = var.recordings_retention_days
}

output "db_name" {
  value = huaweicloud_rds_pg_database.app.name
}
