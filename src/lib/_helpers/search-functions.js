"use strict";
/**
 * @file search-functions.ts
 * @description Remembers which filter functions a backend service rejected, so `$search` stops sending them.
 *
 * `$search` on an insensitive backend sends `contains(tolower(field), 'word')`. Some services refuse it
 * (`Filter function 'TOLOWER' not supported`); the rejection is remembered for the process and that service is then
 * searched case-sensitively (see {@link effectiveSearchMode}). Columns a backend can not filter on are NOT handled
 * here: they are excluded with `@cds.search: false` in the local service projection.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFunctionUnsupported = exports.learnUnsupportedFunction = exports.rejectedFunction = exports.resetLearnedFunctions = void 0;
const unsupportedFunctions = new Set();
/** Forgets everything learned (tests). */
const resetLearnedFunctions = () => { unsupportedFunctions.clear(); };
exports.resetLearnedFunctions = resetLearnedFunctions;
/** The function a "Filter function 'X' not supported" rejection names (lower case). */
const rejectedFunction = (err) => /Filter function '([A-Za-z_]+)'\s+(?:is\s+)?not supported/i.exec(String(err?.message ?? err?.reason?.message ?? ''))?.[1]?.toLowerCase();
exports.rejectedFunction = rejectedFunction;
/**
 * Remembers that a service can not evaluate `fn` in a filter.
 *
 * @returns `true` when that was not known yet (a plan made before is out of date).
 */
const learnUnsupportedFunction = (service, fn) => {
    const key = `${service}|${fn.toLowerCase()}`;
    if (unsupportedFunctions.has(key))
        return false;
    unsupportedFunctions.add(key);
    return true;
};
exports.learnUnsupportedFunction = learnUnsupportedFunction;
/** `true` when the service rejected `fn` before. */
const isFunctionUnsupported = (service, fn) => unsupportedFunctions.has(`${service}|${fn.toLowerCase()}`);
exports.isFunctionUnsupported = isFunctionUnsupported;
