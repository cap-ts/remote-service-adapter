"use strict";
/**
 * @file where-split.ts
 * @description Hybrid WHERE split: separates predicates that can be pushed to
 * the remote backend from those that must be evaluated in memory.
 *
 * The split happens at the top-level AND boundary, keeping individual
 * sub-expressions intact. This is the cornerstone of `RemoteService`'s
 * hybrid execution model.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitWhereClause = exports.isLocalOnlyExpression = exports.combineWithAnd = exports.extractAndExpressions = void 0;
const alias_maps_1 = require("./alias-maps");
const M = 'where-split';
/**
 * Splits a flat CQN WHERE token array into separate sub-arrays at each
 * top-level `AND` boundary.
 *
 * @param where  CQN WHERE token array.
 * @returns      Array of individual expression sub-arrays.
 */
const extractAndExpressions = (where) => {
    const expressions = [];
    let current = [];
    for (const token of where) {
        if (typeof token === 'string' && token.toUpperCase() === 'AND') {
            if (current.length > 0) {
                expressions.push(current);
                current = [];
            }
        }
        else {
            current.push(token);
        }
    }
    if (current.length > 0)
        expressions.push(current);
    return expressions;
};
exports.extractAndExpressions = extractAndExpressions;
/**
 * Joins expression groups back into a single CQN WHERE array using `AND`.
 *
 * @param expressionGroups  Array of expression sub-arrays.
 * @returns                 Combined CQN WHERE array, or `undefined` when empty.
 */
const combineWithAnd = (expressionGroups) => {
    if (expressionGroups.length === 0)
        return undefined;
    const result = [];
    expressionGroups.forEach((group, index) => {
        if (index > 0)
            result.push('AND');
        result.push(...group);
    });
    return result;
};
exports.combineWithAnd = combineWithAnd;
/**
 * Returns `true` when the given CQN expression sub-array references any
 * field that cannot be pushed to the remote backend:
 * - Multi-segment navigation paths (association traversal).
 * - Fields not present in the local entity definition.
 * - Virtual, `$calc`, or formula (`value`) fields.
 * - Association / Composition elements.
 * - Fields with no corresponding remote mapping.
 *
 * Function arguments and parenthesised groups (`xpr`) are checked with the same rules.
 *
 * @param expr           A single AND-clause expression token array.
 * @param entityDef      Local entity definition.
 * @param localToRemote  Field alias map.
 */
const isLocalOnlyExpression = (expr, entityDef, localToRemote, isSoap = false) => {
    for (const token of expr) {
        if (typeof token !== 'object' || token === null)
            continue;
        // OData function calls (contains, startswith, endswith, tolower, …)
        // cannot be pushed to SOAP — evaluate them in memory.
        // For non-SOAP (OData) backends these functions are valid and can be
        // pushed to the remote service, so only treat them as local-only when
        // the target is a SOAP service.
        if (isSoap && token.func)
            return true;
        // A field wrapped in a function (`contains(ParentName, 'x')`) is local-only when the field is:
        // check the function arguments with the same rules as top-level refs.
        if (Array.isArray(token.args) && (0, exports.isLocalOnlyExpression)(token.args, entityDef, localToRemote, isSoap))
            return true;
        // A parenthesised group `(a and b)` arrives as a nested `xpr` (OData `$filter=(_Assoc/Field gt 1) and (...)`): the same
        // rules apply inside it, otherwise a path / virtual / calculated field in a group would be pushed to the backend.
        if (Array.isArray(token.xpr) && (0, exports.isLocalOnlyExpression)(token.xpr, entityDef, localToRemote, isSoap))
            return true;
        if (token.ref) {
            const path = token.ref;
            if (path.length > 1 || (typeof path[0] === 'string' && path[0].includes('/')))
                return true;
            const fieldName = path[0];
            const el = entityDef?.elements?.[fieldName];
            if (!el)
                return true;
            if (el.virtual || el.$calc || el.value)
                return true;
            if ((0, alias_maps_1.isAssociationElement)(el))
                return true;
            if (!localToRemote[fieldName])
                return true;
        }
    }
    return false;
};
exports.isLocalOnlyExpression = isLocalOnlyExpression;
/**
 * Splits a CQN WHERE array into two disjoint parts:
 * - `remoteWhere` — predicates that can be safely pushed to the backend.
 * - `localWhere`  — predicates that must be evaluated in memory (virtual /
 *                   calculated / association-path / unmapped fields).
 *
 * @param where          Incoming CQN WHERE array (may be `undefined`).
 * @param entityDef      Local entity definition used for field classification.
 * @param localToRemote  Alias map for field-name translation.
 * @returns              `{ remoteWhere, localWhere }`; either may be `undefined`.
 */
const splitWhereClause = (where, entityDef, localToRemote, log, isSoap = false) => {
    if (!where || !Array.isArray(where) || where.length === 0) {
        return { remoteWhere: undefined, localWhere: undefined };
    }
    const expressions = (0, exports.extractAndExpressions)(where);
    const remoteExprs = [];
    const localExprs = [];
    for (const expr of expressions) {
        if ((0, exports.isLocalOnlyExpression)(expr, entityDef, localToRemote, isSoap))
            localExprs.push(expr);
        else
            remoteExprs.push(expr);
    }
    log?.forModule(M).debug('splitWhereClause', 'Split complete', {
        total: expressions.length,
        remote: remoteExprs.length,
        local: localExprs.length,
    });
    return {
        remoteWhere: (0, exports.combineWithAnd)(remoteExprs),
        localWhere: (0, exports.combineWithAnd)(localExprs)
    };
};
exports.splitWhereClause = splitWhereClause;
