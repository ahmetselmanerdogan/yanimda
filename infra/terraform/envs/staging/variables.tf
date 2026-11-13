variable "region" {
  description = "Huawei Cloud bölgesi (İstanbul: tr-west-1)"
  type        = string
  default     = "tr-west-1"
}

variable "admin_cidrs" {
  type    = list(string)
  default = []
}

variable "ssh_key_pair" {
  type = string
}

variable "db_version" {
  type    = string
  default = "16"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_app_password" {
  type      = string
  sensitive = true
}

variable "enable_timescaledb" {
  type    = bool
  default = true
}

variable "redis_password" {
  type      = string
  sensitive = true
}

variable "redis_app_password" {
  type      = string
  sensitive = true
}

variable "redis_monitor_password" {
  type      = string
  sensitive = true
}

variable "dns_zone" {
  description = "ör. staging.yanimda.app"
  type        = string
}

variable "dns_create_zone" {
  type    = bool
  default = true
}
