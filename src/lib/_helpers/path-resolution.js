"use strict";
/**
 * @file path-resolution.ts
 * @description Resolves to-one association-path columns (`_A._B._C.Field as X`,
 * any depth) after the main rows have been fetched and mapped.
 *
 * All requested paths are merged into ONE tree (shared prefixes are fetched
 * once) and resolved level by level: one batched key-IN fetch per hop for
 * the DISTINCT parent keys of that level, chunked by {@link PATH_FETCH_CHUNK}.
 * The leaf is then copied into the projection element and the temporary
 * data is discarded.
 *
 * Deliberately not built on `resolveExpandNodes`: it resolves nested levels
 * once per parent row (N+1), which is unacceptable for chains of any depth.
 * Fetch primitives (`fetchAssociatedRecords`, column builders) are shared.
 *
 * Flow inside `handleSimpleProjection`:
 * 1. `pathJoinKeyNames` + `withSourceColumns` — main SELECT also requests the first hop's parent join keys.
 * 2. {@link stashPathJoinKeys}  — raw rows get a `$pathKeys` copy (survives record mapping, raw rows untouched).
 * 3. {@link resolvePathColumns} — after mapping: fetch hop by hop, fill the elements, drop `$pathKeys`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyCalcPathColumns = exports.resolvePathColumns = exports.stashPathJoinKeys = exports.pathJoinKeyNames = exports.PATH_KEYS_PROP = exports.PATH_FETCH_CHUNK = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const association_meta_1 = require("./association-meta");
const column_builders_1 = require("./column-builders");
const expand_materializer_1 = require("./expand-materializer");
const join_parser_1 = require("./join-parser");
const record_mapping_1 = require("./record-mapping");
const service_resolver_1 = require("./service-resolver");
const M = 'path-resolution';
const { SELECT } = cds_1.default.ql;
/** Max distinct parent keys per fetch of the first hop (URL / IN-list size). */
exports.PATH_FETCH_CHUNK = 200;
/** Temporary property that carries the first hop's join key values on a row. */
exports.PATH_KEYS_PROP = '$pathKeys';
const assocMetaOf = (owner, name, cache) => {
    const el = owner?.elements?.[name];
    return el?.target ? (0, association_meta_1.resolveAssociationMeta)(name, owner, el.target, el, cache) : null;
};
/** Parent-side join key names of the FIRST hop of every requested path (source-entity element names). */
const pathJoinKeyNames = (plan, paths, cache) => {
    const keys = new Set();
    for (const first of new Set(paths.map((p) => p.hops[0]))) {
        for (const k of assocMetaOf(plan.sourceDef, first, cache)?.localKeys ?? [])
            keys.add(k);
    }
    return [...keys];
};
exports.pathJoinKeyNames = pathJoinKeyNames;
/**
 * Copies each raw row and attaches its join key values under {@link PATH_KEYS_PROP}.
 * A key that was selected under a local alias is looked up through `remoteToLocal`.
 * Raw rows are never mutated (they may be `@response.data`).
 */
const stashPathJoinKeys = (rows, keyNames, remoteToLocal) => rows.map((row) => {
    const keys = {};
    for (const k of keyNames)
        keys[k] = row?.[k] ?? row?.[remoteToLocal[k]];
    return { ...row, [exports.PATH_KEYS_PROP]: keys };
});
exports.stashPathJoinKeys = stashPathJoinKeys;
const buildTrie = (plan, paths) => {
    const roots = new Map();
    for (const p of paths) {
        let level = roots;
        let owner = plan.sourceDef;
        let node;
        for (const hop of p.hops) {
            node = level.get(hop);
            if (!node) {
                node = { name: hop, def: owner, target: owner?.elements?.[hop]?.target, leaves: new Set(), children: new Map() };
                level.set(hop, node);
            }
            owner = cds_1.default.model.definitions[node.target];
            level = node.children;
        }
        node.leaves.add(p.leaf);
    }
    return roots;
};
/** Columns to fetch for one node: its leaves plus the join keys its children need. */
const columnsOf = (node, targetDef, cache) => {
    const names = new Set(node.leaves);
    for (const child of node.children.values()) {
        for (const k of assocMetaOf(targetDef, child.name, cache)?.localKeys ?? [])
            names.add(k);
    }
    return [...names];
};
/**
 * Resolves `nodes` (siblings under `owner`) for `rows`: sets `row[node.name]`
 * to the target row (or `null`) and recurses with the DISTINCT fetched rows.
 */
const resolveLevel = async (req, owner, nodes, rows, cache, log) => {
    for (const node of nodes.values()) {
        const meta = assocMetaOf(owner, node.name, cache);
        const targetDef = meta && cds_1.default.model.definitions[meta.target];
        if (!meta || !targetDef) {
            log.warn('resolveLevel', 'Association not resolvable — path elements stay null', { hop: node.name });
            for (const row of rows)
                row[node.name] = null;
            continue;
        }
        const serviceName = (0, service_resolver_1.resolveServiceNameFromTarget)(meta.target);
        const queryLocal = (0, service_resolver_1.usesLocalServiceSemantics)(serviceName);
        const aliasMaps = (0, alias_maps_1.getAliasMaps)(targetDef, cache);
        const expNode = { name: node.name, columns: columnsOf(node, targetDef, cache).map((ref) => ({ ref: [ref] })) };
        const columns = queryLocal
            ? (0, column_builders_1.buildSelectedLocalColumns)(targetDef, expNode, meta.targetKeys)
            : (0, column_builders_1.buildSelectedRemoteColumns)(targetDef, expNode, aliasMaps, meta.targetKeys);
        const entity = queryLocal && serviceName !== req.service?.name
            ? meta.target
            : (meta.target.split('.').pop() || meta.target);
        const remoteSrv = await cds_1.default.connect.to(serviceName);
        const distinct = new Map();
        for (const row of rows)
            distinct.set((0, join_parser_1.buildParentJoinKey)(row, meta.localKeys), row);
        const parents = [...distinct.values()];
        const byKey = new Map();
        for (let i = 0; i < parents.length; i += exports.PATH_FETCH_CHUNK) {
            const where = (0, expand_materializer_1.buildAssociationJoinValues)(meta, parents.slice(i, i + exports.PATH_FETCH_CHUNK));
            if (!where.length)
                continue; // no usable parent keys in this chunk
            const query = SELECT.from(entity).columns(columns);
            const found = await (0, expand_materializer_1.fetchAssociatedRecords)(req, remoteSrv, meta, query, where, aliasMaps, targetDef, cache, log, !queryLocal);
            for (const [k, v] of found)
                byKey.set(k, Array.isArray(v) ? v[0] : v);
        }
        for (const row of rows)
            row[node.name] = byKey.get((0, join_parser_1.buildParentJoinKey)(row, meta.localKeys)) ?? null;
        const children = [...new Set(rows.map((r) => r[node.name]).filter(Boolean))];
        if (node.children.size > 0 && children.length > 0) {
            await resolveLevel(req, targetDef, node.children, children, cache, log);
        }
    }
};
const walk = (row, hops, leaf) => {
    let cur = row;
    for (const hop of hops) {
        cur = cur?.[hop];
        if (cur == null)
            return null;
    }
    return cur?.[leaf] ?? null;
};
/**
 * Fills the path elements of `records` (mutates them) and removes the
 * temporary {@link PATH_KEYS_PROP}. A broken chain (missing parent at any
 * hop) yields `null`, never an error.
 *
 * @param req        Incoming CAP request (user / tenant context for the sub-fetches).
 * @param plan       Column plan of the projection.
 * @param paths      Requested, to-one path columns.
 * @param records    Mapped rows carrying {@link PATH_KEYS_PROP}.
 * @param cache      Per-service metadata cache.
 * @param parentLog  Request-scoped logger.
 */
const resolvePathColumns = async (req, plan, paths, records, cache, parentLog) => {
    const log = parentLog.forModule(M);
    const keyNames = (0, exports.pathJoinKeyNames)(plan, paths, cache);
    const keyOf = (row) => JSON.stringify(keyNames.map((k) => row?.[exports.PATH_KEYS_PROP]?.[k] ?? null));
    // One parent object per distinct key combination, named like the source entity's elements.
    const parents = new Map();
    for (const row of records) {
        const key = keyOf(row);
        if (!parents.has(key))
            parents.set(key, Object.fromEntries(keyNames.map((k) => [k, row?.[exports.PATH_KEYS_PROP]?.[k]])));
    }
    log.info('resolvePathColumns', 'ENTER', {
        paths: paths.map((p) => `${p.hops.join('.')}.${p.leaf}`),
        rows: records.length,
        distinctParents: parents.size,
    });
    await resolveLevel(req, plan.sourceDef, buildTrie(plan, paths), [...parents.values()], cache, log);
    for (const row of records) {
        const parent = parents.get(keyOf(row));
        for (const p of paths)
            row[p.alias] = walk(parent, p.hops, p.leaf);
        delete row[exports.PATH_KEYS_PROP];
    }
    log.info('resolvePathColumns', 'EXIT', { rows: records.length });
};
exports.resolvePathColumns = resolvePathColumns;
/**
 * Evaluates calculated columns that read association paths, once their hidden
 * path elements have been filled by {@link resolvePathColumns}, and drops the
 * hidden elements. Overwrites the value the first (path-less) evaluation gave.
 *
 * @param records  Mapped rows whose hidden path elements are resolved (mutated).
 * @param columns  Requested calculated columns with association paths.
 */
const applyCalcPathColumns = (records, columns) => {
    for (const row of records) {
        for (const c of columns)
            row[c.alias] = (0, record_mapping_1.evaluateColumnExpression)(c.column, row);
        for (const c of columns)
            for (const p of c.paths)
                delete row[p.alias];
    }
};
exports.applyCalcPathColumns = applyCalcPathColumns;
