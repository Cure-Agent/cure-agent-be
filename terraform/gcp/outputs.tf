output "instance_public_ip" {
  description = "고정 외부 IP — GitHub Secret SERVER_HOST + api/grafana DNS A 레코드(둘 다 이 IP)에 사용"
  value       = google_compute_address.static_ip.address
}

output "ssh_user" {
  description = "SSH 접속 사용자 — GitHub Secret SERVER_USER에 사용"
  value       = var.ssh_user
}
