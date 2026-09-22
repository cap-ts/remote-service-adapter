"use strict";
/**
 * @file join-mashup-pipeline.ts
 * @description Handles a READ that maps to a CDS view whose FROM clause is
 * a JOIN of two or more remote entities.
 *
 * Strategy: query the *primary* (left-most) entity first, then batched
 * lookups keyed on the join keys for each subsequent joined table. Results
 * from later tables are merged into the primary rows using the projected
 * column mapping in the view.
 *
 * ## Logging
 * The primary fetch and each secondary JOIN emit `INFO` boundary logs with
 * timing. Foreign-key extraction and the join map size are logged at `DEBUG`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleComplexJoinMashup = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const column_builders_1 = require("./column-builders");
const cqn_utils_1 = require("./cqn-utils");
const cqn_rewriter_1 = require("./cqn-rewriter");
const expand_materializer_1 = require("./expand-materializer");
const join_parser_1 = require("./join-parser");
const service_resolver_1 = require("./service-resolver");
const { SELECT } = cds_1.default.ql;
const M = 'join-mashup-pipeline';
/**
 * Executes the complex-join-mashup pipeline for a JOIN-based view.
 */
const handleComplexJoinMashup = async (serviceName, req, next, entityDef, selectSpec, cache, parentLog) => {
    const log = parentLog.forModule(M);
    const t0 = Date.now();
    if (!entityDef) {
        log.warn('handleComplexJoinMashup', 'No entity definition; delegating to next()');
        return next();
    }
    log.info('handleComplexJoinMashup', 'ENTER', { entity: entityDef.name });
    const joinSequence = (0, join_parser_1.flattenJoinStructure)(selectSpec.from);
    if (!joinSequence.length) {
        log.warn('handleComplexJoinMashup', 'Empty join sequence; returning empty result');
        return req.query.SELECT?.one ? {} : [];
    }
    log.debug('handleComplexJoinMashup', 'Join sequence', {
        sources: joinSequence.map((j) => ({ path: j.entityPath, alias: j.alias })),
    });
    // ------------------------------------------------------------------
    // Primary source
    // ------------------------------------------------------------------
    const primarySource = joinSequence[0];
    const [primarySrvName, primaryEntity] = (0, service_resolver_1.splitServiceAndEntity)(primarySource.entityPath);
    const primarySrv = await (0, service_resolver_1.getServiceByName)(primarySrvName);
    const primaryUsesLocalSemantics = (0, service_resolver_1.usesLocalServiceSemantics)(primarySrvName);
    const primaryQueryEntity = primaryUsesLocalSemantics && primarySrvName !== serviceName ? primarySource.entityPath : primaryEntity;
    const primaryEntityDef = cds_1.default.model.definitions[primarySource.entityPath];
    const primaryAliasMaps = (0, alias_maps_1.getAliasMaps)(primaryEntityDef, cache);
    const primaryQuery = SELECT.from(primaryQueryEntity);
    if (req.query.SELECT.count)
        primaryQuery.SELECT.count = true;
    if (req.query.SELECT.where) {
        const cleanWhere = (0, cqn_utils_1.filterWhereForTable)(req.query.SELECT.where, primarySource.alias);
        if (cleanWhere)
            primaryQuery.where(cleanWhere);
    }
    if (req.query.SELECT.limit)
        primaryQuery.limit(req.query.SELECT.limit.rows.val, req.query.SELECT.limit.offset);
    if (req.query.SELECT.orderBy)
        primaryQuery.orderBy(req.query.SELECT.orderBy);
    if (!primaryUsesLocalSemantics) {
        (0, cqn_rewriter_1.rewriteQueryCqn)(primaryQuery, primaryAliasMaps.localToRemote, cache, primaryEntityDef);
    }
    const expandTree = (0, join_parser_1.parseExpandTree)(selectSpec.columns || []);
    if (expandTree.length === 0 && !selectSpec.columns?.length) {
        primaryQuery.columns(primaryUsesLocalSemantics
            ? (0, column_builders_1.buildDefaultLocalColumns)(primaryEntityDef)
            : (0, column_builders_1.buildDefaultRemoteColumns)(primaryEntityDef, primaryAliasMaps.localToRemote));
    }
    const tPrimary = Date.now();
    log.info('handleComplexJoinMashup', 'Executing primary read', {
        service: primarySrvName,
        entity: primaryEntity,
    });
    const primaryRecords = await primarySrv.run(primaryQuery);
    log.info('handleComplexJoinMashup', 'Primary read done', {
        elapsedMs: Date.now() - tPrimary,
        rows: Array.isArray(primaryRecords) ? primaryRecords.length : (primaryRecords ? 1 : 0),
    });
    if (!primaryRecords || (Array.isArray(primaryRecords) && primaryRecords.length === 0)) {
        log.info('handleComplexJoinMashup', 'EXIT (empty primary)', { elapsedMs: Date.now() - t0 });
        return primaryRecords;
    }
    const isArray = Array.isArray(primaryRecords);
    const records = isArray ? primaryRecords : [primaryRecords];
    const remoteCount = primaryRecords.$count;
    // ------------------------------------------------------------------
    // Secondary joins
    // ------------------------------------------------------------------
    for (let i = 1; i < joinSequence.length; i++) {
        const joinInfo = joinSequence[i];
        const tJoin = Date.now();
        log.info('handleComplexJoinMashup', `JOIN step ${i}`, {
            source: joinInfo.entityPath,
            alias: joinInfo.alias,
        });
        const [joinSrvName, joinEntity] = (0, service_resolver_1.splitServiceAndEntity)(joinInfo.entityPath);
        const joinUsesLocalSemantics = (0, service_resolver_1.usesLocalServiceSemantics)(joinSrvName);
        const joinQueryEntity = joinUsesLocalSemantics && joinSrvName !== serviceName ? joinInfo.entityPath : joinEntity;
        const joinEntityDef = cds_1.default.model.definitions[joinInfo.entityPath];
        const joinAliasMaps = (0, alias_maps_1.getAliasMaps)(joinEntityDef, cache);
        const { leftKey, rightKey } = (0, join_parser_1.parseJoinKeys)(joinInfo.onCondition, joinSequence[i - 1].alias, joinInfo.alias);
        if (!leftKey || !rightKey) {
            log.warn('handleComplexJoinMashup', 'Could not parse join keys; skipping join', {
                step: i,
                onCondition: joinInfo.onCondition,
            });
            continue;
        }
        log.debug('handleComplexJoinMashup', 'Join keys parsed', { leftKey, rightKey });
        const foreignKeys = [...new Set(records.map((r) => r[leftKey]).filter((v) => v != null))];
        if (!foreignKeys.length) {
            log.info('handleComplexJoinMashup', 'No foreign keys to join; skipping step', { step: i });
            continue;
        }
        log.debug('handleComplexJoinMashup', 'Foreign keys collected', {
            unique: foreignKeys.length,
            sample: foreignKeys.slice(0, 3),
        });
        const joinSrv = await (0, service_resolver_1.getServiceByName)(joinSrvName);
        const joinedQuery = SELECT.from(joinQueryEntity).where({ [rightKey]: { in: foreignKeys } });
        if (!joinUsesLocalSemantics) {
            (0, cqn_rewriter_1.rewriteQueryCqn)(joinedQuery, joinAliasMaps.localToRemote, cache, joinEntityDef);
        }
        const joinedRecords = await joinSrv.run(joinedQuery);
        const joinedList = Array.isArray(joinedRecords) ? joinedRecords : [joinedRecords];
        const joinedMap = new Map(joinedList.map((item) => [item[rightKey], item]));
        log.info('handleComplexJoinMashup', `JOIN step ${i} fetched`, {
            elapsedMs: Date.now() - tJoin,
            joinedRows: joinedList.length,
            uniqueKeys: joinedMap.size,
        });
        const projectionMappings = (0, join_parser_1.getProjectionMappings)(selectSpec.columns, joinInfo.alias);
        let merged = 0;
        for (const record of records) {
            const matched = joinedMap.get(record[leftKey]);
            if (!matched)
                continue;
            for (const mapping of projectionMappings)
                record[mapping.projectedAs] = matched[mapping.sourceField];
            merged++;
        }
        log.debug('handleComplexJoinMashup', `JOIN step ${i} merged`, {
            projectedFields: projectionMappings.length,
            recordsMerged: merged,
        });
    }
    if (expandTree.length > 0) {
        log.info('handleComplexJoinMashup', 'Resolving $expand tree on merged records', {
            expands: expandTree.map((e) => e.as || e.name),
            rows: records.length,
        });
        const mapped = await (0, expand_materializer_1.resolveExpandNodes)(req, entityDef, records, expandTree, cache, log);
        if (remoteCount !== undefined)
            mapped.$count = remoteCount;
        log.info('handleComplexJoinMashup', 'EXIT', {
            elapsedMs: Date.now() - t0,
            rows: mapped.length,
        });
        return isArray ? mapped : mapped[0];
    }
    if (remoteCount !== undefined)
        records.$count = remoteCount;
    log.info('handleComplexJoinMashup', 'EXIT', {
        elapsedMs: Date.now() - t0,
        rows: records.length,
    });
    return isArray ? records : records[0];
};
exports.handleComplexJoinMashup = handleComplexJoinMashup;
