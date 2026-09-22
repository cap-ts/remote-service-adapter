"use strict";
/**
 * @file utils.ts
 * @description Zero-dependency utilities shared by every helper module:
 * `deepClone` and the local-development logger.
 *
 * ## Logger design
 *
 * This is a **local-development-only** logger. It has three modes:
 *
 * 1. **Off (production default)** — every method is a zero-cost no-op. The
 *    `DEBUG` flag is evaluated once at module load, and when it is false the
 *    factory returns pre-bound no-op closures so hot paths pay nothing.
 *
 * 2. **Console only (`DEBUG=remote-service`)** — pretty-printed to stderr via
 *    `console.warn` / `console.error`. Payloads are JSON.stringified. No file
 *    I/O.
 *
 * 3. **Console + file (`DEBUG=remote-service LOG_TO_FILE=true`)** — same output
 *    as mode 2, plus a per-run timestamped file at
 *    `${LOG_DIR || 'logs'}/remote-service-YYYYMMDD-HHMMSS.log`.
 *
 * ## Production safety
 *
 * File logging is **hard-disabled** when `NODE_ENV === 'production'` regardless
 * of the value of `LOG_TO_FILE`. Cloud Foundry containers have ephemeral
 * filesystems, so writing files there would silently lose data and confuse the
 * `cf logs` pipeline. See `.claude/docs/troubleshooting.md` for the
 * full rationale.
 *
 * ## Correlation
 *
 * Each incoming request gets a short correlation ID (`reqId`, first 8 chars of
 * a UUID v4). Every log line for that request carries the same ID so a single
 * request can be traced across ~30–50 log lines from all helper modules.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeLogger = exports.createLogger = exports.getLogFilePath = exports.deepClone = exports.LOG_DIR = exports.LOG_TO_FILE = exports.LOG_TO_CONSOLE = exports.LOG_LEVEL = exports.DEBUG = void 0;
const fs = require("fs");
const path = require("path");
// ============================================================================
// Configuration — evaluated once at module load
// ============================================================================
/**
 * Master trace switch. Set via `DEBUG=remote-service` (or `DEBUG=*`).
 * When false every logger method is a no-op closure with zero call cost.
 */
exports.DEBUG = /(^|,)\s*(remote-service|\*)\s*(,|$)/.test(process.env.DEBUG ?? '');
const LEVEL_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const parseLevel = (v, fallback) => {
    const s = (v ?? '').toLowerCase();
    return ['trace', 'debug', 'info', 'warn', 'error'].includes(s)
        ? s
        : fallback;
};
/**
 * Level threshold — messages below this are dropped.
 * Resolution order (first match wins):
 *   1. `LOG_LEVEL` env var (e.g. `LOG_LEVEL=trace`)
 *   2. `CDS_LOG_LEVELS_ESI` env var — lets package.json scripts set
 *      the remote-service level independently of the global `LOG_LEVEL`
 *   3. `debug` when the `DEBUG` env var is set, `error` otherwise
 */
exports.LOG_LEVEL = parseLevel(process.env.LOG_LEVEL ?? process.env.CDS_LOG_LEVELS_ESI, exports.DEBUG ? 'debug' : 'error');
/** Whether to print to stderr. Default: true when DEBUG is on. */
exports.LOG_TO_CONSOLE = (process.env.LOG_TO_CONSOLE ?? (exports.DEBUG ? 'true' : 'false')).toLowerCase() === 'true';
/**
 * Whether to also append to a timestamped log file. **Hard-disabled** in
 * production. Default: false.
 */
exports.LOG_TO_FILE = process.env.NODE_ENV !== 'production' &&
    (process.env.LOG_TO_FILE ?? 'false').toLowerCase() === 'true';
/** Log directory (relative to process cwd). Default: `logs`. */
exports.LOG_DIR = process.env.LOG_DIR || 'logs';
// ============================================================================
// deepClone
// ============================================================================
/**
 * Fast structured clone with a JSON fallback for runtimes that pre-date the
 * `structuredClone` global (Node.js < 17).
 */
const deepClone = (value) => {
    const sc = globalThis.structuredClone;
    return typeof sc === 'function' ? sc(value) : JSON.parse(JSON.stringify(value));
};
exports.deepClone = deepClone;
// ============================================================================
// Timestamp helpers
// ============================================================================
const pad2 = (n) => (n < 10 ? '0' : '') + n;
/** Compact timestamp for filenames: `YYYYMMDD-HHMMSS`. */
const filenameTimestamp = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
/** ISO-8601 timestamp for log lines. */
const isoTimestamp = (d = new Date()) => d.toISOString();
// ============================================================================
// File sink — lazy, per-process, singleton
// ============================================================================
let _fileStream = null;
let _fileStreamInitialized = false;
let _resolvedLogPath = null;
/**
 * Returns the write stream for the timestamped log file, creating it (and
 * the parent directory) on first use. Returns `null` in production or when
 * `LOG_TO_FILE=false`.
 */
const getFileStream = () => {
    if (_fileStreamInitialized)
        return _fileStream;
    _fileStreamInitialized = true;
    if (!exports.LOG_TO_FILE)
        return null;
    try {
        const dir = path.isAbsolute(exports.LOG_DIR)
            ? exports.LOG_DIR
            : path.resolve(process.cwd(), exports.LOG_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const fileName = `remote-service-${filenameTimestamp()}.log`;
        _resolvedLogPath = path.join(dir, fileName);
        _fileStream = fs.createWriteStream(_resolvedLogPath, { flags: 'a', encoding: 'utf8' });
        // Best-effort "latest" convenience pointer. Skipped silently on failure
        // (e.g. Windows without symlink privilege). Not critical.
        try {
            const latest = path.join(dir, 'remote-service-latest.log');
            if (fs.existsSync(latest) || fs.lstatSync(latest).isSymbolicLink?.())
                fs.unlinkSync(latest);
        }
        catch { /* ignore */ }
        try {
            fs.symlinkSync(fileName, path.join(dir, 'remote-service-latest.log'));
        }
        catch { /* ignore */ }
        // Header
        _fileStream.write(`# remote-service log — started ${isoTimestamp()} — pid=${process.pid} — NODE_ENV=${process.env.NODE_ENV || 'unset'}\n`);
        // Flush on shutdown so trailing entries aren't lost
        const flushAndClose = () => {
            try {
                _fileStream?.end();
            }
            catch { /* ignore */ }
        };
        process.once('exit', flushAndClose);
        process.once('SIGINT', flushAndClose);
        process.once('SIGTERM', flushAndClose);
    }
    catch (err) {
        // Never let logger init crash the app
        // eslint-disable-next-line no-console
        console.error(`[remote-service logger] failed to init file sink:`, err.message);
        _fileStream = null;
    }
    return _fileStream;
};
/** Absolute path of the current run's log file, or `null` when file logging is disabled. */
const getLogFilePath = () => {
    getFileStream(); // lazy init
    return _resolvedLogPath;
};
exports.getLogFilePath = getLogFilePath;
// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const LEVEL_TAG = {
    trace: 'TRACE',
    debug: 'DEBUG',
    info: 'INFO ',
    warn: 'WARN ',
    error: 'ERROR',
};
/**
 * Fields that will be redacted from any logged context object. Best-effort —
 * do not rely on this in place of not logging secrets in the first place.
 */
const REDACT_KEYS = new Set([
    'authorization', 'auth', 'password', 'pwd', 'token', 'access_token',
    'refresh_token', 'apikey', 'api_key', 'secret', 'cookie', 'set-cookie',
    'x-csrf-token',
]);
const redact = (value) => {
    if (value == null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(redact);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
    }
    return out;
};
const formatLine = (level, module, reqId, method, message, context) => {
    const base = `${isoTimestamp()} ${LEVEL_TAG[level]} [${reqId}] [${module}.${method}] ${message}`;
    if (context === undefined)
        return base;
    try {
        return `${base} ${JSON.stringify(redact(context))}`;
    }
    catch {
        return `${base} <unserialisable context>`;
    }
};
// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------
const emit = (level, line) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[exports.LOG_LEVEL])
        return;
    if (exports.LOG_TO_CONSOLE) {
        // stderr for warn/error, stdout otherwise — matches Node conventions
        if (level === 'error' || level === 'warn') {
            // eslint-disable-next-line no-console
            console.error(line);
        }
        else {
            // eslint-disable-next-line no-console
            console.log(line);
        }
    }
    const stream = getFileStream();
    if (stream)
        stream.write(line + '\n');
};
// ---------------------------------------------------------------------------
// Logger implementations
// ---------------------------------------------------------------------------
const NOOP_LOGGER = (() => {
    const noop = () => { };
    const self = {
        reqId: 'noop',
        module: 'noop',
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        forModule: () => self,
        forRequest: () => self,
    };
    return self;
})();
class ActiveLogger {
    module;
    reqId;
    constructor(module, reqId) {
        this.module = module;
        this.reqId = reqId;
    }
    trace(method, message, context) {
        emit('trace', formatLine('trace', this.module, this.reqId, method, message, context));
    }
    debug(method, message, context) {
        emit('debug', formatLine('debug', this.module, this.reqId, method, message, context));
    }
    info(method, message, context) {
        emit('info', formatLine('info', this.module, this.reqId, method, message, context));
    }
    warn(method, message, context) {
        emit('warn', formatLine('warn', this.module, this.reqId, method, message, context));
    }
    error(method, message, context) {
        emit('error', formatLine('error', this.module, this.reqId, method, message, context));
    }
    forModule(module) { return new ActiveLogger(module, this.reqId); }
    forRequest(reqId) { return new ActiveLogger(this.module, reqId); }
}
// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
/**
 * Creates a {@link Logger} bound to the given module name. Returns a shared
 * no-op instance when `DEBUG` is off (zero allocation, zero I/O).
 *
 * @param module  Module tag used in every log line (e.g. `'projection-pipeline'`).
 * @param reqId   Optional correlation ID. Defaults to `'boot'` for module-level logs.
 */
const createLogger = (module, reqId = 'boot') => {
    if (!exports.DEBUG)
        return NOOP_LOGGER;
    return new ActiveLogger(module, reqId);
};
exports.createLogger = createLogger;
/**
 * Legacy factory kept for backwards compatibility with the initial refactor.
 * Produces a call-style logger that additionally implements the {@link Logger}
 * interface via prototype-mixin, so both `log('msg', ctx)` and
 * `log.debug('method', 'msg', ctx)` work.
 *
 * @deprecated Use {@link createLogger} instead.
 */
const makeLogger = () => {
    if (!exports.DEBUG) {
        const noop = () => { };
        Object.assign(noop, NOOP_LOGGER);
        return noop;
    }
    const structured = new ActiveLogger('legacy', 'boot');
    const fn = (message, payload) => {
        structured.debug('log', message, payload);
    };
    // Mixin the structured interface so tests / older code can still call debug()/info() etc.
    fn.reqId = structured.reqId;
    fn.module = structured.module;
    fn.debug = structured.debug.bind(structured);
    fn.info = structured.info.bind(structured);
    fn.warn = structured.warn.bind(structured);
    fn.error = structured.error.bind(structured);
    fn.forModule = structured.forModule.bind(structured);
    fn.forRequest = structured.forRequest.bind(structured);
    return fn;
};
exports.makeLogger = makeLogger;
