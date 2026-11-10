terraform {
  required_version = ">= 1.6.0"
  required_providers {
    huaweicloud = {
      source  = "huaweicloud/huaweicloud"
      version = "~> 1.69"
    }
  }

  # Uzak durum: S3 uyumlu (Huawei OBS) kova. Değerler backend.hcl'de (bkz. backend.hcl.example):
  #   terraform init -backend-config=backend.hcl
  # Doğrulama ağsız: terraform init -backend=false && terraform validate
  backend "s3" {}
}

# Kimlik bilgileri ortamdan: HW_ACCESS_KEY, HW_SECRET_KEY (ve isteğe bağlı HW_PROJECT_ID). Kodda sır yok.
provider "huaweicloud" {
  region = var.region
}
