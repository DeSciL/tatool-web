// Provision researcher/teacher accounts directly, without self-registration or email.
//
// Self-registration is disabled (REGISTRATION_ENABLED), and lab mode's built-in
// admin@tatool-web.com / 1234 must never be used on an internet-facing instance. This script is
// the supported way to create the initial accounts.
//
// Accounts are created through the Mongoose model on purpose: password hashing lives in the
// User pre('save') hook, so inserting via mongosh would store a plaintext password.
//
// Usage
//   node seed-users.js alice@ethz.ch bob@ethz.ch:admin
//   node seed-users.js users.json
//   SEED_USERS='[{"email":"alice@ethz.ch","password":"...","roles":["user","admin"]}]' node seed-users.js
//
// Passwords are never taken from the command line (they would be visible in the process list).
// Omit a password and a strong one is generated and printed once.
//
// Re-running is safe: existing accounts are left alone unless --update-roles is passed.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const User = require('./models/user');
const Counter = require('./models/counter');

const DEFAULT_ROLES = ['user', 'developer', 'analytics'];
const ROLE_ALIASES = {
  admin: ['user', 'developer', 'analytics', 'admin'],
  researcher: DEFAULT_ROLES,
  user: ['user']
};

function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

// Accepts:  "alice@ethz.ch"  |  "alice@ethz.ch:admin"  |  "alice@ethz.ch:user,developer"
function parseArg(arg) {
  const idx = arg.lastIndexOf(':');
  if (idx === -1) {
    return { email: arg, roles: DEFAULT_ROLES };
  }
  const email = arg.slice(0, idx);
  const spec = arg.slice(idx + 1);
  return { email: email, roles: ROLE_ALIASES[spec] || spec.split(',').map(r => r.trim()).filter(Boolean) };
}

function loadRequests(argv) {
  if (process.env.SEED_USERS) {
    return JSON.parse(process.env.SEED_USERS);
  }
  if (argv.length === 1 && /\.json$/i.test(argv[0])) {
    return JSON.parse(fs.readFileSync(path.resolve(argv[0]), 'utf8'));
  }
  return argv.map(parseArg);
}

async function seedUser(request, updateRoles) {
  const email = (request.email || '').trim().toLowerCase();
  if (!email) throw new Error('Entry is missing an "email" field.');

  const roles = (request.roles && request.roles.length) ? request.roles : DEFAULT_ROLES;

  const existing = await User.findOne({ email: email });
  if (existing) {
    if (updateRoles) {
      existing.roles = roles;
      existing.updated_at = new Date();
      await existing.save();
      return { email: email, status: 'roles updated', roles: roles };
    }
    return { email: email, status: 'exists, skipped', roles: existing.roles };
  }

  // Only generated passwords are reported back, so a caller-supplied secret is never echoed.
  const password = request.password || generatePassword();
  const generated = !request.password;

  const counter = await Counter.getUserCode();

  const user = new User();
  user.email = email;
  user.password = password;
  user.roles = roles;
  user.verified = true;   // provisioned out of band, so there is no verification email to wait for
  user.token = '';
  user.code = counter.next;
  user.updated_at = new Date();
  await user.save();

  return {
    email: email,
    status: 'created',
    roles: roles,
    code: counter.next,
    password: generated ? password : '(as supplied)'
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const updateRoles = argv.includes('--update-roles');
  const requests = loadRequests(argv.filter(a => !a.startsWith('--')));

  if (!requests.length) {
    console.error('No users specified. See the usage comment at the top of this file.');
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URI || 'mongodb://127.0.0.1:27017/tatool-web', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false,
    useCreateIndex: true
  });

  const results = [];
  for (const request of requests) {
    try {
      results.push(await seedUser(request, updateRoles));
    } catch (err) {
      results.push({ email: request.email, status: 'FAILED: ' + err.message });
    }
  }

  console.log('');
  for (const r of results) {
    console.log(`  ${r.email}`);
    console.log(`    status   : ${r.status}`);
    if (r.roles) console.log(`    roles    : ${r.roles.join(', ')}`);
    if (r.code) console.log(`    code     : ${r.code}`);
    if (r.password) console.log(`    password : ${r.password}`);
  }
  console.log('');
  if (results.some(r => r.password && r.password !== '(as supplied)')) {
    console.log('Generated passwords are shown once only. Record them now, and have each user');
    console.log('change their password after first login.');
    console.log('');
  }

  await mongoose.connection.close();
  process.exit(results.some(r => String(r.status).startsWith('FAILED')) ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
