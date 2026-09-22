"use strict";
/**
 * @file calc-dependencies.ts
 * @description Projection-level calculated columns (`CASE …`, `LEFT(x, 2)`, …)
 * are evaluated in memory on the mapped row. They can reference fields of the
 * SOURCE entity that the projection does not expose as elements; those fields
 * must be requested from the source or the expression sees `undefined`.
 *
 * The calculated element itself is never a field of the source and is never
 * requested from it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.withSourceColumns = exports.calcSourceDependencies = exports.getComputedAliases = void 0;
const alias_maps_1 = require("./alias-maps");
const path_columns_1 = require("./path-columns");
/**
 * Names of the projection's in-memory calculated elements.
 *
 * @param entityDef  CDS entity definition.
 */
const getComputedAliases = (entityDef) => new Set((0, alias_maps_1.collectProjectionColumns)(entityDef).filter(path_columns_1.isComputedColumn).map((c) => c.as));
exports.getComputedAliases = getComputedAliases;
/** Single-segment field refs inside an expression (`$self`, `$user`, paths and literals are ignored). */
const collectFieldRefs = (node, out) => {
    if (Array.isArray(node)) {
        for (const n of node)
            collectFieldRefs(n, out);
        return;
    }
    if (!node || typeof node !== 'object')
        return;
    if (Array.isArray(node.ref)) {
        if (node.ref.length === 1 && typeof node.ref[0] === 'string' && !node.ref[0].startsWith('$'))
            out.add(node.ref[0]);
        return;
    }
    for (const v of Object.values(node))
        if (v && typeof v === 'object')
            collectFieldRefs(v, out);
};
/**
 * Source fields the REQUESTED calculated columns depend on that are not
 * elements of the projection (elements are already handled by
 * `expandRequestedFieldsWithDependencies`).
 *
 * @param entityDef  CDS entity definition.
 * @param select     `SELECT` part of the incoming CQN (decides which calculated columns are requested).
 * @param alsoNeeded Calculated columns needed although not requested (searched by `$search`).
 */
const calcSourceDependencies = (entityDef, select, alsoNeeded = new Set()) => {
    const req = (0, path_columns_1.requestedElements)(select);
    const deps = new Set();
    for (const col of (0, alias_maps_1.collectProjectionColumns)(entityDef)) {
        if (!(0, path_columns_1.isComputedColumn)(col) || !(req.all || req.names.has(col.as) || alsoNeeded.has(col.as)))
            continue;
        const refs = new Set();
        collectFieldRefs(col.xpr ?? col.args ?? col, refs);
        for (const r of refs)
            if (r !== col.as && !entityDef.elements?.[r])
                deps.add(r);
    }
    return [...deps];
};
exports.calcSourceDependencies = calcSourceDependencies;
/**
 * Appends `{ ref: [name] }` for every source field in `names` that no column
 * selects yet. `*` selects everything, so it is returned unchanged.
 *
 * @param columns  Columns of the outgoing SELECT.
 * @param names    Source field names that must be fetched additionally.
 */
const withSourceColumns = (columns, names) => {
    if (!Array.isArray(columns) || columns.includes('*') || columns.some((c) => c?.ref?.[0] === '*'))
        return columns;
    const extra = names
        .filter((n) => !columns.some((c) => c?.ref?.length === 1 && c.ref[0] === n && !c.expand))
        .map((n) => ({ ref: [n] }));
    return extra.length ? [...columns, ...extra] : columns;
};
exports.withSourceColumns = withSourceColumns;
