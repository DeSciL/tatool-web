# Tatool Web — K8S deployment

Live at <https://tatool.vlab.ethz.ch>, namespace `li`.

Manifest source of truth: **`DescilK8S`, `li/li-tatool.yaml`**. [li-tatool.yaml](li-tatool.yaml) here
is a sanitised reference copy, not applied from this repo — it carries the rationale for each
setting. This file covers what the manifest can't: app behaviour and operational commands.

| | |
|---|---|
| Image | `<REGISTRY>/li/tatool:<tag>`, built on git tag push by `docker-ci.yml` |
| Port | 3000 (API and static SPA both) |
| Runs as | uid/gid 1001, non-root |
| Replicas | 1, `RollingUpdate` (`maxSurge: 1`, `maxUnavailable: 0`) |
| Storage | `trident-csi`, ReadWriteMany, 10 Gi |
| Database | Cluster MongoDB 8.3.8, own `tatool-web` database, **auth enabled** |

⚠ Pin a concrete version tag. `:latest` with `imagePullPolicy: IfNotPresent` never re-pulls.

---

## Environment

| Variable | |
|---|---|
| `NODE_ENV=production` | Required. Arms the `JWT_SECRET` check; without it that check only warns. |
| `JWT_SECRET` | Required — the app **exits 1** if unset or equal to `secret`. From the `li-tatool` Secret. |
| `DB_URI` | Required. Needs credentials **and** `?authSource=` — Mongo runs with auth. From the `li-tatool` Secret. |
| `PROJECTS_PATH_TYPE` / `PRIVATE_PATH_TYPE` | `local` |
| `PROJECTS_PATH` / `PRIVATE_PATH` | `/app/app/projects/` |
| `TRUST_PROXY` | Hop count, default `1`. Raise only if another proxy is added in front of the ingress. |
| `CORS_ORIGIN` | Optional, comma-separated. Cross-origin is denied by default; nothing needs it. |
| `LOG_FORMAT` | Optional. `combined` for Apache-style lines, which also log the full query string. |

⚠ **Trailing slashes on the path variables are mandatory** — they are string-concatenated onto
access/project names, so `/app/app/projects` yields `/app/app/projectspublic/...`.

Deliberately unset: `REGISTRATION_ENABLED`, `RECAPTCHA_PRIVATE_KEY`, `SENDER_EMAIL`,
`POSTMARK_API_KEY`, `MAIL_*`, `EDITOR_USER`. No mail transport is configured and none is needed.

---

## Database snapshots

`tatool-shell.js` writes a gzipped snapshot of the whole database to `/app/backups` (a third
`subPath` on the same PVC):

```
kubectl -n li exec deploy/li-tatool -- node tatool-shell.js db-backup --keep 30
kubectl -n li exec deploy/li-tatool -- node tatool-shell.js db-list
```

⚠ **This is "undo", not disaster recovery.** The snapshot lives on the same PVC as the data, so both
are lost together if the volume is. It protects against the likely failures — a deleted module, a bad
edit, an app bug, a botched migration. **Trident volume snapshots are the actual DR mechanism.**

There is no schedule yet; a nightly CronJob calling `db-backup --keep 30` is the obvious next step.

### Copying a snapshot out, and reopening it locally

The file is self-describing (source database, app version, timestamp, per-collection counts) and
restores into whatever `DB_URI` points at, so cluster → laptop works directly:

```
POD=$(kubectl -n li get pod -l app=li-tatool -o jsonpath='{.items[0].metadata.name}')
kubectl -n li cp $POD:/app/backups/tatool-<stamp>.json.gz ./backups/ -c li-tatool-container

docker compose exec tatool-web node tatool-shell.js db-restore tatool-<stamp>.json.gz        # dry run
docker compose exec tatool-web node tatool-shell.js db-restore tatool-<stamp>.json.gz --yes  # apply
```

`./backups` is bind-mounted into the compose container, so a file dropped there is visible
immediately. Without `--yes` it only prints a `current -> restored` table per collection — always
read that first, since restore **replaces** the contents of every collection in the snapshot.

Inspect one without restoring: `zcat tatool-<stamp>.json.gz | jq '.counts'`

⚠ **A snapshot is the whole database** — bcrypt password hashes, participant identifiers, collected
trial data. Copying one to a laptop copies the participant dataset with it, so it falls under the
study's data-protection scope. `backups/` is gitignored in the app repo; keep copies off shared
drives and delete them when done.

Types are encoded explicitly (`$oid`, `$date`) because the image has no `mongodump` and its bundled
`bson` predates `EJSON`. Any unrecognised BSON type makes the backup **fail** rather than silently
lose fidelity.

---

## Storage — three write locations, all must persist

**`/app/uploads`** — participant CSVs, written to a hardcoded *relative* path
(`controllers/resourceCtrl.js:182`). `PRIVATE_PATH` is ignored on the local code path, so no env var
can move it. Without this mount, collected data is lost on any restart. Project files can be
re-uploaded; collected data cannot be re-collected.

**`/app/app/projects`** — project assets. The image bakes ~57 MB of task batteries in here and
mounting a volume over the path hides them, so an initContainer seeds the volume.

⚠ **Do not seed with `cp -rn`** — busybox `cp -n` silently skips an entire subtree when the
destination directory exists, copying nothing. Copy file by file, quoting every path (several
batteries have spaces in their names). See the initContainer in the manifest.

**`/app/backups`** — database snapshots (see above). Loses nothing if dropped, but you also lose the
ability to undo a bad edit.

⚠ **`securityContext.fsGroup: 1001`** is mandatory. A fresh PVC is owned `root:root`, so a non-root
process cannot write to it.

---

## Probes

`/healthz` — 200 while the process is responsive. No dependency checks, so a Mongo outage does not
cause a restart loop.

`/readyz` — 200 when Mongo is connected, 503 otherwise. Recovers on its own.

⚠ **Never probe `/`.** It serves the SPA and returns 200 with Mongo completely unreachable.

Both report the build version, with the leading `v` stripped (tag `v0.0.6` → version `0.0.6`):

```
$ curl https://tatool.vlab.ethz.ch/healthz
{"status":"ok","version":"0.0.6"}
```

---

## Logging

One JSON line per request on stdout; `level` is derived from the status code.

```json
{"level":"info","method":"GET","path":"/api/user/modules","status":200,"duration_ms":8.3,
 "length":2,"extid":"student-042","code":10001,"ip":"203.0.113.7"}
```

`extid` is the study's participant id and `code` is Tatool's own participant number — the join key in
the CSV exports. Both come from the JWT as well as the URL, so a whole session is traceable.

Skipped: the probes, and **successful** static fetches — the SPA bundle and task stimuli via
`/{user,public,developer}/resources/`, where one participant run is hundreds of requests. Failures on
those paths are still logged; a 404 on a stimulus is what explains a task that will not run.

⚠ `ip` is personal data, unlike `extid` and `code`. The log store is therefore in the study's
data-protection scope and needs a retention limit.

---

## Admin shell

`tatool-shell.js` is in the image and is the entry point for everything the UI does not show —
diagnostics, project/module records, collected data. Interactive menu, or subcommands with `--json`:

```
kubectl -n li exec -it deploy/li-tatool -- node tatool-shell.js          # menu
kubectl -n li exec    deploy/li-tatool -- node tatool-shell.js doctor    # exit 1 on errors
kubectl -n li exec    deploy/li-tatool -- node tatool-shell.js data      # what has been collected
```

**Run `doctor` after every deploy.** It checks the things that fail silently here: resource files that
do not exist, modules referencing a missing project, published modules with no Analytics record,
installed copies stale against the published version. Current accepted baseline is **5 errors,
5 warnings** — see the app repo's `TODO.md` for why each is expected. Anything beyond that is new.

Modules are addressed by **label**, not project name (`stefanStroop`, not `stefan-stroop`).

---

## Accounts

Self-registration is disabled, so a fresh instance has no users:

```
kubectl -n li exec deploy/li-tatool -- node tatool-users.js user@ethz.ch admin@ethz.ch:admin
```

Passwords are generated and printed once — capture them. `:admin` grants the admin role; default is
`user, developer, analytics`. Re-running is safe.

⚠ **Never bootstrap with `node server.js lab prod`** — it creates the hardcoded, publicly documented
`admin@tatool-web.com` / `1234` on an internet-facing host.

No self-service password recovery: admins reset via `POST /api/admin/users/:user/reset`.

---

## Checks after a deploy

1. `/healthz` → version matches the tag you deployed.
2. `/readyz` → `{"status":"ready","db":"connected",...}`.
3. `kubectl -n li exec deploy/li-tatool -- ls /app/app/projects/public` → batteries listed.
   **Empty means seeding failed**, the most likely silent failure.
4. Complete a run, confirm a CSV under `/app/uploads`, then **delete the pod and check again**. If it
   is gone, `/app/uploads` is not persistent and you have silent data loss.

---

## Deliberate, do not "fix"

- **Three routes serve project resources unauthenticated** (`NO JWT CHECK` in `server.js`). The
  participant flow depends on this.
- **`trust proxy` is a hop count, not `true`.** `true` takes the client-supplied left-most
  `X-Forwarded-For` entry, letting anyone forge the logged IP.
- **The Modules page is empty on a fresh database.** Modules live in MongoDB; the initContainer seeds
  the filesystem. Not a seeding failure. The repo ships 41 definitions under
  `app/projects/*/modules/*.json` that match `moduleDefinition` and can be imported by script.

## Outstanding

- Mongoose 5.13.23 carries advisories fixable only by moving to ≥6.13.10.
