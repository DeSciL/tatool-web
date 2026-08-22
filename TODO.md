# TATOOL TODO

Fork of [tatool/tatool-web](https://github.com/tatool/tatool-web). Working branch: `descil`.
Target: **internet-facing** deployment on our K8S, Trident PVC, existing cluster MongoDB 8.3.8,
manifests in **DescilK8S → `li`** namespace. Golive ≈ **2026-09-05**.

---

# ★ PRIORITY LIST — implement in this order

## P0 — **DONE** (implemented and verified 2026-08-22)

| # | Task | Where | Verified |
|---|---|---|---|
| 1 | Registration disabled by default; `REGISTRATION_ENABLED=true` to opt in | [server.js](server.js) | `POST /api/register` → **403**, process survives, no account created |
| 2 | Auto-verify reverted; `verified` login guard restored; `deleteMany()` → `User.deleteOne()` | [user.js](controllers/user.js), [auth.js](controllers/auth.js) | unverified user → **500** "not yet verified" |
| 3 | `JWT_SECRET` required — exits rather than using a forgeable default | [server.js](server.js) | `NODE_ENV=production` without it → `FATAL`, **exit 1** |
| 4 | `seed-users.js` provisions accounts directly (bcrypt via the model hook) | [seed-users.js](seed-users.js) | seeded user logs in; wrong password → 401; re-run is idempotent |
| 5 | `moduleType: 'public'` guard on the public endpoints | [mainCtrl.js](controllers/mainCtrl.js) | public module → 200 (student flow intact), private → **404** |

Supporting changes: `seed-users.js` added to the [Dockerfile](Dockerfile) so accounts can be
provisioned in-cluster; `JWT_SECRET` set in [docker-compose.yml](docker-compose.yml) so local dev
still starts; [.env.example](.env.example) documents `REGISTRATION_ENABLED` and the mail variables.

**Two things the manifests must now get right:**
- **Set `NODE_ENV=production`** — that is what arms the `JWT_SECRET` fail-fast.
- **Set `JWT_SECRET`**, or the pod will (deliberately) refuse to start.

**Provisioning the customer's test users** (after the first deploy):
```
kubectl -n li exec deploy/tatool-web -- node seed-users.js customer@example.org teacher@example.org:admin
```
Passwords are generated and printed once. `:admin` grants the admin role; the default is
`user, developer, analytics`. Roles can be revised later with `--update-roles`.

## P1 — deploy path

| # | Task | Status |
|---|---|---|
| 6 | Commit `package-lock.json`, switch Dockerfile to `npm ci` | **DONE** — `.gitignore` had been excluding it, which is why none existed |
| 7 | Standard `docker-ci.yml`, delete the two GAE workflows | **DONE** — publishes `$HARBOR/li/tatool` |
| 8 | Manifests in DescilK8S `li`: 1 replica, Trident PVC + seeding initContainer + `fsGroup: 1001`, `JWT_SECRET`/`DB_URI` secrets, `NODE_ENV=production`, `tcpSocket` probe | **TODO** (~30 min) |
| 9 | Push a tag to produce the first image, then smoke test: log in as a seeded user, author a module, open the `?extid=` student URL | **TODO** (~15 min) |

Also done alongside #6: base image parameterised as `ARG NODE_VERSION` (default **26**; fall back
with `--build-arg NODE_VERSION=24`, today's Active LTS), `engines` relaxed to `>=20`, and mongoose
patched 5.13.20 → 5.13.23. Verified on Node 26 + MongoDB 8.3.8: build, startup, seeding, bcrypt
login, JWT, role enforcement, `?extid=` flow, `moduleType` guard, registration block.

## P2 — before golive (~2 weeks)

10. **Drop `"npm": "6.14.8"` from `dependencies`** ([package.json](package.json)) — one line that
    removes **49 of the 87** production advisories (they are reachable only through this bundled
    npm) and ~470 MB. Nothing at runtime needs it; `npm start` uses the base image's npm. Highest
    value-per-minute item left.
11. **Upgrade mongoose 5.13.23 → 6.13.11.** Three advisories have **no fix in the 5.x line**,
    including a **critical** search injection (`GHSA-vg7j-7cwx-8wgw`, needs ≥6.13.6) and a `$nor`
    `sanitizeFilter` NoSQL injection (≥6.13.9). Mongoose 6 is the right target because it **still
    supports callbacks**, so the 114 callback-style call sites survive. Work: remove the four
    removed connect options (`useNewUrlParser` / `useUnifiedTopology` / `useFindAndModify` /
    `useCreateIndex`) from [server.js](server.js), [seed-users.js](seed-users.js) and
    [seed-sample-module.js](seed-sample-module.js), then check `strictQuery` and
    `findByIdAndUpdate` default changes. Do **not** jump to 8 or 9 — mongoose 7 removed callbacks
    outright, which turns this into a 114-site rewrite across 11 files.
12. `/healthz` + `/readyz` endpoints, then repoint the K8S probes at them (§5).
13. `app.set('trust proxy', true)`, enable `morgan` in production, lock CORS to the hostname.
14. Rate-limit `/public/login/:moduleId` — it creates a DB record per unseen `extid`.
15. Slim the image further: `COPY --chown` instead of `chown -R` (saves 286 MB), narrow the `app/`
    copy (64 MB). With #10 this gets 1.11 GB down to roughly 250 MB.

**Deferred beyond golive:** captcha (§6), email delivery (§7), mongoose 8/9, Postgres.

---

# 1. ⚠ FIXED — anonymous request created a privileged account, then crashed the server

> **Resolved by P0 #1 and #2.** Retained as the record of what was wrong, and as the reason
> `REGISTRATION_ENABLED` must not be turned on until captcha (§6) and mail (§7) are both configured.

Reproduced against the built image with MongoDB 8.3.8 and no mail configured (i.e. exactly our
Phase-1 setup). A single unauthenticated request:

```
POST /api/register  {"userName":"attacker@evil.example","userPassword":"hunter2","devAccess":true}
```

**Result 1 — the account is created, verified, with developer privileges:**
```json
{ "email": "attacker@evil.example", "verified": true,
  "roles": ["user", "developer", "analytics"] }
```

**Result 2 — the process then dies with an uncaught exception:**
```
TypeError: user.deleteMany is not a function
    at /app/controllers/user.js:63:24
    at /app/node_modules/nodemailer/lib/mailer/index.js:230:21
    ...
Node.js v20.20.2
→ container Exited (1)
```

### Why this happens
Three separate defects line up:
1. [user.js:32](controllers/user.js#L32) — `user.verified = true; // Auto-verify for local
   development` (from commit `0ac6dee`), so no email confirmation is needed.
2. [auth.js:35-41](controllers/auth.js#L35-L41) — the `if (!user.verified)` login guard is commented
   out (same commit), so nothing re-checks it.
3. [user.js:63](controllers/user.js#L63) — the "roll back the user because the mail failed" path
   calls `user.deleteMany()`, which **does not exist on a document**. It throws inside a nodemailer
   callback, outside any try/catch and outside Express's error handling → uncaught → `process.exit(1)`.
   The rollback never happens, so the account persists.

### Impact on an internet-facing 1-replica deployment
- **Remote DoS:** one `curl` crashes the pod. K8S restarts it, the attacker repeats → CrashLoopBackOff.
- **Open signup with elevated roles:** `devAccess: true` grants `developer` + `analytics`, i.e.
  module authoring and access to participant data exports.
- Note the HTTP response never arrives (the client sees a timeout), so this looks like "registration
  is broken" rather than a breach. It is both.

### Fix (applied)
The `/register` route is now gated behind `REGISTRATION_ENABLED` (default off) and returns a plain
403 when disabled, so the crashing code path is unreachable. Both `0ac6dee` bypasses are reverted, so
even if registration is re-enabled accounts start unverified and cannot log in. `user.deleteMany()`
is now `User.deleteOne({_id: …})`, so the rollback works instead of throwing.

---

# 2. Strategy

**Students need no accounts and no auth.** Tatool already ships query-string participant
identification (built for MTurk/Prolific):

```
https://<host>/#!/public/<moduleId>?extid=<studentId>&c=<condition>&forceupload
```

Verified end-to-end against MongoDB 8.3.8:

| Request | Result |
|---|---|
| `?extid=student-042` (1st visit) | temp user created, `code: 10002` |
| `?extid=student-042` (2nd visit) | **same** user, `code: 10002` |
| `?extid=student-099` | new user, `code: 10003` |

No login, registration, captcha or email anywhere in that path. `extid` is stored on the user,
embedded in the JWT, shown in the Analytics tab, and included in exports
([export.service.js:138](app/scripts/app/export.service.js#L138)).
`&c=` drives conditional execution; `&forceupload` exposes a manual upload button
([app.developer.ctrl.js:271-279](app/scripts/app/app.developer.ctrl.js#L271-L279)).

→ **Student accounts do not need prepopulating.** They are created on first click and are stable
across sessions as long as the same `extid` is reused.

Two caveats:
- `extid` is **unauthenticated** — anyone with the URL can claim any id. Fine for a classroom (same
  trust model as Prolific), but it is not verified identity. If it matters, issue each student a
  random 16-character `extid`.
- Temp users are scoped per **(extid, moduleId)** ([user.js:99-103](controllers/user.js#L99-L103)),
  so one student across three modules yields three temp accounts sharing one `extid`. Analytics
  joins on `extid`, so this is fine — just expect it.

**Researchers/teachers:** registration stays off; seed the handful of customer test users directly
(P0 #4). The seed must go through Mongoose, not raw `mongosh` — bcrypt hashing lives in the
`pre('save')` hook ([models/user.js:51-68](models/user.js#L51-L68)). Thereafter the admin UI can
create and reset users (`POST /api/admin/users/:user`, `/reset`,
[server.js:132-135](server.js#L132-L135)) with no email involved.

⚠ **Do not bootstrap with lab mode on an internet-facing host.** `node server.js lab prod`
auto-creates `admin@tatool-web.com` / `1234` — hardcoded and publicly documented. That is why P0 #4
is a seed script rather than "start lab mode and change the password".

Because admin reset covers researcher lockout, **email never reaches the critical path.**

---

# 3. Upstream merge — **DONE**

- Added remote `upstream` → `https://github.com/tatool/tatool-web.git`.
- Fast-forwarded local `master`: `1d50bb5` → `3fafa13`.
- Merged into `descil` → merge commit `a443038`, **no conflicts**. Both upstream commits were
  content-only (uzh-ef Turkish translations + doc pages).
- **Not pushed yet.**

**Is the fork necessary? Yes.** Local `master` had zero commits upstream lacked, so there is no
divergence to manage, and the fork buys us upstream's ongoing content updates (task batteries,
translations) for free via `git merge upstream/master`. Keep `master` as a clean upstream mirror,
work on `descil`.

---

# 4. CI — standard `docker-ci.yml` (P1 #7)

Model on [DescilCICD](https://github.com/DeSciL/DescilCICD) / DescilPanel: tag-push +
`workflow_dispatch`, `runs-on: descil-runners`, ETH proxy build-args, `--provenance=false`,
push to Harbor + GitLab + GHCR, cosign signing. Deltas for this repo:

- `--file Dockerfile` — Dockerfile is at the repo root, so there is no `FOLDER` subdirectory like
  `Descil.Panel`.
- `LABEL: tatool-web`; `org.opencontainers.image.source=https://github.com/DeSciL/tatool-web`.
- **License is `GPL-3.0`**, not MIT (inherited from upstream).
- Delete `.github/workflows/build-deploy-prod.yml` and `build-deploy-stage.yml` (both deploy to
  Google App Engine via `zxyle/publish-gae-action@master` — an unpinned third-party action on a
  moving branch).
- The proxy build-args matter here: the build runs `npm install` **twice** (builder + runtime
  stages). Docker treats `http_proxy`/`https_proxy` as predefined build args, so no `ARG` lines are
  needed in the Dockerfile.
- Builds on **tags only** — a plain push to `descil` produces no image. Tag (e.g. `v1.5.1`).
- **`package-lock.json` (P1 #6) is a prerequisite.** Without it every tagged build resolves
  different transitive dependencies and "rebuild that tag" is not reproducible.

`app.yaml` / `app-stage.yaml` / `.gcloudignore` / the `gcp-build` script become dead, but they are
upstream files — leaving them costs nothing and avoids merge conflicts.

---

# 5. K8S manifests — DescilK8S, `li` namespace (P1 #8)

Deployment, Service, Ingress, Secret, PVC.

- **1 replica.** Trident supports RWX over NFS, so multi-replica is possible later, but
  `PROJECTS_PATH_TYPE=local` plus a single writer is the simple correct starting point.
- **`securityContext.fsGroup: 1001`** — the container runs as uid 1001
  ([Dockerfile:41-45](Dockerfile#L41-L45)); PVC writes fail with EACCES without it.
- **initContainer to seed `app/projects` from the image.** The public task batteries are baked in at
  `/app/app/projects`; mounting a PVC there **hides them**. Without the initContainer the shipped
  batteries silently disappear.
- **Probes: do not use `httpGet /`.** Verified that `/` returns `200` with the database completely
  unreachable, so it would actively lie about readiness. Use a `tcpSocket` probe on 3000 until
  `/healthz` + `/readyz` exist (P2 #10).
- **Secrets: only `JWT_SECRET` and `DB_URI`.** Everything else (`RECAPTCHA_*`, `SENDER_EMAIL`,
  `POSTMARK_API_KEY`, `MAIL_*`, `EDITOR_USER`) is only needed once registration and email return.
  `JWT_SECRET` **must** be set — it silently defaults to `'secret'`
  ([server.js:23](server.js#L23)), which makes every token forgeable, including admin.
- **MongoDB: use the existing cluster instance** with its own database
  (`DB_URI=mongodb://<svc>/tatool-web`). See §8.
- PVC size: ~64 MB of project assets are seeded; uploads grow from there.

Database failure mode worth knowing: [`mongoose.connect`](server.js#L39-L44) has no error handler,
and `initCounter`'s failure path never invokes its callback
([user.js:460-481](controllers/user.js#L460-L481)), so `setup()` never runs — `initProjects` is
silently skipped. With an unreachable DB the pod stays up, serves `200` on `/`, and logs one line.

---

# 6. Captcha — why it doesn't work (deferred)

Not on the golive path (registration is off), but this is the answer to the original question.
Three independent problems:

1. **Switched off** in commit `0ac6dee`: the widget div
   ([register.html:23-24](app/views/auth/register.html#L23-L24)), the client-side guard, and the
   `verifyCaptcha()` call ([auth.login.ctrl.js:58-79](app/scripts/auth/auth.login.ctrl.js#L58-L79))
   are all commented out.
2. **The site key is bound to a foreign domain.** `6LfSvfwSAAAAAOD0SuK_6f3vswGHswyH3kiHj-q3` is
   hardcoded at [register.html:24](app/views/auth/register.html#L24). Probing Google's `api2/anchor`
   endpoint returns **`Invalid domain for site key`** — even for `tatool.ch`. It can never work on
   our hostname; a new v2 key must be registered.
3. **Verification is fail-open and bypassable.**
   [user.js:157-181](controllers/user.js#L157-L181) returns `200` with no check at all when
   `RECAPTCHA_PRIVATE_KEY` is empty (the default). And it is a *separate* `POST /user/captcha` call,
   decoupled from `POST /api/register` — so a bot just calls register directly. That decoupling is
   upstream's design, not something we introduced.

If it is ever re-enabled: make the site key runtime-configurable (extend `/mode` into a `/config`
endpoint), verify **inside** `register` rather than in a separate call, and fail closed when the key
is unset. Also delete the dead reCAPTCHA **v1** block at
[auth.login.ctrl.js:144-157](app/scripts/auth/auth.login.ctrl.js#L144-L157) — it loads
`http://www.google.com/recaptcha/api/js/recaptcha_ajax.js`, shut down by Google in 2018.

---

# 7. Email — not required (deferred)

With registration off, every mail path is reachable only via self-registration or the password-reset
form, and admin reset covers researcher lockout.

If wanted later: nodemailer is hardcoded to `service: 'gmail'`
([user.js:506-514](controllers/user.js#L506-L514)), so an SMTP relay needs `MAIL_HOST`/`MAIL_PORT`/
`MAIL_SECURE` added; a webhook needs a new transport function. Comparable effort, ~20 lines either
way — pick whichever we already operate. `SENDER_EMAIL` is required by both paths and is missing
from [.env.example](.env.example).

---

# 8. MongoDB — use the existing cluster instance

**Do not deploy an old MongoDB <5.** Verified: `mongoose@5.13.20` (MongoDB Node driver 3.6) works
against `docker.io/mongo:8.3.8` (`maxWireVersion 28`, `minWireVersion 0`). Exercised successfully:
startup, index creation, counter init, project seeding, bcrypt user creation, basic-auth login →
JWT, authenticated queries, temp-user create/reuse. No errors — the driver negotiates OP_MSG and the
server still advertises `minWireVersion 0`, so the handshake passes.

An EOL Mongo <5 would be strictly worse: no security patches plus a second DB deployment to maintain.

Caveats:
- The combination is **outside the vendor support matrix** even though it works. Keep pinning by
  digest and re-test after Mongo upgrades.
- **Do not attempt a Mongoose upgrade before golive.** Mongoose 7+ removed callback-style queries
  entirely and this codebase is 100% callbacks; `useNewUrlParser` / `useUnifiedTopology` /
  `useFindAndModify` / `useCreateIndex` ([server.js:40-43](server.js#L40-L43)) are all removed too.
- [docker-compose.yml:5](docker-compose.yml#L5) pins `mongo:7.0` for local dev — worth aligning to
  `8.3.8` so local matches the cluster.

**On a future Postgres swap:** this is a data-layer rewrite, not a config change. Seven Mongoose
models, all callback-style, with `moduleDefinition` / `moduleProperties` / `sessions` stored as
`Schema.Types.Mixed` (schemaless JSON). They would map to `jsonb`, but every query, the `Counter`
sequence, and the three-collections-sharing-one-schema trick
([models/module.js:129-134](models/module.js#L129-L134)) would need rewriting. Budget it as a
project. Reassuring counterpoint given limited Mongo experience here: this app's usage is simple —
`findOne` / `save` / `find`, no aggregation, no transactions — so it needs very little Mongo
expertise to *operate*.

---

# 9. Remaining hardening (P2 detail)

- **No production request logging.** `morgan` is only enabled when `env === 'dev'`
  ([server.js:63-66](server.js#L63-L66)) — nothing for K8S log collection to collect.
- **`app.use(cors())`** ([server.js:67](server.js#L67)) allows any origin. Lock to the hostname.
- **`app.set('trust proxy', true)`** — needed behind the ingress for any absolute URL the app builds.
- Three routes are explicitly marked `// NO JWT CHECK`
  ([server.js:94](server.js#L94), [102](server.js#L102), [121](server.js#L121)) and serve project
  resources unauthenticated. The student flow depends on this, so it is intended — but confirm the
  exposure is acceptable now that the host is internet-facing.
- `GET /api/admin/users` returns bcrypt password hashes in the response body (no field projection).
  Admin-only, so low severity, but hashes should not be on the wire.
- Image is **1.28 GB**. Measured: `npm install --omit=dev` 471 MB (dominated by `"npm": "6.14.8"`
  being a *runtime* dependency, [package.json:60](package.json#L60)), `chown -R` duplicating
  286 MB into a new layer, `COPY app/` 64 MB. Fixing all three gets it under 300 MB.
- No `lint` script despite `jshint` + `.jshintrc` being present. `test/` has no configured runner —
  there is no automated regression safety net.

---

# 10. Checked and *not* a problem

Investigated and cleared — no action needed:

- **Docker build** — succeeds cleanly (exit 0).
- **SIGTERM handling** — measured: `docker stop` returns in ~1s. npm-as-PID-1 does forward the
  signal, so rollouts will not hang on the grace period. (Adding `server.close()` would make
  shutdown *graceful* rather than abrupt, but at 1 replica with short requests this is cosmetic.)
- **MongoDB 8.3.8 compatibility** — tested working (§8).
- **Node 20 base image** — fine; no need to bump before golive despite local dev being on Node 26.
- **`ejs.renderFile('views/...')` CWD-relative paths** — resolve correctly in the image (WORKDIR
  `/app`).
- **`/mode` returning `{}`** in server mode — the client falls back to `''`; harmless.
- **GAE leftovers** (`app.yaml`, `.gcloudignore`) — dead but harmless; keep to avoid merge conflicts.
- **GCS storage path** — not chosen; PVC instead. No work needed.
- **`.dockerignore`** — excludes `test`; the remaining unexcluded files (`mturk/`, `.github/`) are
  negligible.
- **HPA / PodDisruptionBudget** — not meaningful at 1 replica.
