"use strict";
/**
 * @file index.ts
 * @description CAP plugin entry (`cds-plugin.js` -> `require('./src/lib/_loader')()`).
 *
 * Makes {@link RemoteApplicationService} the implementation of any local CAP service explicitly annotated `@remote`,
 * without a handler file per service.
 *
 * ## Opt-in
 * Annotate the service itself:
 *
 * ```cds
 * @remote
 * service MyService {
 *     entity Foo as projection on SomeOtherService.Foo;
 * }
 * ```
 *
 * `@remote` is the entire opt-in surface. This plugin does not inspect what the service's entities project on, and it
 * does not look at `cds.requires` to decide who gets patched.
 *
 * ## What it does
 * On every `cds.on('loaded')` (raw CSN, before linking), every LOCAL service carrying `@remote` gets `@impl` pointing
 * at this package's `RemoteApplicationService`. CAP then instantiates it for the service, and `RemoteApplicationService`
 * reads through `cds.connect.to(<owning service of whatever the entity actually projects on>)`.
 *
 * ## What it never does
 * - It does not touch a service marked external itself (`@cds.external`, `@external`, `requires.<name>.external`):
 *   `RemoteApplicationService` reads through `cds.connect.to(<owning service>)`, which would return the same cached
 *   instance and make the service call itself.
 * - It never replaces an implementation the project already has: an existing `@impl`, a `cds.requires.<local>.impl`,
 *   or a sibling handler file that CAP would pick up (`<name>.js` next to the `.cds`, or in `lib/` / `handlers/`).
 *   Such services can extend `RemoteApplicationService` themselves.
 * - A service without `@remote` is left alone entirely, whatever its entities project on.
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
 * @param moduleFile  Absolute path of this package's `RemoteApplicationService` module.
 * @param root        `cds.root`.
 */
const resolveImplSpecifier = (moduleFile, root) => {
    const specifier = `${PACKAGE_NAME}/src/lib/RemoteApplicationService`;
    try {
        return require.resolve(specifier, { paths: [root] }) === moduleFile ? specifier : moduleFile;
    }
    catch {
        return moduleFile;
    }
};
/** Where CAP looks for a handler file next to the service's `.cds` file (see `@sap/cds/lib/srv/factory.js`). */
const SIBLING_DIRS = ['/', '/lib/', '/handlers/'];
/** Default file check: CAP's own (`cds.utils.isfile`, resolved against `cds.root`). */
const defaultIsFile = (file) => !!cds_1.default.utils.isfile(file);
/** `true` when the service is imported from an external model (`@cds.external`, `@external`, `requires.<name>.external`). */
const isExternalService = (name, def, requires) => !!(def['@cds.external'] || def['@external'] || requires[name]?.external);
/**
 * `true` when CAP would load a handler file for this service by itself (the sibling lookup of `cds.service.factory`).
 *
 * A `.ts` handler counts even when `CDS_TYPESCRIPT` is not set. The CDS CLI sets it only for `cds serve` / `cds watch`, not
 * for `cds compile` / `cds build`; there the loader would not see `lib/X.ts`, write `@impl` into the CSN, and at runtime
 * (`gen/srv`, where the handler is compiled to `X.js`) CAP prefers the CSN's `@impl` over the sibling file: the project's own
 * implementation would be replaced by `RemoteApplicationService`.
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
/**
 * Sets `@impl` on every local service annotated `@remote`. A service without `@remote` is left alone entirely,
 * whatever its entities project on.
 *
 * @param csn       Raw CSN (mutated).
 * @param requires  `cds.env.requires`.
 * @param implPath  `@impl` value: specifier or absolute path of the module whose default export is `RemoteApplicationService`.
 * @param log       Optional logger.
 * @param isFile    File check, injectable for tests.
 * @returns Names of the services that received `@impl`.
 */
const applyRemoteServiceImpl = (csn, requires, implPath, log, isFile = defaultIsFile) => {
    const patched = [];
    for (const [name, def] of Object.entries(csn.definitions)) {
        if (def.kind !== 'service' || !def['@remote'])
            continue;
        if (isExternalService(name, def, requires))
            continue;
        const reason = def['@impl'] ? '@impl' : requires[name]?.impl ? 'cds.requires impl' : hasSiblingImplementation(def, isFile) ? 'handler file' : undefined;
        if (reason) {
            log?.debug(`${name}: keeps its own implementation (${reason})`);
            continue;
        }
        def['@impl'] = implPath;
        patched.push(name);
        log?.info(`${name}: RemoteApplicationService implements it (@remote)`);
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
    const moduleFile = require.resolve('../RemoteApplicationService');
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
    isExternalService,
    hasSiblingImplementation,
    findPackageJson,
    resolveImplSpecifier,
    applyRemoteServiceImpl,
};
