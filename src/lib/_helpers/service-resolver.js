"use strict";
/**
 * @file service-resolver.ts
 * @description Resolves CDS service names / instances from fully qualified
 * entity paths. Uses `cds.model.definitions` to find the longest-prefix
 * service that owns a given path, and prefers locally-served providers over
 * remote services.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServiceByName = exports.usesLocalServiceSemantics = exports.getServedLocalService = exports.resolveServiceNameFromTarget = exports.splitServiceAndEntity = exports.resolveOwningServiceName = void 0;
const cds_1 = require("@sap/cds");
/**
 * Finds the longest-prefix service in `cds.model.definitions` that owns the
 * given path. Longest-prefix wins so nested service naming works correctly
 * (e.g. `A.B` beats `A` for `A.B.Entity`).
 *
 * @param path  Fully qualified entity path.
 * @returns     Owning service name, or `undefined` when none applies.
 */
const resolveOwningServiceName = (path) => {
    const definitions = cds_1.default.model?.definitions || {};
    let owningService;
    for (const [name, def] of Object.entries(definitions)) {
        if (def?.kind !== 'service')
            continue;
        if (!path.startsWith(`${name}.`))
            continue;
        if (!owningService || name.length > owningService.length)
            owningService = name;
    }
    return owningService;
};
exports.resolveOwningServiceName = resolveOwningServiceName;
/**
 * Splits a fully qualified entity path into `[serviceName, entityName]`.
 * Falls back to `['db', path]` when no service owns the path.
 *
 * @param path  Fully qualified path like `MyService.MyEntity`.
 */
const splitServiceAndEntity = (path) => {
    const serviceName = (0, exports.resolveOwningServiceName)(path);
    return serviceName ? [serviceName, path.slice(serviceName.length + 1)] : ['db', path];
};
exports.splitServiceAndEntity = splitServiceAndEntity;
/**
 * Returns the service that owns the given entity path, or `'db'` when
 * no service owns it.
 *
 * @param target  Fully qualified entity or type name.
 */
const resolveServiceNameFromTarget = (target) => (0, exports.resolveOwningServiceName)(target) || 'db';
exports.resolveServiceNameFromTarget = resolveServiceNameFromTarget;
/**
 * Returns the locally-served service instance with the given name, or
 * `undefined` when the service is provided by a remote backend.
 *
 * @param serviceName  Service name.
 */
const getServedLocalService = (serviceName) => {
    const providers = (cds_1.default.service?.providers || []);
    return providers.find((provider) => provider?.name === serviceName);
};
exports.getServedLocalService = getServedLocalService;
/**
 * Returns `true` when the named service is served locally by this process,
 * meaning queries against it should target local (CAP) projections rather
 * than remote physical entity names.
 *
 * @param serviceName  Service name.
 */
const usesLocalServiceSemantics = (serviceName) => {
    if (!serviceName || serviceName === 'db')
        return false;
    return !!(0, exports.getServedLocalService)(serviceName);
};
exports.usesLocalServiceSemantics = usesLocalServiceSemantics;
/**
 * Returns a connected service instance for the given name. Prefers
 * locally-served providers, then `cds.db`, then remote services via
 * `cds.connect.to`.
 *
 * @param serviceName  Service name.
 */
const getServiceByName = async (serviceName) => {
    const localService = (0, exports.getServedLocalService)(serviceName);
    if (localService)
        return localService;
    if (serviceName === 'db' && cds_1.default.db)
        return cds_1.default.db;
    return await cds_1.default.connect.to(serviceName);
};
exports.getServiceByName = getServiceByName;
