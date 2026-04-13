# Deployment Guide

## Repository shape

- Public repo: this project
- Private storage: `private-data/` by default, optionally mirrored to a private repository

## Required secrets

- `DEEPSEEK_API_KEY`
- `FEISHU_WEBHOOK_URL`
- `PRIVATE_DATA_REPO_PAT`
- `PRIVATE_DATA_REPO`

## Required variables

- `PUBLIC_BASE_URL`
- `DISCOVERY_PROVIDER_SEARCH_TEMPLATES`
- `DISCOVERY_PROVIDER_REQUEST_HEADERS`
- `PRIVATE_DATA_REPO_BRANCH` (optional, defaults to `main`)
- `PRIVATE_DATA_REPO_BASE_PATH` (optional)

## Runner choice

The workflow defaults to `ubuntu-latest`.

If the collector and scraper need a more stable outbound network, set repository variable `ACTIONS_RUNNER=self-hosted`.

## First production run

1. Push the repository to GitHub
2. Configure Actions secrets and variables
3. Enable GitHub Pages
4. Trigger `workflow_dispatch`
   - Use `feishu_only` when only the Feishu delivery needs a retry
5. Verify:
   - `daily/` updated
   - `site/` updated
   - Feishu received the digest
   - No unresolved incident in `private-data/incidents/`
   - workflow artifact contains runtime copies of `private-data/runs` and `private-data/incidents`
