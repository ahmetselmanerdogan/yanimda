output "vps_public_ip" {
  value = module.env.vps_public_ip
}

output "db_private_ip" {
  value = module.env.db_private_ip
}

output "redis_address" {
  value = module.env.redis_address
}

output "recordings_bucket" {
  value = module.env.recordings_bucket
}

output "backups_bucket" {
  value = module.env.backups_bucket
}

output "obs_endpoint" {
  value = module.env.obs_endpoint
}

output "dns_nameservers" {
  value = module.env.dns_nameservers
}

output "hostnames" {
  value = module.env.hostnames
}
