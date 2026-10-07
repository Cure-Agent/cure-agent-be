# terraform/gcp-us — GCP 무료 등급 서버 (Terraform Cloud)

GCP 무료 체험 종료(2026-10)에 대비한 **병행 환경**이다. 전환 전까지 운영은 서울(`terraform/gcp`)이고,
서울 배포 경로(`cd-gcp.yml` → `deploy.sh` → `docker/gcp`)는 이전 전에 급히 배포할 일에 대비해 **고치지 않는다**.
그래서 서울 파일을 고치는 대신 사본을 만들었다.

| 사본 | 서울 원본 |
|------|-----------|
| `terraform/gcp-us/` | `terraform/gcp/` |
| `docker/gcp-us/compose.yml` | `docker/gcp/compose.yml` |
| `deploy-gcp-us.sh` | `deploy.sh` |
| `.github/workflows/cd-gcp-us.yml` (dispatch 전용) | `.github/workflows/cd-gcp.yml` |

`nginx/`는 서울과 함께 쓴다(마운트만 한다). 병행 기간에 서울 원본을 고치면 사본에도 옮긴다.

## 서울과 다른 점

| 항목 | 서울 | 미국 |
|------|------|------|
| TFC 워크스페이스 | `cure-agent-gcp` | `cure-agent-gcp-us` |
| 리전 | asia-northeast3 | us-west1 — 무료 등급은 us-west1·us-central1·us-east1뿐이고 그중 한국과 가장 가깝다 |
| 머신 | e2-standard-2 (2 vCPU/8GB) | e2-micro (2 vCPU 공유/1GB) |
| 디스크 | pd-balanced 50GB | pd-standard 30GB — 무료 등급 상한, 바닥 성능 없음(읽기 ≈22 IOPS·3.6MiB/s) |
| 스왑 | 4GB | 없음 — 느린 디스크에서는 메모리를 늘려 주지 못한다 |
| 리소스 이름 | `cure-*` | `cure-us-*` — 같은 프로젝트라 달라야 한다 |
| 컨테이너 | 13개 | 6개 + certbot-init — 모니터링 7종이 없다 |
| 그 밖 | — | `allow_stopping_for_update`, docker 로그 회전(20MB × 5) |

모니터링이 없으니 **알림도 없다.** 장애는 배포 로그·`docker logs`·외부 헬스 확인으로만 보인다.
체험이 끝난 뒤에도 무료 등급을 쓰려면 결제 계정을 유료로 전환해 둬야 한다.

## 생성과 실측 (전환 전)

무료 등급 사용량은 체험 크레딧과 별개다 — 미리 띄워 1GB에 들어가는지 잰다.
이 기간에 쌓인 미국 DB는 전환 때 덮어쓴다.

1. TFC organization `cure-agent`에 워크스페이스 **`cure-agent-gcp-us`**(CLI-driven)를 만들고 `credentials`
   (서비스 계정 JSON 키 전체 내용)를 **Sensitive Variable**로 등록한다 — 서울 워크스페이스의 변수는 따라오지 않는다.
2. apply:
   ```bash
   cd terraform/gcp-us
   cp terraform.tfvars.example terraform.tfvars   # project_id·ssh_public_keys는 서울 tfvars와 같은 값
   terraform init && terraform plan && terraform apply
   terraform output   # instance_public_ip
   ```
3. GitHub Secret **`SERVER_HOST_US`** ← `instance_public_ip`. 계정·키(`SERVER_USER`·`GCP_SSH_PRIVATE_KEY`)는 서울 것을 함께 쓴다.
   **DNS는 아직 건드리지 않는다.**
4. 서울의 인증서를 복사한다 — **첫 배포 전 필수.** DNS가 아직 서울을 가리키므로 certbot-init의 발급은 실패하는데,
   그 전에 nginx의 더미 인증서를 지워서 배포의 `nginx -t`가 깨진다.
   ```bash
   ssh <서울> 'sudo tar -C ~/deploy -czf - letsencrypt' | ssh <미국> 'mkdir -p ~/deploy && sudo tar -C ~/deploy -xzf -'
   ```
5. 배포: `gh workflow run cd-gcp-us.yml` — 이 워크플로가 기본 브랜치(dev)에 머지돼 있어야 실행된다.
6. 측정:
   ```bash
   ssh <미국> 'free -m && docker stats --no-stream'
   curl --resolve api.cure.demo01.xyz:443:<미국 IP> https://api.cure.demo01.xyz/api/v1/health
   ```
   이때 DB는 마이그레이션만 적용된 빈 DB라 postgres 수치가 실제보다 낮다.

1GB가 모자라면 snapd 제거(서울 실측 44MiB)부터 검토한다. 그래도 모자라면 `machine_type`을 올린다(유료) —
`allow_stopping_for_update`가 있어 apply가 정지 → 변경 → 기동으로 처리한다.

## 전환

전환 중에는 main에 머지하지 않는다 — 서울 CD가 멈춰 둔 서울 app을 다시 띄운다.

1. 서울 app을 멈춘다 — 덤프 뒤의 쓰기가 사라지지 않게: `ssh <서울> 'docker stop cure-app'`
   (되돌릴 때는 `docker start cure-app` 뒤 `docker exec cure-nginx nginx -s reload` — app IP가 바뀌면 502다)
2. 덤프 — 보관한다(미국 서버에도 백업이 없다):
   ```bash
   ssh <서울> 'docker exec cure-postgres sh -c "pg_dump -U \"\$POSTGRES_USER\" -d cure_agent -Fc"' > cure_agent.dump
   ```
   DB 전체 덤프라 `drizzle` 스키마(마이그레이션 이력)가 함께 들어간다 — 빠지면 다음 배포의 migrate가 0000부터
   다시 돌아 실패한다. 환자 데이터 일부는 앱 레벨 암호문이라 `CRYPTO_ENC_KEYS`·`CRYPTO_HMAC_INDEX_KEY`는 같은 시크릿을 쓴다.
3. 미국에 복원 — app을 멈추고 DB를 새로 만든 뒤 넣는다:
   ```bash
   ssh <미국> 'docker stop cure-app && docker exec cure-postgres sh -c "dropdb -U \"\$POSTGRES_USER\" --force cure_agent && createdb -U \"\$POSTGRES_USER\" cure_agent"'
   ssh <미국> 'docker exec -i cure-postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d cure_agent --no-owner --single-transaction"' < cure_agent.dump
   ```
4. 미국 재배포: `gh workflow run cd-gcp-us.yml` — 덤프보다 새 마이그레이션이 있으면 적용하고, app을 다시 만들어
   키워드 어휘 캐시를 복원된 데이터로 채운다.
5. 확인: 위 `curl --resolve`로 헬스를 보고, 로그인·질문을 한 번 해 본다.
6. DNS: `api.cure.demo01.xyz` A 레코드 → 미국 IP. FE(Vercel)의 `BE_ORIGIN`·`AGENT_ORIGIN`은 도메인이라 바꿀 것이 없다.
7. DNS 전파 뒤 인증서를 api 단독으로 재발급한다 — 복사한 인증서는 SAN에 grafana가 있어 갱신 때 grafana 검증이 실패한다:
   ```bash
   ssh <미국> 'docker run --rm -v ~/deploy/letsencrypt:/etc/letsencrypt -v ~/deploy/certbot/www:/var/www/certbot certbot/certbot:v5.5.0 certonly --webroot -w /var/www/certbot --cert-name api.cure.demo01.xyz -d api.cure.demo01.xyz --non-interactive && docker exec cure-nginx nginx -s reload'
   ```

Redis는 옮기지 않는다 — 락·로그아웃 거부 목록·OAuth 티켓뿐이고 전부 수십 분 안에 TTL로 만료된다.

## 전환 뒤 정리

- **서울은 체험 종료일 전에 멈추거나 지운다** — 체험이 끝나면 서울 VM(e2-standard-2·pd-balanced 50GB·고정 IP)에
  요금이 붙는다. 되돌아갈 길이 필요 없어지면 `terraform/gcp`에서 `terraform destroy`, grafana DNS 레코드도 지운다.
- 첫 달 청구서에서 무료 등급 밖 항목(외부 IP 등)이 없는지 확인한다.
- `cd-gcp.yml`의 push 트리거를 `cd-gcp-us.yml`로 옮기고, ship의 CD 대기 대상(`automation/pipeline.md`의
  `run-wait.sh cd-gcp.yml`)과 새 환경 변수 절차를 `cd-gcp-us.yml`·`docker/gcp-us`로 바꾼다.
- compose 불변식 테스트(`test/agent-service-bootstrap.e2e-spec.ts`)가 `docker/gcp-us`를 보게 한다. 모니터링을 뺐으므로
  `test/agent-liveness-metrics.e2e-spec.ts`(spec 50의 alloy 기준)는 스펙으로 다룬다.
- 서울 파일(`terraform/gcp`·`docker/gcp`·`deploy.sh`·`cd-gcp.yml`)은 `terraform/oci`처럼 비활성으로 표기해 남기거나 지운다.
