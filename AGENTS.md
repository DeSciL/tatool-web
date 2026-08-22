# AGENTS.md

Instructions for agents working in this repo.

Tatool Web — AngularJS 1.x + Express platform for running cognitive experiments online. This is
DeSciL's fork of [tatool/tatool-web](https://github.com/tatool/tatool-web), deployed at
<https://tatool.vlab.ethz.ch>. Deployment details: [k8s/README.md](k8s/README.md). Open work:
[TODO.md](TODO.md).

**The three jobs an agent is expected to help with here:**

1. **Experiment setup** — building or importing modules, wiring stimuli and instructions.
2. **Data export** — getting collected trial data out, in bulk.
3. **Load simulation** *(later)* — driving the participant flow synthetically to test capacity.

Everything below either supports those or keeps you from breaking the deployment.

---

## Ground rules

- **Do not commit, push, tag or amend.** Stage with `git add` and summarise what you changed; the
  user makes the commits.
- **Work on `descil`.** `master` is an untouched mirror of `upstream/master`, used to pull upstream
  content via `git merge upstream/master`. Keep files that upstream also touches as close to upstream
  as possible — gratuitous diffs in shared files cause merge conflicts later.
- **Verify before claiming.** This repo has **no tests and no lint script**. If you change server
  behaviour, run it (see below) and show the output. Do not report a change as working on the
  strength of reading the code.
- **Match the existing style.** Server code is ES5-flavoured: `var`, callbacks, no async/await. This
  is not preference — see the Mongoose constraint below.

---

## Layout

| Path | |
|---|---|
| `server.js` | Express app: env config, routes, health endpoints, logging, shutdown |
| `controllers/` | Route handlers. Callback-style Mongoose. |
| `models/` | Mongoose schemas. `module.js` exports three models sharing one schema. |
| `app/scripts/` | AngularJS frontend source — **bundled by webpack into `dist/`** |
| `app/views/` | HTML templates, `require`d into the bundle. `app/views/doc/` is the in-app documentation (94 pages). |
| `app/projects/` | Task content on disk: stimuli, instructions, executables, module JSONs |
| `k8s/` | Deployment brief + sanitised reference manifest |
| `seed-users.js` | Provisions accounts (self-registration is disabled) |

Editing anything under `app/` requires a webpack rebuild before it takes effect — `dist/` is what is
served.

---

## Running and verifying

Local stack, mirrors production (Mongo 8.3.8 with auth, both persistent volumes):

```
docker compose up -d --build
docker compose exec tatool-web node seed-users.js you@ethz.ch   # prints a generated password once
curl localhost:3000/healthz   # {"status":"ok","version":"local"}
curl localhost:3000/readyz    # {"status":"ready","db":"connected",...}
```

`npm run dev` runs webpack-dev-server for frontend work; `npm run build` produces `dist/`.

Verifying a server change usually means: build the image, run it against Mongo, exercise the endpoint,
show the response codes. Health and auth are the quickest smoke test — seed a user, log in, hit an
authenticated route.

---

## Release flow

Tag → `docker-ci.yml` builds and pushes `<REGISTRY>/li/tatool:<tag>` to Harbor (cosign-signed) →
bump the image in `DescilK8S` `li/li-tatool.yaml` (**two places**: app container *and* the
`seed-projects` initContainer) → confirm with `/healthz` that the deployed version matches.

Nothing reaches production without a new tag *and* the manifest bump. Committed-but-unreleased work is
easy to lose track of.

---

## Hard constraints

**Mongoose 5.13.23, callbacks only.** 114 callback-style query call sites across 11 files. Mongoose 7+
removed callback support, so do not "modernise" a query to async/await — it would have to be all or
nothing. The intended upgrade target is 6.13.11, which keeps callbacks.

**`PROJECTS_PATH` / `PRIVATE_PATH` need trailing slashes.** They are string-concatenated onto
access/project names, so a missing slash silently yields `/app/app/projectspublic/...`.

**Participant data goes to a hardcoded relative path**, `uploads/<mode>/<moduleId>/…csv`
(`controllers/resourceCtrl.js`). `PRIVATE_PATH` is accepted and then ignored on the local code path.

**Registration is disabled** (`REGISTRATION_ENABLED`) and must stay off — captcha is non-functional
and no mail transport is configured. Accounts come from `seed-users.js`.

**`JWT_SECRET` is mandatory** in production; the app exits 1 without it rather than fall back to a
known key.

**Three routes serve project resources unauthenticated** (`NO JWT CHECK` in `server.js`). The
participant flow depends on this; do not "fix" it.

---

## Domain: setting up an experiment

### Object model

| Term | |
|---|---|
| **Executable** | A task / paradigm. The unit of behaviour. |
| **Property** | Typed key–value config on an Executable, so one task serves many experiments. |
| **Element** | Groups Executables, controls iteration and order. `List` or `Dual`. Nestable. |
| **Handler** | Shared state attached to an Element, available to its children (`trialCountHandler`, `levelHandler`). |
| **Module** | One runnable experiment: the Element/Executable tree plus metadata. |
| **Project** | Folder of files for an experiment (`executables/ instructions/ stimuli/ modules/`), and the access-control unit. |
| **Session** | One execution of a Module. Trials are stored per session. |

⚠ **Modules live in MongoDB; Projects live on the filesystem.** A freshly seeded instance therefore
has all the task *files* but an empty Modules list. That is expected, not a seeding failure.

### Setup path

1. Admin tab → Projects → add a project (name, access, owner email, and an executables descriptor
   `[{"customType":"myExecutable","description":"..."}]`). Creates the four subfolders.
2. Put stimuli CSVs, instruction HTML/images and executable code in those folders.
3. Build the Module in the Editor, **or** import a module JSON via the Editor's **Open** button
   (top right — file input wired to `addModule`, uses `FileReader`).
4. Publish as `public` or `private`. Republish after every edit; users must then update.
5. Distribute the participant URL.
6. Collect data via Analytics or the auto-upload exporter.

### Module JSON

Verified against `app/projects/public/tatool/modules/demoFlanker.json`. This is what the Editor's
Open button consumes, and the shape of the 41 files under `app/projects/*/modules/*.json`. It maps
onto the `moduleDefinition` field of a module document.

```json
{
  "name": "Demo: Flanker",
  "label": "demoFlanker",
  "author": "Tatool",
  "moduleMaxSessions": null,
  "fullscreen": true,
  "allowEscapeKey": true,
  "exportDelimiter": ",",
  "exportFormat": "long",
  "export": [
    { "mode": "upload",   "auto": true, "enabled": true },
    { "mode": "download", "enabled": true }
  ],
  "moduleHierarchy": {
    "tatoolType": "List",
    "label": "Task List",
    "iterator": { "customType": "ListIterator", "numIterations": 1, "order": "sequential" },
    "handlers": [],
    "children": [ ... ]
  }
}
```

- `label` becomes `moduleId` in the CSV export.
- `exportFormat`: `long` (default) or `legacy` (implicit fallback). `export.service.js:156` branches
  on `long` and treats anything else as legacy. **`"csv"` is not valid** — note
  `seed-sample-module.js` gets this wrong.
- `moduleMaxSessions: null` = unlimited. `numIterations: -1` = unlimited.
- `order`: `sequential` | `random` (re-randomised each iteration).
- `condition` on an Element: runs only when it matches the session condition. Plain string, no
  special characters or underscores.
- Shipped JSONs contain leaked AngularJS `$$hashKey` keys. Harmless, safe to strip.

**Dual Element:** first child is primary, second is secondary; order is primary → secondary →
primary. An Executable calling `suspend()` instead of `stop()` loops back for another secondary pass
— that is how complex-span tasks work. Primary-only is legal.

### Executable nodes

⚠ **Properties are flat siblings, not nested under a `properties` key.** The most common mistake when
hand-writing a module.

```json
{
  "tatoolType": "Executable",
  "customType": "tatoolInstruction",
  "name": "instruction",
  "project": { "access": "public", "name": "tatool" },

  "pages": {
    "propertyType": "ArrayResource",
    "propertyValue": [
      { "resourceType": "instructions", "resourceName": "tatoolFlanker.html",
        "project": { "access": "public", "name": "tatool" } }
    ]
  },
  "fixationInterval": 0,
  "blankInterval": "0"
}
```

### Property types

```json
String        →  "2000"                                    // plain string, even for numbers
Boolean       →  { "propertyType": "Boolean", "propertyValue": true }
ArrayString   →  { "propertyType": "ArrayString", "propertyValue": ["a","b"] }
Resource      →  { "propertyType": "Resource",
                   "project": { "name": "tatool-stimuli", "access": "public" },
                   "resourceName": "myFile.csv", "resourceType": "stimuli" }
Path          →  { "propertyType": "Path",
                   "project": { "name": "tatool-stimuli", "access": "public" },
                   "resourceType": "stimuli" }
ArrayResource →  { "propertyType": "ArrayResource", "propertyValue": [ <Resource>, ... ] }
```

Resolves to `{projects}/{access}/{project}/{resourceType}/{resourceName}`, where `resourceType` is
`stimuli`, `instructions` or `executables`.

External resources use `"project": { "name": "External Resource", "access": "external" }` with a full
URL in `resourceName` (or `resourcePath` for a Path). The Instruction task does **not** support
external HTML — images only.

### Stimuli CSV

One row per stimulus. Column names are a convention the display services depend on:
`stimulusValueType` (`text`|`image`|`video`|`audio`|`audio-text`|`audio-image`|`circle`|`square`),
`stimulusValue`, `stimulusAudioValue`, `stimulusType` (condition label — what `full-condition`
randomisation balances on), `stimulusClass`, `stimulusValueColor`, `correctResponse`, `keyCode`,
`keyLabel`, `keyLabelType`, `gridPosition`.

With randomisation on, list each unique combination once and control trial count via `numIterations`.

### Running with participants

```
https://<host>/#!/public/<moduleId>?extid=<participant>&c=<condition>&forceupload
```

- `extid` — participant id. Creates/reuses a temp user per `(extid, moduleId)`; no login,
  registration or email. Unauthenticated, so not verified identity.
- `c` — session condition, matched against Element `condition`. **This is how between-subjects
  manipulation works**: same module, different `c`, different Elements execute. Assignment is
  external — Tatool does no randomisation or balancing itself.
- `forceupload` — offers a manual upload button for incomplete sessions.

---

## Domain: data export

### Where the data physically is

Participant CSVs on the volume, one file per participant per session:

```
/app/uploads/<mode>/<moduleId>/<userCode>_<sessionId>.csv       # mode is 'user' or 'developer'
```

⚠ The write path includes `<mode>`, but the local read/zip path is hardcoded to `uploads/user/`
(`pathPrefix` in `resourceCtrl.js`). So **developer-mode test runs are written but not downloadable**
through the UI. Real participant runs — both logged-in and `?extid=` — use mode `user` and export
correctly.

Fastest bulk grab, bypassing the app entirely:

```
kubectl -n li exec deploy/li-tatool -- tar cf - -C /app/uploads/user . > data.tar
```

### Via the API

Download is a **two-step token flow**, because the actual download route is unauthenticated:

```
GET /api/analytics/data/modules/:moduleId              → returns a UUID token   (JWT required)
GET /api/analytics/data/modules/:moduleId/:userCode    → token, single participant
GET /data/user/:token                                  → streams a ZIP of matching CSVs (no auth)
```

The token is a `DownloadToken` document tied to moduleId (and optionally userCode). Requires the
`analytics` role and that the caller's email is on the module's Analytics record.

Supporting routes: `GET /api/analytics/modules` (list), `GET /api/analytics/modules/:moduleId`,
`DELETE /api/analytics/modules/:moduleId[/:userCode]`.

### CSV structure

One row per trial. Fixed leading columns: `userCode`, `extId`, `moduleId`, `sessionId`,
`sessionToken`, `trialId`, `executableId`, then `session.complete` (1 = finished or Escape-stopped,
0 = interrupted), then `module.<executable>.<prop>` / `session.<executable>.<prop>`, then trial
fields as `<executableName>.<propertyName>`.

`extId` is the join key back to your participant list. `sessionToken` is what a URL participant is
shown as proof of completion.

Note `exportFormat: long` (the default) omits the `<executable>.` prefix on trial columns;
`legacy` includes it (`export.service.js:156`).

---

## Domain: load simulation (not built yet)

No load-testing harness exists. The participant flow is scriptable without a browser, which is what
makes this feasible. Sequence:

```
GET  /public/run/:moduleId                       → module definition (must be moduleType 'public')
GET  /public/login/:moduleId?extid=<id>          → { token, roles, code }; creates/reuses a temp user
POST /api/public/modules/:moduleId/install       → installs the module for that temp user
POST /api/public/modules/:moduleId/trials/:sessionId
     body: { "trialData": "<LZString.compressToBase64 of the CSV-ish payload>", "target": ... }
```

Key facts for a simulator:

- Trial upload is **LZ-String compressed base64** (`lz-string`, `compressToBase64` client-side,
  `decompressFromBase64` in `resourceCtrl.js`). Not plain JSON.
- The write is an idempotent whole-file `fs.writeFile` keyed by participant+session — not an append —
  so re-posting a session overwrites rather than duplicating.
- Body limit is 1 MB (`bodyParser.json`), matched by the ingress `proxy-body-size: 1m`.
- A distinct `extid` mints a new temp user and DB record each time, unauthenticated and unthrottled.
  **A load test will therefore create real users and real files** — point it at a scratch module and
  clean up afterwards, and be aware rate-limiting this endpoint is an open TODO.
- Request logging skips successful stimulus fetches, so a load run will not be visible in the logs
  except via the non-static endpoints.

---

## Reference

**Task library.** Experimental: Brown-Peterson, Choice Reaction Time, Complex Span, Corsi Block,
Flanker, Item Recognition, Local Recognition, Memory Span, Monitoring, Object-Location Memory,
Shifting, Simon, Stroop. Training: Digit Memory Span. Accessory: Code, Countdown, Instruction.

**Shipped batteries** under `app/projects/public/`: `ept-14`, `uzh-ef-battery`, `uzh-luco-battery`,
`uzh-multi-battery`, `uzh-shifting-battery`, `Representation Asymmetry`, plus `tatool`,
`tatool-stimuli`, `tatool-share`. Each carries ready-to-run module JSONs under `modules/`.

**In-app docs** (`app/views/doc/`, 94 pages, served under the Docs tab). Per-task property tables are
in `lib-*.html`. Most useful for the jobs above: `start-glossary`, `use-editor`, `use-analytics`,
`ref-elements`, `ref-properties`, `ref-stimulus`, `ref-export`, `ref-handler`,
`dev-executable-project`.
