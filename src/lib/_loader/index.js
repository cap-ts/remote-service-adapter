"use strict";
/**
 * @file index.ts
 * @description CAP plugin entry (`cds-plugin.js` -> `require('./src/lib/_loader')()`).
 *
 * Makes {@link RemoteService} the implementation of local CAP services that are projections on external OData / SOAP
 * services, without a handler file per service.
 *
 * ## Opt-in
 * Per external service, in the consuming project's `cds.requires`:
 *
 * ```json
 * { "cds": { "requires": { "MyExternalService": {
 *     "kind": "odata",
 *     "model": "srv/external/MyExternalService",
 *     "credentials": { "url": "https://example.com" },
 *     "remoteService": true
 * } } } }
 * ```
 *
 * Supported kinds: `odata`, `odata-v2`, `odata-v4`, `soap`. Any other kind with the flag is reported and ignored.
 *
 * ## What it does
 * On every `cds.on('loaded')` (raw CSN, before linking) every LOCAL service that has at least one entity selecting from an
 * opted-in external service gets `@impl` pointing at this package's `RemoteService`. CAP then instantiates it for the
 * service, and `RemoteService` reads through `cds.connect.to(<external>)`.
 *
 * ## What it never does
 * - It does not touch the external service itself. `cds.requires.<external>.impl` (your own client extension) keeps
 *   working. Pointing it at `RemoteService` would make the service call itself, because `RemoteService` reads through
 *   `cds.connect.to(<owning service>)`, which returns the same cached instance.
 * - It never replaces an implementation the project already has: an existing `@impl`, a `cds.requires.<local>.impl`,
 *   or a sibling handler file that CAP would pick up (`<name>.js` next to the `.cds`, or in `lib/` / `handlers/`).
 *   Such services can extend `RemoteService` themselves.
 *
 * See `.claude/docs/integration.md`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPlugin = loadPlugin;
const cds_1 = require("@sap/cds");
const fs = require("fs");
const path = require("path");
/** Name of the log channel (`DEBUG=remote-service` enables the debug lines). */
const LOG_NAME = 'remote-service';
/** Property of `cds.requires.<external>` that opts the external service in. */
const OPT_IN_KEY = 'remoteService';
/** External service kinds `RemoteService` can read from. */
const SUPPORTED_KINDS = new Set(['odata', 'odata-v2', 'odata-v4', 'soap']);
/**
 * Nearest `package.json` walking up from `startDir`: this module's own manifest. Not a fixed relative depth because the
 * compiled module runs one directory level deeper in the dev/test tree (under `build/`) than it does once installed in a
 * consumer's `node_modules` (where `package.json` sits three levels above `src/lib/_loader/index.js`).
 */
const findPackageJson = (startDir) => {
    let dir = startDir;
    for (;;) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            throw new Error(`package.json not found above ${startDir}`);
        dir = parent;
    }
};
/** Name of this package (its own `package.json`), used to build a portable `@impl` specifier. */
const PACKAGE_NAME = require(findPackageJson(__dirname)).name;
/**
 * The value written to `@impl`. The absolute file path is machine specific: `cds build` / `cds compile` copy `@impl`
 * into the CSN, so on another machine (Cloud Foundry) CAP would try to load a path that does not exist, and the plugin
 * would take it for an implementation of the project and leave it alone. A package specifier survives that: CAP
 * resolves it from `cds.root` (`node_modules`). It is only used when it resolves to the very same file; otherwise
 * (nested / linked installs that `cds.root` can not see) the absolute path is kept.
 *
 * @param moduleFile  Absolute path of this package's `_RemoteService` module.
 * @param root        `cds.root`.
 */
const resolveImplSpecifier = (moduleFile, root) => {
    const specifier = `${PACKAGE_NAME}/src/lib/_RemoteService`;
    try {
        return require.resolve(specifier, { paths: [root] }) === moduleFile ? specifier : moduleFile;
    }
    catch {
        return moduleFile;
    }
};
/** Where CAP looks for a handler file next to the service's `.cds` file (see `@sap/cds/lib/srv/factory.js`). */
const SIBLING_DIRS = ['/', '/lib/', '/handlers/'];
/**
 * @param kind  `cds.requires.<name>.kind`.
 * @returns `true` for the kinds `RemoteService` supports.
 */
const isSupportedKind = (kind) => SUPPORTED_KINDS.has(kind);
/** Default file check: CAP's own (`cds.utils.isfile`, resolved against `cds.root`). */
const defaultIsFile = (file) => !!cds_1.default.utils.isfile(file);
const nameOf = (segment) => (typeof segment === 'string' ? segment : segment?.id);
/**
 * Names of the entities a CSN `from` clause selects from, including all sides of a JOIN.
 *
 * @param from  `projection.from` / `query.SELECT.from` of a definition.
 * @param out   Accumulator (used by the recursion).
 * @returns The entity names in source order.
 */
const collectSourceNames = (from, out = []) => {
    if (!from || typeof from !== 'object')
        return out;
    if (Array.isArray(from.ref) && from.ref.length > 0) {
        const name = nameOf(from.ref[0]);
        if (name)
            out.push(name);
    }
    for (const arg of from.args ?? [])
        collectSourceNames(arg, out);
    return out;
};
/**
 * Longest service definition whose name is a prefix of `entityName` (`Svc.Sub.Entity` -> `Svc.Sub`).
 *
 * @param definitions  `csn.definitions`.
 * @param entityName   Fully qualified entity name.
 */
const owningServiceName = (definitions, entityName) => {
    let owner;
    for (const [name, def] of Object.entries(definitions)) {
        if (def.kind !== 'service' || !entityName.startsWith(`${name}.`))
            continue;
        if (!owner || name.length > owner.length)
            owner = name;
    }
    return owner;
};
/** `true` when the service is imported from an external model (`@cds.external`, `@external`, `requires.<name>.external`). */
const isExternalService = (name, def, requires) => !!(def['@cds.external'] || def['@external'] || requires[name]?.external);
/**
 * `true` when CAP would load a handler file for this service by itself (the sibling lookup of `cds.service.factory`).
 *
 * A `.ts` handler counts even when `CDS_TYPESCRIPT` is not set. The CDS CLI sets it only for `cds serve` / `cds watch`, not
 * for `cds compile` / `cds build`; there the loader would not see `lib/X.ts`, write `@impl` into the CSN, and at runtime
 * (`gen/srv`, where the handler is compiled to `X.js`) CAP prefers the CSN's `@impl` over the sibling file: the project's own
 * implementation would be replaced by `RemoteService`.
 *
 * @param def     CSN definition of the service.
 * @param isFile  File check, injectable for tests.
 */
const hasSiblingImplementation = (def, isFile = defaultIsFile) => {
    const source = def['@source'] || def.$location?.file;
    if (!source)
        return false;
    const { dir, name } = path.parse(source);
    const extensions = ['.ts', '.js', '.mjs'];
    for (const sub of SIBLING_DIRS) {
        for (const ext of extensions)
            if (isFile((dir || '.') + sub + name + ext))
                return true;
    }
    return false;
};
/** `true` for a `cds.requires` entry that opted in and has a supported kind. */
const isOptedIn = (config) => config?.[OPT_IN_KEY] === true && isSupportedKind(config.kind);
/**
 * Local services that select from an opted-in external service, with the external services they use.
 *
 * @param csn       Raw CSN.
 * @param requires  `cds.env.requires`.
 * @returns Map local service name -> external service names.
 */
const findRemoteServiceTargets = (csn, requires) => {
    const definitions = csn.definitions;
    const targets = new Map();
    for (const [name, def] of Object.entries(definitions)) {
        if (def.kind !== 'entity')
            continue;
        const local = owningServiceName(definitions, name);
        if (!local)
            continue;
        for (const source of collectSourceNames(def.projection?.from ?? def.query?.SELECT?.from)) {
            const external = owningServiceName(definitions, source);
            if (!external || external === local || !isOptedIn(requires[external]))
                continue;
            const used = targets.get(local) ?? new Set();
            used.add(external);
            targets.set(local, used);
        }
    }
    return targets;
};
/**
 * Sets `@impl` on every eligible local service (see the file header) and reports opt-ins with an unsupported kind.
 *
 * @param csn       Raw CSN (mutated).
 * @param requires  `cds.env.requires`.
 * @param implPath  `@impl` value: specifier or absolute path of the module whose default export is `RemoteService`.
 * @param log       Optional logger.
 * @param isFile    File check, injectable for tests.
 * @returns Names of the services that received `@impl`.
 */
const applyRemoteServiceImpl = (csn, requires, implPath, log, isFile = defaultIsFile) => {
    const patched = [];
    for (const [name, config] of Object.entries(requires)) {
        if (config?.[OPT_IN_KEY] === true && !isSupportedKind(config.kind)) {
            log?.warn(`cds.requires.${name}.${OPT_IN_KEY} is ignored: kind '${config.kind}' is not one of ${[...SUPPORTED_KINDS].join(', ')}`);
        }
    }
    for (const [local, externals] of findRemoteServiceTargets(csn, requires)) {
        const def = csn.definitions[local];
        if (isExternalService(local, def, requires))
            continue;
        const reason = def['@impl'] ? '@impl' : requires[local]?.impl ? 'cds.requires impl' : hasSiblingImplementation(def, isFile) ? 'handler file' : undefined;
        if (reason) {
            log?.debug(`${local}: keeps its own implementation (${reason})`);
            continue;
        }
        def['@impl'] = implPath;
        patched.push(local);
        log?.info(`${local}: RemoteService implements it (reads from ${[...externals].join(', ')})`);
    }
    return patched;
};
/**
 * Registers the `loaded` listener. Called once by CAP's plugin loader through `cds-plugin.js`.
 *
 * @returns `void` - side effects only.
 */
function loadPlugin() {
    const log = cds_1.default.log(LOG_NAME);
    const moduleFile = require.resolve('../_RemoteService');
    cds_1.default.on('loaded', (csn) => {
        if (!csn?.definitions)
            return;
        applyRemoteServiceImpl(csn, cds_1.default.env.requires || {}, resolveImplSpecifier(moduleFile, cds_1.default.root), log);
    });
}
/** CJS default export: the plugin factory, as CAP's plugin loader expects (`require('.../_loader')()`). */
module.exports = loadPlugin;
/**
 * Testable surface: `require('.../_loader').__test`. Named exports do not survive `module.exports = loadPlugin`, so the
 * helpers are only reachable here.
 */
module.exports.__test = {
    OPT_IN_KEY,
    isSupportedKind,
    collectSourceNames,
    owningServiceName,
    isExternalService,
    hasSiblingImplementation,
    findPackageJson,
    resolveImplSpecifier,
    findRemoteServiceTargets,
    applyRemoteServiceImpl,
};
