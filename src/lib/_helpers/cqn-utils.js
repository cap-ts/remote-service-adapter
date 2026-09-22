"use strict";
/**
 * @file cqn-utils.ts
 * @description Pure CQN utilities: FROM-node retargeting, WHERE stripping,
 * association-path detection, and remote-error inspection.
 *
 * None of these functions have side effects on external state — they operate
 * only on the CQN node they are passed (mutating in place where documented)
 * and the given entity definition.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterWhereForTable = exports.applyInMemorySort = exports.isAssociationPathRemoteError = exports.replaceWithNonFilteredRemoteQuery = exports.stripRemoteWhere = exports.containsAssociationPathString = exports.containsAssociationPathInWhere = exports.resolveTargetEntity = exports.retargetFromNode = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const { SELECT } = cds_1.default.ql;
/**
 * Re-targets a SELECT.from node to a physical remote entity while preserving
 * key predicates and aliases from the incoming request CQN.
 *
 * @param fromNode          Original CQN FROM node (may be `undefined`).
 * @param targetEntityName  Physical entity name to substitute.
 * @returns                 Updated CQN FROM node.
 */
const retargetFromNode = (fromNode, targetEntityName) => {
    if (!fromNode || typeof fromNode !== 'object') {
        return { ref: [targetEntityName] };
    }
    if (Array.isArray(fromNode.ref) && fromNode.ref.length > 0) {
        const ref = [...fromNode.ref];
        const head = ref[0];
        if (typeof head === 'string') {
            ref[0] = targetEntityName;
        }
        else if (head && typeof head === 'object') {
            ref[0] = { ...head, id: targetEntityName };
        }
        else {
            ref[0] = targetEntityName;
        }
        return { ...fromNode, ref };
    }
    return { ...fromNode, ref: [targetEntityName] };
};
exports.retargetFromNode = retargetFromNode;
/**
 * Resolves the physical target entity name from a CDS entity definition's
 * projection or query FROM clause.
 *
 * @param entityDef  CDS entity definition.
 * @returns          Fully qualified target entity name.
 */
const resolveTargetEntity = (entityDef) => {
    const fromRef = entityDef.query?.SELECT?.from?.ref || entityDef.projection?.from?.ref;
    let targetEntity = Array.isArray(fromRef) ? fromRef[0] : entityDef.name;
    if (targetEntity && typeof targetEntity === 'object' && targetEntity.id)
        targetEntity = targetEntity.id;
    return targetEntity;
};
exports.resolveTargetEntity = resolveTargetEntity;
/**
 * Returns `true` when the WHERE clause contains association navigation paths
 * (e.g. `to_Partner/Country`). Used to detect filters that cannot be forwarded
 * to backends that do not support cross-entity navigation in `$filter`.
 *
 * @param where      CQN WHERE node.
 * @param entityDef  Local entity definition.
 */
const containsAssociationPathInWhere = (where, entityDef) => {
    if (!where || !entityDef?.elements)
        return false;
    const segmentId = (segment) => {
        if (typeof segment === 'string')
            return segment;
        if (segment && typeof segment === 'object') {
            if (typeof segment.id === 'string')
                return segment.id;
            if (typeof segment.name === 'string')
                return segment.name;
        }
        return undefined;
    };
    const isAssocPath = (segments) => {
        if (!Array.isArray(segments) || segments.length === 0)
            return false;
        if (segments.length > 1) {
            const head = segmentId(segments[0]);
            const element = head ? entityDef.elements?.[head] : undefined;
            return !!(element && (0, alias_maps_1.isAssociationElement)(element));
        }
        const first = segmentId(segments[0]);
        if (typeof first === 'string' && first.includes('/')) {
            const head = first.split('/')[0];
            const element = head ? entityDef.elements?.[head] : undefined;
            return !!(element && (0, alias_maps_1.isAssociationElement)(element));
        }
        return false;
    };
    const walk = (node) => {
        if (!node)
            return false;
        if (Array.isArray(node))
            return node.some(walk);
        if (typeof node !== 'object')
            return false;
        if (Array.isArray(node.ref) && isAssocPath(node.ref))
            return true;
        if (node.func && Array.isArray(node.args)) {
            for (const arg of node.args) {
                if (typeof arg === 'string' && arg.includes('/')) {
                    const head = arg.split('/')[0];
                    const element = head ? entityDef.elements?.[head] : undefined;
                    if (element && (0, alias_maps_1.isAssociationElement)(element))
                        return true;
                }
            }
        }
        return Object.values(node).some(walk);
    };
    return walk(where);
};
exports.containsAssociationPathInWhere = containsAssociationPathInWhere;
/**
 * Faster string-based heuristic: checks whether the serialised WHERE contains
 * any association name followed by `/`. Used as a secondary guard.
 *
 * @param where      CQN WHERE node.
 * @param entityDef  Local entity definition.
 */
const containsAssociationPathString = (where, entityDef) => {
    if (!where || !entityDef?.elements)
        return false;
    const serialized = JSON.stringify(where);
    if (!serialized)
        return false;
    for (const [name, element] of Object.entries(entityDef.elements)) {
        if (!(0, alias_maps_1.isAssociationElement)(element))
            continue;
        if (serialized.includes(`${name}/`))
            return true;
    }
    return false;
};
exports.containsAssociationPathString = containsAssociationPathString;
/**
 * Removes any WHERE clause from a remote query CQN object, including inline
 * key predicates inside the FROM node.
 *
 * @param query  Mutable CQN query object.
 */
const stripRemoteWhere = (query) => {
    if (!query?.SELECT)
        return;
    query.SELECT.where = undefined;
    delete query.SELECT.where;
    const fromNode = query.SELECT.from;
    if (fromNode?.where) {
        fromNode.where = undefined;
        delete fromNode.where;
    }
    if (Array.isArray(fromNode?.ref) && fromNode.ref[0] && typeof fromNode.ref[0] === 'object') {
        const head = fromNode.ref[0];
        if (head.where) {
            head.where = undefined;
            delete head.where;
        }
    }
};
exports.stripRemoteWhere = stripRemoteWhere;
/**
 * Rebuilds a remote query without any top-level WHERE clause so that
 * navigation-path filters are never forwarded to backends that don't
 * support them on the root entity. Preserves `$select`, `$orderby`,
 * `$top`, `$skip`, `$count`, and `$top=1` (one) flags.
 *
 * @param query             Mutable CQN query object.
 * @param targetEntityName  Entity name to target.
 */
const replaceWithNonFilteredRemoteQuery = (query, targetEntityName) => {
    if (!query?.SELECT)
        return;
    const rebuilt = SELECT.from(targetEntityName);
    if (Array.isArray(query.SELECT.columns))
        rebuilt.columns(query.SELECT.columns);
    if (query.SELECT.orderBy)
        rebuilt.orderBy(query.SELECT.orderBy);
    if (query.SELECT.limit) {
        const rows = query.SELECT.limit.rows?.val ?? query.SELECT.limit.rows;
        const offset = query.SELECT.limit.offset?.val ?? query.SELECT.limit.offset;
        rebuilt.limit(rows, offset);
    }
    if (query.SELECT.count)
        rebuilt.SELECT.count = true;
    if (query.SELECT.one)
        rebuilt.SELECT.one = true;
    query.SELECT = rebuilt.SELECT;
};
exports.replaceWithNonFilteredRemoteQuery = replaceWithNonFilteredRemoteQuery;
/**
 * Heuristically detects backend errors of the form
 * *"Property <X> not found in type <Y>"* where `<X>` is an association name.
 * Used to trigger the in-memory filter fallback path.
 *
 * @param error      Unknown error thrown by the remote service.
 * @param entityDef  Local entity definition (used to enumerate association names).
 */
const isAssociationPathRemoteError = (error, entityDef) => {
    const message = String(error?.message
        || error?.reason?.message
        || error?.response?.body?.error?.message?.value
        || error?.response?.data?.error?.message?.value
        || error?.error?.message
        || '');
    const serialized = JSON.stringify(error || {});
    if (!message.includes('Property') || !message.includes('not found in type'))
        return false;
    for (const [name, element] of Object.entries(entityDef?.elements || {})) {
        if (!(0, alias_maps_1.isAssociationElement)(element))
            continue;
        if (message.includes(name) || serialized.includes(name))
            return true;
    }
    return false;
};
exports.isAssociationPathRemoteError = isAssociationPathRemoteError;
/**
 * Sorts `records` in-place according to a CQN `orderBy` specification.
 * Used when the full sort must happen in memory (e.g. after local filtering).
 *
 * @param records  Mutable array of mapped result records.
 * @param orderBy  CQN `orderBy` clause array.
 * @returns        The same array, sorted.
 */
const applyInMemorySort = (records, orderBy) => {
    return records.sort((a, b) => {
        for (const clause of orderBy) {
            const field = clause.ref ? clause.ref[0] : null;
            if (!field)
                continue;
            const isDesc = clause.sort?.toLowerCase() === 'desc';
            if (a[field] < b[field])
                return isDesc ? 1 : -1;
            if (a[field] > b[field])
                return isDesc ? -1 : 1;
        }
        return 0;
    });
};
exports.applyInMemorySort = applyInMemorySort;
/**
 * Placeholder hook: filter a JOIN mashup's WHERE clause down to predicates
 * that reference only the given alias. Currently a pass-through because the
 * primary query's WHERE is trusted; kept as an extension point.
 *
 * @param where   CQN WHERE clause.
 * @param _alias  Table alias.
 */
const filterWhereForTable = (where, _alias) => where;
exports.filterWhereForTable = filterWhereForTable;
