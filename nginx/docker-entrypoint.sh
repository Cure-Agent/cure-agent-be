#!/bin/sh
set -e

# openssl이 없으면 설치 (nginx:alpine 기본 이미지에 미포함)
if ! command -v openssl > /dev/null 2>&1; then
  apk add --no-cache openssl
fi

DOMAIN="${NGINX_DOMAIN:?NGINX_DOMAIN env is required}"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

# 유효한 CA 발급 인증서인지 확인 (자체 서명이 아닌지)
is_real_cert() {
  [ -f "$CERT_DIR/fullchain.pem" ] && \
    ! openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -issuer 2>/dev/null | grep -q "CN=$DOMAIN"
}

# 인증서가 없거나 자체 서명(더미)이면 더미 인증서 생성 (nginx 시작용)
if ! is_real_cert; then
  echo "[init-ssl] No valid certificate found for $DOMAIN. Creating dummy self-signed cert..."
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=$DOMAIN" 2>/dev/null
  echo "[init-ssl] Dummy certificate created. Waiting for certbot to issue real cert..."

  # certbot이 실제 인증서를 발급할 때까지 대기 후 reload (타임아웃 없음)
  (
    while ! is_real_cert; do
      sleep 5
    done

    sleep 2
    nginx -s reload
    echo "[init-ssl] Real certificate detected. Nginx reloaded."
  ) &
fi

# 백그라운드에서 12시간마다 nginx reload (certbot 갱신 반영)
(while :; do sleep 12h; nginx -s reload 2>/dev/null || true; echo "[nginx] Periodic config reload."; done) &

exec nginx -g "daemon off;"
