"use strict";
/**
 * @file record-mapping.ts
 * @description Translates raw backend records into the local CAP shape and
 * evaluates any projection-level calculated columns. Also enforces
 * association naming so overlapping remote/local names never both survive
 * in the final response.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pruneRecordsToRequestedShape = exports.enforceAssociationAliases = exports.normalizeExpandedAssociationNames = exports.orderRowLikeDefinition = exports.mapRemoteRecordToLocal = exports.evaluateColumnExpression = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const association_meta_1 = require("./association-meta");
const where_eval_1 = require("./where-eval");
const join_parser_1 = require("./join-parser");
const case_expression_1 = require("./case-expression");
/**
 * Evaluates a projection column expression (calculated / function column)
 * against a mapped local record. Handles both `xpr` (expression) columns
 * and top-level function columns; adds a fast-path for `LEFT(...)`.
 *
 * @param col  CQN projection column.
 * @param row  Broad record used to resolve field refs.
 */
const evaluateColumnExpression = (col, row) => {
    if ((0, case_expression_1.isCaseExpression)(col.xpr))
        return (0, case_expression_1.evaluateCaseExpression)(col.xpr, row);
    if (col.xpr) {
        const funcNode = col.xpr.find((x) => x && typeof x === 'object' && x.func);
        if (funcNode)
            return (0, where_eval_1.evaluateFunctionOperand)(funcNode, row);
    }
    if (col.func) {
        if (col.func.toLowerCase() === 'left') {
            const strVal = String((0, where_eval_1.evaluateOperand)(col.args?.[0], row) ?? '');
            const lenVal = Number((0, where_eval_1.evaluateOperand)(col.args?.[1], row) ?? 0);
            return strVal.substring(0, lenVal);
        }
        return (0, where_eval_1.evaluateFunctionOperand)(col, row);
    }
    return undefined;
};
exports.evaluateColumnExpression = evaluateColumnExpression;
/**
 * Translates a raw remote record into the local shape: renames keys via
 * `remoteToLocal`, evaluates any projection-level calculated columns
 * (e.g. `LEFT(CompanyCode, 2) AS ShortCode`), and produces a stably-ordered
 * output object (modeled fields first, annotations last).
 *
 * @param entityDef      Local entity definition.
 * @param record         Raw remote record.
 * @param remoteToLocal  Alias map (remote → local).
 * @param cache          Per-service metadata cache.
 * @returns              Broad record.
 */
const mapRemoteRecordToLocal = (entityDef, record, remoteToLocal, cache) => {
    const elements = entityDef?.elements || {};
    const assocAliasByRemote = new Map(Object.entries((0, alias_maps_1.getAssociationAliasMaps)(entityDef, cache).remoteToLocal));
    const resolveLocalName = (remoteKey) => {
        const assocAlias = assocAliasByRemote.get(remoteKey);
        if (assocAlias)
            return assocAlias;
        if (remoteToLocal[remoteKey])
            return remoteToLocal[remoteKey];
        for (const [localName, el] of Object.entries(elements)) {
            const original = el?.original || el?.value?.ref?.[el?.value?.ref?.[el?.value?.ref?.length - 1]];
            if (original === remoteKey || localName === remoteKey)
                return localName;
        }
        return remoteKey;
    };
    const out = {};
    for (const key of Object.keys(record || {}))
        out[resolveLocalName(key)] = record[key];
    const AGGREGATE_FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max', 'count_distinct']);
    const projColumns = entityDef.projection?.columns || entityDef.query?.SELECT?.columns || [];
    for (const col of projColumns) {
        if (!col.as)
            continue;
        // Skip aggregate functions — their values are pre-computed by applyGroupBy
        // and must not be overwritten here (evaluateFunctionOperand does not handle them).
        if (col.func && AGGREGATE_FUNCS.has(String(col.func).toLowerCase()))
            continue;
        if (col.xpr || col.func)
            out[col.as] = (0, exports.evaluateColumnExpression)(col, out);
    }
    // Stable ordering: modeled non-association fields first, then everything else
    const ordered = {};
    for (const localKey of Object.keys(elements)) {
        if ((0, alias_maps_1.isAssociationElement)(elements[localKey]))
            continue;
        if (out[localKey] !== undefined)
            ordered[localKey] = out[localKey];
    }
    for (const [k, v] of Object.entries(out)) {
        if (ordered[k] !== undefined)
            continue;
        if (elements[k] !== undefined || k.startsWith('@') || k.startsWith('$'))
            ordered[k] = v;
    }
    return ordered;
};
exports.mapRemoteRecordToLocal = mapRemoteRecordToLocal;
/**
 * Re-orders a row IN PLACE so modeled non-association elements follow the
 * entity definition order (same convention as {@link mapRemoteRecordToLocal});
 * everything else (associations, `$`/`@` keys) keeps its relative order after
 * them. Needed after values are added late (association-path elements).
 *
 * @param entityDef  Entity definition whose element order applies.
 * @param row        Row to re-order.
 */
const orderRowLikeDefinition = (entityDef, row) => {
    if (!row || typeof row !== 'object')
        return;
    const elements = entityDef?.elements || {};
    const entries = Object.entries(row);
    const modeled = Object.keys(elements).filter((k) => !(0, alias_maps_1.isAssociationElement)(elements[k]) && Object.prototype.hasOwnProperty.call(row, k));
    const rest = entries.filter(([k]) => !modeled.includes(k));
    for (const [k] of entries)
        delete row[k];
    for (const k of modeled)
        row[k] = entries.find(([key]) => key === k)[1];
    for (const [k, v] of rest)
        row[k] = v;
};
exports.orderRowLikeDefinition = orderRowLikeDefinition;
/**
 * Ensures every expanded association appears in records under its canonical
 * local name (moves data from remote-named siblings when needed) and removes
 * the duplicate remote-named copies. Recurses into nested expands.
 *
 * @param entityDef   Parent entity definition.
 * @param records     Records with expanded associations.
 * @param expandTree  Parsed expand tree.
 * @param cache       Per-service metadata cache.
 */
const normalizeExpandedAssociationNames = (entityDef, records, expandTree, cache) => {
    if (!records?.length || !expandTree?.length)
        return;
    const aliasMaps = (0, alias_maps_1.getAliasMaps)(entityDef, cache);
    for (const exp of expandTree) {
        const localKeyName = exp.as || exp.name;
        const assocEl = entityDef?.elements?.[exp.name];
        if (!assocEl?.target)
            continue;
        const assocMeta = (0, association_meta_1.resolveAssociationMeta)(exp.name, entityDef, assocEl.target, assocEl, cache);
        const inferredRemoteName = (0, alias_maps_1.findRemoteAssociationName)(entityDef, exp.name, cache, assocEl);
        const remoteCandidates = [
            aliasMaps.localToRemote[localKeyName],
            assocMeta?.originalName,
            inferredRemoteName,
            assocEl.original,
            assocEl.value?.ref?.[assocEl.value?.ref?.[assocEl.value?.ref?.length - 1]]
        ].filter((c) => !!c && c !== localKeyName);
        const nestedTree = exp.columns?.length ? (0, join_parser_1.parseExpandTree)(exp.columns) : [];
        const targetDef = nestedTree.length ? cds_1.default.model.definitions[assocEl.target] : null;
        for (const row of records) {
            if (!row || typeof row !== 'object')
                continue;
            if (row[localKeyName] === undefined) {
                for (const candidate of remoteCandidates) {
                    if (row[candidate] !== undefined) {
                        row[localKeyName] = row[candidate];
                        break;
                    }
                }
            }
            for (const candidate of remoteCandidates) {
                if (Object.prototype.hasOwnProperty.call(row, candidate))
                    delete row[candidate];
            }
            if (targetDef && row[localKeyName] !== undefined) {
                const children = Array.isArray(row[localKeyName]) ? row[localKeyName] : [row[localKeyName]];
                (0, exports.normalizeExpandedAssociationNames)(targetDef, children.filter(Boolean), nestedTree, cache);
            }
        }
    }
};
exports.normalizeExpandedAssociationNames = normalizeExpandedAssociationNames;
/**
 * Final pass over a single row to guarantee every association is stored
 * under its local alias and no leftover remote-named copies remain.
 * Recurses through nested associations.
 *
 * @param entityDef  Entity definition of `row`.
 * @param row        Record to normalise (mutated).
 * @param cache      Per-service metadata cache.
 */
const enforceAssociationAliases = (entityDef, row, cache) => {
    if (!row || typeof row !== 'object' || !entityDef?.elements)
        return;
    const assocMaps = (0, alias_maps_1.getAssociationAliasMaps)(entityDef, cache);
    for (const [remoteName, localName] of Object.entries(assocMaps.remoteToLocal)) {
        if (row[localName] === undefined && row[remoteName] !== undefined)
            row[localName] = row[remoteName];
        if (Object.prototype.hasOwnProperty.call(row, remoteName))
            delete row[remoteName];
    }
    for (const [name, el] of Object.entries(entityDef.elements)) {
        if (!(0, alias_maps_1.isAssociationElement)(el))
            continue;
        const targetDef = el.target ? cds_1.default.model.definitions[el.target] : null;
        const data = row[name] !== undefined ? row[name] : row[assocMaps.localToRemote[name]];
        if (targetDef && data != null) {
            const children = Array.isArray(data) ? data : [data];
            for (const child of children)
                (0, exports.enforceAssociationAliases)(targetDef, child, cache);
        }
    }
};
exports.enforceAssociationAliases = enforceAssociationAliases;
/**
 * Removes fields from records that were not explicitly requested in the
 * incoming CQN column list. Preserves key fields, annotations (keys
 * starting with `@` or `$`), and recurses into any expanded children.
 * Mutates records in place.
 *
 * @param entityDef  Entity definition of the records being pruned.
 * @param records    Records to prune.
 * @param columns    Incoming CQN columns list.
 */
const pruneRecordsToRequestedShape = (entityDef, records, columns) => {
    if (!records?.length || !columns?.length || !entityDef?.elements)
        return;
    const requestedScalarFields = new Set();
    const requestedExpandMap = new Map();
    for (const col of columns) {
        if (col?.ref && !col.expand)
            requestedScalarFields.add(col.ref[col.ref.length - 1]);
    }
    for (const exp of (0, join_parser_1.parseExpandTree)(columns)) {
        requestedExpandMap.set(exp.as || exp.name, exp);
    }
    const shouldPruneScalars = requestedScalarFields.size > 0;
    const keyFields = new Set(Object.entries(entityDef.elements)
        .filter(([, element]) => !!element?.key)
        .map(([name]) => name));
    for (const record of records) {
        if (!record || typeof record !== 'object')
            continue;
        if (shouldPruneScalars) {
            for (const fieldName of Object.keys(record)) {
                if (fieldName.startsWith('@') || fieldName.startsWith('$'))
                    continue;
                const element = entityDef.elements[fieldName];
                if (!element || (0, alias_maps_1.isAssociationElement)(element))
                    continue;
                if (requestedScalarFields.has(fieldName) || keyFields.has(fieldName))
                    continue;
                delete record[fieldName];
            }
        }
        for (const [expandName, expandNode] of requestedExpandMap.entries()) {
            const assocEl = entityDef.elements[expandName];
            if (!assocEl?.target || record[expandName] == null)
                continue;
            const targetDef = cds_1.default.model.definitions[assocEl.target];
            if (!targetDef)
                continue;
            const children = Array.isArray(record[expandName]) ? record[expandName] : [record[expandName]];
            (0, exports.pruneRecordsToRequestedShape)(targetDef, children.filter(Boolean), expandNode.columns);
        }
    }
};
exports.pruneRecordsToRequestedShape = pruneRecordsToRequestedShape;
