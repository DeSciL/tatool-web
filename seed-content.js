// Content management for a Tatool instance: register projects, import module definitions, and
// export them back out. Companion to seed-users.js.
//
// A fresh instance has all the task *files* (baked into the image, seeded onto the volume by the
// initContainer) but an empty database, so nothing is visible in the UI. This script closes that gap.
//
// Usage
//   node seed-content.js status
//   node seed-content.js projects
//   node seed-content.js modules --owner someone@ethz.ch [--publish] [--only <substring>]
//   node seed-content.js export <moduleLabel|moduleId> [outfile.json]
//
// In-cluster:
//   kubectl -n li exec deploy/li-tatool -- node seed-content.js status
//
// NOTE ON ASSETS: the app exposes no upload endpoint for project files. Stimuli, instructions and
// executables reach the volume either baked into the image or copied in out-of-band, e.g.
//   kubectl -n li cp ./mystimuli li-tatool-<pod>:/app/app/projects/public/myproject/stimuli
// This script only manages the database records that make those files usable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const Project = require('./models/project');
const DeveloperModule = require('./models/module').developerModule;
const RepositoryModule = require('./models/module').repositoryModule;
const Analytics = require('./models/analytics');

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

function projectsRoot() {
  // Same resolution the server uses, so this works both in-cluster and locally.
  const base = process.env.PROJECTS_PATH || path.join(__dirname, 'app', 'projects', '/');
  return path.join(base, 'public');
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

function readModuleFiles() {
  const root = projectsRoot();
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const project of fs.readdirSync(root)) {
    const dir = path.join(root, project, 'modules');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const full = path.join(dir, file);
      try {
        found.push({ project, file, definition: stripDollarKeys(JSON.parse(fs.readFileSync(full, 'utf8'))) });
      } catch (err) {
        console.error(`  SKIP ${project}/${file}: unparseable (${err.message})`);
      }
    }
  }
  return found;
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

// Mirrors analyticsCtrl.initAnalytics. That is only called from developerCtrl's *update* path (the
// Editor's save), NOT from publish — so a module published any other way has no Analytics record.
// Without one it never appears under Analytics, and addAnalyticsUser silently no-ops for every
// participant because it only acts when the record already exists. Trial CSVs still land on disk, so
// nothing is lost; it just cannot be seen or downloaded through the UI.
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

function executablesDescriptor(derived) {
  return Object.entries(derived || {}).map(([customType, props]) => ({
    customType,
    description: customType,
    customProperties: Object.entries(props).map(([propertyName, propertyType]) =>
      propertyType ? { propertyName, propertyType } : { propertyName })
  }));
}

async function cmdStatus() {
  const root = projectsRoot();
  const onDisk = fs.existsSync(root)
    ? fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory())
    : [];
  const modules = readModuleFiles();
  const registered = new Map((await Project.find({})).map(p => [p.name, p]));
  const devModules = await DeveloperModule.find({});
  const published = await RepositoryModule.find({});

  console.log(`projects root: ${root}`);
  console.log(`\nprojects (${onDisk.length} on disk, ${registered.size} registered):`);
  for (const name of onDisk.sort()) {
    const reg = registered.get(name);
    const mark = reg ? `registered, ${(reg.executables || []).length} executables` : 'NOT REGISTERED';
    console.log(`  ${name.padEnd(26)} ${mark}${RESERVED.has(name) ? ' (reserved)' : ''}`);
  }
  for (const name of [...registered.keys()].filter(n => !onDisk.includes(n))) {
    console.log(`  ${name.padEnd(26)} registered but NO DIRECTORY ON DISK`);
  }

  // A module referencing a project that does not exist cannot run.
  const known = new Set(onDisk);
  const broken = modules.filter(m => {
    const refs = new Set();
    (function w(n) {
      if (!n || typeof n !== 'object') return;
      if (n.project && n.project.name) refs.add(n.project.name);
      for (const k of Object.keys(n)) w(n[k]);
    })(m.definition);
    return [...refs].some(r => r !== 'External Resource' && !known.has(r));
  });

  console.log(`\nmodules: ${modules.length} on disk, ${devModules.length} imported, ${published.length} published`);
  if (broken.length) {
    console.log('  reference a project that is missing from disk (cannot run):');
    broken.forEach(m => console.log(`    ${m.project}/${m.file}`));
  }
}

async function cmdProjects() {
  const root = projectsRoot();
  if (!fs.existsSync(root)) {
    console.error(`No projects directory at ${root}. Is PROJECTS_PATH set correctly?`);
    process.exitCode = 1;
    return;
  }
  const derived = deriveExecutables(readModuleFiles());
  const owner = process.env.SEED_OWNER || 'admin@localhost';
  let created = 0, updated = 0, skipped = 0;

  for (const name of fs.readdirSync(root)) {
    if (!fs.statSync(path.join(root, name)).isDirectory()) continue;
    if (RESERVED.has(name)) { skipped++; continue; }

    const executables = executablesDescriptor(derived[name]);
    const description = DESCRIPTIONS[name] || `${name} project.`;
    const existing = await Project.findOne({ name, access: 'public' });

    if (existing) {
      existing.description = description;
      existing.executables = executables;
      await existing.save();
      updated++;
      console.log(`  updated  ${name.padEnd(26)} executables=${executables.length}`);
    } else {
      const project = new Project();
      project.name = name;
      project.access = 'public';
      project.email = owner;
      project.description = description;
      project.executables = executables;
      await project.save();
      created++;
      console.log(`  created  ${name.padEnd(26)} executables=${executables.length}`);
    }
  }
  console.log(`\ncreated ${created}, updated ${updated}, skipped ${skipped} (reserved).`);
}

async function cmdModules(opts) {
  if (!opts.owner) {
    console.error('--owner <email> is required: developer modules belong to a user.');
    process.exitCode = 1;
    return;
  }
  const known = new Set(fs.existsSync(projectsRoot()) ? fs.readdirSync(projectsRoot()) : []);
  let imported = 0, existing = 0, publishedCount = 0, blocked = 0;

  for (const { project, file, definition } of readModuleFiles()) {
    if (opts.only && !`${project}/${file}`.includes(opts.only)) continue;
    if (!definition.name || !definition.moduleHierarchy) {
      console.log(`  SKIP     ${file} (missing name or moduleHierarchy)`);
      continue;
    }

    const already = await DeveloperModule.findOne({ email: opts.owner, moduleName: definition.name });
    if (already) { existing++; continue; }

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
      email: opts.owner,
      created_by: opts.owner,
      created_at: now,
      updated_at: now,
      moduleVersion: 1,
      publishedModuleVersion: 0,
      moduleStatus: 'ready',
      moduleType: '',
      moduleProperties: {},
      maxSessionId: 0,
      sessions: {}
    });
    await doc.save();
    imported++;

    if (!opts.publish) { console.log(`  imported ${definition.name}`); continue; }

    // Refuse to publish something that cannot run: participants would hit a dead module.
    const refs = new Set();
    (function w(n) {
      if (!n || typeof n !== 'object') return;
      if (n.project && n.project.name) refs.add(n.project.name);
      for (const k of Object.keys(n)) w(n[k]);
    })(definition);
    const missing = [...refs].filter(r => r !== 'External Resource' && !known.has(r));
    if (missing.length) {
      blocked++;
      console.log(`  imported ${definition.name}  NOT PUBLISHED (missing project: ${missing.join(', ')})`);
      continue;
    }

    doc.moduleType = 'public';
    doc.publishedModuleVersion = doc.moduleVersion;
    await doc.save();

    // Mirror of repositoryCtrl: same document in the repository collection, runtime fields cleared.
    const repo = doc.toObject();
    delete repo._id;
    delete repo.__v;
    repo.maxSessionId = '';
    repo.moduleProperties = {};
    repo.sessions = {};
    repo.updated_at = new Date();
    await RepositoryModule.findOneAndUpdate({ moduleId: doc.moduleId }, repo, { upsert: true, new: true });
    await ensureAnalytics(doc);
    publishedCount++;
    console.log(`  published ${definition.name}`);
  }
  console.log(`\nimported ${imported}, already present ${existing}, published ${publishedCount}` +
    (blocked ? `, withheld ${blocked} (missing projects)` : ''));
}

// Backfill Analytics records for modules that were published without one. Safe to re-run.
async function cmdRepairAnalytics() {
  const published = await DeveloperModule.find({ moduleType: { $exists: true, $nin: [''] } });
  if (!published.length) {
    console.log('No published modules found.');
    return;
  }
  let created = 0, refreshed = 0;
  for (const mod of published) {
    if (await ensureAnalytics(mod)) { created++; console.log(`  created  ${mod.moduleName}`); }
    else refreshed++;
  }
  console.log(`\ncreated ${created}, already present ${refreshed}, of ${published.length} published modules.`);
  if (created) {
    console.log('\nModules now appear under Analytics and "download all data" works. Per-participant');
    console.log('rows stay empty for runs that happened before this fix — addAnalyticsUser no-ops when');
    console.log('the record is missing — but their CSVs are on disk and included in the download.');
  }
}

async function cmdExport(target, outfile) {
  if (!target) {
    console.error('Usage: node seed-content.js export <moduleLabel|moduleId> [outfile.json]');
    process.exitCode = 1;
    return;
  }
  const doc = await DeveloperModule.findOne({ $or: [{ moduleLabel: target }, { moduleId: target }] })
    || await RepositoryModule.findOne({ $or: [{ moduleLabel: target }, { moduleId: target }] });
  if (!doc) {
    console.error(`No module found with label or id '${target}'.`);
    process.exitCode = 1;
    return;
  }
  const json = JSON.stringify(doc.moduleDefinition, null, 2);
  const dest = outfile || `${doc.moduleLabel || doc.moduleId}.json`;
  fs.writeFileSync(dest, json);
  console.log(`wrote ${dest} (${json.length} bytes) — importable via the Editor's Open button.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const opts = {
    owner: process.env.SEED_OWNER,
    publish: argv.includes('--publish'),
    only: null
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--owner') opts.owner = argv[++i];
    else if (argv[i] === '--only') opts.only = argv[++i];
  }

  // Usage before connecting, so `node seed-content.js` is useful without a database.
  const COMMANDS = ['status', 'projects', 'modules', 'export', 'repair-analytics'];
  if (!COMMANDS.includes(command)) {
    console.log('Commands:');
    console.log('  status                                              drift between disk and database');
    console.log('  projects                                            register/refresh project records');
    console.log('  modules --owner <email> [--publish] [--only <s>]    import module definitions');
    console.log('  export <moduleLabel|moduleId> [outfile.json]        dump a module back to JSON');
    console.log('  repair-analytics                                    backfill missing Analytics records');
    process.exitCode = command ? 1 : 0;
    return;
  }

  await mongoose.connect(process.env.DB_URI || 'mongodb://127.0.0.1:27017/tatool-web', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false,
    useCreateIndex: true
  });

  try {
    if (command === 'status') await cmdStatus();
    else if (command === 'projects') await cmdProjects();
    else if (command === 'modules') await cmdModules(opts);
    else if (command === 'export') await cmdExport(argv[1], argv[2]);
    else if (command === 'repair-analytics') await cmdRepairAnalytics();
  } finally {
    await mongoose.connection.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
