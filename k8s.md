# Tatool Web — K8S deployment brief

**For the session implementing manifests in the `DescilK8S` repo, `li` folder/namespace.**

This is self-contained: you do not need the tatool-web repo open, though the file references below
are all in `github.com/DeSciL/tatool-web` (branch `descil`) if you want to check something.

---

## 1. What you are deploying

AngularJS + Express experiment platform used to run cognitive tasks with participants. Researchers
log in to author "modules"; students/participants run them via an unauthenticated public URL.

| | |
|---|---|
| Image | `<HARBOR>/li/tatool:<tag>` — built by `docker-ci.yml` on tag push, cosign-signed |
| Namespace | `li` |
| Container port | **3000** |
| Runs as | uid **1001**, gid **1001** (non-root) |
| WORKDIR | `/app` |
| Replicas | **1** (see §4 — do not scale up) |
| Exposure | **Internet-facing** |
| Database | Existing helm-deployed cluster MongoDB `8.3.8` |

Deploy a specific tag or digest, not `:latest` — rollbacks need to be deterministic.
You will need an `imagePullSecret` for Harbor.

---

## 2. Environment variables

### Required — the pod will not start without these

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Arms the `JWT_SECRET` check below. Without it the check is only a warning. |
| `JWT_SECRET` | long random string, from a `Secret` | The app **calls `process.exit(1)`** if this is unset or equals the literal `secret` when `NODE_ENV=production`. A known signing key makes admin tokens forgeable, so this is deliberate. Generate with `openssl rand -base64 32`. |
| `DB_URI` | `mongodb://<mongo-svc>.<ns>.svc.cluster.local:27017/tatool-web` | Give tatool **its own database** on the existing instance. |

> If the pod CrashLoopBackOffs immediately with `FATAL: JWT_SECRET is not set`, that is this check
> working correctly — set the secret, don't work around it.

### Required for storage (see §3)

| Variable | Value |
|---|---|
| `PROJECTS_PATH_TYPE` | `local` |
| `PROJECTS_PATH` | `/app/app/projects/` |
| `PRIVATE_PATH_TYPE` | `local` |
| `PRIVATE_PATH` | `/app/app/projects/` |

⚠ **The trailing slash is mandatory.** Paths are built by naive string concatenation
(`projectsPath + project.access + '/' + ...`, `controllers/admin.js:303`), so
`/app/app/projects` without the slash silently produces `/app/app/projectspublic/...`.

### Deliberately not set

`REGISTRATION_ENABLED` (defaults to off — self-registration is disabled by design),
`RECAPTCHA_PRIVATE_KEY`, `SENDER_EMAIL`, `POSTMARK_API_KEY`, `MAIL_USER`, `MAIL_PW`, `EDITOR_USER`.
No mail transport is configured and none is needed; accounts are provisioned directly (§6).

---

## 3. Storage — two write locations, both must persist

**This is the part most likely to go wrong.** The app writes to two different places, and only one
of them is configurable.

### 3a. `/app/uploads` — participant data ⚠ most important

Collected experiment data (CSV per participant per session) is written to a **hardcoded relative
path**: `uploads/<mode>/<moduleId>/<code>_<session>.csv`
(`controllers/resourceCtrl.js:182`). Relative to WORKDIR, so `/app/uploads/...`.

Note `PRIVATE_PATH` is passed into that function and then **ignored** — it is only honoured on the
GCS code path. So you cannot redirect this with an env var.

**If `/app/uploads` is not a persistent volume, every participant's collected data is lost on pod
restart, rescheduling, or redeploy.** Project files can be re-uploaded by a researcher; collected
data cannot be re-collected. Treat this as the highest-value volume.

### 3b. `/app/app/projects` — project assets

Task stimuli, instructions and executables. Researchers upload here through the UI, and the image
ships **58 MB** of public task batteries baked in at `/app/app/projects/public/`.

⚠ **Mounting a volume at `/app/app/projects` hides the baked-in batteries.** You need an
`initContainer` to seed the volume from the image, or the shipped tasks silently disappear and
researchers open an empty instance.

Use `cp -rn` (no-clobber) rather than a one-shot marker file, so that when a future image ships new
upstream batteries they get added without overwriting anything a researcher has changed. Verify
busybox `cp -n` behaves as expected in the alpine base, or use a marker-file approach instead.

### Suggested layout — one PVC, two `subPath` mounts

```yaml
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: tatool-data

# in the app container
volumeMounts:
  - { name: data, mountPath: /app/uploads,        subPath: uploads }
  - { name: data, mountPath: /app/app/projects,   subPath: projects }

initContainers:
  - name: seed-projects
    image: <HARBOR>/li/tatool:<tag>        # same tag as the app container
    command: ["/bin/sh", "-c"]
    args:
      - cp -rn /app/app/projects/. /seed/ || true
    volumeMounts:
      - { name: data, mountPath: /seed, subPath: projects }
```

The initContainer must mount the volume somewhere **other** than `/app/app/projects`, otherwise it
hides its own source.

### Sizing and access mode

- Trident PVC, **ReadWriteOnce** is fine at 1 replica.
- Start around **10 Gi**: 58 MB seeded assets, plus participant CSVs (small, but one per
  participant per session), plus researcher uploads.
- **`securityContext.fsGroup: 1001`** on the pod, or writes fail with `EACCES` — the container is
  non-root.
- Do **not** set `readOnlyRootFilesystem: true`. Even with both volumes mounted, the app calls
  `mkdirp` on relative paths.

---

## 4. Why exactly 1 replica

`PROJECTS_PATH_TYPE=local` means uploads land on a local filesystem with no coordination between
pods. With ReadWriteOnce and >1 replica, pods either fail to schedule or silently diverge.

Trident can do ReadWriteMany over NFS, so multi-replica becomes *possible* later — but nobody has
tested this app for it, so leave it at 1 until someone deliberately does. There is no HPA and no
PodDisruptionBudget worth adding at 1 replica.

---

## 5. Probes — use `/healthz` and `/readyz`

> **Updated:** these endpoints now exist. If you already wrote `tcpSocket` probes based on an
> earlier version of this brief, switch to the HTTP probes below — they are strictly better.

| Endpoint | Behaviour |
|---|---|
| `GET /healthz` | Always `200` while the process is responsive. No dependency checks, so a database outage does **not** trigger a restart loop. |
| `GET /readyz` | `200 {"status":"ready","db":"connected"}` when MongoDB is connected; `503 {"status":"not ready","db":"disconnected"}` otherwise. |

```yaml
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
  initialDelaySeconds: 10
  periodSeconds: 10
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  initialDelaySeconds: 20
  periodSeconds: 20
```

Verified behaviour across a full outage cycle: readiness returns 503 while Mongo is down, liveness
stays 200 throughout (so the pod is not killed), and readiness returns to 200 on its own once Mongo
comes back — no restart needed.

⚠ **Do not point probes at `/`.** `express.static` serves the SPA and returns **200 even when
MongoDB is completely unreachable** — verified — so a probe on `/` reports a broken pod as healthy.
The `HEALTHCHECK` baked into the Dockerfile does exactly this; K8S ignores Docker healthchecks, so
just don't reproduce it in the manifests.

---

## 6. Post-deploy: create the accounts

Self-registration is **disabled**, so the instance has no users until you make some. The image
ships a seed script:

```
kubectl -n li exec deploy/tatool-web -- \
  node seed-users.js customer@example.org teacher@example.org:admin
```

- Passwords are **generated and printed once** — capture them from the command output.
- `:admin` grants the admin role; the default role set is `user, developer, analytics`
  (i.e. can author modules and see analytics).
- Re-running is safe: existing users are skipped.
- Never bootstrap with lab mode (`node server.js lab prod`). It creates
  `admin@tatool-web.com` / `1234`, which is hardcoded and publicly documented — unacceptable on an
  internet-facing host.

---

## 7. Ingress

- Internet-facing, TLS. **Hostname still to be decided — ask before assuming one.**
- Route everything to port 3000; the app serves both the API and the static SPA.
- Request bodies are capped at 1 MB in the app (`bodyParser.json({limit: 1048576})`), so the usual
  nginx `proxy-body-size: 1m` default is consistent. Raising it in the ingress alone won't help.
- The app does **not** currently set `trust proxy`, so `req.protocol` is `http` behind a
  TLS-terminating ingress. Only matters for absolute URLs the app builds (verification and
  password-reset emails), which are unused while registration is off. Being fixed app-side.
- CORS is currently wide open (`app.use(cors())`) — also being fixed app-side. Nothing to do here,
  but don't be surprised by it in a scan.

---

## 8. Resources

No profiling has been done. Starting point for a single-instance research app (it ran on a GAE F1
before):

```yaml
resources:
  requests: { cpu: 100m, memory: 256Mi }
  limits:   { cpu: "1",  memory: 1Gi }
```

Watch memory on first use — data export builds ZIP archives in-process via `archiver`.

---

## 9. Acceptance checklist

1. Pod `Running`, not CrashLoopBackOff. If it exited, read the logs — a deliberate `FATAL` about
   `JWT_SECRET` is the most likely cause.
2. `kubectl -n li exec deploy/tatool-web -- ls /app/app/projects/public | head` returns task
   batteries. **Empty means the initContainer seeding didn't work** — the single most likely silent
   failure.
3. Seed a user (§6) and log in through the browser.
4. As that user, author or open a module and confirm project assets load.
5. Publish a module as public, then open `https://<host>/#!/public/<moduleId>?extid=test-001`.
   It should run **without any login**. That is the student flow.
6. `kubectl -n li exec deploy/tatool-web -- ls -R /app/uploads` after completing a run — confirm a
   CSV appeared.
7. **Delete the pod, wait for reschedule, and re-check step 6.** If the CSV is gone, `/app/uploads`
   is not actually persistent and you have silent data loss. Do not skip this.

---

## 10. Needs a human decision

- **Hostname** for the Ingress.
- **MongoDB service DNS name** and namespace for `DB_URI`.
- Harbor registry hostname and the `imagePullSecret` to use.
- Trident storage class name, and confirmation that 10 Gi is a sensible start.
- Whether a stage instance is wanted alongside prod, or prod only.

---

## 11. Known app-side issues (context, not your work)

Tracked in `TODO.md` in the app repo; listed so you can recognise them if they surface:

- No graceful shutdown — the process exits immediately on SIGTERM, dropping in-flight requests.
  Rollouts do not hang; requests in progress are just cut.
- No request logging in production (`morgan` is dev-only), so there is little to collect.
- Image is ~1.1 GB, mostly a stray `npm` runtime dependency; being slimmed.
- Mongoose 5.13.23 has advisories fixable only by moving to ≥6.13.10; planned.
- Minor, and **not** something that affects participant data: researcher *developer-mode* test runs
  are written to `uploads/developer/<moduleId>/`, while the local export reads
  `uploads/user/<moduleId>`, so those test runs are not downloadable. Real participant data — both
  the logged-in and the student `?extid=` flows — is written with mode `user` and exports correctly.
  Mentioned only so that "developer test data won't download" isn't mistaken for a volume fault.
