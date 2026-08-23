# TATOOL TODO

Fork of [tatool/tatool-web](https://github.com/tatool/tatool-web). Working branch: `descil`.
Deployed at <https://tatool.vlab.ethz.ch> — see [k8s/README.md](k8s/README.md). Golive ≈ 2026-09-05.

**Unreleased:** the request-logging, `extid`/`ip` logging and `trust proxy` changes are committed but
need a new tag plus an image bump in `DescilK8S`.

---

## Outstanding

1. **Mongoose 5.13.23 → 6.13.11.** Clears a critical search injection (`GHSA-vg7j-7cwx-8wgw`) and a
   `$nor` NoSQL injection, neither fixable in 5.x. Work: drop the four removed connect options
   (`useNewUrlParser`, `useUnifiedTopology`, `useFindAndModify`, `useCreateIndex`) from
   [server.js](server.js), [tatool-users.js](tatool-users.js), [tatool-shell.js](tatool-shell.js);
   check `strictQuery` and `findByIdAndUpdate` default changes.
   ⚠ **Not 7+** — callbacks were removed there, and this codebase has 114 callback-style call sites
   across 11 files.

2. **`doctor` cannot be a CI gate while known upstream breakage is unfixed.** It exits 1 on the three
   `de_response_01_*` findings below, so a permanent red masks genuinely new problems. Add a small
   known-issues allowlist (accepted findings, by check + resource) so a fresh typo still stands out.

3. **Decide on password recovery.** Register and "Forgot password" links are hidden, so an admin must
   reset via `POST /api/admin/users/:user/reset`. Needs a mail transport to change.

4. **Rate-limit `/public/login/:moduleId`** — unauthenticated, and creates a DB record per unseen
   `extid`.

5. **`GET /api/admin/users` returns bcrypt hashes** in the response body. Admin-only, so low
   severity, but add a field projection.

6. Optional: no `lint` script despite `jshint` + `.jshintrc` being present; `test/` has no runner, so
   there is no automated regression safety net.

**Deferred:** captcha, email delivery, mongoose 8/9, Postgres.

---

## Known upstream issues — deliberately not fixed

**Three `uzh-shifting-battery` instruction files have a stray space before the extension.** Found by
`tatool-shell.js doctor` on its first run:

```
on disk:              de_response_01_01 .htm    de_response_01_02 .htm    de_response_01_04 .htm
module references:    de_response_01_01.htm     de_response_01_02.htm     de_response_01_04.htm
```

`_03` and `_05` are fine, so it is a typo in three filenames, not a convention. The module
`Shifting: Response` therefore 404s three instruction pages mid-task.

**Decision:** leave the files as upstream has them, to keep the fork clean and merges trivial.
Instead, `Shifting: Response` is **unpublished** on the deployed instance — it stays in the Editor but
is out of the repository, so no participant can start it. If upstream ever fixes the names, republish
with `tatool-shell.js publish shifting_response`.

Consequence: `doctor` reports three permanent `resource-missing` errors and exits 1. See Outstanding
item 2.

---

## Standing facts

**Fork discipline.** `master` mirrors `upstream/master` untouched; all work on `descil`; pull upstream
content with `git merge upstream/master`. Keeping shared files byte-identical to upstream is what
keeps those merges trivial.

**Students need no accounts.** `https://<host>/#!/public/<moduleId>?extid=<id>&c=<condition>` creates
and reuses a temp user per `(extid, moduleId)` — no login, registration, captcha or email. `extid` is
unauthenticated, so it is not verified identity.

**Registration is off** (`REGISTRATION_ENABLED`), and must stay off until captcha and mail both work.
Accounts come from [tatool-users.js](tatool-users.js).

**Captcha would need three fixes**, if ever re-enabled: it is commented out in
[register.html](app/views/auth/register.html) and
[auth.login.ctrl.js](app/scripts/auth/auth.login.ctrl.js); the hardcoded site key is bound to a
domain we do not control; and verification is fail-open *and* bypassable, being a separate
`POST /user/captcha` decoupled from `/api/register`.

**Email is unconfigured.** Nodemailer is hardcoded to `service: 'gmail'`, so an SMTP relay needs
`MAIL_HOST`/`MAIL_PORT`/`MAIL_SECURE` added.

**MongoDB.** Mongoose 5.13.23 works against the cluster's `8.3.8` despite being outside the vendor
support matrix — tested. Keep pinning by digest and re-test after Mongo upgrades.

**Postgres would be a rewrite**, not a migration: 7 callback-style models, `Mixed` schemaless
documents, a `Counter` sequence, and three collections sharing one schema.

---

## Checked, do not re-open

- Mongo 8.3.8 compatibility — works.
- Docker build, Node 26, `npm ci` — all fine.
- SIGTERM, PID 1, graceful shutdown — fixed.
- `ejs.renderFile` relative paths — resolve correctly in the image.
- GCS client — unused at runtime but kept; `resourceCtrl` requires it at module load.
- Narrowing `COPY app/` to `app/projects/` — not worth it. `app/projects` is 58 MB of the 61 MB, so
  it saves ~3 MB. Image is 669 MB; the floor is the 229 MB dependency layer plus the 178 MB base
  image.
- The 41 shipped module JSONs are import-ready; upstream's public library lived in upstream's own
  database and did not travel with the image.
