"use strict";
/**
 * @file cqn-rewriter.ts
 * @description Rewrites CQN queries from local field names to remote field
 * names, and sanitises them so they contain only fields that actually exist
 * on the remote backend.
 *
 * Two entry points:
 * - {@link rewriteQueryCqn}      — recursively translate every `ref` in a query.
 * - {@link sanitizeAndRewriteQuery} — same, but also strips virtual / `$calc` /
 *                                     unmapped fields (needed for expand
 *                                     children where the incoming CQN may
 *                                     contain fields the backend cannot handle).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeAndRewriteQuery = exports.sanitizeCqnWhere = exports.rewriteQueryCqn = exports.rewriteFromNode = exports.rewriteCqnNode = exports.rewriteRefArray = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const column_builders_1 = require("./column-builders");
/**
 * Rewrites the terminal segment of a CQN `ref` array using the alias map.
 * The array is mutated in place and also returned for chaining.
 *
 * @param ref  CQN ref array.
 * @param map  Alias map.
 */
const rewriteRefArray = (ref, map) => {
    if (!Array.isArray(ref) || ref.length === 0)
        return ref;
    const last = ref[ref.length - 1];
    if (map[last])
        ref[ref.length - 1] = map[last];
    return ref;
};
exports.rewriteRefArray = rewriteRefArray;
/**
 * Recursively rewrites CQN nodes, applying the alias map to every `ref`
 * array. Nested `$expand` nodes are rewritten against the target entity's
 * own alias map (not the parent's).
 *
 * @param node       CQN node (array or object).
 * @param map        Alias map for the current scope.
 * @param entityDef  Current-scope entity definition.
 * @param cache      Per-service metadata cache.
 * @param seen       Cycle guard (do not pass explicitly at call sites).
 */
const rewriteCqnNode = (node, map, entityDef, cache, seen = new Set()) => {
    if (Array.isArray(node))
        return node.map((n) => (0, exports.rewriteCqnNode)(n, map, entityDef, cache, seen));
    if (!node || typeof node !== 'object')
        return node;
    if (seen.has(node))
        return node;
    seen.add(node);
    if (node.ref) {
        const localName = node.ref[node.ref.length - 1];
        node.ref = (0, exports.rewriteRefArray)(node.ref, map);
        if (node.expand && entityDef?.elements?.[localName]?.target) {
            const targetDef = cds_1.default.model.definitions[entityDef.elements[localName].target];
            if (targetDef) {
                const targetMap = (0, alias_maps_1.getAliasMaps)(targetDef, cache).localToRemote;
                node.expand = (stripAliasesInternal((0, exports.rewriteCqnNode)(node.expand, targetMap, targetDef, cache, seen)));
            }
        }
    }
    if (node.xpr)
        node.xpr = (0, exports.rewriteCqnNode)(node.xpr, map, entityDef, cache, seen);
    if (node.list)
        node.list = (0, exports.rewriteCqnNode)(node.list, map, entityDef, cache, seen);
    if (node.expand)
        node.expand = (0, exports.rewriteCqnNode)(node.expand, map, entityDef, cache, seen);
    if (node.having)
        node.having = (0, exports.rewriteCqnNode)(node.having, map, entityDef, cache, seen);
    if (node.where)
        node.where = (0, exports.rewriteCqnNode)(node.where, map, entityDef, cache, seen);
    if (node.on)
        node.on = (0, exports.rewriteCqnNode)(node.on, map, entityDef, cache, seen);
    if (node.args)
        node.args = (0, exports.rewriteCqnNode)(node.args, map, entityDef, cache, seen);
    return node;
};
exports.rewriteCqnNode = rewriteCqnNode;
// Internal duplicate of stripAliases to avoid a circular import with
// column-builders (which imports from association-meta and thus everything
// else). Small and identical to `column-builders.ts:stripAliases`.
const stripAliasesInternal = (columns) => {
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
/**
 * Rewrites a CQN FROM node in-place, including nested JOIN args, inline
 * key predicates (`where`), and expand columns.
 *
 * @param node       CQN FROM node.
 * @param map        Alias map.
 * @param entityDef  Optional entity definition.
 * @param cache      Per-service metadata cache.
 */
const rewriteFromNode = (node, map, entityDef, cache) => {
    if (!node || typeof node !== 'object')
        return node;
    if (node.ref) {
        node.ref = (0, exports.rewriteRefArray)(node.ref, map);
        if (node.where)
            node.where = (0, exports.rewriteCqnNode)(node.where, map, entityDef, cache);
    }
    if (node.args)
        node.args = node.args.map((a) => (0, exports.rewriteFromNode)(a, map, entityDef, cache));
    if (node.on)
        node.on = (0, exports.rewriteCqnNode)(node.on, map, entityDef, cache);
    if (node.expand)
        node.expand = (0, exports.rewriteCqnNode)(node.expand, map, entityDef, cache);
    return node;
};
exports.rewriteFromNode = rewriteFromNode;
/**
 * Rewrites every `ref` node inside a CQN query (columns, where, orderBy,
 * having, groupBy, from) using the given alias map.
 *
 * @param query      Mutable CQN query.
 * @param map        Local→remote alias map for the query's target entity.
 * @param cache      Per-service metadata cache.
 * @param entityDef  Optional entity definition (enables nested-expand rewriting).
 */
const rewriteQueryCqn = (query, map, cache, entityDef) => {
    const select = query?.SELECT;
    if (!select)
        return;
    const seen = new Set();
    if (select.columns)
        select.columns = (0, exports.rewriteCqnNode)(select.columns, map, entityDef, cache, seen);
    if (select.where)
        select.where = (0, exports.rewriteCqnNode)(select.where, map, entityDef, cache, seen);
    if (select.orderBy)
        select.orderBy = (0, exports.rewriteCqnNode)(select.orderBy, map, entityDef, cache, seen);
    if (select.having)
        select.having = (0, exports.rewriteCqnNode)(select.having, map, entityDef, cache, seen);
    if (select.groupBy)
        select.groupBy = (0, exports.rewriteCqnNode)(select.groupBy, map, entityDef, cache, seen);
    if (select.from)
        select.from = (0, exports.rewriteFromNode)(select.from, map, entityDef, cache);
};
exports.rewriteQueryCqn = rewriteQueryCqn;
/**
 * Recursively filters and rewrites WHERE / HAVING clause tokens: drops any
 * predicate that references a virtual / `$calc` / unmapped field, and cleans
 * up dangling `AND`/`OR` operators left behind by removals.
 *
 * @param whereClause       CQN WHERE array.
 * @param targetDef         Target entity definition.
 * @param localToRemoteMap  Alias map.
 * @returns                 Sanitised WHERE array, or `null` when nothing remains.
 */
const sanitizeCqnWhere = (whereClause, targetDef, localToRemoteMap) => {
    if (!Array.isArray(whereClause) || whereClause.length === 0)
        return null;
    const rewritten = [];
    let i = 0;
    while (i < whereClause.length) {
        const token = whereClause[i];
        if (typeof token === 'string') {
            // and/or/parentheses are kept here; operators left dangling by a removed predicate are cleaned up below
            rewritten.push(token);
            i++;
            continue;
        }
        if (Array.isArray(token)) {
            const groupRes = (0, exports.sanitizeCqnWhere)(token, targetDef, localToRemoteMap);
            if (groupRes && groupRes.length > 0)
                rewritten.push(groupRes);
            i++;
            continue;
        }
        if (token && typeof token === 'object' && token.ref) {
            const localField = token.ref[0];
            const element = targetDef.elements?.[localField];
            if (!element || element.virtual || element.$calc || !localToRemoteMap[localField]) {
                // Skip the entire "ref op val" triple
                i += 3;
                continue;
            }
            rewritten.push({ ref: [localToRemoteMap[localField]] });
            i++;
            continue;
        }
        rewritten.push(token);
        i++;
    }
    // Clean up trailing operators (e.g. dangling 'and' after a removed predicate); a closing parenthesis stays
    while (rewritten.length > 0) {
        const last = rewritten[rewritten.length - 1];
        if (typeof last !== 'string' || last === ')')
            break;
        rewritten.pop();
    }
    const cleaned = dropDanglingLogic(rewritten);
    return cleaned.length > 0 ? cleaned : null;
};
exports.sanitizeCqnWhere = sanitizeCqnWhere;
const isLogicOp = (t) => typeof t === 'string' && (t.toLowerCase() === 'and' || t.toLowerCase() === 'or');
/**
 * Removes what a dropped predicate leaves behind: empty `( )` groups, and
 * `and`/`or` operators that are leading, trailing, next to a parenthesis or
 * directly after another operator (the FIRST of two adjacent operators wins).
 */
const dropDanglingLogic = (tokens) => {
    const out = [...tokens];
    for (let i = 0; i < out.length;) {
        const t = out[i];
        if (t === '(' && out[i + 1] === ')') {
            out.splice(i, 2);
            i = Math.max(0, i - 1);
            continue;
        }
        if (isLogicOp(t) && (i === 0 || i === out.length - 1 || out[i - 1] === '(' || out[i + 1] === ')')) {
            out.splice(i, 1);
            i = Math.max(0, i - 1);
            continue;
        }
        if (isLogicOp(t) && isLogicOp(out[i + 1])) {
            out.splice(i + 1, 1);
            continue;
        }
        i++;
    }
    return out;
};
/**
 * Sanitises and rewrites CQN query parameters (`$select`, `$filter`,
 * `$orderby`) so they contain only fields that exist on the remote backend.
 * Virtual, `$calc`, and unmapped elements are removed rather than translated —
 * they would otherwise trigger 400 responses.
 *
 * @param cqn        Mutable CQN query.
 * @param targetDef  Target entity definition.
 * @param aliasMaps  Target-side alias maps.
 * @returns          The same CQN, mutated.
 */
const sanitizeAndRewriteQuery = (cqn, targetDef, aliasMaps) => {
    if (!cqn || !cqn.SELECT)
        return cqn;
    const select = cqn.SELECT;
    // 1. $select columns
    if (Array.isArray(select.columns) && select.columns.length > 0) {
        const validColumns = [];
        for (const col of select.columns) {
            if (col.expand) {
                validColumns.push(col);
                continue;
            }
            const remoteFieldName = col.ref ? col.ref[col.ref.length - 1] : col;
            const fieldName = col.as || aliasMaps.remoteToLocal[remoteFieldName] || remoteFieldName;
            const element = targetDef.elements?.[fieldName];
            if (element && (element.virtual || element.$calc))
                continue;
            const remoteName = aliasMaps.localToRemote[fieldName] || remoteFieldName;
            if (!remoteName)
                continue;
            validColumns.push((0, column_builders_1.buildRemoteColumn)(targetDef, fieldName, remoteName, true));
        }
        select.columns = validColumns.length > 0 ? validColumns : ['*'];
    }
    // 2. $filter
    if (select.where) {
        const sanitizedWhere = (0, exports.sanitizeCqnWhere)(select.where, targetDef, aliasMaps.localToRemote);
        if (sanitizedWhere && sanitizedWhere.length > 0)
            select.where = sanitizedWhere;
        else
            delete select.where;
    }
    // 3. $orderby
    if (Array.isArray(select.orderBy)) {
        const validOrderBy = [];
        for (const order of select.orderBy) {
            const fieldName = order.ref ? order.ref[0] : null;
            if (!fieldName)
                continue;
            const element = targetDef.elements?.[fieldName];
            const remoteName = aliasMaps.localToRemote[fieldName];
            if (element && !element.virtual && !element.$calc && remoteName) {
                validOrderBy.push({ ref: [remoteName], sort: order.sort || 'asc' });
            }
        }
        if (validOrderBy.length > 0)
            select.orderBy = validOrderBy;
        else
            delete select.orderBy;
    }
    return cqn;
};
exports.sanitizeAndRewriteQuery = sanitizeAndRewriteQuery;
