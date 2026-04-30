// Script to seed a sample module into the database
// Run with: node seed-sample-module.js

const mongoose = require('mongoose');

// Connect to MongoDB
mongoose.connect(process.env.DB_URI || 'mongodb://127.0.0.1:27017/tatool-web', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
  useCreateIndex: true
});

const repositoryModuleSchema = new mongoose.Schema({
  moduleName: String,
  moduleLabel: String,
  moduleAuthor: String,
  moduleIcon: String,
  moduleDescription: String,
  moduleMaxSessions: Number,
  moduleBackground: String,
  moduleForwardUrl: String,
  exportDelimiter: String,
  exportFormat: String,
  invites: mongoose.Schema.Types.Mixed,
  email: String,
  moduleId: String,
  moduleVersion: String,
  publishedModuleVersion: String,
  sessionToken: String,
  lastSessionToken: String,
  created_by: String,
  created_at: Date,
  updated_at: Date,
  moduleStatus: String,
  moduleType: String,
  moduleDefinition: mongoose.Schema.Types.Mixed,
  moduleProperties: mongoose.Schema.Types.Mixed,
  sessions: mongoose.Schema.Types.Mixed,
  maxSessionId: String
}, { collection: 'repositorymodules' });

const RepositoryModule = mongoose.model('RepositoryModule', repositoryModuleSchema);

// Sample module definition
const sampleModule = {
  moduleName: 'My Sample Experiment',
  moduleLabel: 'mySampleExperiment',
  moduleAuthor: 'Tatool',
  moduleIcon: 'fa fa-flask',
  moduleDescription: 'A simple sample experiment to get you started with Tatool.',
  moduleMaxSessions: 0,
  moduleBackground: '',
  moduleForwardUrl: '',
  exportDelimiter: ';',
  exportFormat: 'csv',
  email: 'public@tatool-web.com',
  moduleId: 'public@tatool-web.com1711459200000',
  moduleVersion: '1',
  publishedModuleVersion: '1',
  created_by: 'public@tatool-web.com',
  created_at: new Date(),
  updated_at: new Date(),
  moduleStatus: 'ready',
  moduleType: 'public',
  moduleProperties: {},
  sessions: {},
  maxSessionId: '',
  moduleDefinition: {
    "type": "tatoolModule",
    "name": "module",
    "label": "Module",
    "children": [
      {
        "type": "tatoolSession",
        "name": "session1",
        "label": "Session 1",
        "children": [
          {
            "type": "Instruction",
            "name": "instruction1",
            "customType": "tatoolInstruction",
            "label": "Welcome",
            "properties": {
              "stimuliPath": {
                "propertyValue": "myExperiment"
              },
              "pages": {
                "propertyValue": [
                  {
                    "pageName": "page1.htm"
                  }
                ]
              }
            }
          },
          {
            "type": "Executable",
            "name": "executable1",
            "customType": "myExecutable",
            "label": "My Task",
            "properties": {
              "project": {
                "propertyValue": "myExperiment"
              }
            }
          }
        ]
      }
    ]
  }
};

// Insert the module
RepositoryModule.findOne({ moduleId: sampleModule.moduleId })
  .then(existing => {
    if (existing) {
      console.log('Sample module already exists!');
      process.exit(0);
    } else {
      return RepositoryModule.create(sampleModule);
    }
  })
  .then(result => {
    console.log('Sample module created successfully!');
    console.log('Module Name:', result.moduleName);
    console.log('Module ID:', result.moduleId);
    console.log('\nYou can now find this module in the "Modules" section of Tatool.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
