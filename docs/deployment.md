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

## Self-hosted runner

The workflow is configured to run on `self-hosted`. The collector and scraper should stay there because content discovery is less stable on GitHub-hosted runners.

## First production run

1. Push the repository to GitHub
2. Configure Actions secrets and variables
3. Enable GitHub Pages
4. Trigger `workflow_dispatch`
5. Verify:
   - `daily/` updated
   - `site/` updated
   - Feishu received the digest
   - No unresolved incident in `private-data/incidents/`
