terraform {
  cloud {
    organization = "cure-agent"

    workspaces {
      name = "cure-agent-oci-a1flex"
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

  # 단일 서버에 App, Nginx, Postgres(pgvector), Redis, node-exporter, Alloy 모두 배포
  user_data = <<-END_OF_USERDATA
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

# OS 방화벽 설정
firewall-offline-cmd --add-port=22/tcp
firewall-offline-cmd --add-service=http
firewall-offline-cmd --add-service=https
systemctl enable firewalld
END_OF_USERDATA
}

# VCN 설정 시작
resource "oci_core_vcn" "vcn_1" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.1.0.0/16"]
  display_name   = "${var.prefix}-vcn-1"
  dns_label      = substr(lower(replace(var.prefix, "-", "")), 0, 15)
}

resource "oci_core_internet_gateway" "igw_1" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-igw-1"
  enabled        = true
}

resource "oci_core_local_peering_gateway" "lpg_to_e2micro" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-lpg-to-e2micro"
  peer_id        = var.e2_lpg_ocid
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

  # e2_1_micro VCN(모니터링)으로의 트래픽을 VCN 피어링으로 라우팅
  route_rules {
    network_entity_id = oci_core_local_peering_gateway.lpg_to_e2micro.id
    destination       = "10.0.0.0/16"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_security_list" "sl_1" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn_1.id
  display_name   = "${var.prefix}-sl-1"

  # SSH
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 22
      max = 22
    }
  }

  # HTTP
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 80
      max = 80
    }
  }

  # HTTPS
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"

    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    protocol = "1" # ICMP
    source   = "10.1.0.0/16"

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
  cidr_block                 = "10.1.1.0/24"
  display_name               = "${var.prefix}-subnet-1"
  route_table_id             = oci_core_route_table.rt_1.id
  security_list_ids          = [oci_core_security_list.sl_1.id]
  prohibit_public_ip_on_vnic = false
  dns_label                  = substr(lower(replace("${var.prefix}sub1", "-", "")), 0, 15)
}

# Compute 설정 시작 — A1.Flex 단일 인스턴스 (Always Free 한도: 2 OCPU, 12 GB)
resource "oci_core_instance" "instance" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = "${var.prefix}-instance-1"
  shape               = var.instance_shape

  create_vnic_details {
    subnet_id        = oci_core_subnet.subnet_1.id
    assign_public_ip = true
    display_name     = "${var.prefix}-vnic-1"
    hostname_label   = "${var.prefix}vm1"
  }

  metadata = {
    ssh_authorized_keys = join("\n", var.ssh_public_keys)
    user_data           = base64encode(local.user_data)
  }

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.oracle_linux.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }
}

# OS 방화벽 — http/https 즉시 개방 (기존 VM 포함)
resource "null_resource" "firewall_instance" {
  triggers = {
    instance_id = oci_core_instance.instance.id
  }

  connection {
    type        = "ssh"
    user        = "opc"
    private_key = var.ssh_private_key
    host        = oci_core_instance.instance.public_ip
  }

  provisioner "remote-exec" {
    inline = [
      "sudo firewall-cmd --add-service=http --permanent",
      "sudo firewall-cmd --add-service=https --permanent",
      "sudo firewall-cmd --reload",
    ]
  }
}
