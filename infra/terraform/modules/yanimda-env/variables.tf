# T-083 tek ortam (staging / prod): 1 VPS + yönetilen Postgres (HA, PITR) + yönetilen Redis + OBS kovaları + DNS.
# Sağlayıcıya özgü olan yalnız bu modüldür; compose ve Helm sağlayıcıdan bağımsızdır.

variable "name" {
  description = "Kaynak adı öneki, ör. yanimda-staging"
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "name küçük harf, rakam ve tire (3–31 karakter) olmalı."
  }
}

variable "environment" {
  description = "staging | prod"
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment staging veya prod olmalı."
  }
}

variable "tags" {
  description = "Tüm kaynaklara eklenecek etiketler"
  type        = map(string)
  default     = {}
}

# --- Ağ ---
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "subnet_cidr" {
  type    = string
  default = "10.20.1.0/24"
}

variable "subnet_gateway_ip" {
  type    = string
  default = "10.20.1.1"
}

variable "admin_cidrs" {
  description = "SSH (22) erişimine izinli yönetici CIDR'leri. Boş liste = SSH kapalı (yalnız bulut konsolu)."
  type        = list(string)
  default     = []
}

# --- VPS (ECS) ---
variable "vps_vcpus" {
  type    = number
  default = 4
}

variable "vps_memory_gb" {
  type    = number
  default = 8
}

variable "vps_image_name" {
  description = "Genel imaj adı (bölgede mevcut olmalı)"
  type        = string
  default     = "Ubuntu 22.04 server 64bit"
}

variable "vps_system_disk_gb" {
  type    = number
  default = 40
}

variable "vps_data_disk_gb" {
  description = "/srv/yanimda veri diski (Caddy sertifikaları, Prometheus/Loki, Uptime Kuma, yerel dump önbelleği)"
  type        = number
  default     = 100
}

variable "disk_type" {
  description = "ECS/EVS disk tipi (SSD, GPSSD, ESSD …)"
  type        = string
  default     = "GPSSD"
}

variable "ssh_key_pair" {
  description = "Önceden oluşturulmuş KPS anahtar çifti adı (gizli anahtar kodda değil)"
  type        = string
}

variable "eip_type" {
  description = "EIP hat tipi (bölgeye göre değişir; Huawei çoğu bölgede 5_bgp)"
  type        = string
  default     = "5_bgp"
}

variable "eip_bandwidth_mbit" {
  type    = number
  default = 50
}

# --- Yönetilen Postgres (RDS for PostgreSQL) ---
variable "db_version" {
  description = "PostgreSQL ana sürümü. TimescaleDB uzantısının bu sürümde desteklendiği doğrulanmalı (README)."
  type        = string
  default     = "16"
}

variable "db_vcpus" {
  type    = number
  default = 2
}

variable "db_memory_gb" {
  type    = number
  default = 8
}

variable "db_volume_type" {
  type    = string
  default = "CLOUDSSD"
}

variable "db_volume_gb" {
  type    = number
  default = 100
}

variable "db_ha_replication_mode" {
  description = "HA çoğaltma kipi: async | semisync | sync. Olay kaybı sıfır hedefi için sync/semisync önerilir."
  type        = string
  default     = "semisync"
}

variable "db_backup_keep_days" {
  description = "Otomatik yedek + WAL (PITR penceresi) saklama günü"
  type        = number
  default     = 7
}

variable "db_backup_window" {
  description = "Günlük tam yedek penceresi (UTC, hh:mm-hh:mm)"
  type        = string
  default     = "00:00-01:00"
}

variable "db_name" {
  type    = string
  default = "yanimda"
}

variable "db_app_user" {
  type    = string
  default = "yanimda"
}

variable "db_app_password" {
  description = "Uygulama hesabı parolası (DATABASE_URL); TF_VAR_db_app_password"
  type        = string
  sensitive   = true
}

variable "enable_timescaledb" {
  description = "RDS'te timescaledb uzantısını kur (desteklenmiyorsa false + ayrı Timescale VM)"
  type        = bool
  default     = true
}

variable "db_password" {
  description = "RDS root parolası (tfvars'ta değil; TF_VAR_db_password veya sır yöneticisi)"
  type        = string
  sensitive   = true
}

# --- Yönetilen Redis (DCS) ---
variable "redis_version" {
  type    = string
  default = "6.0"
}

variable "redis_capacity_gb" {
  type    = number
  default = 1
}

variable "redis_password" {
  type      = string
  sensitive = true
}

# --- Nesne deposu (OBS, S3 uyumlu) ---
variable "recordings_retention_days" {
  description = "Görüşme kayıtları WORM saklama süresi (gün). API RECORDING_RETENTION_DAYS ile aynı olmalı."
  type        = number
  default     = 365
}

variable "backup_retention_days" {
  description = "Günlük pg_dump nesnelerinin saklama süresi (gün)"
  type        = number
  default     = 35
}

# --- DNS ---
variable "dns_zone" {
  description = "Genel DNS bölgesi (sonunda nokta yok), ör. staging.yanimda.app"
  type        = string
}

variable "dns_create_zone" {
  description = "true: bölge burada oluşturulur (alan adı NS kayıtları çıktıdaki sunuculara verilir)"
  type        = bool
  default     = true
}

variable "dns_records" {
  description = "VPS'e (EIP) işaret edecek alt alan adları; Caddy bu adlar için otomatik TLS alır"
  type        = list(string)
  default     = ["api", "console", "auth", "aile", "status"]
}

variable "dns_email" {
  type    = string
  default = "ops@example.com"
}
