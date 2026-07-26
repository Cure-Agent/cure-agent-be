# terraform/oci — OCI 인프라 (Terraform Cloud) — ⚠️ 비활성

> **2026-07-26 GCP로 전환됨 (배포 계획 v2)** — OCI 계정 생성 제한으로 `terraform/gcp/`(e2-standard-2 단일 서버)가 현행 인프라다.
> 이 코드는 **출구 전략용 보관**이다: GCP 무료 체험(90일) 종료 전 OCI 가입 제한 해제를 확인하고 복귀할 때 사용한다.
> 복귀 시 확인 사항: A1 Always Free 한도(반토막 후 2 OCPU/12GB 기준으로 작성됨), TFC 워크스페이스 생성, CI 이미지 arm64 재빌드.

loopin-be의 terraform/oci를 기반으로 각색한 cure-agent 인프라 정의.
Terraform Cloud organization **`cure-agent`** 의 워크스페이스 2개로 관리한다 (CLI-driven, remote execution).

| 디렉토리 | TFC 워크스페이스 | 생성 리소스 | VCN |
|----------|------------------|-------------|-----|
| `e2_1_micro/` | `cure-agent-oci` | 모니터링 서버 2대 (Server 1: Grafana·Prometheus·Alertmanager / Server 2: Loki) + LPG | 10.0.0.0/16 |
| `a1_flex/` | `cure-agent-oci-a1flex` | 메인 서버 1대 (App·Nginx·Postgres(pgvector)·Redis·node-exporter·Alloy) + LPG 피어링 | 10.1.0.0/16 |

마이크로 2대는 **한 번의 apply로 동시에 생성**된다 — 서버별 포트 차이는 실행 입력이 아니라
코드 내부의 서버별 security list(`sl_1`/`sl_2`)·subnet·cloud-init(`user_data_by_index`)으로 표현돼 있다.

## 포트 정책

| 서버 | 공개 (0.0.0.0/0) | 내부 |
|------|------------------|------|
| a1 메인 | 22, 80, 443 | — |
| Server 1 | 22, 80, 443 (Grafana Nginx) | 9090 ← a1 subnet(10.1.1.0/24, Alloy remote write) |
| Server 2 | 22 | 3100 ← Server 1 subnet(Grafana 조회) + a1 subnet(Alloy push) |

## 실행 순서 (워크스페이스 간 의존성 있음)

```bash
terraform login   # TFC 토큰 발급 (최초 1회)

# ① 모니터링 2대 — LPG가 여기서 먼저 생성돼야 한다
cd e2_1_micro
terraform init && terraform plan && terraform apply
terraform output  # lpg_ocid, server1/2_private_ip, instance_public_ips 기록

# ② a1_flex 워크스페이스 변수(또는 로컬 terraform.tfvars)에 e2_lpg_ocid = <①의 lpg_ocid> 입력

# ③ 메인 서버 — LPG peer_id로 ①의 LPG를 연결해 VCN 피어링 완성
cd ../a1_flex
terraform init && terraform plan && terraform apply
terraform output  # instance_public_ip 기록
```

- A1 "Out of capacity" 오류 시 `availability_domain_index`를 1, 2로 바꿔 재시도한다.
- cloud-init이 swap·docker·OS 방화벽까지 처리하므로 apply 후 서버 수동 세팅은 없다.
- 변수 입력: `terraform.tfvars.example`을 `terraform.tfvars`로 복사해 채운다(gitignore됨).
  `private_key`(OCI API 키)·`ssh_private_key`는 tfvars에 넣지 말고 **TFC 워크스페이스
  Sensitive Variable**로 등록한다. 두 워크스페이스 모두에 공통 변수(tenancy/user/fingerprint/
  region/compartment/키)를 각각 등록해야 한다.

## output → 후속 단계 매핑

| output | 사용처 |
|--------|--------|
| a1 `instance_public_ip` | GitHub Secret `OCI_HOST` + `api.cure.demo01.xyz` A 레코드 |
| e2 `instance_public_ips[0]` | `grafana.cure.demo01.xyz` A 레코드 + server1 CD 접속 |
| e2 `instance_public_ips[1]` | server2(Loki) CD 접속 |
| e2 `server1_private_ip` | GitHub Secret `OCI_A1_S1_PRIVATE_IP` (Alloy → Prometheus) |
| e2 `server2_private_ip` | GitHub Secret `OCI_A1_S2_PRIVATE_IP` (Alloy → Loki) |
| e2 `lpg_ocid` | a1_flex 변수 `e2_lpg_ocid` |

## loopin-be 대비 변경점

- Object Storage(bucket·dynamic group·policy) 리소스 제거 — cure-agent는 오브젝트 스토리지 미사용.
- Server 2에서 MongoDB(27017)·Kafka(9092) 포트 규칙·방화벽 제거 — Loki(3100)만 유지.
- prefix 기본값 `cure`(e2) / `cure-a1`(a1), TFC organization·워크스페이스 이름 변경.
