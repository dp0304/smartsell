// X and TikTok drivers on the fixture platform pages over the CDP pipe to the Worker's own Chrome (phase 1).
// The same suites over the owner's own Chrome run in drivers-fixtures-own-chrome.test.ts.
import { driverFixtureSuites } from './fakes/driver-fixtures-suite.ts';

driverFixtureSuites('pipe');
