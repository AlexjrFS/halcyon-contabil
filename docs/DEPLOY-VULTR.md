# Deploying Halcyon-contabil on a Vultr VM

Two containers on one Vultr Cloud Compute VM: the **app** (API, web app, built-in payment rail, state in a Docker volume) and **Caddy** (HTTPS, with a certificate it gets and renews itself).

## Quick path

1. **VM.** Vultr Cloud Compute (shared CPU), Ubuntu 24.04, 1 vCPU / 2 GB is enough. Open ports 22, 80 and 443.
2. **Get the code on the VM**, as root. A public repository:
   ```bash
   git clone https://github.com/AlexjrFS/halcyon-contabil.git /opt/halcyon-contabil
   ```
   A private one, with a read-only fine-grained token in the URL:
   ```bash
   export REPO_URL='https://AlexjrFS:<token>@github.com/AlexjrFS/halcyon-contabil.git'
   git clone "$REPO_URL" /opt/halcyon-contabil
   ```
3. **Run the setup script.**
   ```bash
   export VULTR_INFERENCE_API_KEY='...'   # Vultr Serverless Inference key; or export ANTHROPIC_API_KEY='sk-ant-...' to use Claude
   export REPO_URL="${REPO_URL:-https://github.com/AlexjrFS/halcyon-contabil.git}"
   bash /opt/halcyon-contabil/scripts/vultr-setup.sh
   ```
   It installs Docker, opens the firewall, writes `.env`, builds and starts both containers, waits for HTTPS and prints the URL. With no `DOMAIN` set it uses `<ip-with-dashes>.sslip.io`, a name that already points at the VM, so no DNS setup is needed.
4. **Check.** `https://<your-url>/health` returns `{"ok":true,...}` and `/` shows the app.

Run the script again after pushing new code: it pulls and rebuilds.

## Settings (`.env`, written by the script)

| Variable | Meaning |
|---|---|
| `VULTR_INFERENCE_API_KEY` | Key for Vultr Serverless Inference (create it in the Vultr console, Serverless Inference). Used when it is the only model key set, or when `LLM_PROVIDER=vultr` |
| `VULTR_MODEL` | Optional. Default `kimi-k2-instruct`. Pick a model that supports tool calling |
| `ANTHROPIC_API_KEY` | Alternative: a Claude key made for this demo, with a spending limit set at the provider |
| `ANTHROPIC_MODEL` | Optional. Default `claude-haiku-5-5` |
| `LLM_PROVIDER` | Optional. `vultr` or `anthropic` to force one when both keys are set |
| `DOMAIN` | Public host name for Caddy |
| `DEMO_TOKEN` | Optional access code. When set, every API route but `/health` needs it, and the web app asks for it |
| `RATE_PER_MINUTE`, `CHAT_PER_HOUR_IP`, `CHAT_PER_HOUR_GLOBAL` | Demo limits (defaults 90, 40 and 200). The global one is the spending cap on model calls |

## Operating it

```bash
cd /opt/halcyon-contabil
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 100 app
docker compose -f docker-compose.prod.yml restart app
```

State lives in the `halcyon-contabil-data` volume (`rail.json`, `proposals.json`, `state.json`). The **Reset demo** button (or `POST /demo/reset`) clears a demo run. Back up the volume with `docker run --rm -v halcyon-contabil-data:/data -v "$PWD":/out busybox tar czf /out/data.tgz -C /data .`.

## What runs where

- **Vultr Cloud Compute VM**: the control layer. Agent loop, finance checks, policy, approvals, executor, payment rail and rate limits all run here. It is the system of record, not static hosting.
- **Caddy**: terminates HTTPS and streams the chat answer through unbuffered.
- **Model**: Vultr Serverless Inference (OpenAI-compatible chat with tool calling) or the Anthropic API. It is the only outside call. With Vultr, the whole stack runs on Vultr. Either way the model is limited to read tools and proposals.
