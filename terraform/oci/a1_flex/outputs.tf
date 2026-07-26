output "instance_public_ip" {
  description = "OCI A1.Flex 인스턴스의 퍼블릭 IP 주소 — GitHub Secret OCI_HOST + api DNS A 레코드에 사용"
  value       = oci_core_instance.instance.public_ip
}

output "instance_private_ip" {
  description = "OCI A1.Flex 인스턴스의 프라이빗 IP 주소"
  value       = oci_core_instance.instance.private_ip
}
