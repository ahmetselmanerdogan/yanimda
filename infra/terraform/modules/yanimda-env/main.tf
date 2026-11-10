locals {
  tags = merge({ project = "yanimda", environment = var.environment, managed_by = "terraform" }, var.tags)
  az   = data.huaweicloud_availability_zones.this.names
}

data "huaweicloud_availability_zones" "this" {}

# ---------------------------------------------------------------------------------------------------------------------
# Ağ: tek VPC, tek alt ağ. Genel IP yalnız VPS'te (EIP); RDS ve DCS yalnız iç ağda.
# ---------------------------------------------------------------------------------------------------------------------
resource "huaweicloud_vpc" "this" {
  name = var.name
  cidr = var.vpc_cidr
  tags = local.tags
}

resource "huaweicloud_vpc_subnet" "this" {
  name       = "${var.name}-app"
  vpc_id     = huaweicloud_vpc.this.id
  cidr       = var.subnet_cidr
  gateway_ip = var.subnet_gateway_ip
  tags       = local.tags
}

resource "huaweicloud_networking_secgroup" "vps" {
  name                 = "${var.name}-vps"
  description          = "Yanimda VPS: 80/443 genel, 22 yalniz yonetici CIDR"
  delete_default_rules = true
}

resource "huaweicloud_networking_secgroup_rule" "vps_egress" {
  security_group_id = huaweicloud_networking_secgroup.vps.id
  direction         = "egress"
  ethertype         = "IPv4"
  remote_ip_prefix  = "0.0.0.0/0"
}

resource "huaweicloud_networking_secgroup_rule" "vps_https" {
  for_each          = { http = 80, https = 443 }
  security_group_id = huaweicloud_networking_secgroup.vps.id
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = each.value
  port_range_max    = each.value
  remote_ip_prefix  = "0.0.0.0/0"
  description       = "Caddy ${each.key}"
}

resource "huaweicloud_networking_secgroup_rule" "vps_http3" {
  security_group_id = huaweicloud_networking_secgroup.vps.id
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "udp"
  port_range_min    = 443
  port_range_max    = 443
  remote_ip_prefix  = "0.0.0.0/0"
  description       = "Caddy HTTP/3"
}

resource "huaweicloud_networking_secgroup_rule" "vps_ssh" {
  for_each          = toset(var.admin_cidrs)
  security_group_id = huaweicloud_networking_secgroup.vps.id
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 22
  port_range_max    = 22
  remote_ip_prefix  = each.value
  description       = "SSH yonetici"
}

resource "huaweicloud_networking_secgroup" "db" {
  name                 = "${var.name}-db"
  description          = "RDS: 5432 yalniz VPS guvenlik grubundan"
  delete_default_rules = true
}

resource "huaweicloud_networking_secgroup_rule" "db_from_vps" {
  security_group_id = huaweicloud_networking_secgroup.db.id
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 5432
  port_range_max    = 5432
  remote_group_id   = huaweicloud_networking_secgroup.vps.id
  description       = "Postgres <- VPS"
}

# ---------------------------------------------------------------------------------------------------------------------
# VPS (ECS): 4 vCPU / 8 GB, ayrı veri diski, EIP. Docker + compose cloud-init ile kurulur; uygulama dağıtımı
# infra/README.md'deki adımlarla (compose dosyaları + .env.prod) yapılır.
# ---------------------------------------------------------------------------------------------------------------------
data "huaweicloud_compute_flavors" "vps" {
  availability_zone = local.az[0]
  performance_type  = "normal"
  cpu_core_count    = var.vps_vcpus
  memory_size       = var.vps_memory_gb
}

data "huaweicloud_images_image" "vps" {
  name        = var.vps_image_name
  visibility  = "public"
  most_recent = true
}

resource "huaweicloud_compute_instance" "vps" {
  name               = "${var.name}-vps"
  image_id           = data.huaweicloud_images_image.vps.id
  flavor_id          = data.huaweicloud_compute_flavors.vps.ids[0]
  availability_zone  = local.az[0]
  security_group_ids = [huaweicloud_networking_secgroup.vps.id]
  key_pair           = var.ssh_key_pair
  system_disk_type   = var.disk_type
  system_disk_size   = var.vps_system_disk_gb
  user_data          = templatefile("${path.module}/user_data.sh.tftpl", { data_mount = "/srv/yanimda" })
  tags               = local.tags

  network {
    uuid = huaweicloud_vpc_subnet.this.id
  }
}

resource "huaweicloud_evs_volume" "data" {
  name              = "${var.name}-data"
  volume_type       = var.disk_type
  size              = var.vps_data_disk_gb
  availability_zone = local.az[0]
  tags              = local.tags
}

resource "huaweicloud_compute_volume_attach" "data" {
  instance_id = huaweicloud_compute_instance.vps.id
  volume_id   = huaweicloud_evs_volume.data.id
}

resource "huaweicloud_vpc_eip" "vps" {
  publicip {
    type = var.eip_type
  }
  bandwidth {
    name        = "${var.name}-bw"
    size        = var.eip_bandwidth_mbit
    share_type  = "PER"
    charge_mode = "traffic"
  }
  tags = local.tags
}

resource "huaweicloud_compute_eip_associate" "vps" {
  public_ip   = huaweicloud_vpc_eip.vps.address
  instance_id = huaweicloud_compute_instance.vps.id
}

# ---------------------------------------------------------------------------------------------------------------------
# Yönetilen Postgres: birincil + bekleme farklı AZ'de (HA), otomatik yedek + WAL arşivi → PITR (RPO ≤ 15 dk hedefi;
# Huawei RDS PG artımlı WAL yedeğini ~5 dk'da bir alır). TimescaleDB uzantısı: README "Doğrulanacaklar".
# ---------------------------------------------------------------------------------------------------------------------
data "huaweicloud_rds_flavors" "db" {
  db_type       = "PostgreSQL"
  db_version    = var.db_version
  instance_mode = "ha"
  vcpus         = var.db_vcpus
  memory        = var.db_memory_gb
}

resource "huaweicloud_rds_instance" "db" {
  name                = "${var.name}-pg"
  flavor              = data.huaweicloud_rds_flavors.db.flavors[0].name
  ha_replication_mode = var.db_ha_replication_mode
  availability_zone   = [local.az[0], local.az[length(local.az) > 1 ? 1 : 0]]
  vpc_id              = huaweicloud_vpc.this.id
  subnet_id           = huaweicloud_vpc_subnet.this.id
  security_group_id   = huaweicloud_networking_secgroup.db.id
  time_zone           = "UTC+03:00"
  tags                = local.tags

  db {
    type     = "PostgreSQL"
    version  = var.db_version
    password = var.db_password
    port     = 5432
  }

  volume {
    type = var.db_volume_type
    size = var.db_volume_gb
  }

  backup_strategy {
    start_time = var.db_backup_window
    keep_days  = var.db_backup_keep_days
  }

  # PITR/RPO: WAL dosyası en geç 5 dk'da bir kapanır ve arşivlenir (RPO 15 dk kabulü için pay bırakır).
  parameters {
    name  = "archive_timeout"
    value = "300"
  }
}

# Uygulama hesabı ve veritabanı (root parolası yalnız yönetim için). Uzantılar: infra/init.sql ile aynı.
resource "huaweicloud_rds_pg_account" "app" {
  instance_id = huaweicloud_rds_instance.db.id
  name        = var.db_app_user
  password    = var.db_app_password
  description = "Yanimda API"
}

resource "huaweicloud_rds_pg_database" "app" {
  instance_id                = huaweicloud_rds_instance.db.id
  name                       = var.db_name
  owner                      = huaweicloud_rds_pg_account.app.name
  is_revoke_public_privilege = true
}

# TimescaleDB yönetilen RDS'te uzantı olarak kurulur; sürüm/bölge desteği apply öncesi doğrulanmalı (README).
# enable_timescaledb=false ise Timescale ayrı VM/birimde çalıştırılır (README "Geri dönüş").
resource "huaweicloud_rds_pg_plugin" "ext" {
  for_each      = toset(concat(["pgcrypto"], var.enable_timescaledb ? ["timescaledb"] : []))
  instance_id   = huaweicloud_rds_instance.db.id
  database_name = huaweicloud_rds_pg_database.app.name
  name          = each.value
}

# ---------------------------------------------------------------------------------------------------------------------
# Yönetilen Redis (DCS, master/standby farklı AZ). Yalnız alt ağdan erişim (beyaz liste).
# ---------------------------------------------------------------------------------------------------------------------
data "huaweicloud_dcs_flavors" "redis" {
  engine         = "Redis"
  engine_version = var.redis_version
  cache_mode     = "ha"
  capacity       = var.redis_capacity_gb
}

resource "huaweicloud_dcs_instance" "redis" {
  name               = "${var.name}-redis"
  engine             = "Redis"
  engine_version     = var.redis_version
  capacity           = var.redis_capacity_gb
  flavor             = data.huaweicloud_dcs_flavors.redis.flavors[0].name
  availability_zones = [local.az[0], local.az[length(local.az) > 1 ? 1 : 0]]
  vpc_id             = huaweicloud_vpc.this.id
  subnet_id          = huaweicloud_vpc_subnet.this.id
  password           = var.redis_password
  whitelist_enable   = true
  tags               = local.tags

  whitelists {
    group_name = "app-subnet"
    ip_address = [var.subnet_cidr]
  }

  backup_policy {
    backup_type = "auto"
    save_days   = 3
    period_type = "weekly"
    backup_at   = [1, 2, 3, 4, 5, 6, 7]
    begin_at    = "02:00-03:00"
  }
}

# ---------------------------------------------------------------------------------------------------------------------
# Nesne deposu (OBS, S3 uyumlu): görüşme kayıtları (WORM / nesne kilidi, COMPLIANCE) ve veritabanı dökümleri.
# ---------------------------------------------------------------------------------------------------------------------
# WORM: API her kaydı x-amz-object-lock-mode=COMPLIANCE + retain-until ile yazar; kovada nesne kilidi AÇIK olmalı.
# huaweicloud_obs_bucket WORM argümanı sunmuyor (sağlayıcı 1.100) → kova S3 API ile nesne kilidiyle oluşturulup
# `terraform import` edilir (README "Kayıt kovası WORM").
resource "huaweicloud_obs_bucket" "recordings" {
  bucket        = "${var.name}-recordings"
  acl           = "private"
  storage_class = "STANDARD"
  versioning    = true
  multi_az      = true
  encryption    = true
  sse_algorithm = "AES256"
  force_destroy = false
  tags          = local.tags
}

resource "huaweicloud_obs_bucket" "backups" {
  bucket        = "${var.name}-backups"
  acl           = "private"
  storage_class = "STANDARD"
  versioning    = true
  multi_az      = true
  encryption    = true
  sse_algorithm = "AES256"
  force_destroy = false
  tags          = local.tags

  lifecycle_rule {
    name    = "pg-dump-retention"
    prefix  = "pg/"
    enabled = true
    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      days = 7
    }
  }
}

# ---------------------------------------------------------------------------------------------------------------------
# DNS: tüm genel adlar VPS EIP'ine. TLS sertifikalarını Caddy (ACME HTTP-01/TLS-ALPN) otomatik alır.
# ---------------------------------------------------------------------------------------------------------------------
resource "huaweicloud_dns_zone" "this" {
  count     = var.dns_create_zone ? 1 : 0
  name      = "${var.dns_zone}."
  email     = var.dns_email
  zone_type = "public"
  ttl       = 300
  tags      = local.tags
}

data "huaweicloud_dns_zones" "existing" {
  count     = var.dns_create_zone ? 0 : 1
  name      = "${var.dns_zone}."
  zone_type = "public"
}

locals {
  dns_zone_id = var.dns_create_zone ? huaweicloud_dns_zone.this[0].id : data.huaweicloud_dns_zones.existing[0].zones[0].id
}

resource "huaweicloud_dns_recordset" "app" {
  for_each = toset(var.dns_records)
  zone_id  = local.dns_zone_id
  name     = "${each.value}.${var.dns_zone}."
  type     = "A"
  ttl      = 300
  records  = [huaweicloud_vpc_eip.vps.address]
}
