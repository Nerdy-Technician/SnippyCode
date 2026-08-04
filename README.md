<p align="center">
  <img src="client/public/CodeSnippy.png" alt="SnippyCode logo" width="128" height="128" />
</p>

<h1 align="center">SnippyCode</h1>

<p align="center">
  Private, self-hosted snippet management for commands, scripts, docs, raw install links, and team workflows.
</p>

<p align="center">
  <a href=".github/workflows/release.yml"><img alt="Release workflow" src="https://img.shields.io/badge/release-GHCR-66d9c2?style=for-the-badge&logo=githubactions&logoColor=14191c"></a>
  <a href="Dockerfile"><img alt="Docker" src="https://img.shields.io/badge/docker-ready-66d9c2?style=for-the-badge&logo=docker&logoColor=14191c"></a>
  <a href="LICENCE.md"><img alt="License" src="https://img.shields.io/badge/license-MIT-66d9c2?style=for-the-badge"></a>
</p>

## What It Does

SnippyCode is a private code library for storing useful snippets, install commands, scripts, and implementation notes. It pairs a Monaco-powered editor with authentication, auditability, raw-link sharing, and GitHub sync so a small team can keep working code close at hand without making it public.

## Highlights

- First-run owner setup with required authentication
- Local accounts, roles, MFA, avatars, and Gravatar fallback
- Optional OIDC login with provider testing and account matching
- Monaco editor with language detection, formatting, docs, command palette, and theming
- Per-snippet raw tokens with revoke and regenerate controls
- Secret warnings before saving or syncing snippets
- Admin tools for users, OIDC, GitHub sync, import/export, tasks, and audit logs
- PostgreSQL storage with Docker Compose healthchecks and backup profile
- Multi-architecture container releases through GitHub Container Registry

## Quick Start

```sh
cp .env.example .env
docker compose up -d
```

Open `http://localhost:5000`, complete the first-run owner wizard, then sign in.

Required production values:

```sh
SESSION_SECRET=replace-with-a-long-random-secret
POSTGRES_PASSWORD=replace-with-a-strong-db-password
```

## Local Development

```sh
npm run init
docker compose up -d postgres
npm run dev
```

The development servers run separately:

- Frontend: `http://localhost:3000`
- API/server: `http://localhost:5000`

Useful checks:

```sh
npm run build:tsc
npm run build --prefix client
docker build -t snippycode:local .
```

## Docker Compose

The included [docker-compose.yml](./docker-compose.yml) starts:

- `postgres`: PostgreSQL 16 storage
- `snippycode`: the Node API and built React client
- `postgres-backup`: optional backup profile

Run the released GHCR image:

```sh
SNIPPYCODE_IMAGE=ghcr.io/nerdy-technician/snippycode:latest docker compose up -d
```

Build locally instead:

```sh
docker compose up -d --build
```

Create a database backup:

```sh
docker compose --profile backup run --rm postgres-backup
```

Backups are written to the `postgres-backups` Docker volume.

## Configuration

Core environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | Yes | Signs auth sessions. Use a long random value in production. |
| `DATABASE_URL` | No | Full PostgreSQL connection URL. Compose sets this automatically. |
| `POSTGRES_DB` | No | Compose database name. Defaults to `snippycode`. |
| `POSTGRES_USER` | No | Compose database user. Defaults to `snippycode`. |
| `POSTGRES_PASSWORD` | Yes | Compose database password. |
| `SNIPPYCODE_PORT` | No | Host port for the app container. Defaults to `5000`. |
| `SNIPPYCODE_IMAGE` | No | Released image to run with Compose. |

Optional GitHub sync:

```sh
GITHUB_TOKEN=github_pat_...
GITHUB_REPO_OWNER=your-user-or-org
GITHUB_REPO_NAME=your-private-repo
GITHUB_REPO_BRANCH=main
GITHUB_SNIPPETS_PATH=snippets
```

The GitHub token needs contents read/write access to the target private repository.

## Roles

| Role | Access |
| --- | --- |
| `Viewer` | Read snippets and raw metadata. |
| `Editor` | Create, update, delete snippets, and manage raw tokens. |
| `Admin` | Manage server tasks, GitHub/OIDC/import/export/users. |
| `Owner` | Full access, including first-run ownership. |

## Raw Links

Raw URLs use per-snippet tokens:

```text
/raw/install-docker.sh?key=SNIPPET_RAW_TOKEN
```

Tokens can be generated, copied, regenerated, and revoked from the snippet detail page.

## Releases

The workflow in [.github/workflows/release.yml](./.github/workflows/release.yml) builds a multi-architecture container image and creates a GitHub release when the app version changes or when a SemVer tag is pushed.

Automatic release from a version bump:

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json .github/RELEASE.md
git commit -m "Release v1.0.1"
git push origin main
```

On `main`, the workflow reads `package.json`, creates the matching `vX.Y.Z` tag if it does not already exist, publishes the image, and creates the GitHub release.

Manual tag release:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Published image tags:

- `ghcr.io/nerdy-technician/snippycode:latest`
- `ghcr.io/nerdy-technician/snippycode:v1.0.0`
- `ghcr.io/nerdy-technician/snippycode:1.0.0`
- `ghcr.io/nerdy-technician/snippycode:1.0`

The same workflow can be run manually from GitHub Actions. Release body text lives in [.github/RELEASE.md](./.github/RELEASE.md); update it before tagging a new version.
