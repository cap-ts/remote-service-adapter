"use strict";
/**
 * @file expand-materializer.ts
 * @description Turns a parsed `$expand` tree into materialised parent→child
 * associations. Handles pre-fetched (inline) children and missing children
 * (batched IN-clause fetch), plus SOAP dispatch when the target is a SOAP
 * service.
 *
 * ## Logging
 * Each expand node emits an `INFO` boundary log with parent-row count,
 * pre-fetched vs missing split, and batched-fetch timing. Fallbacks are
 * logged at `WARN`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveExpandNodes = exports.fetchAssociatedRecords = exports.buildAssociationJoinValues = exports.purgeRemoteAssociationKeys = exports.localSort = exports.sliceByLimit = exports.applyExpandModifiers = void 0;
const cds_1 = require("@sap/cds");
const utils_1 = require("./utils");
const alias_maps_1 = require("./alias-maps");
const association_meta_1 = require("./association-meta");
const column_builders_1 = require("./column-builders");
const cqn_rewriter_1 = require("./cqn-rewriter");
const join_parser_1 = require("./join-parser");
const record_mapping_1 = require("./record-mapping");
const service_resolver_1 = require("./service-resolver");
const soap_adapter_1 = require("./soap-adapter");
const where_eval_1 = require("./where-eval");
const where_split_1 = require("./where-split");
const { SELECT } = cds_1.default.ql;
const M = 'expand-materializer';
// ============================================================================
// thin helpers (no logging — trivial)
// ============================================================================
const applyExpandModifiers = (query, exp) => {
    if (exp.orderBy)
        query.orderBy(exp.orderBy);
    if (exp.limit) {
        const rows = exp.limit.rows?.val ?? exp.limit.rows;
        const offset = exp.limit.offset?.val ?? exp.limit.offset;
        query.limit(rows, offset);
    }
    if (exp.count)
        query.SELECT.count = true;
    if (exp.where)
        query.where(exp.where);
};
exports.applyExpandModifiers = applyExpandModifiers;
const sliceByLimit = (list, limit) => {
    const rows = limit.rows?.val ?? limit.rows;
    const offset = limit.offset?.val ?? limit.offset ?? 0;
    return list.slice(offset, offset + rows);
};
exports.sliceByLimit = sliceByLimit;
const localSort = (array, orderBySpec, aliasMaps) => {
    if (!Array.isArray(orderBySpec))
        return array;
    return [...array].sort((a, b) => {
        for (const order of orderBySpec) {
            const prop = order.ref ? order.ref[order.ref.length - 1] : order;
            const localKey = aliasMaps.remoteToLocal[prop] || prop;
            const dir = order.sort === 'desc' ? -1 : 1;
            const valA = a[localKey];
            const valB = b[localKey];
            if (valA == null)
                return 1 * dir;
            if (valB == null)
                return -1 * dir;
            if (valA < valB)
                return -1 * dir;
            if (valA > valB)
                return 1 * dir;
        }
        return 0;
    });
};
exports.localSort = localSort;
const purgeRemoteAssociationKeys = (records, localKeyName, candidates, protectedKeys) => {
    const remoteCandidates = candidates.filter((c) => !!c && c !== localKeyName && !protectedKeys.has(c));
    if (!remoteCandidates.length)
        return;
    for (const record of records) {
        if (!record)
            continue;
        for (const candidate of remoteCandidates) {
            if (Object.prototype.hasOwnProperty.call(record, candidate))
                delete record[candidate];
        }
    }
};
exports.purgeRemoteAssociationKeys = purgeRemoteAssociationKeys;
const buildAssociationJoinValues = (assocMeta, records) => {
    const { localKeys, targetKeys } = assocMeta;
    if (!localKeys?.length || !targetKeys?.length)
        return [];
    const seenKeys = new Set();
    const uniqueRecords = records.filter((record) => {
        const key = localKeys.map((k) => String(record[k] ?? '')).join('|||');
        if (seenKeys.has(key))
            return false;
        seenKeys.add(key);
        return true;
    });
    if (localKeys.length === 1) {
        const targetKeyName = targetKeys[0];
        const values = uniqueRecords.map((r) => r[localKeys[0]]).filter((v) => v !== undefined && v !== null && v !== '');
        if (values.length === 0)
            return [];
        if (values.length === 1)
            return [{ ref: [targetKeyName] }, '=', { val: values[0] }];
        return [{ ref: [targetKeyName] }, 'in', { list: values.map((v) => ({ val: v })) }];
    }
    const whereClause = [];
    uniqueRecords.forEach((record, index) => {
        const recordConditions = [];
        localKeys.forEach((localKey, keyIdx) => {
            const value = record[localKey] ?? '';
            recordConditions.push({ ref: [targetKeys[keyIdx]] }, '=', { val: value });
            if (keyIdx < localKeys.length - 1)
                recordConditions.push('and');
        });
        if (index > 0)
            whereClause.push('or');
        whereClause.push('(', ...recordConditions, ')');
    });
    return whereClause;
};
exports.buildAssociationJoinValues = buildAssociationJoinValues;
// ============================================================================
// Fetch pipeline (logged)
// ============================================================================
/**
 * Executes the target-side SELECT for a `$expand` and returns a `Map` keyed
 * on the parent join key. Handles SOAP separately and includes a fallback
 * that strips column / filter / order restrictions when the backend rejects
 * the query.
 */
const fetchAssociatedRecords = async (req, remoteSrv, assocMeta, targetQuery, whereCondition, aliasMaps, targetDef, cache, log, rewriteForRemote = true, outerReq) => {
    const result = new Map();
    if (!whereCondition?.length)
        return result;
    const select = targetQuery?.SELECT;
    const entityName = select?.from?.ref?.[0] || assocMeta.target.split('.').pop() || assocMeta.target;
    const q = SELECT.from(entityName);
    if (select?.columns)
        q.columns(JSON.parse(JSON.stringify(select.columns)));
    if (select?.orderBy)
        q.orderBy(JSON.parse(JSON.stringify(select.orderBy)));
    if (select?.limit) {
        const rows = select.limit.rows?.val ?? select.limit.rows;
        const offset = select.limit.offset?.val ?? select.limit.offset;
        q.limit(rows, offset);
    }
    if (select?.count)
        q.SELECT.count = true;
    // For SOAP services, split the expand $filter into predicates the SOAP
    // adapter can push down (simple equality) vs. those it cannot (function
    // calls like contains(), startswith(), etc.).  Only the pushable part is
    // sent to SOAP; the rest is applied in-memory after the fetch.
    const isSoap = (0, soap_adapter_1.isSoapService)(remoteSrv.name);
    let inMemoryExpandFilter;
    const { remoteWhere: expandRemoteWhere, localWhere: expandLocalWhere } = isSoap && select?.where
        ? (0, where_split_1.splitWhereClause)(select.where, targetDef, aliasMaps.localToRemote, log, true)
        : { remoteWhere: select?.where, localWhere: undefined };
    if (isSoap && expandLocalWhere) {
        inMemoryExpandFilter = expandLocalWhere;
        log.debug('fetchAssociatedRecords', 'Expand $filter split — local-only predicates deferred to in-memory', {
            target: assocMeta.target,
            localWhere: JSON.stringify(expandLocalWhere),
        });
    }
    const finalWhere = whereCondition.length > 3 ? ['(', ...whereCondition, ')'] : [...whereCondition];
    for (const filter of assocMeta.constantFilters || []) {
        for (const [key, val] of Object.entries(filter)) {
            if (finalWhere.length > 0)
                finalWhere.push('and');
            finalWhere.push({ ref: [key] }, '=', { val });
        }
    }
    const effectiveRemoteWhere = isSoap ? expandRemoteWhere : select?.where;
    if (effectiveRemoteWhere) {
        if (finalWhere.length > 0)
            finalWhere.push('and');
        if (Array.isArray(effectiveRemoteWhere))
            finalWhere.push('(', ...effectiveRemoteWhere, ')');
        else
            finalWhere.push(effectiveRemoteWhere);
    }
    if (finalWhere.length > 0)
        q.where(finalWhere);
    const queryToRun = rewriteForRemote ? (0, cqn_rewriter_1.sanitizeAndRewriteQuery)(q, targetDef, aliasMaps) : q;
    const tExec = Date.now();
    log.debug('fetchAssociatedRecords', 'ENTER', {
        target: assocMeta.target,
        entity: entityName,
        parentKeyCount: whereCondition.length,
        soap: isSoap,
    });
    let rows;
    log.debug('fetchAssociatedRecords', 'Before dispatch', { target: assocMeta.target, entity: entityName, remoteSrv: remoteSrv.name });
    if (isSoap) {
        log.debug('fetchAssociatedRecords', 'SOAP dispatch');
        // Expand fetches need ALL matching rows so the materializer can distribute
        // them across parent records. The default 1000-row page in _base would
        // silently truncate a large association (e.g. 637 roles for one BP when
        // earlier BPs already consumed most of the page window). Signal _base to
        // skip pagination for this internal sub-fetch.
        if (queryToRun?.SELECT)
            queryToRun.SELECT.__skipPagination = true;
        rows = await (0, soap_adapter_1.runSoapRead)(remoteSrv, entityName, req, queryToRun, targetDef, log, outerReq ?? req);
    }
    else {
        // For non-SOAP expand sub-fetches (e.g. UserDataService.BusinessUserRoleSet),
        // the dispatch goes through a local CAP service which then calls SOAP internally.
        // Set __skipPagination on the query so handleSimpleProjection propagates it
        // to the outbound SOAP query, bypassing the SOAP-level row cap.
        // Only services that understand the hint get it: others (e.g. BillingDataService, implemented through
        // esi.impl.RemoteService) reject a SELECT with an unknown property ("Feature not supported: SELECT
        // statement with .__skipPagination"), which made every read through such an association fail.
        if (queryToRun?.SELECT && remoteSrv?.supportsSkipPagination)
            queryToRun.SELECT.__skipPagination = true;
        // Use remoteSrv.tx(req) so user/tenant context is propagated.
        // Also pass outerReq (the original top-level HTTP request) so that
        // any nested SOAP dispatch inside _handleDynamicRead can source the
        // full HTTP headers (authorization etc.) from it.
        const tx = remoteSrv.tx(req);
        try {
            log.debug('fetchAssociatedRecords', 'Backend dispatch (tx)');
            rows = await tx.run(queryToRun);
        }
        catch (err) {
            log.warn('fetchAssociatedRecords', 'Backend rejected expand query — retrying without columns/filters', {
                target: assocMeta.target,
                error: err?.message,
            });
            delete queryToRun.SELECT.columns;
            delete queryToRun.SELECT.where;
            delete queryToRun.SELECT.orderBy;
            if (whereCondition?.length)
                queryToRun.where(whereCondition);
            rows = await tx.run(queryToRun);
        }
    }
    const list = Array.isArray(rows) ? rows : [rows];
    for (const row of list) {
        if (!row)
            continue;
        const mapped = (0, record_mapping_1.mapRemoteRecordToLocal)(targetDef, row, aliasMaps.remoteToLocal, cache);
        const key = (0, join_parser_1.buildChildJoinKey)(mapped, assocMeta.targetKeys);
        // Diagnostic: log raw row keys, mapped keys, and the computed child join key
        log.trace('fetchAssociatedRecords', 'Child key diagnostic', {
            targetKeys: assocMeta.targetKeys,
            rawRowKeys: Object.keys(row),
            mappedRowKeys: Object.keys(mapped),
            targetKeyValues: assocMeta.targetKeys.reduce((acc, k) => { acc[k] = mapped[k]; return acc; }, {}),
            childJoinKey: key,
        });
        if (assocMeta.isToMany) {
            const arr = result.get(key) || [];
            arr.push(mapped);
            result.set(key, arr);
        }
        else {
            result.set(key, mapped);
        }
    }
    // Apply any expand $filter predicates that SOAP could not push down
    // (e.g. contains(), startswith()) in-memory on the mapped results.
    if (inMemoryExpandFilter) {
        let filtered = 0;
        for (const [key, children] of result.entries()) {
            if (Array.isArray(children)) {
                const before = children.length;
                const kept = children.filter((child) => (0, where_eval_1.evaluateWhereOnRecord)(inMemoryExpandFilter, child));
                result.set(key, kept);
                filtered += before - kept.length;
            }
            else if (children && !(0, where_eval_1.evaluateWhereOnRecord)(inMemoryExpandFilter, children)) {
                result.delete(key);
                filtered++;
            }
        }
        log.debug('fetchAssociatedRecords', 'In-memory expand filter applied', {
            target: assocMeta.target,
            removedRows: filtered,
        });
    }
    log.info('fetchAssociatedRecords', 'EXIT', {
        target: assocMeta.target,
        elapsedMs: Date.now() - tExec,
        childRows: list.length,
        keyedGroups: result.size,
    });
    return result;
};
exports.fetchAssociatedRecords = fetchAssociatedRecords;
const attachPreFetchedChildren = async (req, parents, localKeyName, exp, assocMeta, targetDef, targetAliasMaps, targetExpandTree, cache, log) => {
    log.debug('attachPreFetchedChildren', 'ENTER', {
        assoc: assocMeta.name,
        parents: parents.length,
    });
    for (const parent of parents) {
        const preFetched = parent[localKeyName];
        if (!preFetched)
            continue;
        let childGroup = (Array.isArray(preFetched) ? preFetched : [preFetched]).map((child) => (0, record_mapping_1.mapRemoteRecordToLocal)(targetDef, child, targetAliasMaps.remoteToLocal, cache));
        // Apply $filter from the expand clause (e.g. $expand=_RoleSet($filter=contains(BusinessRoleID,'_BILLING_CLERK')))
        if (exp.where) {
            childGroup = childGroup.filter((child) => (0, where_eval_1.evaluateWhereOnRecord)(exp.where, child));
        }
        // Apply $top/$skip from the expand clause
        if (exp.limit) {
            childGroup = (0, exports.sliceByLimit)(childGroup, exp.limit);
        }
        if (targetExpandTree.length > 0) {
            childGroup = await (0, exports.resolveExpandNodes)(req, targetDef, childGroup, targetExpandTree, cache, log);
        }
        parent[localKeyName] = assocMeta.isToMany ? childGroup : childGroup[0];
    }
    log.debug('attachPreFetchedChildren', 'EXIT');
};
const attachMissingChildren = async (req, entityDef, parents, exp, localKeyName, assocMeta, targetDef, targetAliasMaps, targetExpandTree, cache, log) => {
    log.debug('attachMissingChildren', 'ENTER', {
        assoc: assocMeta.name,
        parents: parents.length,
        target: assocMeta.target,
    });
    const whereCondition = (0, exports.buildAssociationJoinValues)(assocMeta, parents);
    if (!whereCondition.length) {
        log.info('attachMissingChildren', 'No parent keys — setting empty children', { assoc: assocMeta.name });
        for (const parent of parents)
            parent[localKeyName] = assocMeta.isToMany ? [] : null;
        return;
    }
    const targetServiceName = (0, service_resolver_1.resolveServiceNameFromTarget)(assocMeta.target);
    const queryLocalProjection = (0, service_resolver_1.usesLocalServiceSemantics)(targetServiceName);
    const selectCols = queryLocalProjection
        ? (0, column_builders_1.buildSelectedLocalColumns)(targetDef, exp, assocMeta.targetKeys)
        : (0, column_builders_1.buildSelectedRemoteColumns)(targetDef, exp, targetAliasMaps, assocMeta.targetKeys);
    const targetQueryEntity = queryLocalProjection && targetServiceName !== req.service?.name
        ? assocMeta.target
        : (assocMeta.target.split('.').pop() || assocMeta.target);
    const targetQuery = SELECT.from(targetQueryEntity).columns(selectCols);
    (0, exports.applyExpandModifiers)(targetQuery, exp);
    const remoteSrv = await cds_1.default.connect.to(targetServiceName);
    const childRecordsByParent = await (0, exports.fetchAssociatedRecords)(req, remoteSrv, assocMeta, targetQuery, whereCondition, targetAliasMaps, targetDef, cache, log, !queryLocalProjection);
    let matched = 0;
    let unmatched = 0;
    for (const parent of parents) {
        const key = (0, join_parser_1.buildParentJoinKey)(parent, assocMeta.localKeys);
        // Diagnostic: log parent key fields and computed join key
        log.debug('attachMissingChildren', 'Parent key diagnostic', {
            localKeys: assocMeta.localKeys,
            parentKeys: Object.keys(parent),
            localKeyValues: assocMeta.localKeys.reduce((acc, k) => { acc[k] = parent[k]; return acc; }, {}),
            parentJoinKey: key,
            availableChildKeys: [...childRecordsByParent.keys()],
        });
        const rawChildren = childRecordsByParent.get(key);
        if (!rawChildren) {
            parent[localKeyName] = assocMeta.isToMany ? [] : null;
            unmatched++;
            continue;
        }
        matched++;
        if (assocMeta.isToMany) {
            let childGroup = rawChildren;
            if (exp.orderBy && childGroup.length > 1)
                childGroup = (0, exports.localSort)(childGroup, exp.orderBy, targetAliasMaps);
            const originalCount = childGroup.length;
            if (exp.limit)
                childGroup = (0, exports.sliceByLimit)(childGroup, exp.limit);
            parent[localKeyName] = await (0, exports.resolveExpandNodes)(req, targetDef, childGroup, targetExpandTree, cache, log);
            if (exp.count)
                parent[localKeyName].$count = originalCount;
        }
        else {
            const single = Array.isArray(rawChildren) ? rawChildren[0] : rawChildren;
            const resolvedChildren = await (0, exports.resolveExpandNodes)(req, targetDef, [single], targetExpandTree, cache, log);
            parent[localKeyName] = resolvedChildren[0];
        }
    }
    log.info('attachMissingChildren', 'EXIT', {
        assoc: assocMeta.name,
        matched,
        unmatched,
    });
};
/**
 * Materialises a `$expand` tree against a set of parent records.
 */
const resolveExpandNodes = async (req, entityDef, records, expandTree, cache, parentLog) => {
    if (!records?.length || !expandTree?.length)
        return records;
    const log = parentLog.module === M ? parentLog : parentLog.forModule(M);
    log.info('resolveExpandNodes', 'ENTER', {
        entity: entityDef?.name,
        parents: records.length,
        expands: expandTree.map((e) => e.as || e.name),
    });
    const resolved = (0, utils_1.deepClone)(records);
    const sourceAliasMaps = (0, alias_maps_1.getAliasMaps)(entityDef, cache);
    const requestedExpandKeys = new Set(expandTree.map((e) => e.as || e.name));
    const seen = new Set();
    for (const exp of expandTree) {
        if (seen.has(exp.name))
            continue;
        seen.add(exp.name);
        const assocEl = entityDef?.elements?.[exp.name];
        if (!assocEl?.target) {
            log.warn('resolveExpandNodes', 'Skipping expand — no target on element', { expand: exp.name });
            continue;
        }
        const assocMeta = (0, association_meta_1.resolveAssociationMeta)(exp.name, entityDef, assocEl.target, assocEl, cache);
        if (!assocMeta) {
            log.warn('resolveExpandNodes', 'Skipping expand — could not resolve assoc meta', { expand: exp.name });
            continue;
        }
        const targetDef = cds_1.default.model.definitions[assocMeta.target];
        if (!targetDef) {
            log.warn('resolveExpandNodes', 'Skipping expand — target not in cds.model', { target: assocMeta.target });
            continue;
        }
        const targetExpandTree = (0, join_parser_1.parseExpandTree)(exp.columns || []);
        const targetAliasMaps = (0, alias_maps_1.getAliasMaps)(targetDef, cache);
        const localKeyName = exp.as || exp.name;
        const inferredRemoteKeyName = (0, alias_maps_1.findRemoteAssociationName)(entityDef, exp.name, cache, assocEl);
        const remoteKeyName = (assocMeta.originalName && assocMeta.originalName !== localKeyName ? assocMeta.originalName : undefined) ||
            inferredRemoteKeyName;
        const preFetchedRecords = [];
        const missingRecords = [];
        for (const record of resolved) {
            let foundKey = null;
            if (assocMeta.isManaged) {
                if (record[localKeyName] !== undefined)
                    foundKey = localKeyName;
                else if (remoteKeyName && record[remoteKeyName] !== undefined)
                    foundKey = remoteKeyName;
            }
            if (foundKey !== null) {
                record[localKeyName] = record[foundKey];
                if (foundKey !== localKeyName)
                    delete record[foundKey];
                preFetchedRecords.push(record);
            }
            else {
                missingRecords.push(record);
            }
        }
        log.debug('resolveExpandNodes', 'Partition', {
            expand: exp.name,
            preFetched: preFetchedRecords.length,
            missing: missingRecords.length,
            nestedExpands: targetExpandTree.length,
        });
        if (preFetchedRecords.length > 0) {
            await attachPreFetchedChildren(req, preFetchedRecords, localKeyName, exp, assocMeta, targetDef, targetAliasMaps, targetExpandTree, cache, log);
        }
        if (missingRecords.length > 0) {
            await attachMissingChildren(req, entityDef, missingRecords, exp, localKeyName, assocMeta, targetDef, targetAliasMaps, targetExpandTree, cache, log);
        }
        (0, exports.purgeRemoteAssociationKeys)(resolved, localKeyName, [
            remoteKeyName,
            assocMeta.originalName,
            inferredRemoteKeyName,
            assocEl.original,
            assocEl.value?.ref?.[assocEl.value?.ref?.[assocEl.value?.ref?.length - 1]],
            sourceAliasMaps.localToRemote[localKeyName]
        ], requestedExpandKeys);
    }
    log.info('resolveExpandNodes', 'EXIT', { entity: entityDef?.name, records: resolved.length });
    return resolved;
};
exports.resolveExpandNodes = resolveExpandNodes;
