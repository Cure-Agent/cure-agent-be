variable "prefix" {
  description = "Prefix for all resources"
  type        = string
  default     = "cure"
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "asia-northeast3"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "asia-northeast3-a"
}

variable "credentials" {
  description = "Terraform용 서비스 계정 JSON 키 전체 내용 — TFC 워크스페이스에 Sensitive Variable로 등록 (파일 커밋 금지)"
  type        = string
  sensitive   = true
}

variable "ssh_user" {
  description = "인스턴스에 생성할 SSH 사용자 이름 — CD의 SERVER_USER Secret과 동일해야 한다"
  type        = string
  default     = "deploy"
}

variable "ssh_public_keys" {
  description = "인스턴스(ssh_user)에 등록할 SSH 공개키 목록 (로컬 머신 + github-actions)"
  type        = list(string)
  default     = []
  sensitive   = true
}

variable "machine_type" {
  description = "GCP machine type (2 vCPU, 8 GB)"
  type        = string
  default     = "e2-standard-2"
}

variable "boot_image" {
  description = "부팅 디스크 이미지 (project/family 형식)"
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "boot_disk_size_in_gb" {
  description = "부팅 디스크 크기 (pd-balanced)"
  type        = number
  default     = 50
}
