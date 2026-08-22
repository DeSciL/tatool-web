# Tatool Web — K8S deployment

Live at <https://tatool.vlab.ethz.ch>, namespace `li`.

- **Manifest source of truth:** `DescilK8S`, `li/li-tatool.yaml`.
- **Reference copy here:** [li-tatool.yaml](li-tatool.yaml), sanitised (registry host is
  `<REGISTRY>`). Not applied from this repo; if they diverge, DescilK8S wins.

This file records the settings that are load-bearing for *application* behaviour — the ones where a
reasonable-looking change silently breaks something.

| | |
|---|---|
| Image | `<REGISTRY>/li/tatool:<tag>`, built on git tag push by `docker-ci.yml` |
| Port | 3000 (API and static SPA both) |
| Runs as | uid/gid 1001, non-root |
| Replicas | 1, `RollingUpdate` (`maxSurge: 1`, `maxUnavailable: 0`) |
| Storage | `trident-csi`, ReadWriteMany, 10 Gi |
| Database | Cluster MongoDB 8.3.8, own `tatool-web` database, **auth enabled** |

---

## Environment

Required — the pod will not start without these:

| Variable | Note |
|---|---|
| `NODE_ENV=production` | Arms the `JWT_SECRET` check. Without it, that check only warns. |
| `JWT_SECRET` | The app **exits 1** if unset or equal to `secret`. From the `li-tatool` Secret. |
| `DB_URI` | Needs credentials **and** `?authSource=` — Mongo runs with auth. From the `li-tatool` Secret. |

Required for storage:

```
PROJECTS_PATH_TYPE=local   PROJECTS_PATH=/app/app/projects/
PRIVATE_PATH_TYPE=local    PRIVATE_PATH=/app/app/projects/
```

⚠ **Trailing slashes are mandatory.** These are string-concatenated onto access/project names, so
`/app/app/projects` yields `/app/app/projectspublic/...`.

Deliberately unset: `REGISTRATION_ENABLED` (self-registration is off), `RECAPTCHA_PRIVATE_KEY`,
`SENDER_EMAIL`, `POSTMARK_API_KEY`, `MAIL_*`, `EDITOR_USER`. No mail transport is configured and
none is needed.

---

## Storage — two write locations, both must persist

**`/app/uploads` — participant data.** Written to a hardcoded *relative* path,
`uploads/<mode>/<moduleId>/…csv` (`controllers/resourceCtrl.js:182`). `PRIVATE_PATH` is accepted and
then ignored on the local code path, so no env var can move it. Without this mount, every
participant's collected data is lost on any restart or reschedule. Project files can be re-uploaded;
collected data cannot be re-collected.

**`/app/app/projects` — project assets.** The image bakes ~57 MB of public task batteries in here,
and mounting a volume over the path hides them. An initContainer seeds the volume.

⚠ **Do not seed with `cp -rn`.** Busybox `cp -n` skips an entire subtree when the destination
directory already exists, so on a populated volume it copies nothing — silently. Copy file by file,
skipping what exists, and keep every `$f` quoted (several batteries have spaces in their names):

```sh
cd /app/app/projects
find . -type d -exec mkdir -p /seed/{} \;
find . -type f | while IFS= read -r f; do
  [ -e "/seed/$f" ] || cp -p "$f" "/seed/$f"
done
```

The initContainer must mount the volume somewhere **other** than `/app/app/projects`, or it hides
its own source.

⚠ **`securityContext.fsGroup: 1001`** is mandatory — the container is non-root, so without it every
volume write fails with `EACCES`.

---

## Probes

| Endpoint | Behaviour |
|---|---|
| `/healthz` | 200 while the process is responsive. No dependency checks, so a Mongo outage does not cause a restart loop. |
| `/readyz` | 200 when Mongo is connected, 503 otherwise. Recovers on its own when Mongo returns. |

⚠ **Never probe `/`.** It serves the SPA and returns 200 with Mongo completely unreachable, so it
reports a dead instance as healthy.

Both report the build version, so the running tag is one request away:

```
$ curl https://tatool.vlab.ethz.ch/healthz
{"status":"ok","version":"0.0.4"}
```

The version has the leading `v` stripped: git tag `v0.0.4` → image `:v0.0.4` → version `0.0.4`.

---

## Accounts

Self-registration is disabled, so a fresh instance has no users:

```
kubectl -n li exec deploy/li-tatool -- node seed-users.js user@ethz.ch admin@ethz.ch:admin
```

Passwords are generated and printed once — capture them. `:admin` grants the admin role; default is
`user, developer, analytics`. Re-running is safe.

⚠ **Never bootstrap with `node server.js lab prod`** — it creates the hardcoded, publicly documented
`admin@tatool-web.com` / `1234` on an internet-facing host.

There is no self-service password recovery (both register and "Forgot password" links are hidden).
Admins reset via `POST /api/admin/users/:user/reset`.

---

## Checks after a deploy

1. `curl https://tatool.vlab.ethz.ch/readyz` → `{"status":"ready","db":"connected",...}`.
2. `kubectl -n li exec deploy/li-tatool -- ls /app/app/projects/public` → batteries listed.
   **Empty means seeding failed** — the most likely silent failure.
3. Complete a run, confirm a CSV under `/app/uploads`, then **delete the pod and check again**. If
   it is gone, `/app/uploads` is not persistent and you have silent data loss.

---

## Known app-side issues

- **No graceful shutdown.** The process exits immediately on SIGTERM, dropping in-flight requests.
  The `preStop` sleep gives the ingress time to deregister first.
- **No request logging in production** (`morgan` is dev-only).
- **CORS is wide open** (`app.use(cors())`), and `trust proxy` is not set, so `req.protocol` is
  `http` behind the ingress.
- Three routes serve project resources unauthenticated (marked `NO JWT CHECK` in `server.js`). The
  participant flow depends on this.
- Mongoose 5.13.23 has advisories fixable only by moving to ≥6.13.10.
- **The Modules page is empty on a fresh database, by design** — modules live in MongoDB, seeding
  fills the filesystem. The repo ships 41 module definitions under `app/projects/*/modules/*.json`
  that match `moduleDefinition` directly and can be imported by script.
