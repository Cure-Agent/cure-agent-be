output "instance_public_ips" {
  description = "OCI 인스턴스들의 퍼블릭 IP 주소 — [0]=Server 1(grafana DNS A 레코드·CD 접속), [1]=Server 2(CD 접속)"
  value       = oci_core_instance.instance[*].public_ip
}

output "instance_private_ips" {
  description = "OCI 인스턴스들의 프라이빗 IP 주소 (VCN 내부 통신용)"
  value       = oci_core_instance.instance[*].private_ip
}

output "server1_private_ip" {
  description = "Server 1(Grafana·Prometheus) 프라이빗 IP — GitHub Secret OCI_A1_S1_PRIVATE_IP에 사용 (a1_flex Alloy가 Prometheus remote write 대상으로 참조)"
  value       = oci_core_instance.instance[0].private_ip
}

output "server2_private_ip" {
  description = "Server 2(Loki) 프라이빗 IP — GitHub Secret OCI_A1_S2_PRIVATE_IP에 사용 (a1_flex Alloy가 Loki push 대상으로 참조)"
  value       = oci_core_instance.instance[1].private_ip
}

output "lpg_ocid" {
  description = "e2_1_micro VCN LPG OCID — a1_flex 워크스페이스의 e2_lpg_ocid 변수에 입력"
  value       = oci_core_local_peering_gateway.lpg_to_a1flex.id
}
