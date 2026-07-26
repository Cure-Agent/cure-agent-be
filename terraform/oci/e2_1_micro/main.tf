terraform {
  cloud {
    organization = "cure-agent"

    workspaces {
      name = "cure-agent-oci"
    }
  }

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}

# OCI 설정 시작
provider "oci" {
  tenancy_ocid         = var.tenancy_ocid
  user_ocid            = var.user_ocid
  fingerprint          = var.fingerprint
  private_key          = var.private_key
  private_key_password = var.private_key_password
  region               = var.region
}
# OCI 설정 끝

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "oracle_linux" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Oracle Linux"
  operating_system_version = "8"
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  availability_domain = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name

  base_user_data = <<-END_OF_BASE
#!/bin/bash

# Swap 설정 (DNF OOM kill 방지를 위해 가장 먼저 실행)
dd if=/dev/zero of=/swapfile bs=128M count=32
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo "/swapfile swap swap defaults 0 0" >> /etc/fstab

dnf update -y

# Docker CE (upstream) 설치
dnf install -y yum-utils git curl
yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io

systemctl enable docker
systemctl start docker

usermod -aG docker opc

curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
END_OF_BASE

  # Server 1: Grafana(Nginx 80/443) + Prometheus(9090) + Alertmanager
  server1_user_data = "${local.base_user_data}\n# OS 방화벽 설정 (cloud-init 환경에서는 firewalld 데몬 없이 동작하는 offline-cmd 사용)\nfirewall-offline-cmd --add-port=22/tcp\nfirewall-offline-cmd --add-service=http\nfirewall-offline-cmd --add-service=https\nfirewall-offline-cmd --add-port=9090/tcp\nsystemctl enable firewalld\n"

  # Server 2: Loki(3100) — 내부 통신 전용
  server2_user_data = "${local.base_user_data}\n# OS 방화벽 설정 (cloud-init 환경에서는 firewalld 데몬 없이 동작하는 offline-cmd 사용)\nfirewall-offline-cmd --add-port=22/tcp\nfirewall-offline-cmd --add-port=3100/tcp\nsystemctl enable firewalld\n"

  user_data_by_index = [local.server1_user_data, local.server2_user_data]
}

# VCN 설정 시작
resource "oci_core_vcn" "vcn_1" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "${var.prefix}-vcn-1"
  dns_label      = substr(lower(replace(var.prefix, "-", "")), 0, 15)
}

resource "oci_core_internet_gateway" "igw_1" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-igw-1"
  enabled        = true
}

resource "oci_core_local_peering_gateway" "lpg_to_a1flex" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-lpg-to-a1flex"
}

resource "oci_core_route_table" "rt_1" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-rt-1"

  route_rules {
    network_entity_id = oci_core_internet_gateway.igw_1.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }

  # a1_flex VCN으로의 트래픽을 VCN 피어링으로 라우팅
  route_rules {
    network_entity_id = oci_core_local_peering_gateway.lpg_to_a1flex.id
    destination       = "10.1.0.0/16"
    destination_type  = "CIDR_BLOCK"
  }
}

# Server 1(Grafana·Prometheus) 전용 Security List
resource "oci_core_security_list" "sl_1" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-sl-1"

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 22
      max = 22
    }
  }

  # HTTP — Grafana Nginx
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 80
      max = 80
    }
  }

  # HTTPS — Grafana Nginx
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 443
      max = 443
    }
  }

  # Prometheus remote write — a1_flex VCN(Alloy)에서만 허용
  ingress_security_rules {
    protocol = "6"
    source   = "10.1.1.0/24"

    tcp_options {
      min = 9090
      max = 9090
    }
  }

  ingress_security_rules {
    protocol = "1" # ICMP
    source   = "10.0.0.0/16"

    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    protocol = "1" # ICMP
    source   = "0.0.0.0/0"

    icmp_options {
      type = 3
      code = 4
    }
  }

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }
}

resource "oci_core_subnet" "subnet_1" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.vcn_1.id
  cidr_block                 = "10.0.1.0/24"
  display_name               = "${var.prefix}-subnet-1"
  route_table_id             = oci_core_route_table.rt_1.id
  security_list_ids          = [oci_core_security_list.sl_1.id]
  prohibit_public_ip_on_vnic = false
  dns_label                  = substr(lower(replace("${var.prefix}sub1", "-", "")), 0, 15)
}

# Server 2(Loki) 전용 Security List — 3100은 Server 1(Grafana 조회) + a1_flex(Alloy push)에서만 허용
resource "oci_core_security_list" "sl_2" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-sl-2"

  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 22
      max = 22
    }
  }

  # Loki — Server 1 subnet(10.0.1.0/24, Grafana)에서 허용
  ingress_security_rules {
    protocol = "6"
    source   = "10.0.1.0/24"

    tcp_options {
      min = 3100
      max = 3100
    }
  }

  # Loki — a1_flex subnet(10.1.1.0/24, Alloy)에서 허용
  ingress_security_rules {
    protocol = "6"
    source   = "10.1.1.0/24"

    tcp_options {
      min = 3100
      max = 3100
    }
  }

  ingress_security_rules {
    protocol = "1" # ICMP
    source   = "10.0.0.0/16"

    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    protocol = "1" # ICMP
    source   = "0.0.0.0/0"

    icmp_options {
      type = 3
      code = 4
    }
  }

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }
}

# Server 2 전용 Subnet
resource "oci_core_subnet" "subnet_2" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.vcn_1.id
  cidr_block                 = "10.0.2.0/24"
  display_name               = "${var.prefix}-subnet-2"
  route_table_id             = oci_core_route_table.rt_1.id
  security_list_ids          = [oci_core_security_list.sl_2.id]
  prohibit_public_ip_on_vnic = false
  dns_label                  = substr(lower(replace("${var.prefix}sub2", "-", "")), 0, 15)
}

# Compute 설정 시작
resource "oci_core_instance" "instance" {
  count               = var.instance_count
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.prefix}-instance-${count.index + 1}"
  shape               = var.instance_shape

  create_vnic_details {
    # index 0 → subnet_1 (Server 1: Grafana/Prometheus), index 1 → subnet_2 (Server 2: Loki)
    subnet_id        = count.index == 0 ? oci_core_subnet.subnet_1.id : oci_core_subnet.subnet_2.id
    assign_public_ip = true
    display_name     = "${var.prefix}-vnic-${count.index + 1}"
    hostname_label   = "${var.prefix}vm${count.index + 1}"
  }

  metadata = {
    ssh_authorized_keys = join("\n", var.ssh_public_keys)
    user_data           = base64encode(local.user_data_by_index[count.index])
  }

  dynamic "shape_config" {
    for_each = var.instance_ocpus != null ? [1] : []
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_in_gbs
    }
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.oracle_linux.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }
}

# Server 1 OS 방화벽 — 80/443/9090 포트 즉시 개방 (기존 VM 포함)
resource "null_resource" "firewall_server1" {
  triggers = {
    instance_id = oci_core_instance.instance[0].id
  }

  connection {
    type        = "ssh"
    user        = "opc"
    private_key = var.ssh_private_key
    host        = oci_core_instance.instance[0].public_ip
  }

  provisioner "remote-exec" {
    inline = [
      "sudo firewall-cmd --add-service=http --permanent",
      "sudo firewall-cmd --add-service=https --permanent",
      "sudo firewall-cmd --add-port=9090/tcp --permanent",
      "sudo firewall-cmd --reload",
    ]
  }
}

# Server 2 OS 방화벽 — 3100 포트 즉시 개방 (기존 VM 포함, Grafana 조회 + a1_flex Alloy → Loki)
resource "null_resource" "firewall_server2" {
  triggers = {
    instance_id = oci_core_instance.instance[1].id
  }

  connection {
    type        = "ssh"
    user        = "opc"
    private_key = var.ssh_private_key
    host        = oci_core_instance.instance[1].public_ip
  }

  provisioner "remote-exec" {
    inline = [
      "sudo firewall-cmd --add-port=3100/tcp --permanent",
      "sudo firewall-cmd --reload",
    ]
  }
}
