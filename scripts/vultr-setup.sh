#!/usr/bin/env bash
# Sets up Halcyon-contabil on a fresh Ubuntu 24.04 Vultr VM and prints the public URL. Run as root. Safe to run again:
# a second run pulls the latest code and rebuilds.
#
#   export VULTR_INFERENCE_API_KEY=...        # Vultr Serverless Inference, or:
#   export ANTHROPIC_API_KEY=sk-ant-...       # Claude
#   export REPO_URL=https://github.com/AlexjrFS/halcyon-contabil.git      # public repo
#   # private repo: use a read-only token in the URL: https://<user>:<token>@github.com/AlexjrFS/halcyon-contabil.git
#   bash vultr-setup.sh
#
# Optional: DOMAIN (default <ip>.sslip.io), DEMO_TOKEN (access code for the API), LLM_PROVIDER, VULTR_MODEL,
# ANTHROPIC_MODEL, APP_DIR.
set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${VULTR_INFERENCE_API_KEY:-}" ]; then
  echo "Set one model key first: export VULTR_INFERENCE_API_KEY=... (Vultr Serverless Inference) or export ANTHROPIC_API_KEY=..."
  exit 1
fi
: "${REPO_URL:?Set REPO_URL first (see the header of this script)}"
APP_DIR="${APP_DIR:-/opt/halcyon-contabil}"
PUBLIC_URL="$(printf '%s' "$REPO_URL" | sed -E 's#(https://)[^@/]*@#\1#')"

if [ "$(id -u)" -ne 0 ]; then echo "Run as root (the VM's default user on Vultr)."; exit 1; fi

echo "== Docker"
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
docker compose version >/dev/null

echo "== Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null || true
fi

echo "== Code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only "$REPO_URL" main
else
  git clone "$REPO_URL" "$APP_DIR"
fi
# Do not leave a token in .git/config
git -C "$APP_DIR" remote set-url origin "$PUBLIC_URL"
cd "$APP_DIR"

echo "== Settings"
if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)"
  DOMAIN="${IP//./-}.sslip.io"
fi
# Keep an existing DEMO_TOKEN across runs unless a new one is given
if [ -z "${DEMO_TOKEN:-}" ] && [ -f .env ]; then DEMO_TOKEN="$(grep -E '^DEMO_TOKEN=' .env | cut -d= -f2- || true)"; fi
umask 077
cat > .env <<ENV
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-}
VULTR_INFERENCE_API_KEY=${VULTR_INFERENCE_API_KEY:-}
VULTR_MODEL=${VULTR_MODEL:-}
LLM_PROVIDER=${LLM_PROVIDER:-}
DEMO_TOKEN=${DEMO_TOKEN:-}
DOMAIN=${DOMAIN}
ENV

echo "== Build and start"
docker compose -f docker-compose.prod.yml up -d --build

echo "== Waiting for https://${DOMAIN}/health (the first certificate can take a minute)"
for i in $(seq 1 36); do
  if curl -fsS "https://${DOMAIN}/health" >/dev/null 2>&1; then
    echo
    echo "Up: https://${DOMAIN}"
    [ -n "${DEMO_TOKEN:-}" ] && echo "Access code: ${DEMO_TOKEN}"
    exit 0
  fi
  sleep 5
done
echo "Not answering yet. Check: docker compose -f docker-compose.prod.yml logs --tail 50"
exit 1
