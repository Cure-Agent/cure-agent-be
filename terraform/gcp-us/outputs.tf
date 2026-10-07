output "instance_public_ip" {
  description = "고정 외부 IP — GitHub Secret SERVER_HOST_US에 사용, 전환 때 api DNS A 레코드를 이 IP로 옮긴다"
  value       = google_compute_address.static_ip.address
}

output "ssh_user" {
  description = "SSH 접속 사용자 — 서울과 같은 GitHub Secret SERVER_USER를 쓴다"
  value       = var.ssh_user
}
