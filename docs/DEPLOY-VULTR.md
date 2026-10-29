# Deploying Halcyon-contabil on a Vultr VM

Halcyon-contabil runs as one container: the API, the web app and the built-in payment rail, with state in a Docker volume.

1. **VM.** Vultr Cloud Compute, Ubuntu 24.04, 1 vCPU / 2 GB is enough. Open ports 80 and 443 (and 22 for SSH).
2. **Docker.** `curl -fsSL https://get.docker.com | sh`
3. **Code and secrets.** `git clone <this repo> && cd <repo> && cp .env.example .env`, then set `ANTHROPIC_API_KEY` (and `DEMO_TOKEN` if the API should not be open).
4. **Run.** `docker compose up -d --build` and check `curl localhost:3000/health`.
5. **HTTPS and a public URL.** Either put Caddy in front (`caddy reverse-proxy --from your.domain --to localhost:3000`) or install Coolify from the Vultr Marketplace and point it at this repository's Dockerfile.
6. **Verify.** `GET https://your.domain/health` returns `{"ok":true,...}`.

State lives in the `halcyon-contabil-data` volume (`rail.json`, `proposals.json`, `state.json`). `POST /demo/reset` clears a demo run.
