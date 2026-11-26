// X and TikTok drivers on the fixture platform pages over the CDP pipe to the Worker's own Chrome (phase 1).
// The same suites over the owner's own Chrome run in drivers-fixtures-own-chrome.test.ts.
// scripts/test.mjs routes a file to node:test by this import; the suites themselves live in the shared module.
import 'node:test';
import { driverFixtureSuites } from './fakes/driver-fixtures-suite.ts';

driverFixtureSuites('pipe');
