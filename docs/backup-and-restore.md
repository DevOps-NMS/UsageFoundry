# Backup and restore

[← Documentation index](README.md)

Everything this app knows about itself is one SQLite file in one Docker volume:
every run and its whole event log, what each one cost, your ceilings and guards,
your saved templates, specialists, workflows and schedules. There is no second
copy anywhere. `docker compose down -v` destroys it in one command.

Two commands, and then the reasoning behind them.

## Back up

```bash
docker compose exec usagefoundry node scripts/backup-db.mjs /backups
```

It writes `/backups/usagefoundry-<timestamp>.db`, which is `./backups` in this
checkout — a bind mount rather than the volume the database lives in, so the
snapshot survives the command that destroys the volume. It prints what it wrote
and how many rows are in it:

```
source  /data/usagefoundry.db (18.4 MB + 2.9 MB WAL)
wrote   /backups/usagefoundry-20260814T031500Z.db (16.1 MB)
checked integrity_check ok · 31 tables · 412 runs · 88,113 run_events · 3 workflows · …
```

It is safe to run while agents are working. Nothing is stopped, nothing is
locked out, and the file it writes is a single database with no sidecars —
copy it, sync it, put it wherever your other backups go.

## Restore

Onto a fresh container and a fresh volume, which is the case worth writing down
because it is the one nobody has practised:

```bash
docker compose down                  # stop the app; do not use -v unless you mean it
docker compose run --rm --entrypoint node usagefoundry \
  scripts/restore-db.mjs /backups/usagefoundry-20260814T031500Z.db
docker compose up -d
```

The middle command runs in a throwaway container with the same volumes attached,
so it works whether the volume is the one you had, a brand new empty one, or a
different machine's. Then open the dashboard: your runs, their history, your
settings, your workflows and your schedules are as they were at the moment of
the snapshot.

It refuses rather than guesses in three cases, each of which is a way a restore
becomes a second incident:

- **A server is still running against that volume.** The app holds the database
  open with its own write-ahead log; replacing the file underneath it does not
  replace the database, it corrupts it. The check is the age of the heartbeat in
  `server.lock` in the data directory — which works across containers, where a
  pid would not. A lock stamped within the last two minutes counts as a live
  owner, because a server's beat stops for the length of one `git` call without
  the server stopping. `docker compose stop` releases the lock, so the ordinary
  sequence needs no wait; a container that was *killed* leaves its lock behind,
  and the refusal names the second at which it counts as abandoned.
- **The file is not one of this app's databases.** Restores are done under
  pressure from a directory of similar-looking files.
- **It is not a readable SQLite database at all**, or fails `integrity_check`.

The database that was there is **moved aside, never deleted** — you will see
`usagefoundry.db.superseded-<timestamp>` beside the restored one, along with its
`-wal` and `-shm`. Delete those once you are satisfied. The sidecars have to go
with it: a `-wal` left behind belongs to the database being replaced, and SQLite
would replay it into the restored file.

Restoring an older backup into a newer image is fine. The schema migration is
idempotent `CREATE TABLE IF NOT EXISTS`, so the app brings the file up to date on
the next boot.

## Do it on a schedule

Nothing here runs a backup for you. Put this in the host's crontab — 3:15am
nightly, keeping the last 14:

```cron
15 3 * * * cd /path/to/UsageFoundry && docker compose exec -T usagefoundry node scripts/backup-db.mjs /backups --keep 14 >> backups/backup.log 2>&1
```

`-T` because cron has no TTY. `--keep 14` deletes older snapshots **that this
script generated**, matched by the exact `usagefoundry-<timestamp>.db` name, and
nothing else in that directory is touched.

A backup on the same machine as the container is not an offsite backup. It
protects you from `down -v`, an image rebuild that goes wrong, and a schema
change you want to undo — not from losing the disk. Sync `./backups` somewhere
else if that matters to you.

## Why `cp` is not a backup here

The obvious thing to do is copy the file, and it is the one thing that does not
work:

```bash
# Do not do this.
docker cp usagefoundry:/data/usagefoundry.db ./backup.db
```

The database runs in WAL mode, so the committed state is spread across three
files — `usagefoundry.db`, `usagefoundry.db-wal` and `usagefoundry.db-shm`. A
transaction is committed the moment it is in the `-wal`; it reaches the main file
only at a checkpoint, which may be minutes and hundreds of runs later.

So a copy of the main file alone is a database as it stood at the last
checkpoint. It opens cleanly. It passes `integrity_check`. It is simply missing
the newest work — which is the worst failure available, because there is nothing
about the file that says so. Measured against a live writer here, a `cp` taken at
the same instant as a snapshot held **25 runs where the snapshot held 386**, and
both files reported `ok`.

Copying all three files is worse, not better: they are read at three different
instants while runs write between them, so the `-wal` can reference pages the
main file does not have. That restores as a corrupt database, or as a
quietly inconsistent one.

`scripts/backup-db.mjs` uses SQLite's own answer, `VACUUM INTO`, which reads one
consistent snapshot under a read transaction and writes a fresh single-file
database — without blocking writers and without touching the source. The
connection it reads through is opened **read-only**, which is the guarantee
rather than the intent: this app is single-writer by design, and a second
process holding a writable handle is exactly what that design is about.

The snapshot is written under a temporary name and renamed into place only after
it passes `integrity_check`, so an interrupted backup leaves nothing that looks
complete.

## What is not in the backup

Deliberately, because it has other copies:

- **The agents' actual work.** It is committed to git branches in
  `.uf-worktrees` inside your workspace mount, which is a directory on your host.
- **Transcripts and credentials.** They are in your `~/.claude`, also a host
  directory. The dashboard's usage figures are derived from those, so they
  survive independently of this database.

What is *only* here is this app's own record: what ran, what it cost, and how it
was configured. Saved workflows and schedules in particular exist nowhere else —
not in git, not in a file — so losing the volume means rebuilding every graph and
every recurrence by hand.

## Looking inside a backup

The image carries `sqlite3`, so a file can be inspected before it is trusted:

```bash
docker compose exec usagefoundry sqlite3 /backups/usagefoundry-20260814T031500Z.db \
  "select count(*) from runs; select value from settings where key='weeklyCostLimit';"
```

Read-only questions against the live database are fine too. Anything that writes
to it while the app is running is not — that is the single-writer assumption the
folder claim rests on, and SQLite will not stop you.
