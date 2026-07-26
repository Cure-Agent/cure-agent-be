terraform {
  cloud {
    organization = "cure-agent"

    workspaces {
      name = "cure-agent-gcp"
    }
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  credentials = var.credentials
  project     = var.project_id
  region      = var.region
  zone        = var.zone
}

locals {
  # 단일 서버에 앱 + 모니터링 스택 통합 배포 (배포 계획 v2 — docker/gcp/compose.yml)
  # Ubuntu 이미지의 cloud-init이 user-data를 인스턴스 최초 부팅 시 1회 실행한다.
  user_data = <<-END_OF_USERDATA
#!/bin/bash

# Swap 4GB 설정 (8GB RAM 보조 — OOM 방어)
dd if=/dev/zero of=/swapfile bs=128M count=32
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo "/swapfile swap swap defaults 0 0" >> /etc/fstab

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git

# Docker CE (공식 저장소) + compose plugin
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable docker
systemctl start docker

usermod -aG docker ${var.ssh_user}
END_OF_USERDATA
}

# 네트워크 설정 시작
resource "google_compute_network" "vpc_1" {
  name                    = "${var.prefix}-vpc-1"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet_1" {
  name          = "${var.prefix}-subnet-1"
  ip_cidr_range = "10.2.1.0/24"
  region        = var.region
  network       = google_compute_network.vpc_1.id
}

# 외부 개방은 22/80/443만 — 9090(prometheus)/3100(loki)/3000(grafana) 등은
# 전부 docker network 내부 통신이며, 외부 노출은 nginx(443) 경유만 허용한다.
resource "google_compute_firewall" "allow_ssh_web" {
  name    = "${var.prefix}-allow-ssh-web"
  network = google_compute_network.vpc_1.name

  allow {
    protocol = "tcp"
    ports    = ["22", "80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${var.prefix}-server"]
}

# 고정 외부 IP — 인스턴스를 재생성해도 DNS A 레코드가 유지되게 한다
resource "google_compute_address" "static_ip" {
  name   = "${var.prefix}-static-ip"
  region = var.region
}

# Compute 설정 시작 — e2-standard-2 단일 인스턴스 (2 vCPU, 8 GB)
resource "google_compute_instance" "instance" {
  name         = "${var.prefix}-instance-1"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["${var.prefix}-server"]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = var.boot_disk_size_in_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet_1.id

    access_config {
      nat_ip = google_compute_address.static_ip.address
    }
  }

  metadata = {
    # OS Login이 켜져 있으면 ssh-keys 메타데이터가 무시되므로 명시적으로 끈다
    enable-oslogin = "FALSE"
    ssh-keys       = join("\n", [for key in var.ssh_public_keys : "${var.ssh_user}:${key}"])
    user-data      = local.user_data
  }
}
