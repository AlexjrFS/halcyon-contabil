# Halcyon-contabil (Vultr: Agent Rush Hackathon, challenge 2)

An AI finance agent: the agent explains a cash-policy decision, the founder approves, and a virtual card (issued by the built-in payment rail) enforces it. Hosted as one container on a Vultr VM. Dates: online build Nov 3 to 8, 2026 (submission deadline not published yet; plan to submit by the night of Nov 7).

Started as a copy of the `contabil-pj` repo (Airwallex hackathon build). This repo has **no Airwallex code** and must stay independent of it and of the personal Contabil app.

## Rules
- **Synthetic data only.** No real bank data, names or documents. The repo is public under MIT.
- **Money is integer cents** everywhere. Convert to major units only at the rail boundary (`toMajor` in `src/policy/money.ts`).
- **The model never computes amounts and never holds credentials.** Amounts, limits, reserves and state transitions are computed in `src/policy/`. The model calls typed tools and can only *propose* actions; code executes them after the user approves, with the approval bound to amount, currency, merchant category and merchant.
- **Approvals** (`src/approvals/`): the agent proposes by id; terms always come from `termsFor` (offer + policy). `approve` needs the fingerprint the founder saw. The executor re-checks the policy before running (`stale` if the terms changed) and is the only code that calls card create/update. Never give the model a tool that executes.
- **Agent** (`src/agent/`): tools are read-only or `propose_*` by id; `test/agent.test.ts` pins the tool names and parameters. Invoice notes go to the model inside `<untrusted_supplier_text>`. Default model `claude-haiku-5-5`, override with `ANTHROPIC_MODEL`.
- **The rail** (`src/rail/`) implements `RailApi`. Provider adapters must map "this request_id was already used" to `RailError` code `duplicate_request_id`: the executor relies on it to recover after a crash.
- **Secrets** only in `.env` (gitignored). Never commit or print them.
- Code, comments and README in **English** (judges read the repo). Chat with the user in pt-BR.
- The demo numbers are pinned by `test/policy.test.ts` (annual saves 18%, breaks the reserve in week 7). The video narration depends on them: don't change one without the other.

## Hosting
- One Node process (`src/server/main.ts`) serves the API and the static web app from `public/`; `Dockerfile` and `docker-compose.yml` run it on the Vultr VM with state in the `/data` volume. See `docs/DEPLOY-VULTR.md`.
- API paths are listed in `src/server/static.ts` (`API_PREFIXES`); add new API routes there too, or they will be served as static files.

## Before finishing a task
`npm run typecheck`, `npm test` and `npm run smoke`.
