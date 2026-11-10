# T-083 staging ortamı (Türkiye veri yerleşimi, KVKK): Huawei Cloud İstanbul (tr-west-1).
module "env" {
  source = "../../modules/yanimda-env"

  name        = "yanimda-staging"
  environment = "staging"
  tags        = { owner = "platform" }

  admin_cidrs  = var.admin_cidrs
  ssh_key_pair = var.ssh_key_pair

  vps_vcpus     = 4
  vps_memory_gb = 8

  db_version             = var.db_version
  db_vcpus               = 2
  db_memory_gb           = 4
  db_volume_gb           = 40
  db_ha_replication_mode = "semisync"
  db_backup_keep_days    = 7
  db_password            = var.db_password
  db_app_password        = var.db_app_password
  enable_timescaledb     = var.enable_timescaledb

  redis_capacity_gb = 1
  redis_password    = var.redis_password

  recordings_retention_days = 30
  backup_retention_days     = 14

  dns_zone        = var.dns_zone
  dns_create_zone = var.dns_create_zone
}
