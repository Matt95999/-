# Operations

## Run modes

- `npm run daily_run`
- `npm run retry_failed_run`
- `npm run publish_only`
- `npm run feishu_only`
- `npm run manual_review`
- `npm run preflight_check -- --mode publish_only`

Use `npm run feishu_only` when the digest is already published and only the Feishu delivery needs to be retried.

## Incident flow

The remediation engine retries up to five times:

1. retry current scraper
2. allow excerpt-only mode
3. switch strategy or backup source
4. force local summarization fallback
5. allow partial publish and keep manual review open

## Review artifacts

- latest runs: `private-data/runs/`
- incidents: `private-data/incidents/`
- Feishu previews: `private-data/runs/*-feishu-preview.json`
- GitHub Actions artifacts: `runtime-artifacts-*`

## Production advice

- Keep discovery providers small and explicit at first
- Add whitelist sources continuously
- Treat incident logs as feedback for parser hardening
- Run `preflight_check` before `publish_only`, `feishu_only`, or a new environment cutover
- Keep `PRIVATE_DATA_REPO_PAT` and `PRIVATE_DATA_REPO` configured together, or leave both empty
