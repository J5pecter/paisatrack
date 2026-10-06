# paisatrack-data

This repository is the cloud backend for [PaisaTrack](https://github.com/topics/paisatrack).
It holds exactly one file that matters: `data.json`.

## This repo must be private

It contains your salary, your card balances and your loan details. Before you
put a token anywhere near it, confirm the repo is private.

PaisaTrack warns you in Settings if it detects a public repo, but check anyway.

## What is in here

| Path | What it is |
| --- | --- |
| `data.json` | Your entire financial dataset. Written by the app, one commit per sync. |
| `snapshots/` | Dated copies, created nightly by the backup workflow. |

## How restore works

Every sync is a commit, so the full history is recoverable three ways:

1. **In the app** — Settings → Restore from file, using a downloaded backup.
2. **From a snapshot** — copy a file out of `snapshots/` over `data.json`.
3. **From git** — `git log -- data.json`, then `git checkout <sha> -- data.json`.

After restoring from 2 or 3, open PaisaTrack and hit Sync now; it will pull the
restored file down.

## Setup

1. Create this repo as **private**.
2. Copy `.github/workflows/backup.yml` into it (optional but recommended).
3. Generate a fine-grained personal access token scoped to **this repo only**,
   with **Contents: Read and write**.
4. Paste the token into PaisaTrack → Settings → GitHub sync.

The token never leaves your browser except to talk to `api.github.com`.
