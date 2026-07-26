# terraform/gcp — GCP 인프라 (Terraform Cloud)

배포 계획 v2 기준 — **e2-standard-2(2 vCPU/8GB) 단일 서버**에 앱 + 모니터링 스택을 통합한다.
Terraform Cloud organization **`cure-agent`** 의 워크스페이스 **`cure-agent-gcp`** 1개로 관리한다 (CLI-driven, remote execution).

> v1(OCI 3서버) 코드는 `terraform/oci/`에 출구 전략용으로 보관돼 있다 (비활성).

## 리소스 구성 (단일 모듈)

| 리소스 | 내용 |
|--------|------|
| `google_compute_network` / `subnetwork` | 커스텀 VPC + 10.2.1.0/24 |
| `google_compute_firewall` | 22/80/443만 외부 개방 — 9090/3100/3000 등은 docker 내부 통신 전용 |
| `google_compute_address` | 고정 외부 IP (인스턴스 재생성해도 DNS 유지) |
| `google_compute_instance` | e2-standard-2, Ubuntu 24.04 LTS, pd-balanced 50GB, cloud-init(user-data) |

cloud-init이 swap(4GB)·docker/compose 설치·docker 그룹 등록까지 처리하므로 apply 후 서버 수동 세팅은 없다.
OS 방화벽 단계는 없다 — GCP는 VPC 방화벽이 담당하고 Ubuntu ufw는 기본 비활성이다.

## 실행 순서 (워크스페이스 1개 — apply 1회)

```bash
terraform login   # TFC 토큰 발급 (최초 1회)

cd terraform/gcp
terraform init && terraform plan && terraform apply
terraform output  # instance_public_ip 기록
```

- 변수 입력: `terraform.tfvars.example`을 `terraform.tfvars`로 복사해 채운다(gitignore됨).
  `credentials`(서비스 계정 JSON 키 전체 내용)는 tfvars에 넣지 말고 **TFC 워크스페이스
  Sensitive Variable**로 등록한다.
- `ssh_user`(기본 `deploy`)는 CD의 `SERVER_USER` Secret과 동일해야 한다.
- apply 후 **DNS A 레코드 등록**: `api.cure.demo01.xyz`, `grafana.cure.demo01.xyz` → 둘 다 `instance_public_ip`
  (첫 배포 전 전파 필수 — certbot이 참조).

## output → 후속 단계 매핑

| output | 사용처 |
|--------|--------|
| `instance_public_ip` | GitHub Secret `SERVER_HOST` + api/grafana DNS A 레코드 |
| `ssh_user` | GitHub Secret `SERVER_USER` |

## v1(OCI) 대비 변경점

- 서버 3대 → 1대 통합: LPG(VCN 피어링)·server1/server2·크로스 서버 포트 규칙(9090/3100 소스 제한) 전부 삭제 — 모니터링 통신은 docker network 내부로 대체.
- provider oci → google, 워크스페이스 2개 → 1개, ARM(arm64) → **x86_64(CI buildx `linux/amd64`)**.
- cloud-init: dnf/firewalld(Oracle Linux) → apt(Ubuntu), OS 방화벽 단계 제거.
- 고정 IP를 리소스로 확보 (OCI에서는 인스턴스 기본 공인 IP 사용).
