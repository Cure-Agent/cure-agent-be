terraform {
  cloud {
    organization = "cure-agent"

    workspaces {
      # 서울(cure-agent-gcp)과 다른 워크스페이스다 — 같은 이름이면 apply가 서울 VM을 교체한다
      name = "cure-agent-gcp-us"
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
  # 무료 등급 단일 서버에 앱만 배포한다 — 모니터링 스택은 뺐다 (docker/gcp-us/compose.yml)
  # Ubuntu 이미지의 cloud-init이 user-data를 인스턴스 최초 부팅 시 1회 실행한다.
  user_data = <<-END_OF_USERDATA
#!/bin/bash

# 스왑은 만들지 않는다 (서울은 4GB) — 무료 디스크 pd-standard 30GB는 바닥 성능이 없어
# 읽기 ≈22 IOPS·3.6MiB/s다. 스왑이 메모리를 늘려 주지 못하고, 압박이 오면 서버 전체가 디스크를
# 기다리며 멈춘다. 1GB에 들어가는지는 실측으로 판단한다 (terraform/gcp-us/README.md).

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git

# Docker 29+의 containerd 이미지 스토어(overlayfs snapshotter)는 cAdvisor의
# 레거시 layerdb 레이아웃 전제와 비호환 → 컨테이너 지표 수집이 전멸한다.
# classic overlay2 그래프 드라이버를 강제한다 (docker 설치·기동 전에 작성해야 함)
# 여기엔 cAdvisor(alloy)가 없지만 서울과 같은 모드로 둔다 — deploy-gcp-us.sh의 containerd 잔재
# 정리가 이 모드를 전제하고, 모니터링을 되살리면 다시 필요하다.
# 로그 회전은 서울에 없는 추가다 — Loki도 디스크 알림도 없어 json-file 로그가 30GB 디스크를
# 조용히 채울 수 있다.
mkdir -p /etc/docker
echo '{"features":{"containerd-snapshotter":false},"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"}}' > /etc/docker/daemon.json

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

# 네트워크 설정 시작 — 서울과 같은 프로젝트에 공존하므로 이름은 prefix로 가른다
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

# 외부 개방은 22/80/443만 — 나머지는 전부 docker network 내부 통신이며,
# 외부 노출은 nginx(443) 경유만 허용한다.
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

# 고정 외부 IP — 전환 때 api DNS A 레코드를 이 IP로 옮긴다
resource "google_compute_address" "static_ip" {
  name   = "${var.prefix}-static-ip"
  region = var.region
}

# Compute 설정 시작 — e2-micro 단일 인스턴스 (무료 등급: 2 vCPU 공유, 1 GB)
resource "google_compute_instance" "instance" {
  name         = "${var.prefix}-instance-1"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["${var.prefix}-server"]

  # 1GB가 모자라 machine_type을 올릴 때 apply가 거절되지 않고 정지 → 변경 → 기동으로 처리되게 한다
  # (서울 terraform/gcp에는 없어서 machine_type 변경 apply가 거절된다)
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = var.boot_disk_size_in_gb
      # 무료 등급은 standard PD 30GB까지다. 타입을 바꾸면 인스턴스가 교체되고
      # 부팅 디스크에 있는 DB 볼륨도 함께 사라진다
      type = "pd-standard"
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
