// Load before application/vendor modules in both the page and editor worker.
// Syntax transpilation alone cannot supply these APIs on Safari 15 / Chrome 87.
// Keep this list scoped to APIs used by OpenBear and its editor dependencies.
import 'core-js/actual/array/at.js';
import 'core-js/actual/array/find-last.js';
import 'core-js/actual/array/find-last-index.js';
import 'core-js/actual/object/has-own.js';
import 'core-js/actual/structured-clone.js';
