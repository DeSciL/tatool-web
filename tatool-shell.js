// Tatool admin shell: inspect and repair the things that are not visible in the UI.
//
// A fresh instance has all the task *files* (baked into the image, seeded onto the volume by the
// initContainer) but an empty database, so nothing shows up in the UI. Beyond that first gap, most
// failure modes in this app are silent — a module published outside the Editor has no Analytics
// record, a mistyped stimuli filename 404s mid-task, an edited module never reaches users who
// already installed it. This tool makes those visible and fixable.
//
// Interactive (opens the menu):
//   kubectl -n li exec -it deploy/li-tatool -- node tatool-shell.js
//   docker compose exec tatool-web node tatool-shell.js
//
// Non-interactive; every command takes --json for machine-readable output:
//   node tatool-shell.js doctor [--json] [--quiet]        exit 1 if problems found
//   node tatool-shell.js status [--json]
//   node tatool-shell.js data [--json] [--export <mod>] [--out <file.tar>]
//   node tatool-shell.js accounts [--json]
//   node tatool-shell.js projects [--only <projectName>]
//   node tatool-shell.js modules --owner <email> [--publish] [--only <substring>]
//   node tatool-shell.js publish <moduleLabel|moduleId>
//   node tatool-shell.js unpublish <moduleLabel|moduleId>
//   node tatool-shell.js repair-analytics
//   node tatool-shell.js export <moduleLabel|moduleId> [outfile.json]
//
// NOTE ON ASSETS: the app has no upload endpoint for project files, by design. Stimuli, instructions
// and executables reach the volume either baked into the image or copied in out-of-band:
//   kubectl -n li cp ./stimuli <pod>:/app/app/projects/public/<project>/stimuli -c li-tatool-container
// This tool manages the database records that make those files usable, not the files themselves.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');

const Project = require('./models/project');
const DeveloperModule = require('./models/module').developerModule;
const RepositoryModule = require('./models/module').repositoryModule;
const UserModule = require('./models/module').userModule;
const Analytics = require('./models/analytics');
const User = require('./models/user');

// Owned by projects.json and re-seeded by initProjects() on every startup — writing them here would
// just be overwritten.
const RESERVED = new Set(['tatool', 'tatool-stimuli']);

// Structural keys on a hierarchy node; everything else on an Executable node is a property.
const STRUCTURAL = new Set(['tatoolType', 'customType', 'name', 'project', 'handlers', 'children',
  'iterator', 'condition', 'label']);

const DESCRIPTIONS = {
  'ept-14': 'Everyday Problems Test (EPT-14): English, French and German versions of the updated and shortened Everyday Problems Test.',
  'uzh-ef-battery': 'Executive Functions: three tasks each for inhibition, shifting and updating. von Bastian, Souza, & Gade (2016).',
  'uzh-luco-battery': 'Language Use and Cognition: linguistic ability, monitoring, and working-memory list switching. Oschwald, Schaettin, von Bastian, & Souza (2018).',
  'uzh-multi-battery': 'Multifacet Working Memory Testing and Training Package: Tower of Fame testing and training. von Bastian, Langer, Jaencke, & Oberauer (2013).',
  'uzh-shifting-battery': 'Shifting: four tasks for each of five shifting components. von Bastian & Druey (2017).',
  'Representation Asymmetry': 'Representation Asymmetry study materials.',
  'tatool-share': 'Community-shared Tatool executables and stimuli.'
};

let JSON_OUT = false;
const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const emit = obj => { if (JSON_OUT) console.log(JSON.stringify(obj, null, 2)); };

/* ------------------------------------------------------------------ helpers */

function projectsRoot() {
  // Same resolution the server uses, so this works in-cluster and locally.
  const base = process.env.PROJECTS_PATH || path.join(__dirname, 'app', 'projects', '/');
  return path.join(base, 'public');
}
function uploadsRoot() {
  // Participant CSVs go to a hardcoded RELATIVE path in resourceCtrl, i.e. <cwd>/uploads.
  // PRIVATE_PATH is accepted and then ignored on the local code path, so it cannot be moved.
  return path.join(__dirname, 'uploads');
}
function dirsOnDisk() {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(d => {
    try { return fs.statSync(path.join(root, d)).isDirectory(); } catch (e) { return false; }
  });
}

// MongoDB rejects field names beginning with '$'. The shipped module JSONs carry AngularJS
// $$hashKey artifacts; the Editor's own import never trips on this because angular.toJson drops
// $$-prefixed properties on the way out. Inserting them directly fails with an empty 500.
function stripDollarKeys(value) {
  if (Array.isArray(value)) return value.map(stripDollarKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (!key.startsWith('$')) out[key] = stripDollarKeys(value[key]);
    }
    return out;
  }
  return value;
}
function hasDollarKeys(value) {
  if (Array.isArray(value)) return value.some(hasDollarKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).some(k => k.startsWith('$') || hasDollarKeys(value[k]));
  }
  return false;
}

function readModuleFiles() {
  const root = projectsRoot();
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const project of dirsOnDisk()) {
    const dir = path.join(root, project, 'modules');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        found.push({
          project, file,
          definition: stripDollarKeys(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
        });
      } catch (err) {
        say(`  SKIP ${project}/${file}: unparseable (${err.message})`);
      }
    }
  }
  return found;
}

// Walk a definition collecting every project reference and every concrete resource reference.
function walkRefs(definition) {
  const projects = new Set(), resources = [];
  (function w(n) {
    if (!n || typeof n !== 'object') return;
    if (n.project && n.project.name) projects.add(n.project.name);
    if (n.resourceName && n.project && n.project.access !== 'external') {
      resources.push({ access: n.project.access, project: n.project.name,
        type: n.resourceType, name: n.resourceName });
    }
    for (const k of Object.keys(n)) w(n[k]);
  })(definition);
  return { projects: [...projects], resources };
}

// Mirrors the server's path building: {projects}/{access}/{project}/{resourceType}/{resourceName}
function resourcePath(r) {
  const base = process.env.PROJECTS_PATH || path.join(__dirname, 'app', 'projects', '/');
  return path.join(base, r.access || 'public', r.project, r.type || '', r.name);
}

// Derive each project's executables descriptor from the properties its modules actually use. More
// reliable than parsing the executable source, and it matches the format projects.json uses.
function deriveExecutables(modules) {
  const byProject = {};
  for (const { definition } of modules) {
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.tatoolType === 'Executable' && node.project && node.customType) {
        const p = node.project.name, c = node.customType;
        byProject[p] = byProject[p] || {};
        byProject[p][c] = byProject[p][c] || {};
        for (const key of Object.keys(node)) {
          if (STRUCTURAL.has(key)) continue;
          const v = node[key];
          const type = (v && typeof v === 'object' && v.propertyType) ? v.propertyType
            : (typeof v === 'boolean' ? 'Boolean' : null);
          if (type || !(key in byProject[p][c])) byProject[p][c][key] = type;
        }
      }
      for (const key of Object.keys(node)) walk(node[key]);
    })(definition.moduleHierarchy);
  }
  return byProject;
}
function executablesDescriptor(derived) {
  return Object.entries(derived || {}).map(([customType, props]) => ({
    customType,
    description: customType,
    customProperties: Object.entries(props).map(([propertyName, propertyType]) =>
      propertyType ? { propertyName, propertyType } : { propertyName })
  }));
}

// Mirrors analyticsCtrl.initAnalytics, which is only called from developerCtrl's *update* path (the
// Editor's save), NOT from publish. A module published any other way has no Analytics record, so it
// never appears under Analytics and addAnalyticsUser silently no-ops for every participant. Trial
// CSVs still land on disk, so nothing is lost; it just cannot be seen or downloaded via the UI.
async function ensureAnalytics(mod) {
  const existing = await Analytics.findOne({ moduleId: mod.moduleId, created_by: mod.created_by });
  if (existing) {
    existing.moduleName = mod.moduleName;
    existing.moduleLabel = mod.moduleLabel;
    await existing.save();
    return false;
  }
  const a = new Analytics();
  a.moduleId = mod.moduleId;
  a.moduleName = mod.moduleName;
  a.moduleLabel = mod.moduleLabel;
  a.created_by = mod.created_by;
  a.created_at = new Date();
  a.email = [mod.created_by];
  a.userData = [];
  await a.save();
  return true;
}

async function findModule(target) {
  const q = { $or: [{ moduleLabel: target }, { moduleId: target }] };
  return (await DeveloperModule.findOne(q)) || (await RepositoryModule.findOne(q));
}

/* ----------------------------------------------------------------- commands */

async function cmdStatus() {
  const onDisk = dirsOnDisk();
  const files = readModuleFiles();
  const registered = new Map((await Project.find({})).map(p => [p.name, p]));
  const dev = await DeveloperModule.countDocuments({});
  const pub = await RepositoryModule.countDocuments({});

  const projects = onDisk.sort().map(name => ({
    name,
    registered: registered.has(name),
    executables: registered.has(name) ? (registered.get(name).executables || []).length : 0,
    reserved: RESERVED.has(name)
  }));
  const orphanRecords = [...registered.keys()].filter(n => !onDisk.includes(n));
  const result = { projectsRoot: projectsRoot(), projects, orphanRecords,
    moduleFilesOnDisk: files.length, developerModules: dev, publishedModules: pub };

  emit(result);
  say(`projects root: ${result.projectsRoot}\n`);
  say(`projects (${onDisk.length} on disk, ${registered.size} registered):`);
  projects.forEach(p => say(`  ${p.name.padEnd(26)} ` +
    (p.registered ? `registered, ${p.executables} executables` : 'NOT REGISTERED') +
    (p.reserved ? ' (reserved)' : '')));
  orphanRecords.forEach(n => say(`  ${n.padEnd(26)} registered but NO DIRECTORY ON DISK`));
  say(`\nmodules: ${files.length} on disk, ${dev} imported, ${pub} published`);
  return result;
}

// Every check here exists because the corresponding failure is silent in the app.
async function cmdDoctor(opts) {
  const onDisk = new Set(dirsOnDisk());
  const findings = [];
  const add = (check, severity, detail) => findings.push({ check, severity, ...detail });

  const registered = await Project.find({});
  const regNames = new Set(registered.map(p => p.name));
  for (const d of onDisk) if (!regNames.has(d)) add('project-unregistered', 'warn', { project: d });
  for (const p of registered) if (!onDisk.has(p.name)) add('project-missing-on-disk', 'error', { project: p.name });

  const dev = await DeveloperModule.find({});
  const repo = await RepositoryModule.find({});
  const analytics = await Analytics.find({}, { moduleId: 1, created_by: 1 });
  const analyticsKeys = new Set(analytics.map(a => a.moduleId + '|' + a.created_by));

  const seenPaths = new Map();
  for (const m of dev) {
    const { projects, resources } = walkRefs(m.moduleDefinition || {});

    for (const p of projects) {
      if (p !== 'External Resource' && !onDisk.has(p)) {
        add('module-missing-project', 'error', { module: m.moduleName, project: p });
      }
    }
    // The Editor's resource-name field is free text and never lists the folder, so typos are only
    // discovered when a participant hits the task.
    for (const r of resources) {
      const full = resourcePath(r);
      if (!seenPaths.has(full)) seenPaths.set(full, fs.existsSync(full));
      if (!seenPaths.get(full)) {
        add('resource-missing', 'error',
          { module: m.moduleName, resource: `${r.project}/${r.type}/${r.name}`, path: full });
      }
    }
    if (m.moduleType && !analyticsKeys.has(m.moduleId + '|' + m.created_by)) {
      add('published-without-analytics', 'error', { module: m.moduleName });
    }
    const exporters = (m.moduleDefinition && m.moduleDefinition.export) || [];
    if (m.moduleType && !exporters.some(e => e.enabled && e.auto && e.mode === 'upload')) {
      add('no-auto-upload', 'warn', { module: m.moduleName });
    }
    if (hasDollarKeys(m.moduleDefinition)) add('dollar-keys', 'warn', { module: m.moduleName });
  }

  // Users who installed before an edit keep the old definition until they click Update, which only
  // appears when installedVersion < repositoryVersion.
  const repoVersions = new Map(repo.map(r => [r.moduleId, parseInt(r.moduleVersion) || 0]));
  for (const inst of await UserModule.find({}, { moduleId: 1, moduleName: 1, email: 1, moduleVersion: 1 })) {
    const rv = repoVersions.get(inst.moduleId);
    if (rv !== undefined && (parseInt(inst.moduleVersion) || 0) < rv) {
      add('stale-install', 'warn',
        { module: inst.moduleName, user: inst.email, installed: inst.moduleVersion, published: rv });
    }
  }

  const errors = findings.filter(f => f.severity === 'error').length;
  const warns = findings.length - errors;
  emit({ ok: findings.length === 0, errors, warnings: warns, findings });

  if (!opts.quiet) {
    if (!findings.length) say('No problems found.');
    else {
      const byCheck = {};
      findings.forEach(f => (byCheck[f.check] = byCheck[f.check] || []).push(f));
      for (const [check, list] of Object.entries(byCheck)) {
        say(`\n${list[0].severity.toUpperCase()}  ${check}  (${list.length})`);
        list.slice(0, 12).forEach(f => {
          const bits = Object.entries(f).filter(([k]) => k !== 'check' && k !== 'severity')
            .map(([k, v]) => `${k}=${v}`).join('  ');
          say(`    ${bits}`);
        });
        if (list.length > 12) say(`    ... +${list.length - 12} more`);
      }
      say(`\n${errors} error(s), ${warns} warning(s).`);
    }
  }
  if (errors) process.exitCode = 1;
  return findings;
}

async function cmdData(opts) {
  const root = uploadsRoot();
  const byModule = {};
  // Written as uploads/<mode>/<moduleId>/<code>_<session>.csv
  if (fs.existsSync(root)) {
    for (const mode of fs.readdirSync(root)) {
      const modeDir = path.join(root, mode);
      if (!fs.statSync(modeDir).isDirectory()) continue;
      for (const moduleId of fs.readdirSync(modeDir)) {
        const md = path.join(modeDir, moduleId);
        if (!fs.statSync(md).isDirectory()) continue;
        const files = fs.readdirSync(md).filter(f => f.endsWith('.csv'));
        if (!files.length) continue;
        let bytes = 0, latest = 0;
        const participants = new Set();
        for (const f of files) {
          const st = fs.statSync(path.join(md, f));
          bytes += st.size;
          latest = Math.max(latest, st.mtimeMs);
          participants.add(f.split('_')[0]);
        }
        const key = mode + '/' + moduleId;
        byModule[key] = { mode, moduleId, dir: md, sessions: files.length,
          participants: participants.size, bytes, latest: new Date(latest).toISOString() };
      }
    }
  }
  const names = new Map((await RepositoryModule.find({}, { moduleId: 1, moduleName: 1, moduleLabel: 1 }))
    .map(m => [m.moduleId, m]));
  const rows = Object.values(byModule).map(r => ({
    ...r,
    moduleName: names.has(r.moduleId) ? names.get(r.moduleId).moduleName : '(unknown module)',
    moduleLabel: names.has(r.moduleId) ? names.get(r.moduleId).moduleLabel : null
  })).sort((a, b) => b.latest.localeCompare(a.latest));

  emit({ uploadsRoot: root, modules: rows,
    totals: { sessions: rows.reduce((s, r) => s + r.sessions, 0),
      bytes: rows.reduce((s, r) => s + r.bytes, 0) } });

  say(`uploads root: ${root}\n`);
  if (!rows.length) say('No collected data yet.');
  rows.forEach(r => say(`  ${String(r.moduleName).slice(0, 34).padEnd(36)}` +
    ` sessions=${String(r.sessions).padEnd(5)} participants=${String(r.participants).padEnd(5)}` +
    ` ${(r.bytes / 1024).toFixed(1)}kB   ${r.latest.slice(0, 16)}`));
  if (rows.length) say(`\n  total: ${rows.reduce((s, r) => s + r.sessions, 0)} sessions across ${rows.length} module(s)`);

  if (opts.export) {
    const mod = await findModule(opts.export);
    if (!mod) { console.error(`No module '${opts.export}'.`); process.exitCode = 1; return; }
    const dir = path.join(root, 'user', mod.moduleId);
    if (!fs.existsSync(dir)) { console.error(`No data directory for ${mod.moduleName}.`); process.exitCode = 1; return; }
    const out = opts.out || `/tmp/${mod.moduleLabel || mod.moduleId}.tar`;
    const res = spawnSync('tar', ['cf', out, '-C', dir, '.'], { stdio: 'inherit' });
    if (res.status !== 0) { console.error('tar failed'); process.exitCode = 1; return; }
    say(`\nwrote ${out} — retrieve with:`);
    say(`  kubectl -n li cp <pod>:${out} ./${path.basename(out)} -c li-tatool-container`);
  }
}

async function cmdAccounts(opts) {
  const users = await User.find({ tempUser: null },
    { email: 1, roles: 1, verified: 1, code: 1, extid: 1 });
  const owned = {};
  for (const m of await DeveloperModule.find({}, { created_by: 1 })) {
    owned[m.created_by] = (owned[m.created_by] || 0) + 1;
  }
  const temps = await User.countDocuments({ tempUser: true });
  const rows = users.map(u => ({ email: u.email, roles: u.roles, verified: u.verified,
    code: u.code, modulesOwned: owned[u.email] || 0 }));

  emit({ accounts: rows, tempParticipants: temps });
  say(`accounts (${rows.length}), plus ${temps} temp participant record(s)\n`);
  rows.forEach(r => say(`  ${String(r.email).padEnd(28)} code=${String(r.code).padEnd(7)}` +
    ` owns=${String(r.modulesOwned).padEnd(4)} verified=${r.verified}  ${(r.roles || []).join('/')}`));
  say('\nAnalytics is owner-scoped: only the account that published a module can see its data.');

  if (opts.create) {
    // Spawn tatool-users.js so password generation and the bcrypt pre-save hook stay in one place.
    say('');
    const res = spawnSync(process.execPath,
      [path.join(__dirname, 'tatool-users.js'), ...opts.create], { stdio: 'inherit' });
    if (res.status !== 0) process.exitCode = res.status || 1;
  }
}

async function cmdProjects(opts) {
  const root = projectsRoot();
  if (!fs.existsSync(root)) {
    console.error(`No projects directory at ${root}. Is PROJECTS_PATH set correctly?`);
    process.exitCode = 1;
    return;
  }
  const derived = deriveExecutables(readModuleFiles());
  const owner = process.env.SEED_OWNER || 'admin@localhost';
  let created = 0, updated = 0, skipped = 0, matched = 0;

  for (const name of dirsOnDisk()) {
    // Exact match, unlike the substring match on `modules`: project names are short and share
    // prefixes, and a stray hit would silently rewrite the wrong record.
    if (opts && opts.only && name !== opts.only) continue;
    matched++;
    if (RESERVED.has(name)) { skipped++; continue; }

    const executables = executablesDescriptor(derived[name]);
    const description = DESCRIPTIONS[name] || `${name} project.`;
    const existing = await Project.findOne({ name, access: 'public' });
    if (existing) {
      existing.description = description;
      existing.executables = executables;
      await existing.save();
      updated++;
      say(`  updated  ${name.padEnd(26)} executables=${executables.length}`);
    } else {
      const project = new Project();
      project.name = name;
      project.access = 'public';
      project.email = owner;
      project.description = description;
      project.executables = executables;
      await project.save();
      created++;
      say(`  created  ${name.padEnd(26)} executables=${executables.length}`);
    }
  }
  if (opts && opts.only && matched === 0) {
    console.error(`No project directory named '${opts.only}' under ${root}.`);
    process.exitCode = 1;
    return;
  }
  emit({ created, updated, skipped });
  say(`\ncreated ${created}, updated ${updated}, skipped ${skipped} (reserved).`);
}

async function cmdModules(opts) {
  if (!opts.owner) {
    console.error('--owner <email> is required: developer modules belong to a user.');
    process.exitCode = 1;
    return;
  }
  const known = new Set(dirsOnDisk());
  let imported = 0, existing = 0, published = 0, withheld = 0;

  for (const { project, file, definition } of readModuleFiles()) {
    if (opts.only && !`${project}/${file}`.includes(opts.only)) continue;
    if (!definition.name || !definition.moduleHierarchy) {
      say(`  SKIP     ${file} (missing name or moduleHierarchy)`);
      continue;
    }
    if (await DeveloperModule.findOne({ email: opts.owner, moduleName: definition.name })) {
      existing++; continue;
    }
    const now = new Date();
    const doc = new DeveloperModule({
      moduleId: crypto.randomUUID(),
      moduleName: definition.name,
      moduleLabel: definition.label,
      moduleAuthor: definition.author,
      moduleDescription: definition.description || '',
      moduleDefinition: definition,
      // '' is not castable to the Number field on the schema.
      moduleMaxSessions: definition.moduleMaxSessions === '' ? null : definition.moduleMaxSessions,
      moduleBackground: definition.moduleBackground || '',
      moduleForwardUrl: definition.moduleForwardUrl || '',
      exportDelimiter: definition.exportDelimiter,
      exportFormat: definition.exportFormat,
      email: opts.owner, created_by: opts.owner, created_at: now, updated_at: now,
      moduleVersion: 1, publishedModuleVersion: 0, moduleStatus: 'ready', moduleType: '',
      moduleProperties: {}, maxSessionId: 0, sessions: {}
    });
    await doc.save();
    imported++;

    if (!opts.publish) { say(`  imported ${definition.name}`); continue; }

    // Refuse to publish something that cannot run: participants would hit a dead module.
    const missing = walkRefs(definition).projects
      .filter(p => p !== 'External Resource' && !known.has(p));
    if (missing.length) {
      withheld++;
      say(`  imported ${definition.name}  NOT PUBLISHED (missing project: ${missing.join(', ')})`);
      continue;
    }
    await publishModule(doc);
    published++;
    say(`  published ${definition.name}`);
  }
  emit({ imported, alreadyPresent: existing, published, withheld });
  say(`\nimported ${imported}, already present ${existing}, published ${published}` +
    (withheld ? `, withheld ${withheld} (missing projects)` : ''));
}

// Mirror of developerCtrl.publish + repositoryCtrl: copy into the repository collection with runtime
// fields cleared, and make sure the Analytics record exists.
async function publishModule(doc) {
  doc.moduleType = 'public';
  doc.publishedModuleVersion = doc.moduleVersion;
  await doc.save();
  const repo = doc.toObject();
  delete repo._id; delete repo.__v;
  repo.maxSessionId = '';
  repo.moduleProperties = {};
  repo.sessions = {};
  repo.updated_at = new Date();
  await RepositoryModule.findOneAndUpdate({ moduleId: doc.moduleId }, repo, { upsert: true, new: true });
  await ensureAnalytics(doc);
}

// The trap: editing a module does nothing for users who already installed it unless moduleVersion
// increases, because the Update button is gated on installedVersion < repositoryVersion.
async function cmdPublish(target) {
  if (!target) {
    console.error('Usage: node tatool-shell.js publish <moduleLabel|moduleId>');
    process.exitCode = 1;
    return;
  }
  const doc = await DeveloperModule.findOne({ $or: [{ moduleLabel: target }, { moduleId: target }] });
  if (!doc) { console.error(`No developer module '${target}'.`); process.exitCode = 1; return; }
  const first = !doc.moduleType;
  const before = parseInt(doc.moduleVersion) || 0;
  doc.moduleVersion = before + 1;
  doc.updated_at = new Date();
  await publishModule(doc);
  const stale = await UserModule.countDocuments({ moduleId: doc.moduleId });
  emit({ module: doc.moduleName, from: before, to: doc.moduleVersion, firstPublish: first,
    installedCopies: stale });
  say(`${doc.moduleName}: version ${before} -> ${doc.moduleVersion}, ` +
    `${first ? 'published' : 'republished'}, analytics ensured.`);
  if (stale) say(`${stale} user(s) will now see an Update button before they can run the new version.`);
}

// Mirror of developerCtrl.unpublish + repositoryCtrl.remove. Non-destructive: the module stays in the
// Editor and collected data is untouched. It only withdraws it from circulation — the PUBLIC list and
// the participant URL. Note it does NOT revoke copies people have already installed; those keep
// working, so unpublishing stops new participants rather than existing ones.
async function cmdUnpublish(target) {
  if (!target) {
    console.error('Usage: node tatool-shell.js unpublish <moduleLabel|moduleId>');
    process.exitCode = 1;
    return;
  }
  const doc = await DeveloperModule.findOne({ $or: [{ moduleLabel: target }, { moduleId: target }] });
  if (!doc) { console.error(`No developer module '${target}'.`); process.exitCode = 1; return; }
  if (!doc.moduleType) {
    emit({ module: doc.moduleName, alreadyUnpublished: true });
    say(`${doc.moduleName} is not published.`);
    return;
  }
  doc.moduleType = '';
  doc.invites = undefined;
  doc.publishedModuleVersion = 0;
  await doc.save();
  const res = await RepositoryModule.deleteMany({ moduleId: doc.moduleId });
  const installed = await UserModule.countDocuments({ moduleId: doc.moduleId });
  emit({ module: doc.moduleName, repositoryEntriesRemoved: res.deletedCount || 0,
    installedCopiesUnaffected: installed });
  say(`${doc.moduleName}: unpublished. Removed from the repository; the participant URL now 404s.`);
  say('Data and the Analytics record are untouched, and it remains editable in the Editor.');
  if (installed) {
    say(`\n${installed} user(s) already installed it — their copies keep working. Unpublishing stops`);
    say('new participants, not existing ones.');
  }
}

async function cmdRepairAnalytics() {
  const published = await DeveloperModule.find({ moduleType: { $exists: true, $nin: [''] } });
  let created = 0, present = 0;
  for (const mod of published) {
    if (await ensureAnalytics(mod)) { created++; say(`  created  ${mod.moduleName}`); }
    else present++;
  }
  emit({ published: published.length, created, alreadyPresent: present });
  say(`\ncreated ${created}, already present ${present}, of ${published.length} published modules.`);
  if (created) {
    say('\nModules now appear under Analytics and "download all data" works. Per-participant rows');
    say('stay empty for runs that predate this — addAnalyticsUser no-ops when the record is missing');
    say('— but their CSVs are on disk and included in the download.');
  }
}

async function cmdExport(target, outfile) {
  if (!target) {
    console.error('Usage: node tatool-shell.js export <moduleLabel|moduleId> [outfile.json]');
    process.exitCode = 1;
    return;
  }
  const doc = await findModule(target);
  if (!doc) { console.error(`No module found with label or id '${target}'.`); process.exitCode = 1; return; }
  const json = JSON.stringify(doc.moduleDefinition, null, 2);
  const dest = outfile || `${doc.moduleLabel || doc.moduleId}.json`;
  fs.writeFileSync(dest, json);
  emit({ module: doc.moduleName, file: dest, bytes: json.length });
  say(`wrote ${dest} (${json.length} bytes) — importable via the Editor's Open button.`);
}

/* --------------------------------------------------------------------- menu */

async function cmdMenu() {
  if (!process.stdin.isTTY) {
    console.error('The menu needs a terminal. Either add -it:');
    console.error('  kubectl -n li exec -it deploy/li-tatool -- node tatool-shell.js');
    console.error('or use a subcommand (see --help).');
    process.exitCode = 1;
    return;
  }
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, a => res(a.trim())));
  const yes = async q => /^y(es)?$/i.test(await ask(`${q} [y/N] `));

  const dbHost = (process.env.DB_URI || 'localhost:27017').replace(/^mongodb:\/\/[^@]*@?/, '').split('/')[0];
  console.log(`\n  Tatool shell   db=${dbHost}   projects=${projectsRoot()}`);

  for (;;) {
    console.log('\n  1  doctor            find silent problems (missing files, analytics, stale copies)');
    console.log('  2  status            what is on disk vs in the database');
    console.log('  3  data              what has been collected, and export it');
    console.log('  4  accounts          list users, or provision new ones');
    console.log('  5  register projects  create/refresh project records');
    console.log('  6  import modules     load module JSONs, optionally publish');
    console.log('  7  publish            bump version + (re)publish so users get an update');
    console.log('  8  unpublish          withdraw a module from circulation');
    console.log('  9  repair analytics   backfill missing Analytics records');
    console.log(' 10  export a module    write a definition back out as JSON');
    console.log('  q  quit');
    const choice = await ask('\n  choice> ');
    console.log('');

    try {
      if (choice === '1') {
        await cmdDoctor({ quiet: false });
        process.exitCode = 0; // interactive use should not poison the shell's exit code
      } else if (choice === '2') {
        await cmdStatus();
      } else if (choice === '3') {
        await cmdData({});
        const t = await ask('\n  export which module? (label/id, blank = skip): ');
        if (t) await cmdData({ export: t });
      } else if (choice === '4') {
        await cmdAccounts({});
        if (await yes('\n  create accounts?')) {
          const spec = await ask('  emails (e.g. "a@ethz.ch b@ethz.ch:admin"): ');
          if (spec) await cmdAccounts({ create: spec.split(/\s+/).filter(Boolean) });
        }
      } else if (choice === '5') {
        const only = await ask('  project name (blank = all): ');
        await cmdProjects({ only: only || null });
      } else if (choice === '6') {
        const owner = await ask('  owner email: ');
        if (!owner) { console.log('  cancelled: an owner is required.'); continue; }
        const only = await ask('  filter module files by substring (blank = all): ');
        const publish = await yes('  publish as public?');
        console.log('');
        await cmdModules({ owner, only: only || null, publish });
      } else if (choice === '7') {
        const t = await ask('  moduleLabel or moduleId: ');
        if (t) await cmdPublish(t);
      } else if (choice === '8') {
        const t = await ask('  moduleLabel or moduleId: ');
        if (t && await yes(`  unpublish ${t}?`)) await cmdUnpublish(t);
      } else if (choice === '9') {
        await cmdRepairAnalytics();
      } else if (choice === '10') {
        const mods = await DeveloperModule.find({}, { moduleLabel: 1, moduleName: 1 }).limit(60);
        mods.forEach(m => console.log(`  ${String(m.moduleLabel || '(no label)').padEnd(28)} ${m.moduleName}`));
        const t = await ask('\n  moduleLabel or moduleId: ');
        if (t) await cmdExport(t, (await ask('  output file (blank = <label>.json): ')) || undefined);
      } else if (/^q(uit)?$/i.test(choice)) {
        break;
      } else {
        console.log('  unrecognised choice.');
      }
    } catch (err) {
      // Keep the session alive: a failed operation should not drop the shell.
      console.error('  failed: ' + err.message);
    }
  }
  rl.close();
}

/* --------------------------------------------------------------------- main */

const USAGE = `Tatool shell — inspect and repair what the UI does not show.

  (no command, with a TTY)      open the interactive menu

  doctor [--quiet]              find silent problems; exit 1 if any are errors
  status                        disk vs database
  data [--export <mod>] [--out <file>]   collected data summary / tarball
  accounts                      list users and what they own
  projects [--only <name>]      create/refresh project records
  modules --owner <email> [--publish] [--only <substr>]
  publish <mod>                 bump version + (re)publish + ensure analytics
  unpublish <mod>               withdraw from the repository; data untouched
  repair-analytics              backfill missing Analytics records
  export <mod> [outfile.json]   dump a module definition

  --json                        machine-readable output (all commands)
`;

async function main() {
  const argv = process.argv.slice(2);
  JSON_OUT = argv.includes('--json');
  const flag = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
  const command = argv.find(a => !a.startsWith('--')) ||
    (process.stdin.isTTY ? 'menu' : null);

  const COMMANDS = ['menu', 'doctor', 'status', 'data', 'accounts', 'projects', 'modules',
    'publish', 'unpublish', 'repair-analytics', 'export'];
  if (!command || !COMMANDS.includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  const positionals = argv.filter(a => !a.startsWith('--')).slice(1)
    .filter(a => ![flag('--only'), flag('--owner'), flag('--out'), flag('--export')].includes(a));

  await mongoose.connect(process.env.DB_URI || 'mongodb://127.0.0.1:27017/tatool-web', {
    useNewUrlParser: true, useUnifiedTopology: true,
    useFindAndModify: false, useCreateIndex: true
  });
  try {
    if (command === 'menu') await cmdMenu();
    else if (command === 'doctor') await cmdDoctor({ quiet: argv.includes('--quiet') });
    else if (command === 'status') await cmdStatus();
    else if (command === 'data') await cmdData({ export: flag('--export'), out: flag('--out') });
    else if (command === 'accounts') await cmdAccounts({});
    else if (command === 'projects') await cmdProjects({ only: flag('--only') });
    else if (command === 'modules') await cmdModules({ owner: flag('--owner'),
      only: flag('--only'), publish: argv.includes('--publish') });
    else if (command === 'publish') await cmdPublish(positionals[0]);
    else if (command === 'unpublish') await cmdUnpublish(positionals[0]);
    else if (command === 'repair-analytics') await cmdRepairAnalytics();
    else if (command === 'export') await cmdExport(positionals[0], positionals[1]);
  } finally {
    await mongoose.connection.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
