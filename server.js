var express = require('express');
var cors = require('cors');
var compress = require('compression');
var os = require('os');
var path = require('path');
var bodyParser = require('body-parser');
var logger = require('morgan');
var mongoose = require('mongoose');
mongoose.Promise = global.Promise;
var passport = require('passport');
var { expressjwt } = require('express-jwt');
var favicon = require('serve-favicon');
var projects = require('./projects');

var app = express();
app.use(favicon(path.join(__dirname, 'dist/images/favicon.ico')));

/*******************************
   ENVIRONMENT VARIABLES
*******************************/
app.set('port', process.env.PORT || 3000);
app.set('env', process.env.NODE_ENV || process.argv[3] || 'prod');
// Set from the image build arg (see Dockerfile); 'dev' when running outside a built image.
app.set('app_version', process.env.APP_VERSION || 'dev');

// A missing JWT_SECRET used to fall back silently to the literal 'secret', which makes every
// token (including admin tokens) forgeable by anyone who reads this file. Refuse to start in
// production rather than come up insecure; warn elsewhere so local runs still work.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'secret') {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is not set (or is the default \'secret\'). Refusing to start ' +
      'with a forgeable token signing key. Set JWT_SECRET to a long random value.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET is not set. Using an insecure default. Never do this in production.');
}
app.set('jwt_secret', process.env.JWT_SECRET || 'secret');

// Self-registration is disabled by default. It is unauthenticated, and with no mail transport
// configured the registration path creates a usable account and then crashes the process.
// Opt in explicitly with REGISTRATION_ENABLED=true (which also needs captcha + mail configured).
app.set('registration_enabled', process.env.REGISTRATION_ENABLED === 'true');

app.set('projects_path_type', process.env.PROJECTS_PATH_TYPE || 'local'); // local/gcs/legacy
app.set('projects_path', process.env.PROJECTS_PATH || __dirname + '/app/projects/'); // path or gcs bucket name

app.set('private_path_type', process.env.PRIVATE_PATH_TYPE || 'local'); // local/gcs/legacy
app.set('private_path', process.env.PRIVATE_PATH || __dirname + '/app/projects/'); // path or gcs bucket name

app.set('captcha_private_key', process.env.RECAPTCHA_PRIVATE_KEY || '');
app.set('editor_user', process.env.EDITOR_USER || '');
app.set('override_upload_dir', false);
app.set('module_limit', 5);

/*******************************
  DATABASE CONNECTION
/*******************************/
mongoose.connect(process.env.DB_URI || 'mongodb://127.0.0.1/tatool-web', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
  useCreateIndex: true
}).catch(function(err) {
  // The connection is retried in the background, so this is not fatal. Log it: an unreachable
  // database otherwise produces one obscure line at startup and then requests that just hang.
  console.error('MongoDB initial connection failed: ' + err.message);
});

mongoose.connection.on('connected', function() {
  console.log('MongoDB connected.');
});
mongoose.connection.on('disconnected', function() {
  console.warn('MongoDB disconnected.');
});
mongoose.connection.on('error', function(err) {
  console.error('MongoDB connection error: ' + err.message);
});

/*******************************
  CONTROLLERS
/*******************************/
var userCtrl = require('./controllers/user');
var resourceCtrl = require('./controllers/resourceCtrl');
var mainCtrl = require('./controllers/mainCtrl');
var repositoryCtrl = require('./controllers/repositoryCtrl');
var developerCtrl = require('./controllers/developerCtrl');
var analyticsCtrl = require('./controllers/analyticsCtrl');
var authCtrl = require('./controllers/auth')
var adminCtrl = require('./controllers/admin');
var commonCtrl = require('./controllers/commonCtrl');
var logCtrl = require('./controllers/logCtrl');

/*******************************
  EXPRESS SETUP
/*******************************/
if (app.get('env') === 'dev') {
  app.use(logger('dev'));
  mongoose.set('debug', true);
} else {
  // Production request logging. Previously there was none at all outside 'dev', so a deployed
  // instance emitted nothing but a startup banner - there was no way to follow a rollout or see
  // what a failing request actually did.
  //
  // Two things are deliberate here:
  //
  //  1. req.path, NOT the full URL. Participant identifiers travel in the query string
  //     (/#!/public/<moduleId>?extid=<code>), and those identify a student. Logging originalUrl
  //     would put them in the log store indefinitely. moduleId is in the path and is not personal.
  //     Client IPs are likewise absent: 'combined' would log them, and behind the ingress they only
  //     become real client addresses once 'trust proxy' is set - so enabling both together would
  //     silently start collecting participant IPs.
  //  2. A "level" field derived from the status code. Log collection infers severity from the
  //     stream and from content; without an explicit level, ordinary traffic and real failures look
  //     alike, and anything on stderr gets treated as an error.
  // originalUrl, not req.path: Express strips the mount prefix from req.url inside a mounted
  // router, and morgan logs on response finish, so req.path would report /register for a request to
  // /api/register. originalUrl is never rewritten. Split on '?' to drop the query string.
  function requestPath(req) {
    return (req.originalUrl || req.url || '').split('?')[0];
  }

  logger.format('tatoolJson', function(tokens, req, res) {
    var status = res.statusCode;
    return JSON.stringify({
      level: status >= 500 ? 'error' : (status >= 400 ? 'warn' : 'info'),
      method: tokens.method(req, res),
      path: requestPath(req),
      status: status,
      duration_ms: Number(tokens['response-time'](req, res)),
      length: Number(tokens.res(req, res, 'content-length')) || 0
    });
  });

  // LOG_FORMAT=combined for full Apache-style lines when debugging something specific. Note it
  // includes the query string and remote address, i.e. the data point 1 above avoids.
  app.use(logger(process.env.LOG_FORMAT || 'tatoolJson', {
    // Probes run every 10-20s forever and would otherwise be nearly all of the log volume.
    skip: function(req) {
      var p = requestPath(req);
      return p === '/healthz' || p === '/readyz';
    }
    // morgan writes to stdout by default. Keep it that way: stderr is interpreted as error level.
  }));
}
// CORS was previously wide open (`cors()` → Access-Control-Allow-Origin: *), which let any site
// call the unauthenticated endpoints and read the responses — including /public/login, which mints
// participant records.
//
// Default is now deny: the SPA is served from the same origin as the API and the module runs in a
// same-origin iframe, so nothing needs cross-origin access. Same-origin requests are unaffected —
// browsers do not require the header for those. Verified that no cross-origin caller exists: the
// MTurk snippet in mturk/ builds a navigation link, not an XHR.
//
// Set CORS_ORIGIN (comma-separated) from the manifest if a caller ever does need it. Deliberately
// not defaulting to our own hostname: this is a public fork, and the app should not have a
// deployment's URL compiled into it.
var corsOrigin = process.env.CORS_ORIGIN;
app.use(cors({
  origin: corsOrigin ? corsOrigin.split(',').map(function(o) { return o.trim(); }) : false
}));
app.use(compress());

/*******************************
  HEALTH ENDPOINTS (Kubernetes probes)
/*******************************/
// Registered before everything else so they answer even if the API or static handlers misbehave,
// and deliberately not behind the JWT router.
//
// Do NOT point probes at '/': express.static serves the SPA and returns 200 even when MongoDB is
// unreachable, so a probe on '/' reports a broken pod as healthy and traffic gets routed to it.
var MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

// Liveness: the process is running and the event loop is responsive. No dependency checks, so a
// transient database outage does not cause a restart loop. Reports the build version so the
// deployed tag can be confirmed with a single request.
app.get('/healthz', function(req, res) {
  res.status(200).json({ status: 'ok', version: app.get('app_version') });
});

// Readiness: the pod can actually serve requests, i.e. the database is connected. Returns 503
// otherwise so Kubernetes takes it out of the Service endpoints instead of sending traffic to it.
app.get('/readyz', function(req, res) {
  var state = mongoose.connection.readyState;
  res.status(state === 1 ? 200 : 503).json({
    status: state === 1 ? 'ready' : 'not ready',
    db: MONGO_STATES[state] || 'unknown',
    version: app.get('app_version')
  });
});

// parse json and urlencoded body
app.use(bodyParser.json({
  limit: 1048576
})); // allow upload of 1MB
app.use(bodyParser.urlencoded({
  extended: true
}));

// Use passport package
app.use(passport.initialize());

// API router
var router = express.Router();

// User Modules
router.post('/user/modules/:moduleId/install', mainCtrl.install);
router.post('/user/modules/:moduleId', mainCtrl.save);
router.get('/user/modules', mainCtrl.getAll);
router.get('/user/modules/:moduleId', mainCtrl.get);
router.delete('/user/modules/:moduleId', mainCtrl.remove);
router.post('/user/modules/:moduleId/invite/:response', mainCtrl.processInvite);
router.post('/user/modules/:moduleId/trials/:sessionId', mainCtrl.addTrials);
router.get('/user/modules/:moduleId/resources/token', resourceCtrl.getResourceToken);
router.get('/user/projects', commonCtrl.getProjects);
app.get('/user/resources/:projectAccess/:projectName/:resourceType/:resourceName', resourceCtrl.getResource); // NO JWT CHECK

// Public Modules
router.post('/public/modules/:moduleId/install', mainCtrl.install);
router.post('/public/modules/:moduleId', mainCtrl.save);
router.get('/public/modules/:moduleId', mainCtrl.get);
router.post('/public/modules/:moduleId/trials/:sessionId', mainCtrl.addTrials);
router.get('/public/modules/:moduleId/resources/token', resourceCtrl.getResourceToken);
app.get('/public/resources/:projectAccess/:projectName/:resourceType/:resourceName', resourceCtrl.getResource); // NO JWT CHECK

// Repository Modules
router.get('/user/repository', repositoryCtrl.getAll);
router.get('/user/repository/:moduleId', repositoryCtrl.get);
router.get('/developer/repository/:moduleId', repositoryCtrl.get);
router.post('/developer/repository/:moduleId/invite', repositoryCtrl.invite);
router.post('/developer/repository/:moduleId/invite/remove', repositoryCtrl.removeInvite);

// Developer Modules
router.post('/developer/modules/:moduleId', developerCtrl.add);
router.get('/developer/modules', developerCtrl.getAll);
router.get('/developer/modules/:moduleId', developerCtrl.get);
router.delete('/developer/modules/:moduleId', developerCtrl.remove);
router.post('/developer/modules/:moduleId/publish/:moduleType', developerCtrl.publish);
router.get('/developer/modules/:moduleId/unpublish', developerCtrl.unpublish);
router.post('/developer/modules/:moduleId/trials/:sessionId', developerCtrl.addTrials);
router.get('/developer/modules/:moduleId/resources/token', resourceCtrl.getResourceToken);
router.get('/developer/projects', commonCtrl.getProjects);
app.get('/developer/resources/:projectAccess/:projectName/:resourceType/:resourceName', resourceCtrl.getResource); // NO JWT CHECK

// Analytics Modules
router.get('/analytics/modules', analyticsCtrl.getAll);
router.get('/analytics/modules/:moduleId', analyticsCtrl.get);
router.delete('/analytics/modules/:moduleId', analyticsCtrl.remove);
router.delete('/analytics/modules/:moduleId/:userCode', analyticsCtrl.removeUser);
router.get('/analytics/data/modules/:moduleId', analyticsCtrl.getUserDataDownloadToken);
router.get('/analytics/data/modules/:moduleId/:userCode', analyticsCtrl.getUserDataDownloadToken);

// Admin
router.get('/admin/users', adminCtrl.getUsers);
router.post('/admin/users/:user', adminCtrl.updateUser);
router.post('/admin/users/:user/reset', adminCtrl.updatePassword);
router.delete('/admin/users/:user', adminCtrl.removeUser);

router.get('/admin/projects', adminCtrl.getAllProjects);
router.post('/admin/projects/:access/:project', adminCtrl.addProject);
router.delete('/admin/projects/:access/:project', adminCtrl.deleteProject);

// User
router.get('/user/roles', authCtrl.getRoles);
if (app.get('registration_enabled')) {
  router.post('/register', userCtrl.register);
} else {
  router.post('/register', function(req, res) {
    res.status(403).json({
      message: 'Self-registration is disabled on this instance. Please contact the study administrator for an account.'
    });
  });
}
router.get('/login', authCtrl.isAuthenticated);

// protect api with JWT
app.use('/api', expressjwt({
  secret: app.get('jwt_secret'),
  algorithms: ['HS256']
}).unless({
  path: ['/api/login', '/api/register']
}), noCache, authCtrl.hasRole, router);

// disable caching for API
function noCache(req, res, next) {
  res.header("Cache-Control", "no-cache, no-store, must-revalidate");
  res.header("Pragma", "no-cache");
  res.header("Expires", 0);
  next();
}

// open API
app.get('/mode', function(req, res) {
  res.json({
    mode: req.app.get('mode')
  });
});
app.post('/user/verify/resend', userCtrl.verifyResend);
app.get('/user/verify/:token', userCtrl.verifyUser);
app.post('/user/reset', userCtrl.resetPasswordSend);
app.get('/user/resetverify/:token', userCtrl.verifyResetToken);
app.post('/user/reset/:token', userCtrl.updatePassword);
app.post('/user/captcha', userCtrl.verifyCaptcha);
app.get('/data/user/:token', analyticsCtrl.getUserData);

// open API for public module
app.get('/public/run/:moduleId', mainCtrl.getPublic);
app.get('/public/login/:moduleId', mainCtrl.installPublic);

// Tatool Web Client
app.use(express.static(path.join(__dirname, 'dist')));

// send 404 if no match found
app.use(function(req, res, next) {
  res.status(404).send('Page not found');
});

// handle error case
app.use(function(err, req, res, next) {
  if (err.name === 'UnauthorizedError') {
    res.status(401).json({
      message: 'Unauthorized access!'
    });
  }
});

/*******************************
  STARTUP SCRIPT
/*******************************/

// initialize userCode counter at startup
userCtrl.initCounter(setup);

function setup() {
  // processing run mode 'lab'
  if (process.argv[2] === 'lab') {
    console.log('Running tatool in LAB mode.')
    app.set('mode', 'lab');
    userCtrl.registerAdmin();
  }

  // setup default project structure
  adminCtrl.initProjects(projects);
}

// start server
var server = app.listen(app.get('port'), function() {
  console.log('You can now access tatool on ' + os.hostname() + ':' + app.get('port'));
});

/*******************************
  GRACEFUL SHUTDOWN
/*******************************/
// Without this, node's default SIGTERM handling kills the process instantly: in-flight requests are
// cut and the Mongo connection is never closed. Kubernetes sends SIGTERM on every rollout, so that
// happened on each deploy. Relies on node being PID 1 (see the Dockerfile CMD).
var shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Received ' + signal + ', shutting down.');

  // Stop accepting connections, then let in-flight requests finish.
  server.close(function() {
    mongoose.connection.close(false, function() {
      console.log('Shutdown complete.');
      process.exit(0);
    });
  });

  // Backstop: a hung keep-alive connection must not outlast the pod's termination grace period.
  setTimeout(function() {
    console.warn('Shutdown timed out after 10s, exiting.');
    process.exit(0);
  }, 10000).unref();
}

process.on('SIGTERM', function() { shutdown('SIGTERM'); });
process.on('SIGINT', function() { shutdown('SIGINT'); });