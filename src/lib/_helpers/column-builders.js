"use strict";
/**
 * @file column-builders.ts
 * @description Pure builders that turn a set of "requested fields" into a
 * concrete CQN `columns` list for either a local (CAP) or remote (backend)
 * SELECT.
 *
 * Every builder respects the same rules:
 * - Associations, virtual fields, `$calc`, and formula (`value`) elements are
 *   never emitted as scalar columns.
 * - Managed associations' parent join keys are always included so children
 *   can be stitched later.
 * - Unmapped fields are dropped rather than translated — sending them to a
 *   backend would trigger a 400.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildColumnsWithExpands = exports.rewriteNestedExpands = exports.stripAliases = exports.buildLocalColumnsWithExpands = exports.buildSelectedLocalColumns = exports.buildSelectedRemoteColumns = exports.buildDefaultRemoteColumns = exports.buildDefaultLocalColumns = exports.buildRemoteColumn = exports.expandRequestedFieldsWithDependencies = exports.extractReferencedFields = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const association_meta_1 = require("./association-meta");
/**
 * Walks a CQN node recursively and collects the terminal segment of every
 * `ref` array it encounters. Used to discover field dependencies inside
 * complex projection column expressions.
 *
 * @param node  CQN node.
 * @param refs  Accumulator (defaults to a fresh Set).
 */
const extractReferencedFields = (node, refs = new Set()) => {
    if (Array.isArray(node)) {
        for (const item of node)
            (0, exports.extractReferencedFields)(item, refs);
        return refs;
    }
    if (!node || typeof node !== 'object')
        return refs;
    if (Array.isArray(node.ref) && node.ref.length > 0) {
        const last = node.ref[node.ref.length - 1];
        if (typeof last === 'string')
            refs.add(last);
    }
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object')
            (0, exports.extractReferencedFields)(value, refs);
    }
    return refs;
};
exports.extractReferencedFields = extractReferencedFields;
/**
 * Given a set of directly requested local fields, transitively adds any
 * fields referenced by their projection expressions (e.g. a `$calc` that
 * multiplies `Quantity * UnitPrice`). Returns a superset that is safe to
 * fetch from the backend.
 *
 * @param entityDef        CDS entity definition.
 * @param requestedFields  Set of directly requested local field names.
 */
const expandRequestedFieldsWithDependencies = (entityDef, requestedFields) => {
    const expandedFields = new Set(requestedFields);
    const pending = [...requestedFields];
    while (pending.length > 0) {
        const localKey = pending.pop();
        const projectionColumn = (0, alias_maps_1.collectProjectionColumns)(entityDef).find((col) => col?.as === localKey);
        if (!projectionColumn)
            continue;
        for (const dependency of (0, exports.extractReferencedFields)(projectionColumn)) {
            if (dependency === localKey)
                continue;
            const element = entityDef.elements?.[dependency];
            if (!element || (0, alias_maps_1.isAssociationElement)(element) || expandedFields.has(dependency))
                continue;
            expandedFields.add(dependency);
            pending.push(dependency);
        }
    }
    return expandedFields;
};
exports.expandRequestedFieldsWithDependencies = expandRequestedFieldsWithDependencies;
/**
 * Builds a single CQN column node for the remote query. Uses the element's
 * `value.ref` when present (calculated expressions), otherwise the remote
 * name / local alias pair.
 *
 * @param entityDef   Local entity definition.
 * @param localKey    Local field name.
 * @param remoteName  Remote field name.
 * @param withAlias   `true` to emit an `as` alias when names differ.
 */
const buildRemoteColumn = (entityDef, localKey, remoteName, withAlias) => {
    const element = entityDef.elements?.[localKey];
    if (element?.value?.ref)
        return withAlias ? { ref: element.value.ref, as: localKey } : { ref: element.value.ref };
    if (remoteName !== localKey)
        return withAlias ? { ref: [remoteName], as: localKey } : { ref: [remoteName] };
    return { ref: [localKey] };
};
exports.buildRemoteColumn = buildRemoteColumn;
/**
 * Builds the default column list for a query executed against a locally-served
 * service. Skips associations, virtual fields, `$calc`, and formula fields.
 *
 * @param entityDef  CDS entity definition.
 * @param skip       Element names to leave out (association-path elements).
 */
const buildDefaultLocalColumns = (entityDef, skip) => {
    const columns = [];
    if (!entityDef?.elements)
        return ['*'];
    for (const [name, el] of Object.entries(entityDef.elements)) {
        if (skip?.has(name))
            continue;
        if ((0, alias_maps_1.isAssociationElement)(el) || el.virtual || el.$calc || el.value)
            continue;
        columns.push({ ref: [name] });
    }
    return columns.length > 0 ? columns : ['*'];
};
exports.buildDefaultLocalColumns = buildDefaultLocalColumns;
/**
 * Builds the default column list for a query executed against a remote
 * backend. Same rules as {@link buildDefaultLocalColumns}, but emits remote
 * field names.
 *
 * @param entityDef      CDS entity definition.
 * @param localToRemote  Alias map.
 * @param skip           Element names to leave out (association-path elements).
 */
const buildDefaultRemoteColumns = (entityDef, localToRemote, skip) => {
    const columns = [];
    if (!entityDef?.elements)
        return ['*'];
    for (const [name, el] of Object.entries(entityDef.elements)) {
        if (skip?.has(name))
            continue;
        if ((0, alias_maps_1.isAssociationElement)(el) || el.virtual || el.$calc || el.value)
            continue;
        const remoteName = localToRemote[name] || name;
        if (remoteName)
            columns.push({ ref: [remoteName] });
    }
    return columns.length > 0 ? columns : ['*'];
};
exports.buildDefaultRemoteColumns = buildDefaultRemoteColumns;
/**
 * Builds explicit projected columns for a remote query derived from an
 * `$expand` node. Guarantees target join keys are always fetched so
 * parent↔child stitching can succeed.
 *
 * @param entityDef   Target entity definition.
 * @param expandNode  Parsed expand node.
 * @param aliasMaps   Alias maps for the target entity.
 * @param targetKeys  Association join keys that must be included.
 * @param skip        Element names to leave out (association-path elements).
 */
const buildSelectedRemoteColumns = (entityDef, expandNode, aliasMaps, targetKeys, skip) => {
    const requestedFields = new Set();
    for (const col of expandNode.columns || []) {
        if (col?.ref && !col.expand)
            requestedFields.add(col.ref[col.ref.length - 1]);
    }
    if (requestedFields.size === 0)
        return (0, exports.buildDefaultRemoteColumns)(entityDef, aliasMaps.localToRemote, skip);
    const selectedFields = (0, exports.expandRequestedFieldsWithDependencies)(entityDef, requestedFields);
    for (const targetKey of targetKeys)
        selectedFields.add(targetKey);
    const columns = [];
    for (const localKey of selectedFields) {
        if (skip?.has(localKey))
            continue;
        const element = entityDef.elements?.[localKey];
        if (!element || (0, alias_maps_1.isAssociationElement)(element) || element.virtual || element.$calc || element.value)
            continue;
        const remoteName = aliasMaps.localToRemote[localKey];
        if (!remoteName)
            continue;
        columns.push((0, exports.buildRemoteColumn)(entityDef, localKey, remoteName, true));
    }
    return columns.length > 0 ? columns : ['*'];
};
exports.buildSelectedRemoteColumns = buildSelectedRemoteColumns;
const AGGREGATE_FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max', 'count_distinct']);
/**
 * Local-service variant of {@link buildSelectedRemoteColumns}. Emits plain
 * local field refs (no alias translation).
 *
 * @param entityDef   Target entity definition.
 * @param expandNode  Parsed expand node.
 * @param targetKeys  Association join keys that must be included.
 * @param skip        Element names to leave out (association-path elements).
 */
const buildSelectedLocalColumns = (entityDef, expandNode, targetKeys, skip) => {
    const requestedFields = new Set();
    for (const col of expandNode.columns || []) {
        if (col?.ref && !col.expand)
            requestedFields.add(col.ref[col.ref.length - 1]);
    }
    if (requestedFields.size === 0)
        return ['*'];
    const selectedFields = (0, exports.expandRequestedFieldsWithDependencies)(entityDef, requestedFields);
    for (const targetKey of targetKeys)
        selectedFields.add(targetKey);
    // Aggregates (`count(x) as N`) are flagged `$calc` but are computed by the target's own group-by step:
    // they must be requested, or the target prunes them from the result.
    const aggregates = new Set((0, alias_maps_1.collectProjectionColumns)(entityDef)
        .filter((col) => col?.as && col.func && AGGREGATE_FUNCS.has(String(col.func).toLowerCase()))
        .map((col) => col.as));
    const columns = [];
    for (const localKey of selectedFields) {
        if (skip?.has(localKey))
            continue;
        const element = entityDef.elements?.[localKey];
        if (!element || (0, alias_maps_1.isAssociationElement)(element) || element.virtual)
            continue;
        if (element.$calc && !aggregates.has(localKey))
            continue;
        columns.push({ ref: [localKey] });
    }
    return columns.length > 0 ? columns : ['*'];
};
exports.buildSelectedLocalColumns = buildSelectedLocalColumns;
/**
 * Builds a column list that includes both scalar fields (for a local target
 * service) and inline `$expand` nodes for materialised associations.
 *
 * @param entityDef        Parent entity definition.
 * @param expandTree       Parsed expand tree.
 * @param incomingColumns  Incoming CQN columns from the request.
 * @param cache            Per-service metadata cache.
 * @param skip             Element names to leave out (association-path elements).
 * @param targetDef        Definition of the entity the query is sent to. Expands on associations it does
 *                         not define (added by the projection layer) are not pushed down: the expand
 *                         materializer resolves them after the fetch.
 */
const buildLocalColumnsWithExpands = (entityDef, expandTree, incomingColumns, cache, skip, targetDef) => {
    const requestedFields = new Set();
    const requiredParentKeys = new Set();
    let hasExplicitSelect = false;
    for (const col of incomingColumns || []) {
        if (col?.ref && !col.expand) {
            requestedFields.add(col.ref[col.ref.length - 1]);
            hasExplicitSelect = true;
        }
    }
    for (const exp of expandTree) {
        const assoc = entityDef.elements?.[exp.name];
        if (!assoc?.target)
            continue;
        const assocMeta = (0, association_meta_1.resolveAssociationMeta)(exp.name, entityDef, assoc.target, assoc, cache);
        if (!assocMeta)
            continue;
        for (const key of assocMeta.localKeys)
            requiredParentKeys.add(key);
        requiredParentKeys.add(exp.name);
    }
    const selectedFields = (0, exports.expandRequestedFieldsWithDependencies)(entityDef, requestedFields);
    const baseCols = [];
    for (const localKey of Object.keys(entityDef?.elements || {})) {
        if (skip?.has(localKey))
            continue;
        const element = entityDef.elements[localKey];
        if ((0, alias_maps_1.isAssociationElement)(element) || element?.virtual || element?.$calc || element?.value)
            continue;
        if (hasExplicitSelect && !selectedFields.has(localKey) && !requiredParentKeys.has(localKey))
            continue;
        baseCols.push({ ref: [localKey] });
    }
    for (const exp of expandTree) {
        if (targetDef?.elements && !targetDef.elements[exp.name])
            continue;
        baseCols.push({ ref: [exp.name], expand: exp.columns });
    }
    return baseCols.length > 0 ? baseCols : ['*'];
};
exports.buildLocalColumnsWithExpands = buildLocalColumnsWithExpands;
/**
 * Removes `as` aliases from a column array. Used when passing nested
 * expand columns to backends that do not recognise CDS aliases.
 *
 * @param columns  Column array (may be non-array; returned as-is).
 */
const stripAliases = (columns) => {
    if (!Array.isArray(columns))
        return columns;
    return columns.map((col) => {
        if (col && typeof col === 'object') {
            const { as, ...rest } = col;
            return rest;
        }
        return col;
    });
};
exports.stripAliases = stripAliases;
/**
 * Rewrites nested expand columns from local names to remote names, using
 * each target entity's `original` metadata. Preserves the nested `expand`
 * structure recursively so deeply nested `$expand` chains survive.
 *
 * @param targetDef  Entity definition of the parent of the expand tree.
 * @param columns    Column array.
 */
const rewriteNestedExpands = (targetDef, columns) => {
    if (!Array.isArray(columns))
        return columns;
    return columns.map((col) => {
        if (col?.ref && !col.expand) {
            const localKey = col.ref[col.ref.length - 1];
            const remoteName = targetDef.elements?.[localKey]?.original || localKey;
            return remoteName !== localKey ? { ref: [remoteName], as: localKey } : { ref: [localKey] };
        }
        if (col?.ref && col.expand) {
            const localAssocName = col.ref[col.ref.length - 1];
            const assoc = targetDef.elements?.[localAssocName];
            if (!assoc)
                return col;
            const remoteAssocName = assoc.original || localAssocName;
            const nextTargetDef = cds_1.default.model.definitions[assoc.target];
            return {
                ...col,
                ref: [remoteAssocName],
                as: undefined,
                expand: nextTargetDef ? (0, exports.rewriteNestedExpands)(nextTargetDef, col.expand) : col.expand
            };
        }
        return col;
    });
};
exports.rewriteNestedExpands = rewriteNestedExpands;
/**
 * Remote-service variant of {@link buildLocalColumnsWithExpands}. Emits remote
 * column refs and inline `$expand` nodes targeting the remote association
 * name (falling back to the local name when no mapping exists).
 *
 * @param entityDef        Parent entity definition.
 * @param expandTree       Parsed expand tree.
 * @param localToRemote    Alias map for the parent entity.
 * @param incomingColumns  Incoming CQN columns from the request.
 * @param cache            Per-service metadata cache.
 * @param skip             Element names to leave out (association-path elements).
 */
const buildColumnsWithExpands = (entityDef, expandTree, localToRemote, incomingColumns, cache, skip) => {
    const requestedFields = new Set();
    const requiredParentKeys = new Set();
    let hasExplicitSelect = false;
    for (const col of incomingColumns || []) {
        if (col?.ref && !col.expand) {
            requestedFields.add(col.ref[col.ref.length - 1]);
            hasExplicitSelect = true;
        }
    }
    for (const exp of expandTree) {
        const assoc = entityDef.elements?.[exp.name];
        if (!assoc?.target)
            continue;
        const assocMeta = (0, association_meta_1.resolveAssociationMeta)(exp.name, entityDef, assoc.target, assoc, cache);
        if (!assocMeta)
            continue;
        for (const key of assocMeta.localKeys)
            requiredParentKeys.add(key);
        requiredParentKeys.add(exp.name);
    }
    const selectedFields = (0, exports.expandRequestedFieldsWithDependencies)(entityDef, requestedFields);
    const baseCols = [];
    for (const localKey of Object.keys(entityDef?.elements || {})) {
        if (skip?.has(localKey))
            continue;
        const element = entityDef.elements[localKey];
        if ((0, alias_maps_1.isAssociationElement)(element) || element?.virtual || element?.$calc || element?.value)
            continue;
        if (hasExplicitSelect && !selectedFields.has(localKey) && !requiredParentKeys.has(localKey))
            continue;
        baseCols.push((0, exports.buildRemoteColumn)(entityDef, localKey, localToRemote[localKey] || localKey, false));
    }
    for (const exp of expandTree) {
        const assoc = entityDef.elements?.[exp.name];
        if (!assoc)
            continue;
        const assocMeta = (0, association_meta_1.resolveAssociationMeta)(exp.name, entityDef, assoc.target, assoc, cache);
        if (!assocMeta?.isManaged)
            continue;
        const mappedRemoteName = localToRemote[exp.name];
        const inferredRemoteName = (0, alias_maps_1.findRemoteAssociationName)(entityDef, exp.name, cache, assoc);
        const remoteAssocName = (mappedRemoteName && mappedRemoteName !== exp.name ? mappedRemoteName : undefined) ||
            (assocMeta.originalName && assocMeta.originalName !== exp.name ? assocMeta.originalName : undefined) ||
            inferredRemoteName ||
            exp.name;
        if (remoteAssocName === exp.name && !inferredRemoteName)
            continue;
        const targetDef = cds_1.default.model.definitions[assoc.target];
        const cleanedNestedColumns = targetDef
            ? (0, exports.rewriteNestedExpands)(targetDef, exp.columns)
            : (0, exports.stripAliases)(exp.columns);
        baseCols.push({ ref: [remoteAssocName], expand: cleanedNestedColumns });
    }
    return baseCols;
};
exports.buildColumnsWithExpands = buildColumnsWithExpands;
