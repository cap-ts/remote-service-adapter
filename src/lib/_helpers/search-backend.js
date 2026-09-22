"use strict";
/**
 * @file search-backend.ts
 * @description Decides how `$search` behaves for an entity from the backend its data finally comes from.
 *
 * An entity is usually a projection on another entity, often of another locally served service, and so on until an
 * external service or a real local entity is reached. That end decides:
 *
 * | Backend the data comes from                         | `$search`                                   |
 * |-----------------------------------------------------|---------------------------------------------|
 * | local (database / locally implemented entity)       | case-INSENSITIVE                            |
 * | remote OData V4 (`kind: "odata"` / `"odata-v4"`)    | case-INSENSITIVE                            |
 * | remote OData V2 (`kind: "odata-v2"`), anything else | case-SENSITIVE                              |
 * | SOAP (`kind: "soap"`)                               | not supported: the term is ignored          |
 *
 * V2 / V4 is read from `cds.requires.<service>.kind` in package.json. Case-insensitive search needs `tolower` on
 * the backend (pushed as `contains(tolower(field), word)`), which OData V2 services such as S/4
 * `API_BUSINESS_PARTNER` reject, so V2 keeps the exact, case-sensitive `contains`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchModeOf = exports.effectiveSearchMode = exports.resolveSearchBackend = exports.backendKindOfService = void 0;
const cds_1 = require("@sap/cds");
const cqn_utils_1 = require("./cqn-utils");
const service_resolver_1 = require("./service-resolver");
const soap_adapter_1 = require("./soap-adapter");
const search_functions_1 = require("./search-functions");
/** Safety bound for projection chains (a cycle can not be resolved). */
const MAX_HOPS = 20;
/**
 * Kind of an external service, from `cds.requires.<service>.kind`.
 *
 * @param service  Service name as used by `cds.connect.to`.
 */
const backendKindOfService = (service) => {
    const kind = String(cds_1.default.requires?.[service]?.kind ?? '').toLowerCase();
    if (kind === 'soap' || (0, soap_adapter_1.isSoapService)(service))
        return 'soap';
    if (kind === 'odata-v2')
        return 'odata-v2';
    if (kind === 'odata' || kind === 'odata-v4')
        return 'odata-v4';
    return 'other';
};
exports.backendKindOfService = backendKindOfService;
/**
 * Follows `entityDef` through projections and locally served services to the backend its data comes from.
 *
 * @param entityDef  CDS entity definition.
 * @param opts       `startIsLocal`: `entityDef` is the entity the current request reads, which is local by
 *                   definition (it is served by this process). Leave it off for other entities (an association
 *                   target), whose own service decides whether they are external.
 */
const resolveSearchBackend = (entityDef, opts = {}) => {
    const chain = [];
    let def = entityDef;
    for (let hop = 0; def && hop < MAX_HOPS; hop++) {
        chain.push(def.name);
        const [service] = (0, service_resolver_1.splitServiceAndEntity)(def.name);
        const isStart = hop === 0 && !!opts.startIsLocal;
        // SOAP first, at every step: a SOAP service is also served by this process (its adapter), so it would
        // otherwise look "local" and get a search it can not do
        if (service !== 'db' && !isStart && (0, exports.backendKindOfService)(service) === 'soap')
            return { kind: 'soap', service, chain };
        // an entity of an external (imported) service: that service is the backend
        if (!isStart && service !== 'db' && !(0, service_resolver_1.usesLocalServiceSemantics)(service))
            return { kind: (0, exports.backendKindOfService)(service), service, chain };
        const from = def.query?.SELECT?.from ?? def.projection?.from;
        if (!from)
            return { kind: 'local', service, chain }; // a real entity: database / local handler
        if (from.join || !from.ref?.length)
            return { kind: 'other', service, chain }; // joins are not followed
        def = cds_1.default.model?.definitions?.[(0, cqn_utils_1.resolveTargetEntity)(def)];
    }
    return { kind: 'other', service: chain.length ? (0, service_resolver_1.splitServiceAndEntity)(chain[chain.length - 1])[0] : 'db', chain };
};
exports.resolveSearchBackend = resolveSearchBackend;
/**
 * `searchModeOf` for a resolved backend, corrected by what the service is known not to support: a service that rejected
 * `tolower` (S/4 OData V4 `API_PROJECTBILLINGREQUEST`, `BUSINESSROLE`) can only search case-sensitively.
 *
 * @param backend  Result of {@link resolveSearchBackend}.
 */
const effectiveSearchMode = (backend) => {
    const mode = (0, exports.searchModeOf)(backend.kind);
    return mode === 'insensitive' && backend.kind !== 'local' && (0, search_functions_1.isFunctionUnsupported)(backend.service, 'tolower') ? 'sensitive' : mode;
};
exports.effectiveSearchMode = effectiveSearchMode;
/**
 * How `$search` behaves for data from this kind of backend (see the file header).
 *
 * @param kind  Result of {@link resolveSearchBackend}.
 */
const searchModeOf = (kind) => {
    if (kind === 'soap')
        return 'none';
    return kind === 'local' || kind === 'odata-v4' ? 'insensitive' : 'sensitive';
};
exports.searchModeOf = searchModeOf;
