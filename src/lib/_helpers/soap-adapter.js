"use strict";
/**
 * @file soap-adapter.ts
 * @description SOAP-specific request handling. SOAP services require
 * `dispatch()` (not `run()`) so the full request/response pipeline
 * (envelope building, `@Soap.path` field mapping) executes.
 *
 * Results are deduplicated by entity key fields because SOAP backends may
 * return multiple rows per logical key (e.g. one row per
 * `BusinessPartnerRoleCode`). The full dispatch pipeline (header stripping,
 * `createRequest`, `dispatch`, dedup) is delegated to `soap.read()` from
 * `@cap-ts/soap-adapter`. This file adds: `buildSoapProjectionQuery`
 * (FROM-clause retargeting), `deriveParamsFromWhere` (params fallback for
 * expand fetches), and the ENTER/EXIT timing log.
 *
 * ## Logging
 * `runSoapRead` emits INFO on ENTER/EXIT with dispatch timing.
 * All logger params are optional so this adapter can be called from
 * contexts without a logger.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSoapRead = exports.deriveParamsFromWhere = exports.deduplicateSoapResults = exports.buildSoapProjectionQuery = exports.isSoapService = void 0;
const cds_1 = require("@sap/cds");
const soap_adapter_1 = require("@cap-ts/soap-adapter");
const utils_1 = require("./utils");
const cqn_utils_1 = require("./cqn-utils");
const { SELECT } = cds_1.default.ql;
const M = 'soap-adapter';
/**
 * Returns `true` when the named service is configured as a SOAP service
 * (`cds.requires[name].kind === 'soap'` or the CSN definition carries
 * `@soap`).
 *
 * Re-exports the package helper so existing consumer imports of
 * `isSoapService` from this module keep working; the implementation lives
 * in `@cap-ts/soap-adapter` (`soap.isSoapService`).
 */
exports.isSoapService = soap_adapter_1.soap.isSoapService;
/**
 * Clones the incoming CQN query and retargets its FROM clause to the
 * given SOAP entity name so the SOAP adapter receives a clean query.
 * Consumer-specific: preserves the caller's WHERE/columns instead of
 * building a fresh `SELECT.from(name)` like the package's `_loader` does.
 */
const buildSoapProjectionQuery = (query, entityName) => {
    const cloned = query?.SELECT ? (0, utils_1.deepClone)(query) : SELECT.from(entityName);
    if (!cloned.SELECT)
        cloned.SELECT = SELECT.from(entityName).SELECT;
    cloned.SELECT.from = (0, cqn_utils_1.retargetFromNode)(cloned.SELECT.from, entityName);
    return cloned;
};
exports.buildSoapProjectionQuery = buildSoapProjectionQuery;
/**
 * Deduplicate SOAP result rows by the entity's key fields.
 *
 * thin wrapper over `soap.dedupByKeys` + `soap.getEntityKeyFields`
 * from `@cap-ts/soap-adapter` — the actual dedup algorithm and key
 * resolution live in the package (`_util/entity.js`). This wrapper keeps
 * the consumer's call-shape (`soapSrv` + `entityName` + optional
 * `fallbackEntityDef` + `log`) so existing callers don't need to change,
 * and emits a debug line when duplicates are removed.
 */
const deduplicateSoapResults = (results, soapSrv, entityName, fallbackEntityDef, log) => {
    if (!Array.isArray(results) || results.length <= 1)
        return results;
    const entityDef = soapSrv?.entities?.[entityName] ?? fallbackEntityDef;
    const keyFields = soap_adapter_1.soap.getEntityKeyFields(entityDef);
    if (!keyFields || keyFields.length === 0) {
        log?.debug('deduplicateSoapResults', 'No key fields found — skipping dedup', { entity: entityName });
        return results;
    }
    const deduped = soap_adapter_1.soap.dedupByKeys(results, keyFields);
    if (deduped.length !== results.length) {
        log?.debug('deduplicateSoapResults', 'Removed duplicates', {
            entity: entityName,
            before: results.length,
            after: deduped.length,
            keyFields,
        });
    }
    return deduped;
};
exports.deduplicateSoapResults = deduplicateSoapResults;
/**
 * Extracts simple equality predicates from a CQN WHERE clause and returns
 * them as a params-style object `{ fieldName: value }`.
 *
 * The SOAP adapter uses `req.params` to build the SOAP request body. When a
 * read is triggered by a collection query (e.g. an expand fetch) rather than
 * a by-key URL, `req.params` is `[]`. Providing the key values derived from
 * the WHERE clause lets the SOAP adapter build a proper filter, which is
 * required for the second SOAP call within the same outer request (otherwise
 * the adapter returns `{}` with `elapsedMs:0`).
 */
const deriveParamsFromWhere = (where) => {
    if (!Array.isArray(where) || where.length === 0)
        return null;
    const result = {};
    // Walk flat [ref, '=', val, 'and', ref, '=', val, ...] structure
    for (let i = 0; i < where.length - 2; i++) {
        const left = where[i];
        const op = where[i + 1];
        const right = where[i + 2];
        if (left?.ref && Array.isArray(left.ref) && left.ref.length > 0 &&
            op === '=' &&
            right?.val !== undefined) {
            const fieldName = String(left.ref[left.ref.length - 1]);
            result[fieldName] = right.val;
            i += 2; // skip op and val
        }
    }
    return Object.keys(result).length > 0 ? result : null;
};
exports.deriveParamsFromWhere = deriveParamsFromWhere;
/**
 * Single entry-point for reading from a SOAP-backed service.
 *
 * Builds a clean CQN query via {@link buildSoapProjectionQuery} (retargets
 * the FROM clause to `entityName`), derives params from the WHERE clause
 * when `req.params` is empty (expand fetches), then delegates the full
 * dispatch pipeline to `soap.read()` from `@cap-ts/soap-adapter`.
 *
 * `soap.read()` owns: header assembly + stripping, `createRequest` with a
 * unique context id, `soapSrv.dispatch()`, and key-based dedup. This
 * wrapper adds: timing/logging, `buildSoapProjectionQuery`, and the
 * `deriveParamsFromWhere` fallback.
 */
const runSoapRead = async (soapSrv, entityName, req, query, fallbackEntityDef, parentLog, outerReq) => {
    const log = parentLog ? parentLog.forModule(M) : (0, utils_1.createLogger)(M);
    const t0 = Date.now();
    log.info('runSoapRead', 'ENTER', { service: soapSrv?.name, entity: entityName });
    // Retarget the FROM clause so the SOAP adapter receives a clean query
    // against the remote entity name rather than the local projection name.
    const soapQuery = (0, exports.buildSoapProjectionQuery)(query, entityName);
    // Derive params from WHERE clause when the incoming request carries none
    // (e.g. expand fetches triggered by a collection read rather than a
    // by-key URL). The SOAP adapter needs params to build the SOAP filter;
    // without them it returns {} on the second dispatch within the same
    // outer request context.
    const reqParams = req.params ?? [];
    let effectiveParams;
    if (!Array.isArray(reqParams) || reqParams.length === 0) {
        const derived = (0, exports.deriveParamsFromWhere)(soapQuery?.SELECT?.where ?? []);
        if (derived) {
            log.debug('runSoapRead', 'Derived params from WHERE clause', { entity: entityName, derived });
            effectiveParams = [derived];
        }
    }
    log.debug('runSoapRead', 'SOAP target binding check', {
        entity: entityName,
        targetName: soapSrv?.entities?.[entityName]?.name,
        hasSoapBinding: !!(soapSrv?.entities?.[entityName]?.['@Soap.binding']),
        srvEntities: Object.keys(soapSrv?.entities ?? {}),
    });
    let result;
    try {
        result = await soap_adapter_1.soap.read(soapSrv, entityName, req, soapQuery, {
            outerReq,
            params: effectiveParams,
            fallbackEntityDef,
        });
        log.debug('runSoapRead', 'SOAP dispatch completed', {
            service: soapSrv?.name,
            entity: entityName,
            rows: result.length,
        });
    }
    catch (err) {
        log.error('runSoapRead', 'SOAP dispatch failed', {
            service: soapSrv?.name,
            entity: entityName,
            error: { message: err?.message, code: err?.code },
        });
        throw err;
    }
    log.info('runSoapRead', 'EXIT', {
        service: soapSrv?.name,
        entity: entityName,
        elapsedMs: Date.now() - t0,
        rows: result.length,
    });
    return result;
};
exports.runSoapRead = runSoapRead;
