"use strict";
/**
 * @file path-columns.ts
 * @description Classifies projection columns that navigate associations
 * (`_A._B._C.Field as X`) and rejects the ones that cannot be served.
 *
 * Path columns exist only in the **entity definition**
 * (`entityDef.query.SELECT.columns`); `req.query.SELECT.columns` carries
 * projection element names only. Paths start at the projection's *source*
 * entity, so the first association need not be an element of the projection.
 *
 * Any depth is supported as long as every hop is to-one. A to-many hop
 * (1:N, or M:N via a link entity) or a filtered segment makes the element
 * unservable: it is rejected with HTTP 501 when requested.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertSupportedPathColumns = exports.requestedCalcPathColumns = exports.requestedPathColumns = exports.requestedElements = exports.getColumnPlan = exports.isComputedColumn = void 0;
const cds_1 = require("@sap/cds");
// NOTE: leaf module on purpose (alias-maps imports it); do not import alias-maps / cqn-utils here.
const isToManyElement = (el) => {
    const max = el?.cardinality?.max;
    return max === '*' || (typeof max === 'number' && max > 1);
};
const projectionColumnsOf = (entityDef) => entityDef?.query?.SELECT?.columns
    || cds_1.default.model?.definitions?.[entityDef?.name]?.query?.SELECT?.columns
    || [];
const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'count_distinct']);
/** `true` for `<expr> as Name` columns evaluated in memory (not plain refs, not aggregates). */
const isComputedColumn = (col) => !!col?.as && !col.ref && !!(col.xpr || col.func) && !(col.func && AGGREGATES.has(String(col.func).toLowerCase()));
exports.isComputedColumn = isComputedColumn;
const notSupported = (message) => Object.assign(new Error(message), { code: 501, status: 501, statusCode: 501 });
/**
 * Classifies one projection column. Returns `undefined` when it is not an
 * association path (plain ref, expression, structure path such as `Addr.City`).
 */
const classifyColumn = (col, sourceDef) => {
    const ref = col?.ref;
    if (!Array.isArray(ref) || ref.length < 2 || !sourceDef)
        return undefined;
    const last = ref[ref.length - 1];
    const alias = col.as || (typeof last === 'string' ? last : last?.id);
    let def = sourceDef;
    const hops = [];
    let kind = 'toOne';
    let reason;
    const flag = (k, why) => {
        // unsupported outranks toMany outranks toOne
        if (kind === 'unsupported' || (kind === 'toMany' && k === 'toOne'))
            return;
        if (kind === 'toMany' && k === 'toMany')
            return;
        kind = k;
        reason = why;
    };
    for (let i = 0; i < ref.length - 1; i++) {
        const seg = ref[i];
        const name = typeof seg === 'string' ? seg : seg?.id;
        const el = name ? def?.elements?.[name] : undefined;
        if (!el?.target) {
            // Structure segment before any association (`Addr.City`) -> not a path column.
            if (hops.length === 0 && el?.elements) {
                def = el;
                continue;
            }
            if (hops.length === 0)
                return undefined;
            flag('unsupported', `segment '${name}' is not an association`);
            break;
        }
        hops.push(name);
        if (typeof seg !== 'string' && (seg.where || seg.args))
            flag('unsupported', `filter on path segment '${name}'`);
        if (isToManyElement(el))
            flag('toMany', `'${name}' is a to-many association`);
        const next = cds_1.default.model?.definitions?.[el.target];
        if (!next) {
            flag('unsupported', `target '${el.target}' of '${name}' not found in the model`);
            break;
        }
        def = next;
    }
    if (hops.length === 0)
        return undefined;
    return { alias, hops, leaf: typeof last === 'string' ? last : last?.id, kind, reason };
};
/**
 * Finds the association paths (`_A._B.X`, two or more segments) inside a
 * calculated column and returns a copy of it in which each path is replaced
 * by a hidden single-segment element. Structure paths (`Addr.City`), `$self` /
 * `$user` refs and paths that do not resolve are left untouched.
 */
const extractCalcPaths = (col, sourceDef) => {
    const paths = new Map();
    const rewrite = (node) => {
        if (Array.isArray(node))
            return node.map(rewrite);
        if (!node || typeof node !== 'object')
            return node;
        if (Array.isArray(node.ref)) {
            const ids = node.ref.map((s) => (typeof s === 'string' ? s : s?.id));
            if (node.ref.length < 2 || ids.some((i) => typeof i !== 'string') || ids[0].startsWith('$'))
                return node;
            const hidden = `$path_${ids.join('_')}`;
            const pc = classifyColumn({ ref: node.ref, as: hidden }, sourceDef);
            if (!pc)
                return node;
            paths.set(hidden, pc);
            return { ...node, ref: [hidden] };
        }
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, rewrite(v)]));
    };
    const column = rewrite(col);
    return paths.size > 0 ? { alias: col.as, column, paths: [...paths.values()] } : undefined;
};
/**
 * Returns the {@link ColumnPlan} of an entity, memoised per definition.
 *
 * @param entityDef  CDS entity definition.
 * @param cache      Per-service metadata cache.
 */
const getColumnPlan = (entityDef, cache) => {
    if (!entityDef)
        return { paths: new Map() };
    const cached = cache.columnPlan.get(entityDef);
    if (cached)
        return cached;
    const paths = new Map();
    const fromRef = entityDef.query?.SELECT?.from?.ref || entityDef.projection?.from?.ref;
    // Only single-source projections; joins are handled by the mashup pipeline.
    const head = Array.isArray(fromRef) && fromRef.length === 1 ? fromRef[0] : undefined;
    const sourceName = typeof head === 'string' ? head : head?.id;
    const sourceDef = sourceName ? cds_1.default.model?.definitions?.[sourceName] : undefined;
    const calcPaths = [];
    if (sourceDef) {
        for (const col of projectionColumnsOf(entityDef)) {
            const pc = classifyColumn(col, sourceDef);
            if (pc)
                paths.set(pc.alias, pc);
            else if ((0, exports.isComputedColumn)(col)) {
                const cc = extractCalcPaths(col, sourceDef);
                if (cc)
                    calcPaths.push(cc);
            }
        }
    }
    const plan = { paths, calcPaths, sourceDef };
    cache.columnPlan.set(entityDef, plan);
    return plan;
};
exports.getColumnPlan = getColumnPlan;
/** Collects the first segment of every `ref` in a CQN fragment. */
const collectRefHeads = (node, out) => {
    if (Array.isArray(node)) {
        for (const n of node)
            collectRefHeads(n, out);
        return;
    }
    if (!node || typeof node !== 'object')
        return;
    if (Array.isArray(node.ref) && node.ref.length > 0) {
        const head = node.ref[0];
        out.add(typeof head === 'string' ? head : head?.id);
    }
    for (const v of Object.values(node))
        if (v && typeof v === 'object')
            collectRefHeads(v, out);
};
/**
 * Names of the projection elements a query touches through `$select`,
 * `$filter`, `$orderby` and `$apply`/group-by. `all` is `true` when no explicit
 * column list (or `*`) means every element is returned.
 *
 * @param select  `SELECT` part of the incoming CQN.
 */
const requestedElements = (select) => {
    const names = new Set();
    const columns = select?.columns ?? [];
    const all = columns.length === 0 || columns.some((c) => c === '*' || c?.ref?.[0] === '*');
    for (const col of columns)
        if (col && typeof col === 'object' && col.ref && !col.expand)
            collectRefHeads(col, names);
    collectRefHeads(select?.where, names);
    collectRefHeads(select?.orderBy, names);
    collectRefHeads(select?.groupBy, names);
    collectRefHeads(select?.having, names);
    return { all, names };
};
exports.requestedElements = requestedElements;
/**
 * Path elements of `plan` that this query asks for. Empty for entities
 * without path columns.
 *
 * @param plan    Column plan of the target entity.
 * @param select  `SELECT` part of the incoming CQN.
 */
const requestedPathColumns = (plan, select) => {
    if (plan.paths.size === 0)
        return [];
    const req = (0, exports.requestedElements)(select);
    return [...plan.paths.values()].filter((p) => req.all || req.names.has(p.alias));
};
exports.requestedPathColumns = requestedPathColumns;
/**
 * Calculated columns of `plan` that this query asks for and whose association
 * paths are all to-one (others keep the value they had before: not resolved).
 *
 * @param plan       Column plan of the target entity.
 * @param select     `SELECT` part of the incoming CQN.
 * @param alsoNeeded Calculated columns needed although not requested (searched by `$search`).
 */
const requestedCalcPathColumns = (plan, select, alsoNeeded = new Set()) => {
    if (!plan.calcPaths?.length)
        return [];
    const req = (0, exports.requestedElements)(select);
    return plan.calcPaths.filter((c) => (req.all || req.names.has(c.alias) || alsoNeeded.has(c.alias)) && c.paths.every((p) => p.kind === 'toOne'));
};
exports.requestedCalcPathColumns = requestedCalcPathColumns;
/**
 * Rejects (HTTP 501) when the query explicitly names (`$select`, `$filter`,
 * `$orderby`) a path element that crosses a to-many association or otherwise
 * cannot be resolved. Runs before any remote call.
 *
 * A read WITHOUT `$select` (or with `*`) does not reject: such elements are
 * simply left out, as before, so entities that already define them keep
 * working. Pass `strict = true` to reject those reads as well.
 *
 * @param plan    Column plan of the target entity.
 * @param select  `SELECT` part of the incoming CQN.
 * @param entity  Entity name, for the message.
 * @param strict  Also reject when the element is only implied by "all elements".
 */
const assertSupportedPathColumns = (plan, select, entity, strict = false) => {
    if (plan.paths.size === 0)
        return;
    const req = (0, exports.requestedElements)(select);
    for (const p of plan.paths.values()) {
        if (p.kind === 'toOne' || !(req.names.has(p.alias) || (strict && req.all)))
            continue;
        throw notSupported(`Element '${p.alias}'${entity ? ` of '${entity}'` : ''} is not supported: its path `
            + `'${p.hops.join('.')}.${p.leaf}' cannot be resolved (${p.reason}). `
            + `Only paths across to-one associations are supported; leave it out of $select.`);
    }
};
exports.assertSupportedPathColumns = assertSupportedPathColumns;
