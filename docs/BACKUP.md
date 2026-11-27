# Database backup and restore

TalkFav backs up its PostgreSQL database every day with GitHub Actions
(`.github/workflows/db-backup.yml`). Each backup is compressed, **encrypted with
AES-256**, and kept for 14 days as a workflow artifact. Without the backup
password the file cannot be read.

## One-time setup

In the GitHub repository go to **Settings → Secrets and variables → Actions →
New repository secret** and add:

| Name | Value |
|---|---|
| `DATABASE_URL` | the same PostgreSQL connection string Render uses |
| `BACKUP_PASSWORD` | a long random password (store it in a password manager) |

Run the first backup by hand: **Actions → Database backup → Run workflow**.

## Restore a backup

1. Open **Actions → Database backup**, pick a run, and download the artifact
   (a `.zip` that contains `talkfav-YYYY-MM-DD.sql.gz.enc`).
2. Unzip it, then in a terminal with `openssl` and `psql` (Git Bash on Windows
   includes `openssl`):

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass pass:YOUR_BACKUP_PASSWORD \
  -in talkfav-YYYY-MM-DD.sql.gz.enc | gunzip > talkfav.sql

psql "YOUR_DATABASE_URL" -f talkfav.sql
```

Restore into an **empty** database (for example a new Aiven service). Restoring
on top of existing tables will fail on duplicate rows.