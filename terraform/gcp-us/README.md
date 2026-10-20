# terraform/gcp-us — GCP 무료 등급 서버 (Terraform Cloud)

**2026-10-20에 서울(`terraform/gcp`)에서 전환한 운영 서버다**(아래 「전환」). GCP 무료 체험 종료(2026-10)에 대비한
병행 환경으로 만들었다. 그동안 서울 배포 경로(`cd-gcp.yml` → `deploy.sh` → `docker/gcp`)는 급히 배포할 일에 대비해
고치지 않았고, 그래서 서울 파일을 고치는 대신 사본을 만들었다. 전환 뒤 main push 배포는 `cd-gcp-us.yml`이 하고,
`cd-gcp.yml`은 되돌아갈 길로 dispatch만 남겼다.

| 사본 | 서울 원본 |
|------|-----------|
| `terraform/gcp-us/` | `terraform/gcp/` |
| `docker/gcp-us/compose.yml` | `docker/gcp/compose.yml` |
| `deploy-gcp-us.sh` | `deploy.sh` |
| `.github/workflows/cd-gcp-us.yml` (main push · dispatch) | `.github/workflows/cd-gcp.yml` (전환 뒤 dispatch 전용) |

`nginx/`는 서울과 함께 쓴다(마운트만 한다). 전환 뒤로는 사본 쪽을 고친다 — 서울 파일은 서울을 지울 때 정리한다.

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
| 배포 대기 | 헬스 3분 · SSH 10분(기본값) | 헬스 10분 · SSH 45분 — 콜드 스타트가 분 단위다(첫 배포 실측 app 3분 14초·agent 4분 8초) |
| 헬스체크 | 5~10초 간격 | 평상시 60초 · 기동 중 2~5초(`start_interval`), app 프로브는 node 대신 busybox `wget` — 아래 「CPU」 |
| OS | Ubuntu 기본 | `os-tune.sh` — 업데이트 타이머를 한국 새벽으로, man-db 끔, 상주 데몬 4종 mask, snapd 제거 — 아래 「OS 정리」 |
| 그 밖 | — | `allow_stopping_for_update`, docker 로그 회전(20MB × 5) |

모니터링이 없으니 **알림도 없다.** 장애는 배포 로그·`docker logs`·외부 헬스 확인으로만 보인다.
체험이 끝난 뒤에도 무료 등급을 쓰려면 결제 계정을 유료로 전환해 둬야 한다.

## 생성과 실측 (전환 전)

무료 등급 사용량은 체험 크레딧과 별개다 — 미리 띄워 1GB에 들어가는지 잰다.
이 기간에 쌓인 미국 DB는 전환 때 덮어쓴다.

1. TFC organization `cure-agent`에 워크스페이스 **`cure-agent-gcp-us`**(CLI-driven)를 만들고 `credentials`
   (서비스 계정 JSON 키 전체 내용)를 **Terraform variable**로, Sensitive를 체크해 등록한다 — 서울 워크스페이스의
   변수는 따라오지 않는다. Environment variable(`GOOGLE_CREDENTIALS` 등)로 넣으면 plan이
   `No value for required variable "credentials"`로 실패한다(2026-10-14에 실제로 났다).
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

1GB가 모자라면 `machine_type`을 올린다(유료) — `allow_stopping_for_update`가 있어 apply가 정지 → 변경 → 기동으로
처리한다. 그 전에 할 수 있는 OS 정리는 이미 `os-tune.sh`가 한다(아래).

## CPU — 지속 몫은 0.25개분이고, 스로틀링은 steal로 보이지 않는다

e2-micro는 vCPU 2개가 각각 12.5%씩, 합 0.25개분을 지속으로 받는다. 그 위로는 토큰 버킷만큼 버스트한다.
2026-10-14 고정 작업 처리율 실측(서울 e2-standard-2 단일 ≈7.2M/s 기준)은 다음과 같다:

- 5.5분 쉰 뒤 단일 워커가 **약 22초 풀 속도**(85~89%)였다. 그 뒤로는 **5~10%**(평균 6%)로 떨어졌다.
- 같은 구간에 top·vmstat·sar의 steal은 0%였고, 게스트는 2 vCPU 100%로 보고했다. **게스트 지표로는 스로틀을 볼 수 없다**
  — CPU 여유는 짧은 고정 작업의 처리율로 판단한다.
- 아무 요청이 없을 때도 배경 작업이 지속 몫의 약 3/4(≈0.19개분)를 썼다. 대부분 헬스체크 프로세스 생성이었다.
  그래서 헬스체크를 평상시 60초로 늘렸다(`docker/gcp-us/compose.yml` 머리말).

배포·업데이트·적재처럼 연속으로 일하는 구간은 버스트가 바닥나면 풀 속도의 수 %로 돈다. 배포 중단 시간(로그 기준
≈2분 40초)도 대부분 이 구간의 app 기동이다.

## OS 정리 (`os-tune.sh`)

2026-10-14 실측에서 OS 기본 설정이 1GB·0.25개분을 크게 잠식했다.

- `apt-daily-upgrade`가 한국 15:53에 돌아 패키지 4개에 **12분**이 걸렸다. 그동안 가용 메모리 212MiB, 10초에 87MiB 재읽기,
  외부 헬스 응답 **15.7초**였다. 뒤이어 man-db 트리거가 디스크를 채웠다.
- 쓰지 않는 상주 데몬이 RSS 합 ≈90MiB였다: multipathd 27(mlock)·packagekitd 20·snapd 16·networkd-dispatcher 15·
  google_osconfig_agent 14MiB.

`os-tune.sh`가 하는 일은 다음과 같다. 업데이트 타이머는 끄지 않고 02:00·02:30 KST로 옮긴다(앱 크론 03:00·04:00 KST와
겹치지 않게). man-db의 타이머와 dpkg 트리거를 끈다. 위 데몬 4종을 mask한다. snapd를 지운다(gcloud snap도 함께 지워진다).
google-guest-agent는 메타데이터 ssh-keys를 심는 주체라 남긴다.

- **새 VM**: `main.tf`의 user_data(cloud-init)가 첫 부팅에 실행한다.
- **이미 떠 있는 VM**: cloud-init은 다시 돌지 않으니 한 번 실행한다(여러 번 실행해도 결과가 같다).
  ```bash
  ssh deploy@<미국 IP> 'sudo bash -s' < terraform/gcp-us/os-tune.sh
  ```
- user_data를 바꾼 뒤의 `terraform plan`은 인스턴스 metadata의 제자리 변경으로 나온다. VM은 교체되지 않고,
  apply해도 이미 떠 있는 VM의 cloud-init은 다시 돌지 않는다.

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

**2026-10-20 실행 기록**: API 중단은 약 80분이었다(12:12~13:35 KST). 가장 긴 구간은 덤프(140.6MB)를 로컬에서 미국으로
올리는 10분이었다(0.23MB/s — 로컬 상향 대역). 복원은 30초, 재배포는 8분 42초였고 나머지는 단계 사이 대기다.
다시 옮길 일이 있으면(서울로 되돌리기 등) 업로드 경로부터 바꾼다. 위 절차에 없던 주의도 하나 있다 — 전환 중에는
dev에도 머지하지 않는다. `latest` 이미지가 dev push로 빌드되므로 4단계가 받을 이미지가 바뀐다.
서울에서 쓰던 로그인 세션은 덤프로 넘어간 refresh 토큰으로 그대로 이어졌다.

## 전환 뒤 정리

- **서울은 체험 종료일 전에 멈추거나 지운다** — 체험이 끝나면 서울 VM(e2-standard-2·pd-balanced 50GB·고정 IP)에
  요금이 붙는다. 되돌아갈 길이 필요 없어지면 `terraform/gcp`에서 `terraform destroy`, grafana DNS 레코드도 지운다.
- 첫 달 청구서에서 무료 등급 밖 항목(외부 IP 등)이 없는지 확인한다.
- **(2026-10-20 완료)** `cd-gcp.yml`의 push 트리거를 `cd-gcp-us.yml`로 옮기고, ship의 CD 대기 대상(`automation/pipeline.md`의
  `run-wait.sh`)과 새 환경 변수 절차를 `cd-gcp-us.yml`·`docker/gcp-us`로 바꿨다. `cd-gcp.yml`은 dispatch만 남겼다.
- compose 불변식 테스트(`test/agent-service-bootstrap.e2e-spec.ts`)가 `docker/gcp-us`를 보게 한다. 모니터링을 뺐으므로
  `test/agent-liveness-metrics.e2e-spec.ts`(spec 50의 alloy 기준)는 스펙으로 다룬다.
- 서울 파일(`terraform/gcp`·`docker/gcp`·`deploy.sh`·`cd-gcp.yml`)은 `terraform/oci`처럼 비활성으로 표기해 남기거나 지운다.
