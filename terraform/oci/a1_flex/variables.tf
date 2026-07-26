variable "prefix" {
  description = "Prefix for all resources"
  type        = string
  default     = "cure-a1"
}

variable "region" {
  description = "OCI region"
  type        = string
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
}

variable "user_ocid" {
  description = "OCI user OCID"
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint for the OCI API signing key"
  type        = string
}

variable "private_key" {
  description = "OCI API private key content (PEM format)"
  type        = string
  sensitive   = true
}

variable "private_key_password" {
  description = "Password for the OCI API private key, if any"
  type        = string
  default     = null
  sensitive   = true
}

variable "compartment_ocid" {
  description = "Compartment OCID where network and compute resources are created"
  type        = string
}

variable "availability_domain" {
  description = "Availability domain name. Leave empty to auto-select by availability_domain_index"
  type        = string
  default     = ""
}

variable "availability_domain_index" {
  description = "Index of the availability domain to use (0-based) when availability_domain is not set. Change to 1 or 2 if the first AD has no capacity."
  type        = number
  default     = 0
}

variable "ssh_public_keys" {
  description = "Compute 인스턴스(opc 사용자)에 등록할 SSH 공개키(authorized_keys)"
  type        = list(string)
  default     = []
  sensitive   = true
}

variable "ssh_private_key" {
  description = "OCI 인스턴스 접속용 SSH 개인키 (null_resource provisioner용)"
  type        = string
  sensitive   = true
}

variable "instance_shape" {
  description = "OCI compute instance shape"
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "Number of OCPUs for the A1.Flex instance"
  type        = number
  default     = 2
}

variable "instance_memory_in_gbs" {
  description = "Memory in GBs for the A1.Flex instance"
  type        = number
  default     = 12
}

variable "boot_volume_size_in_gbs" {
  description = "Boot volume size for the compute instance (Always Free 총 한도 200GB — e2 50×2 + a1 100 배분)"
  type        = number
  default     = 100
}

variable "e2_lpg_ocid" {
  description = "e2_1_micro VCN의 Local Peering Gateway OCID — e2_1_micro 워크스페이스 outputs.lpg_ocid 참조"
  type        = string
  default     = ""
}
