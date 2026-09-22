"use strict";
/**
 * @file projection-pipeline.ts
 * @description Handles a READ that maps to a single remote entity via a CDS
 * projection or view.
 *
 * ### Pipeline
 * 1. **Hybrid WHERE split** — separate backend-safe predicates from local-only ones.
 * 2. **Build remote SELECT** — translate local column names → remote names.
 * 3. **Execute remote query** — static data / SOAP / OData / local service.
 * 4. **Map results** — translate remote field names back to local names.
 * 5. **In-memory post-processing** — filter, sort, slice, enforce aliases.
 *
 * On backend filter errors (HTTP 400 / "Property not found") the service
 * transparently retries without the WHERE clause and applies all filters
 * in memory.
 *
 * ## Logging
 * Every step above emits `INFO` boundary logs and `DEBUG` decision-point
 * logs (see the module logger scope `projection-pipeline`). Errors caught
 * and swallowed by the fallback are logged at `WARN`; unexpected errors
 * are re-thrown after being logged at `ERROR` by the caller.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSimpleProjection = void 0;
const cds_1 = require("@sap/cds");
const utils_1 = require("./utils");
const aggregation_1 = require("./aggregation");
const column_builders_1 = require("./column-builders");
const alias_maps_1 = require("./alias-maps");
const cqn_utils_1 = require("./cqn-utils");
const cqn_rewriter_1 = require("./cqn-rewriter");
const expand_materializer_1 = require("./expand-materializer");
const path_columns_1 = require("./path-columns");
const calc_dependencies_1 = require("./calc-dependencies");
const path_resolution_1 = require("./path-resolution");
const join_parser_1 = require("./join-parser");
const record_mapping_1 = require("./record-mapping");
const service_resolver_1 = require("./service-resolver");
const soap_adapter_1 = require("./soap-adapter");
const cqn_utils_2 = require("./cqn-utils");
const where_eval_1 = require("./where-eval");
const where_split_1 = require("./where-split");
const search_1 = require("./search");
const search_pushdown_1 = require("./search-pushdown");
const search_backend_1 = require("./search-backend");
const search_functions_1 = require("./search-functions");
const M = 'projection-pipeline';
/**
 * Executes the simple-projection pipeline for a single remote entity.
 *
 * @param serviceName  The owning RemoteApplicationService's name (for local-service detection).
 * @param req          Incoming CAP request.
 * @param next         CAP next-handler continuation.
 * @param entityDef    CDS entity definition.
 * @param cache        Per-service metadata cache.
 * @param parentLog    Request-scoped logger from the orchestrator.
 * @returns            Mapped result rows or a single object.
 */
const handleSimpleProjection = async (serviceName, req, next, entityDef, cache, parentLog, outerReq) => {
    const log = parentLog.forModule(M);
    const t0 = Date.now();
    if (!entityDef) {
        log.warn('handleSimpleProjection', 'No entity definition provided; delegating to next()');
        return next();
    }
    log.info('handleSimpleProjection', 'ENTER', { entity: entityDef.name });
    // Path columns across a to-many association can never be served: fail loudly (501) when one is
    // explicitly asked for, before any remote call. Implied by "all elements" they are left out.
    const columnPlan = (0, path_columns_1.getColumnPlan)(entityDef, cache);
    (0, path_columns_1.assertSupportedPathColumns)(columnPlan, req.query?.SELECT, entityDef.name);
    const requestedPaths = (0, path_columns_1.requestedPathColumns)(columnPlan, req.query?.SELECT).filter((p) => p.kind === 'toOne');
    // ---------------------------------------------------------------------
    // Target resolution
    // ---------------------------------------------------------------------
    const targetEntity = (0, cqn_utils_1.resolveTargetEntity)(entityDef);
    const [targetSrvName, targetEntityName] = (0, service_resolver_1.splitServiceAndEntity)(targetEntity);
    log.debug('handleSimpleProjection', 'Target resolved', {
        entity: entityDef.name,
        targetService: targetSrvName,
        targetEntity: targetEntityName,
    });
    const targetSrv = await (0, service_resolver_1.getServiceByName)(targetSrvName);
    const isTargetSrvSoap = (0, soap_adapter_1.isSoapService)(targetSrvName);
    const queryLocalTarget = (0, service_resolver_1.usesLocalServiceSemantics)(targetSrvName);
    const queryEntityName = queryLocalTarget && targetSrvName !== serviceName ? targetEntity : targetEntityName;
    const { localToRemote, remoteToLocal } = (0, alias_maps_1.getAliasMaps)(entityDef, cache);
    log.debug('handleSimpleProjection', 'Alias maps built', {
        aliasCount: Object.keys(localToRemote).length,
    });
    const incomingColumns = req.query?.SELECT?.columns ?? [];
    const hasExplicitSelect = incomingColumns.length > 0;
    const expandTree = (0, join_parser_1.parseExpandTree)(incomingColumns);
    const isDistinctProjection = !!(entityDef.query?.SELECT?.distinct || entityDef.projection?.distinct);
    const isGroupByProjection = !!(entityDef.query?.SELECT?.groupBy || entityDef.projection?.groupBy);
    const hasSkipPaginationFlag = !!req.query?.SELECT?.__skipPagination;
    if (requestedPaths.length > 0 && (isDistinctProjection || isGroupByProjection)) {
        throw Object.assign(new Error(`Association-path elements (${requestedPaths.map((p) => p.alias).join(', ')}) are not supported on DISTINCT / GROUP BY projections.`), { code: 501, status: 501, statusCode: 501 });
    }
    // `$search` (`SELECT.search`) is never forwarded: rows are matched in memory (STEP 4a). It looks at every
    // searchable column, selected or not, so those must be fetched (plain columns) and resolved (to-one paths).
    const searchTerm = (0, search_1.searchToTerm)(req.query?.SELECT?.search);
    const searchTree = (0, search_1.parseSearchTerm)(searchTerm);
    // Case rule / support from the backend the data finally comes from (search-backend.ts): local and OData V4 ignore
    // case, OData V2 is case-sensitive, SOAP does not support `$search` at all (the term is ignored).
    const searchBackend = searchTree ? (0, search_backend_1.resolveSearchBackend)(entityDef, { startIsLocal: true }) : undefined;
    // (a service known to reject `tolower` is case-sensitive even if its kind says otherwise)
    let searchMode = searchBackend ? (0, search_backend_1.effectiveSearchMode)(searchBackend) : 'sensitive';
    if (searchTree)
        log.debug('handleSimpleProjection', '$search mode', { mode: searchMode, backend: searchBackend.kind, chain: searchBackend.chain });
    if (searchTree && searchMode === 'none')
        log.info('handleSimpleProjection', '$search is not supported for this backend (SOAP): ignored', { entity: entityDef.name, chain: searchBackend.chain });
    const hasSearch = !!searchTree && searchMode !== 'none'; // blank / operator-only terms search nothing
    const searchInfo = hasSearch ? (0, search_1.getSearchColumnInfo)(entityDef, cache) : [];
    const searchColumns = searchInfo.map((c) => c.name);
    const unusedSearchNames = hasSearch ? (0, search_1.explicitSearchNames)(entityDef).filter((n) => !searchColumns.includes(n)) : [];
    if (unusedSearchNames.length > 0) {
        log.warn('handleSimpleProjection', '@cds.search lists names that are not searched: not an element of this entity, not a string, or @cds.search: false', {
            entity: entityDef.name, names: unusedSearchNames, searched: searchColumns,
        });
    }
    const searchCalcAliases = new Set(searchInfo.filter((c) => c.kind === 'calc').map((c) => c.name));
    const searchPaths = hasSearch && !isDistinctProjection && !isGroupByProjection
        ? searchColumns
            .map((c) => columnPlan.paths.get(c))
            .filter((p) => !!p && p.kind === 'toOne' && !requestedPaths.some((r) => r.alias === p.alias))
        : [];
    // Calculated columns reading association paths (`coalesce(_A.X, 0)`): their hidden path elements are
    // resolved together with the path columns, then the expression is evaluated again (see step 4).
    const calcPathColumns = isDistinctProjection || isGroupByProjection ? [] : (0, path_columns_1.requestedCalcPathColumns)(columnPlan, req.query?.SELECT, searchCalcAliases);
    const resolvedPaths = [...requestedPaths, ...searchPaths, ...calcPathColumns.flatMap((c) => c.paths)];
    const pathJoinKeys = resolvedPaths.length > 0 ? (0, path_resolution_1.pathJoinKeyNames)(columnPlan, resolvedPaths, cache) : [];
    log.debug('handleSimpleProjection', 'Request shape', {
        hasExplicitSelect,
        expandCount: expandTree.length,
        isDistinct: isDistinctProjection,
        isGroupBy: isGroupByProjection,
        wantsCount: !!req.query?.SELECT?.count,
        hasSkipPagination: hasSkipPaginationFlag
    });
    const originalWhere = req.query?.SELECT?.where ? (0, utils_1.deepClone)(req.query.SELECT.where) : undefined;
    const originalOrderBy = req.query?.SELECT?.orderBy ? (0, utils_1.deepClone)(req.query.SELECT.orderBy) : undefined;
    const originalLimit = req.query?.SELECT?.limit;
    // -----------------------------------------------------------------
    // STEP 1: hybrid WHERE split
    // -----------------------------------------------------------------
    log.debug('handleSimpleProjection', 'STEP 1 · Split WHERE');
    const { remoteWhere, localWhere } = (0, where_split_1.splitWhereClause)(originalWhere, entityDef, localToRemote, log, isTargetSrvSoap);
    let postFilterWhere = localWhere;
    // A local filter (in-memory WHERE part, `$search`) needs every row the backend has: no remote $top / count,
    // the count is taken and the page cut afterwards.
    const hasLocalFilter = !!localWhere || hasSearch;
    log.info('handleSimpleProjection', 'STEP 1 result', {
        hasRemoteWhere: !!(remoteWhere && remoteWhere.length),
        hasLocalWhere: !!(localWhere && localWhere.length),
    });
    // -----------------------------------------------------------------
    // STEP 2: build remote SELECT
    // -----------------------------------------------------------------
    log.debug('handleSimpleProjection', 'STEP 2 · Build remote SELECT');
    const cleanSelect = {
        from: (0, cqn_utils_1.retargetFromNode)(req.query.SELECT?.from, queryEntityName),
    };
    // Path elements and in-memory calculated elements are not fields of the source entity: never request them from it.
    const computedAliases = isDistinctProjection || isGroupByProjection ? new Set() : (0, calc_dependencies_1.getComputedAliases)(entityDef);
    const skipAliases = columnPlan.paths.size > 0 || computedAliases.size > 0 ? new Set([...columnPlan.paths.keys(), ...computedAliases]) : undefined;
    if (!hasExplicitSelect) {
        cleanSelect.columns = queryLocalTarget
            ? (0, column_builders_1.buildDefaultLocalColumns)(entityDef, skipAliases)
            : (0, column_builders_1.buildDefaultRemoteColumns)(entityDef, localToRemote, skipAliases);
    }
    else {
        cleanSelect.columns = queryLocalTarget
            ? (0, column_builders_1.buildSelectedLocalColumns)(entityDef, { name: '', columns: incomingColumns }, [], skipAliases)
            : (0, column_builders_1.buildSelectedRemoteColumns)(entityDef, { name: '', columns: incomingColumns }, { localToRemote, remoteToLocal }, [], skipAliases);
    }
    if (expandTree.length > 0) {
        cleanSelect.columns = queryLocalTarget
            ? (0, column_builders_1.buildLocalColumnsWithExpands)(entityDef, expandTree, incomingColumns, cache, skipAliases, cds_1.default.model.definitions[targetEntity])
            : (0, column_builders_1.buildColumnsWithExpands)(entityDef, expandTree, localToRemote, incomingColumns, cache, skipAliases);
    }
    const fromHead = req.query?.SELECT?.from?.ref?.[0];
    const isKeyRead = !!(fromHead && typeof fromHead === 'object' && fromHead.where);
    // Backends ignore `$filter` on a by-key URL and return the entity anyway, so a WHERE on a key read
    // (e.g. an instance-based `@restrict ... where`) is never applied by the backend. It is therefore
    // evaluated again in memory (STEP 4b), which needs the fields it refers to even if not selected.
    const keyReadRecheckWhere = isKeyRead && originalWhere && !isDistinctProjection && !isGroupByProjection ? originalWhere : undefined;
    const recheckFields = keyReadRecheckWhere
        ? [...(0, column_builders_1.extractReferencedFields)(keyReadRecheckWhere)]
            .filter((n) => {
            const el = entityDef.elements?.[n];
            return el && !(0, alias_maps_1.isAssociationElement)(el) && !el.virtual && !el.$calc && !el.value && !skipAliases?.has(n);
        })
            .map((n) => (queryLocalTarget ? n : localToRemote[n]))
        : [];
    const searchSourceFields = searchInfo
        .filter((c) => c.kind === 'plain')
        .map((c) => c.name)
        .filter((n) => queryLocalTarget || localToRemote[n])
        .map((n) => (queryLocalTarget ? n : localToRemote[n]));
    // Fields of the source that must be fetched although the projection does not expose them:
    // first-hop join keys of path columns and dependencies of calculated columns.
    // A `$select` naming only such elements would otherwise fall back to `*`: fetch just those fields.
    const sourceExtras = [...pathJoinKeys, ...recheckFields, ...searchSourceFields, ...(computedAliases.size > 0 ? (0, calc_dependencies_1.calcSourceDependencies)(entityDef, req.query?.SELECT, searchCalcAliases) : [])];
    if (skipAliases && hasExplicitSelect && expandTree.length === 0) {
        const scalar = incomingColumns.filter((c) => c?.ref && !c.expand).map((c) => c.ref[0]);
        if (scalar.length > 0 && scalar.every((n) => skipAliases.has(n)))
            cleanSelect.columns = [];
    }
    if (sourceExtras.length > 0)
        cleanSelect.columns = (0, calc_dependencies_1.withSourceColumns)(cleanSelect.columns, sourceExtras);
    if (Array.isArray(cleanSelect.columns) && cleanSelect.columns.length === 0)
        cleanSelect.columns = ['*'];
    if (remoteWhere && remoteWhere.length > 0)
        cleanSelect.where = remoteWhere;
    // A read by key (`Entity('K1')`, key in the FROM node) addresses ONE entity: OData V2 backends reject
    // `$top`/`$skip`/`$orderby`/`$inlinecount` on such a URL, so none of them is forwarded. The count is then
    // simply the number of rows returned (see below).
    if (isKeyRead && originalLimit) {
        log.debug('handleSimpleProjection', 'Read by key — not forwarding limit to the backend', { originalLimit });
    }
    else if (isGroupByProjection && originalLimit) {
        // For GROUP BY projections the remote query must return ALL rows so the
        // in-memory aggregation (applyGroupBy) can produce the correct group set.
        // Passing the OData page limit to the remote service would silently
        // truncate the raw rows and drop groups whose members fall outside the
        // page window. The limit is applied after aggregation, not before.
        log.info('handleSimpleProjection', 'Dropping remote $top for GROUP BY — aggregation needs all rows', { originalLimit });
    }
    else if (!hasLocalFilter && originalLimit) {
        cleanSelect.limit = originalLimit;
    }
    else if (hasLocalFilter && originalLimit) {
        log.info('handleSimpleProjection', 'Dropping remote $top — local filter will slice in-memory', { originalLimit, search: hasSearch });
    }
    if (req.query.SELECT?.count && !hasLocalFilter && !isKeyRead)
        cleanSelect.count = true;
    const remoteQuery = { SELECT: cleanSelect };
    if (isGroupByProjection) {
        (0, aggregation_1.injectAggregationSourceFields)(entityDef, remoteQuery, localToRemote);
        // Signal to _base/_evaluateODataInMemory that this is a GROUP BY sub-fetch:
        // all raw rows must be returned untruncated so in-memory aggregation
        // (applyGroupBy) can produce the correct groups and counts.
        // CAP strips `groupBy` from the CQN before dispatching to SOAP, so the
        // existing `selectAst.groupBy` bypass in _base never fires — this sentinel
        // is the reliable alternative.
        if (isTargetSrvSoap) {
            cleanSelect.__skipPagination = true;
        }
    }
    // Propagate the __skipPagination sentinel from the incoming request to the
    // outbound SOAP query. This handles the expand sub-fetch path where
    // fetchAssociatedRecords sets __skipPagination on the query it passes to
    // a local CAP service (e.g. UserDataService), which then dispatches here.
    // Without propagation, the SOAP-level QueryHitsMaximumNumberValue cap would
    // silently truncate role rows for large multi-user expand fetches.
    if (hasSkipPaginationFlag && isTargetSrvSoap) {
        cleanSelect.__skipPagination = true;
    }
    if (cleanSelect.where && !queryLocalTarget) {
        (0, cqn_rewriter_1.rewriteQueryCqn)(remoteQuery, localToRemote, cache, entityDef);
    }
    // `$search` push-down (search-pushdown.ts): narrows what the backend returns. STEP 4a still matches every
    // returned row locally and has the final say, so a filter that is too wide is harmless and one that fails
    // is retried without (STEP 3). Added AFTER the rewrite: it is already in the names the query uses.
    let searchWheres; // alternatives whose rows are unioned (several when a key list is too long for one URL)
    let searchPushed = false;
    const planSearchPush = () => (0, search_pushdown_1.buildSearchPushdown)({
        req, tree: searchTree, columns: searchInfo, entityDef, plan: columnPlan, cache, log,
        queryLocalTarget, localToRemote, mode: searchMode,
    });
    if (hasSearch && searchTree && !isKeyRead && !isTargetSrvSoap && !isDistinctProjection && !isGroupByProjection && !entityDef['@response.data']) {
        const push = await planSearchPush();
        if (push.none) {
            log.info('handleSimpleProjection', 'EXIT ($search can not match any row: backend not called)', { elapsedMs: Date.now() - t0 });
            const empty = [];
            if (req.query.SELECT?.count)
                empty.$count = 0;
            return empty;
        }
        if (push.wheres) {
            searchWheres = push.wheres;
            searchPushed = true;
        }
        log.info('handleSimpleProjection', push.wheres ? '$search pushed to the backend' : '$search not pushed', { reason: push.reason, queries: push.wheres?.length });
    }
    log.debug('handleSimpleProjection', 'Final remote query built', {
        target: targetEntityName,
        columnCount: cleanSelect.columns.length,
        hasWhere: !!cleanSelect.where,
        limit: cleanSelect.limit,
        count: cleanSelect.count,
    });
    // A search that is not (or no longer) pushed reads the entity unfiltered and matches locally. Bounded: an entity with
    // more than SEARCH_LOCAL_MAX_ROWS rows fails clearly instead of an unbounded read (time-out, response too large).
    // Group-by / distinct projections aggregate over all rows and are not bounded.
    const boundedSearchRead = hasSearch && !isKeyRead && !isTargetSrvSoap && !isDistinctProjection && !isGroupByProjection
        && !entityDef['@response.data'];
    let pushFailure; // why the pushed search failed, for the message below
    const runUnpushed = async () => {
        if (!boundedSearchRead)
            return targetSrv.run(remoteQuery);
        const rows = await targetSrv.run({ SELECT: { ...cleanSelect, limit: { rows: { val: search_1.SEARCH_LOCAL_MAX_ROWS + 1 } }, count: true } });
        const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
        const total = typeof rows?.$count === 'number' ? rows.$count : list.length;
        if (list.length > search_1.SEARCH_LOCAL_MAX_ROWS || total > search_1.SEARCH_LOCAL_MAX_ROWS || list.length < total) {
            throw Object.assign(new Error(`$search could not be pushed to the backend and '${entityDef.name}' has more than ${search_1.SEARCH_LOCAL_MAX_ROWS} rows: narrow it down with $filter`
                + (pushFailure ? ` (the backend said: ${pushFailure})` : '')), { code: 502, status: 502, statusCode: 502, searchTooLarge: true });
        }
        return list;
    };
    // The pushed search: one query per alternative (each ANDed onto the WHERE the query already has), rows unioned by key.
    const runSearchPushed = async () => {
        const keyNames = Object.entries(columnPlan.sourceDef?.elements ?? {}).filter(([, el]) => el?.key).map(([n]) => n);
        const identity = (r) => {
            const key = keyNames.map((k) => r?.[k]);
            return keyNames.length > 0 && key.every((v) => v !== undefined) ? JSON.stringify(key) : JSON.stringify(r);
        };
        const parts = await Promise.all(searchWheres.map((w) => targetSrv.run({ SELECT: { ...cleanSelect, where: (0, search_pushdown_1.andWhere)(cleanSelect.where, w) } })));
        const merged = [];
        const seen = new Set();
        for (const part of parts) {
            for (const row of Array.isArray(part) ? part : [part]) {
                if (!row)
                    continue;
                const id = identity(row);
                if (seen.has(id))
                    continue;
                seen.add(id);
                merged.push(row);
            }
        }
        return merged;
    };
    // -----------------------------------------------------------------
    // STEP 3: execute
    // -----------------------------------------------------------------
    log.info('handleSimpleProjection', 'STEP 3 · Execute remote query', { target: `${targetSrvName}.${targetEntityName}` });
    let results;
    const tExec = Date.now();
    try {
        if (isTargetSrvSoap) {
            log.info('handleSimpleProjection', 'Dispatching SOAP read', { service: targetSrvName, entity: targetEntityName });
            // Pass `remoteQuery` (not `req.query`) so the cleaned query reaches the SOAP
            // adapter — this carries the rewritten WHERE, the correct columns, and
            // critically NO limit for GROUP BY projections (where the full row set is
            // needed before in-memory aggregation runs).
            results = await (0, soap_adapter_1.runSoapRead)(targetSrv, targetEntityName, req, remoteQuery, entityDef, log, outerReq);
            if (results && !Array.isArray(results))
                results = [results];
        }
        else if (entityDef['@response.data']) {
            log.debug('handleSimpleProjection', 'Using @response.data (no remote call)');
            results = entityDef['@response.data'];
        }
        else {
            log.debug('handleSimpleProjection', 'Dispatching OData/DB read', { service: targetSrvName });
            log.debug('handleSimpleProjection', 'Dispatching OData/DB read', { query: remoteQuery });
            for (let replans = 0;; replans++) {
                try {
                    results = searchPushed ? await runSearchPushed() : await runUnpushed();
                    break;
                }
                catch (err) {
                    if (!searchPushed)
                        throw err;
                    // the backend can not evaluate tolower: this service searches case-sensitively from now on
                    const fn = (0, search_functions_1.rejectedFunction)(err);
                    if (replans < 8 && fn === 'tolower' && searchMode === 'insensitive' && searchBackend
                        && (0, search_functions_1.learnUnsupportedFunction)(searchBackend.service, 'tolower')) {
                        searchMode = (0, search_backend_1.effectiveSearchMode)(searchBackend);
                        log.info('handleSimpleProjection', 'Backend does not support tolower: searching case-sensitively', { error: err?.message });
                        const push = await planSearchPush();
                        if (push.none) {
                            results = [];
                            break;
                        }
                        searchWheres = push.wheres;
                        searchPushed = !!push.wheres;
                        continue;
                    }
                    log.warn('handleSimpleProjection', 'Backend rejected the pushed $search filter — retrying without it', { error: err?.message });
                    pushFailure = String(err?.message ?? err).slice(0, 300);
                    searchPushed = false;
                    results = await runUnpushed();
                    break;
                }
            }
        }
        log.info('handleSimpleProjection', 'STEP 3 done', {
            elapsedMs: Date.now() - tExec,
            rows: Array.isArray(results) ? results.length : (results ? 1 : 0),
        });
    }
    catch (err) {
        // our own "too many rows to search locally" error mentions $filter: it must not be taken for a rejected filter
        // (the older fallback below would read the whole entity unbounded)
        if (err?.searchTooLarge)
            throw err;
        const isAssocPath = (0, cqn_utils_1.isAssociationPathRemoteError)(err, entityDef);
        const isFilter400 = String(err?.message).includes('filter') || String(err?.code).includes('400');
        if (!isAssocPath && !isFilter400) {
            log.error('handleSimpleProjection', 'Remote read failed (unrecoverable)', {
                error: { message: err?.message, code: err?.code },
            });
            throw err;
        }
        log.warn('handleSimpleProjection', 'Remote filter rejected — falling back to 100% in-memory filter', {
            error: err?.message,
            reason: isAssocPath ? 'association-path' : 'filter-400',
        });
        postFilterWhere = originalWhere;
        delete remoteQuery.SELECT.where;
        delete remoteQuery.SELECT.limit;
        results = await targetSrv.run(remoteQuery);
        log.info('handleSimpleProjection', 'STEP 3 fallback done', {
            rows: Array.isArray(results) ? results.length : (results ? 1 : 0),
        });
    }
    if (!results || (Array.isArray(results) && results.length === 0)) {
        log.info('handleSimpleProjection', 'EXIT (empty result)', { elapsedMs: Date.now() - t0 });
        if (req.query.SELECT?.count) {
            const empty = [];
            empty.$count = 0;
            return empty;
        }
        return results;
    }
    const isArray = Array.isArray(results);
    let records = isArray ? results : [results];
    if (pathJoinKeys.length > 0)
        records = (0, path_resolution_1.stashPathJoinKeys)(records, pathJoinKeys, remoteToLocal);
    if (isDistinctProjection) {
        log.debug('handleSimpleProjection', 'Applying DISTINCT', { before: records.length });
        records = (0, aggregation_1.applyDistinct)(entityDef, records, localToRemote);
        log.debug('handleSimpleProjection', 'DISTINCT applied', { after: records.length });
    }
    if (isGroupByProjection && records.length > 0) {
        log.debug('handleSimpleProjection', 'Applying GROUP BY', { before: records.length });
        records = (0, aggregation_1.applyGroupBy)(entityDef, records, localToRemote);
        log.debug('handleSimpleProjection', 'GROUP BY applied', { after: records.length });
    }
    let remoteCount;
    if (req.query.SELECT?.count && !hasLocalFilter) {
        if (isGroupByProjection) {
            // For GROUP BY, count = number of groups (after aggregation), not raw rows.
            remoteCount = records.length;
        }
        else {
            remoteCount = results.$count;
            if (isDistinctProjection || remoteCount === undefined)
                remoteCount = records.length;
        }
    }
    // -----------------------------------------------------------------
    // STEP 4: map remote → local
    // -----------------------------------------------------------------
    log.debug('handleSimpleProjection', 'STEP 4 · Map remote → local', { rows: records.length });
    records = records.map((r) => (0, record_mapping_1.mapRemoteRecordToLocal)(entityDef, r, remoteToLocal, cache));
    if (keyReadRecheckWhere) {
        const before = records.length;
        records = records.filter((r) => (0, where_eval_1.evaluateWhereOnRecord)(keyReadRecheckWhere, r));
        log.info('handleSimpleProjection', 'STEP 4b · WHERE re-checked on key read', { before, after: records.length });
        // The entity exists but does not satisfy the WHERE (e.g. `@restrict`): same answer as "not found".
        if (before > 0 && records.length === 0) {
            throw Object.assign(new Error(`Entity '${entityDef.name}' not found`), { code: 404, status: 404, statusCode: 404 });
        }
    }
    if (resolvedPaths.length > 0) {
        log.info('handleSimpleProjection', 'Resolving association-path columns', {
            paths: requestedPaths.map((p) => p.alias),
            calculated: calcPathColumns.map((c) => c.alias),
        });
        await (0, path_resolution_1.resolvePathColumns)(req, columnPlan, resolvedPaths, records, cache, log);
        (0, path_resolution_1.applyCalcPathColumns)(records, calcPathColumns);
        // path values are added last: restore the CDS definition order of the fields
        for (const row of records)
            (0, record_mapping_1.orderRowLikeDefinition)(entityDef, row);
    }
    // STEP 4a: `$search`. Before $expand (fewer parents to expand) and before pruning to the requested shape
    // (the searched columns need not be selected).
    if (hasSearch) {
        const before = records.length;
        const matchColumns = searchInfo.map((c) => c.name);
        if (matchColumns.length === 0)
            log.warn('handleSimpleProjection', 'No searchable columns: nothing can match', { entity: entityDef.name });
        if (before > search_1.SEARCH_WARN_ROWS)
            log.warn('handleSimpleProjection', 'Large in-memory search', { entity: entityDef.name, rows: before });
        records = (0, search_1.applySearch)(records, searchTerm, matchColumns, { ignoreCase: searchMode === 'insensitive' });
        log.info('handleSimpleProjection', 'STEP 4a · $search applied', { term: searchTerm, mode: searchMode, columns: matchColumns.length, before, after: records.length });
        if (req.query.SELECT?.count)
            remoteCount = records.length;
    }
    if (expandTree.length > 0) {
        log.info('handleSimpleProjection', 'Resolving $expand tree', {
            expands: expandTree.map((e) => e.as || e.name),
            parentRows: records.length,
        });
        records = await (0, expand_materializer_1.resolveExpandNodes)(req, entityDef, records, expandTree, cache, log);
        (0, record_mapping_1.normalizeExpandedAssociationNames)(entityDef, records, expandTree, cache);
    }
    if (incomingColumns.length > 0)
        (0, record_mapping_1.pruneRecordsToRequestedShape)(entityDef, records, incomingColumns);
    // -----------------------------------------------------------------
    // STEP 5: in-memory post-processing
    // -----------------------------------------------------------------
    if (postFilterWhere) {
        const before = records.length;
        records = records.filter((r) => (0, where_eval_1.evaluateWhereOnRecord)(postFilterWhere, r));
        log.info('handleSimpleProjection', 'STEP 5a · In-memory filter applied', { before, after: records.length });
        if (req.query.SELECT?.count)
            remoteCount = records.length;
    }
    if (originalOrderBy && records.length > 0) {
        log.debug('handleSimpleProjection', 'STEP 5b · In-memory sort', { rows: records.length });
        records = (0, cqn_utils_2.applyInMemorySort)(records, originalOrderBy);
    }
    if (hasLocalFilter && originalLimit) {
        const rows = originalLimit.rows?.val ?? originalLimit.rows;
        const offset = originalLimit.offset?.val ?? originalLimit.offset ?? 0;
        if (typeof rows === 'number') {
            log.debug('handleSimpleProjection', 'STEP 5c · In-memory slice', { offset, rows });
            records = records.slice(offset, offset + rows);
        }
    }
    for (const row of records)
        (0, record_mapping_1.enforceAssociationAliases)(entityDef, row, cache);
    if (remoteCount !== undefined)
        records.$count = remoteCount;
    log.info('handleSimpleProjection', 'EXIT', {
        elapsedMs: Date.now() - t0,
        rows: records.length,
        $count: remoteCount,
    });
    if (!isArray && records.length === 0)
        return {};
    return isArray ? records : records[0];
};
exports.handleSimpleProjection = handleSimpleProjection;
