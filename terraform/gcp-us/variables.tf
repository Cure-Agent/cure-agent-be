variable "prefix" {
  description = "Prefix for all resources — 서울(cure)과 같은 프로젝트에 공존하므로 달라야 한다 (VPC·방화벽 이름 충돌)"
  type        = string
  default     = "cure-us"
}

variable "project_id" {
  description = "GCP project ID (서울과 같은 프로젝트)"
  type        = string
}

variable "region" {
  description = "GCP region — e2-micro 무료 등급은 us-west1·us-central1·us-east1만 해당한다 (us-west1이 한국과 가장 가깝다)"
  type        = string
  default     = "us-west1"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "us-west1-a"
}

variable "credentials" {
  description = "Terraform용 서비스 계정 JSON 키 전체 내용 — TFC 워크스페이스(cure-agent-gcp-us)에 Sensitive Variable로 등록 (파일 커밋 금지)"
  type        = string
  sensitive   = true
}

variable "ssh_user" {
  description = "인스턴스에 생성할 SSH 사용자 이름 — CD의 SERVER_USER Secret과 동일해야 한다"
  type        = string
  default     = "deploy"
}

variable "ssh_public_keys" {
  description = "인스턴스(ssh_user)에 등록할 SSH 공개키 목록 (로컬 머신 + github-actions) — 서울과 같은 키라야 CD가 GCP_SSH_PRIVATE_KEY를 함께 쓴다"
  type        = list(string)
  default     = []
  sensitive   = true
}

variable "machine_type" {
  description = "GCP machine type — 무료 등급은 e2-micro(2 vCPU 공유, 1 GB) 1대분이다"
  type        = string
  default     = "e2-micro"
}

variable "boot_image" {
  description = "부팅 디스크 이미지 (project/family 형식)"
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "boot_disk_size_in_gb" {
  description = "부팅 디스크 크기 (pd-standard) — 무료 등급은 30GB까지다"
  type        = number
  default     = 30
}
