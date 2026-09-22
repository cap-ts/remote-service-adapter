"use strict";
/**
 * @file search-pushdown.ts
 * @description Builds the part of a `$search` that can be sent to the backend, so fewer rows come back.
 * The local match in `search.ts` still runs on those rows and has the final say.
 *
 * ## Soundness
 * The pushed filter may only drop rows that can not match. For every word `w` of the term it is
 *
 *     OR( contains(field, w)  for each searched field of the entity that can hold w,
 *         fk IN (keys of associated rows that match w)  for each to-one association searched
 *             (a composite key: OR of (k1 = .. AND k2 = ..) tuples),
 *         the pushable condition of each calculated column )
 *
 * and words are combined like the term is (`AND` / `OR`). `NOT` is not pushed (`TRUE`: a row that does not
 * contain a word can not be excluded before all its columns are known). Whenever a column can not be pushed the
 * word is not restricted at all (`TRUE`): a calculated column that is not a substring / simple CASE of one field, a
 * filtered or SOAP association, an association with too many matches (more than {@link SEARCH_MAX_QUERIES} x
 * {@link SEARCH_KEY_LIMIT} keys) or an answer the backend cut short.
 * Nothing is pushed for DISTINCT / GROUP BY projections (aggregates would change).
 *
 * ## Many matching keys
 * The keys of an associated entity are fetched page by page ({@link SEARCH_PREQUERY_PAGE} rows per call, completeness
 * checked against `$count`). An `IN` list of more than {@link SEARCH_KEY_LIMIT} keys (composite:
 * {@link SEARCH_TUPLE_LIMIT}) does not fit a URL, so the main read is split into up to {@link SEARCH_MAX_QUERIES}
 * queries with at most that many keys each, and the pipeline unions their rows. The field `contains` are only
 * in the first query (`A OR fk IN (keys)`: the others just look up the remaining keys). Only ONE oversized key list
 * can be split; a second one leaves the word unrestricted.
 *
 * ## Calculated columns
 * A calculated column is matched locally (it does not exist on the backend), but its word is still pushed when the
 * column is derived from ONE source field in a way that is exact or a superset: `left/right/substring/trim(field)`
 * (the result is a substring of the field: `contains(field, w)`; `upper/lower` only when the search ignores case), and a simple
 * `CASE field WHEN 'E' THEN 'Employee' ... END` (`field = 'E'` for each branch whose text holds the word; an `ELSE`
 * that holds the word leaves the word unrestricted). Any other expression (searched CASE, `concat`, `coalesce`, a
 * path) can not be pushed, so the word is not restricted and the local match does all the work for it.
 *
 * ## Column size
 * `contains` with a word longer than the field makes some backends fail, and can never match anyway: a field
 * whose declared length is shorter than the word is left out of the OR (exact, not just safe).
 *
 * ## Associations ("joined data becomes less at every association")
 * For `_Parent.Name as ParentName` the associated entity is asked first: which `Parent` rows contain the word
 * in `Name`? Their keys become `ParentID IN (...)` in the main filter. Deeper paths ask level by level, from the
 * last hop upwards, so each level only returns keys and the main fetch shrinks.
 *
 * ## Case
 * Follows the entity's search mode (`search-backend.ts`, from the backend its data comes from):
 * - case-SENSITIVE (OData V2): `contains(field, word)`, the word as typed. No function is sent: some V2 services
 *   (S/4 `API_BUSINESS_PARTNER`) reject `tolower`.
 * - case-INSENSITIVE (local, OData V4): `contains(tolower(field), lower-cased word)`. An associated entity whose
 *   own backend can not do that (OData V2) is not pushed: the word is not restricted for it.
 * Either way the pushed filter is exact for the columns it covers, and the local match uses the same case rule.
 * If a backend rejects the filter, the pipeline retries without it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSearchPushdown = exports.andWhere = exports.searchFieldOf = exports.containsCond = exports.SEARCH_MAX_PUSHDOWN_FIELDS = exports.SEARCH_PREQUERY_PAGE = exports.SEARCH_MAX_QUERIES = exports.SEARCH_TUPLE_LIMIT = exports.SEARCH_KEY_LIMIT = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const association_meta_1 = require("./association-meta");
const service_resolver_1 = require("./service-resolver");
const soap_adapter_1 = require("./soap-adapter");
const search_1 = require("./search");
const search_backend_1 = require("./search-backend");
const search_functions_1 = require("./search-functions");
const { SELECT } = cds_1.default.ql;
const M = 'search-pushdown';
/** Most keys in one `IN` list (URL length); more keys split the main read into several queries. */
exports.SEARCH_KEY_LIMIT = 200;
/** Most composite-key tuples in one `(k1 = .. and k2 = ..) or ...` list; more tuples split the main read. */
exports.SEARCH_TUPLE_LIMIT = 50;
/** Most queries a search is split into; with {@link SEARCH_KEY_LIMIT} it bounds the associated keys used (2000). */
exports.SEARCH_MAX_QUERIES = 10;
/** Rows per call when the keys of an associated entity are fetched. */
exports.SEARCH_PREQUERY_PAGE = 500;
/**
 * Most fields (plain + association paths + calculated) that are OR-ed into one pushed filter (URL length, backend
 * cost). Wider entities are not pushed: restrict them with an entity-level `@cds.search: { A, B }` list.
 */
exports.SEARCH_MAX_PUSHDOWN_FIELDS = 100;
// ---------------------------------------------------------------------------
// CQN building
// ---------------------------------------------------------------------------
const wrap = (tokens) => (tokens.length === 1 ? tokens[0] : { xpr: tokens });
const orOf = (parts) => {
    if (parts.includes('true'))
        return 'true';
    const items = parts.filter((p) => p !== 'false');
    if (items.length === 0)
        return 'false';
    if (items.length === 1)
        return items[0];
    return items.flatMap((p, i) => (i === 0 ? [wrap(p)] : ['or', wrap(p)]));
};
const andOf = (parts) => {
    if (parts.includes('false'))
        return 'false';
    const items = parts.filter((p) => p !== 'true');
    if (items.length === 0)
        return 'true';
    if (items.length === 1)
        return items[0];
    return items.flatMap((p, i) => (i === 0 ? [wrap(p)] : ['and', wrap(p)]));
};
/**
 * `contains(field, 'word')` (as typed), or for a case-insensitive search `contains(tolower(field), 'lower-cased word')`.
 */
const containsCond = (field, word, ignoreCase) => ignoreCase
    ? [{ func: 'contains', args: [{ func: 'tolower', args: [{ ref: [field] }] }, { val: word.toLowerCase() }] }]
    : [{ func: 'contains', args: [{ ref: [field] }, { val: word }] }];
exports.containsCond = containsCond;
const inCond = (field, values) => [
    { ref: [field] }, 'in', { list: [...values].map((val) => ({ val })) },
];
/**
 * ANDs a pushed filter onto an existing WHERE, grouping both so operator precedence can not change.
 *
 * @param where   The WHERE already on the query (may be empty).
 * @param pushed  The pushed search filter.
 */
/**
 * The field of the query a searched column is filtered on: the projection's SOURCE entity's own name (the alias map maps
 * `Title` -> `RemoteColumn`), or the element name for a locally served target.
 */
const searchFieldOf = (name, localToRemote, queryLocalTarget) => localToRemote[name] ?? (queryLocalTarget ? name : undefined);
exports.searchFieldOf = searchFieldOf;
const andWhere = (where, pushed) => where && where.length > 0 ? [{ xpr: where }, 'and', { xpr: pushed }] : [wrap(pushed)];
exports.andWhere = andWhere;
const keysPerQuery = (fieldCount) => (fieldCount === 1 ? exports.SEARCH_KEY_LIMIT : exports.SEARCH_TUPLE_LIMIT);
/** `fk IN (v1, v2)`, or for a composite key `(k1 = a AND k2 = b) OR (...)`. */
const listCond = (fields, tuples) => {
    if (fields.length === 1)
        return inCond(fields[0], tuples.map((t) => t[0]));
    return orOf(tuples.map((t) => andOf(fields.map((f, i) => [{ ref: [f] }, '=', { val: t[i] }]))));
};
/**
 * The condition "the key is one of `tuples`". A list too long for one URL becomes a placeholder token that
 * {@link expandChunks} turns into several queries (`chunkable` only for the main read, never inside a pre-query).
 */
const tupleCond = (fields, tuples, chunkable = false) => {
    if (tuples.length === 0)
        return 'false';
    if (chunkable && tuples.length > keysPerQuery(fields.length))
        return [{ __chunks: { fields, tuples } }];
    return listCond(fields, tuples);
};
const findChunkAtoms = (node, out) => {
    if (Array.isArray(node))
        node.forEach((n) => findChunkAtoms(n, out));
    else if (node && typeof node === 'object') {
        if (node.__chunks)
            out.push(node);
        else
            Object.values(node).forEach((n) => findChunkAtoms(n, out));
    }
};
const replaceAtom = (node, atom, by) => {
    if (node === atom)
        return by;
    if (Array.isArray(node))
        return node.map((n) => replaceAtom(n, atom, by));
    if (node && typeof node === 'object')
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, replaceAtom(v, atom, by)]));
    return node;
};
/**
 * Turns a condition that holds one oversized key list into the alternatives whose rows, unioned, are the rows of the
 * whole condition (it is monotone: no NOT is ever pushed). `undefined` when it holds several oversized lists.
 */
const expandChunks = (cond) => {
    const atoms = [];
    findChunkAtoms(cond, atoms);
    if (atoms.length === 0)
        return [cond];
    if (atoms.length > 1)
        return undefined;
    const atom = atoms[0];
    const { fields, tuples } = atom.__chunks;
    const per = keysPerQuery(fields.length);
    const groups = [];
    for (let i = 0; i < tuples.length; i += per)
        groups.push(tuples.slice(i, i + per));
    const listOf = (g) => wrap(listCond(fields, g));
    // `A OR fk IN (keys)`: the first query keeps A, the others only look up their keys (A is not read again)
    if (cond.includes(atom) && !cond.includes('and')) {
        return groups.map((g, i) => (i === 0 ? replaceAtom(cond, atom, listOf(g)) : [listOf(g)]));
    }
    return groups.map((g) => replaceAtom(cond, atom, listOf(g)));
};
/**
 * Keys of `owner` rows whose to-one association path `hops[0]. … .hops[n-1].leaf` contains `word`, or
 * `undefined` when that can not be pushed (see the file header).
 */
const matchingKeys = async (input, owner, hops, leaf, word, log, memo) => {
    const memoKey = `${owner?.name}|${hops.join('.')}|${leaf}|${word}`;
    const hit = memo.get(memoKey);
    if (hit)
        return hit;
    const run = async () => {
        const el = owner?.elements?.[hops[0]];
        if (!el?.target)
            return undefined;
        const meta = (0, association_meta_1.resolveAssociationMeta)(hops[0], owner, el.target, el, input.cache);
        // constant ON-conditions do not say which side they filter: not pushed
        if (!meta || meta.isToMany || meta.constantFilters?.length || meta.localKeys.length === 0 || meta.localKeys.length !== meta.targetKeys.length)
            return undefined;
        const maxKeys = keysPerQuery(meta.localKeys.length) * exports.SEARCH_MAX_QUERIES;
        const targetDef = cds_1.default.model?.definitions?.[meta.target];
        if (!targetDef)
            return undefined;
        const serviceName = (0, service_resolver_1.resolveServiceNameFromTarget)(meta.target);
        if ((0, soap_adapter_1.isSoapService)(serviceName))
            return undefined;
        // A case-insensitive search needs `tolower` on this backend as well; OData V2 (and unknown) backends can not.
        const targetMode = (0, search_backend_1.effectiveSearchMode)((0, search_backend_1.resolveSearchBackend)(targetDef));
        if (targetMode === 'none' || (input.mode === 'insensitive' && targetMode !== 'insensitive'))
            return undefined;
        const queryLocal = (0, service_resolver_1.usesLocalServiceSemantics)(serviceName);
        const { localToRemote } = (0, alias_maps_1.getAliasMaps)(targetDef, input.cache);
        const nameOf = (n) => (queryLocal ? n : localToRemote[n]);
        const namesOf = (ns) => {
            const out = ns.map(nameOf);
            return out.every(Boolean) ? out : undefined;
        };
        // What must hold for a row of the target: the leaf contains the word, or (deeper path) its own
        // association matches, which is asked first.
        let cond;
        if (hops.length === 1) {
            const leafEl = targetDef.elements?.[leaf];
            const field = nameOf(leaf);
            if (!leafEl || !field)
                return undefined;
            const length = typeof leafEl.length === 'number' ? leafEl.length : search_1.DEFAULT_STRING_LENGTH;
            cond = word.length <= length ? (0, exports.containsCond)(field, word, input.mode === 'insensitive') : 'false';
        }
        else {
            const child = await matchingKeys(input, targetDef, hops.slice(1), leaf, word, log, memo);
            const childFields = child && namesOf(child.fks);
            // a pre-query can not be split: a child list that does not fit one URL is not pushed
            if (!child || !childFields || child.tuples.length > keysPerQuery(child.fks.length))
                return undefined;
            cond = tupleCond(childFields, child.tuples);
        }
        if (cond === 'false')
            return { fks: meta.localKeys, tuples: [] };
        const keyFields = namesOf(meta.targetKeys);
        if (!keyFields)
            return undefined;
        const entity = queryLocal && serviceName !== input.req?.service?.name ? meta.target : meta.target.split('.').pop();
        const srv = await cds_1.default.connect.to(serviceName);
        const tx = typeof srv.tx === 'function' ? srv.tx(input.req) : srv;
        // Page by page until the backend's `$count` is reached. A total above the limit, or an answer the backend cut
        // short (fewer rows than `$count` although asked for more), leaves the key set incomplete: not pushed.
        const collected = [];
        let total;
        for (let offset = 0, pages = 0;; pages++) {
            const query = SELECT.from(entity).columns(keyFields.map((f) => ({ ref: [f] }))).where(cond).limit(exports.SEARCH_PREQUERY_PAGE, offset);
            if (offset === 0)
                query.SELECT.count = true;
            const rows = await tx.run(query);
            const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
            if (offset === 0 && typeof rows?.$count === 'number')
                total = rows.$count;
            if (total !== undefined && total > maxKeys) {
                log.debug('matchingKeys', 'Not pushed: too many matches', { target: meta.target, word, total, maxKeys });
                return undefined;
            }
            collected.push(...list);
            offset += list.length;
            if (list.length === 0 || (total !== undefined ? collected.length >= total : list.length < exports.SEARCH_PREQUERY_PAGE))
                break;
            if (collected.length > maxKeys || pages > exports.SEARCH_MAX_QUERIES + 5)
                return undefined;
        }
        if (total !== undefined && collected.length < total) {
            log.debug('matchingKeys', 'Not pushed: truncated answer', { target: meta.target, word, rows: collected.length, total });
            return undefined;
        }
        const seen = new Map();
        for (const row of collected) {
            const tuple = keyFields.map((f) => row[f]);
            if (tuple.some((v) => v === undefined || v === null))
                continue;
            seen.set(JSON.stringify(tuple), tuple);
        }
        log.debug('matchingKeys', 'Association matched', { target: meta.target, hop: hops[0], word, keys: seen.size });
        return { fks: meta.localKeys, tuples: [...seen.values()] };
    };
    const promise = run().catch((err) => {
        let target = owner;
        for (const hop of hops)
            target = cds_1.default.model?.definitions?.[target?.elements?.[hop]?.target];
        // this association's backend can not evaluate a function we sent (tolower): remember it, then it is not asked that way again
        const fn = (0, search_functions_1.rejectedFunction)(err);
        if (target && fn && (0, search_functions_1.learnUnsupportedFunction)((0, search_backend_1.resolveSearchBackend)(target).service, fn))
            log.info('matchingKeys', 'Learned: the backend does not support this filter function', { function: fn });
        log.warn('matchingKeys', 'Association pre-query failed — not pushed', { target: owner?.elements?.[hops[0]]?.target, error: err?.message });
        return undefined;
    });
    memo.set(memoKey, promise);
    return promise;
};
// ---------------------------------------------------------------------------
// Calculated columns
// ---------------------------------------------------------------------------
/** Functions whose result is a substring of their first argument, unchanged. */
const SUBSTRING_FUNCS = new Set(['left', 'right', 'substring', 'substr', 'trim', 'ltrim', 'rtrim']);
/** ... and those that only change the case: still a substring when the search ignores case, otherwise not. */
const CASE_FUNCS = new Set(['tolower', 'lower', 'toupper', 'upper']);
/** The one source field a `left(f, 2)` / `trim(f)` expression is a substring of. */
const substringSource = (node, ignoreCase) => {
    if (node?.ref && node.ref.length === 1 && typeof node.ref[0] === 'string')
        return node.ref[0];
    const fn = String(node?.func ?? '').toLowerCase();
    if (node?.func && (SUBSTRING_FUNCS.has(fn) || (ignoreCase && CASE_FUNCS.has(fn))))
        return substringSource(node.args?.[0], ignoreCase);
    return undefined;
};
/** `CASE field WHEN 'a' THEN 'x' ... [ELSE 'z'] END` with literal branches. Anything else: `undefined`. */
const simpleCase = (xpr) => {
    if (!Array.isArray(xpr) || String(xpr[0]).toLowerCase() !== 'case')
        return undefined;
    const operand = xpr[1];
    if (!operand?.ref || operand.ref.length !== 1 || typeof operand.ref[0] !== 'string')
        return undefined;
    const whens = [];
    let i = 2;
    while (String(xpr[i]).toLowerCase() === 'when') {
        const when = xpr[i + 1];
        const then = xpr[i + 3];
        if (when?.val === undefined || String(xpr[i + 2]).toLowerCase() !== 'then' || then?.val === undefined)
            return undefined;
        whens.push({ when: when.val, then: String(then.val) });
        i += 4;
    }
    let otherwise;
    if (String(xpr[i]).toLowerCase() === 'else') {
        if (xpr[i + 1]?.val === undefined)
            return undefined;
        otherwise = String(xpr[i + 1].val);
        i += 2;
    }
    return String(xpr[i]).toLowerCase() === 'end' && whens.length > 0 ? { operand: operand.ref[0], whens, otherwise } : undefined;
};
/** The pushable condition of `word` in a calculated column (see the file header), `'true'` when there is none. */
const calcCond = (col, word, sourceDef, ignoreCase) => {
    const sub = substringSource(col, ignoreCase);
    if (sub) {
        const el = sourceDef?.elements?.[sub];
        if (!el)
            return 'true';
        return word.length <= (typeof el.length === 'number' ? el.length : search_1.DEFAULT_STRING_LENGTH) ? (0, exports.containsCond)(sub, word, ignoreCase) : 'false';
    }
    const cs = simpleCase(col?.xpr);
    if (cs && sourceDef?.elements?.[cs.operand]) {
        // the ELSE branch (also taken for a NULL operand) can not be expressed without listing every other value
        const holds = (text) => (ignoreCase ? text.toLowerCase().includes(word.toLowerCase()) : text.includes(word));
        if (cs.otherwise !== undefined && holds(cs.otherwise))
            return 'true';
        return orOf(cs.whens.filter((w) => holds(w.then)).map((w) => [{ ref: [cs.operand] }, '=', { val: w.when }]));
    }
    return 'true';
};
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/**
 * Plans the pushed-down part of a `$search`.
 *
 * @param input  See {@link PushdownInput}.
 * @returns      `{ where }` to AND onto the backend query, `{ none: true }` when nothing can match, or `{ reason }`
 *               when nothing is pushed (the local match then does all the work).
 */
const buildSearchPushdown = async (input) => {
    const log = input.log.forModule(M);
    const { columns, plan, tree } = input;
    const plain = columns.filter((c) => c.kind === 'plain');
    const pathColumns = columns.filter((c) => c.kind === 'path');
    const calcColumns = columns.filter((c) => c.kind === 'calc');
    if (plain.length + pathColumns.length + calcColumns.length > exports.SEARCH_MAX_PUSHDOWN_FIELDS) {
        return { reason: `more than ${exports.SEARCH_MAX_PUSHDOWN_FIELDS} searched columns` };
    }
    // The query goes to the projection's SOURCE entity: its own field names (the alias map maps `Title` -> `RemoteColumn`).
    const fieldOf = (name) => input.localToRemote[name] ?? (input.queryLocalTarget ? name : undefined);
    if (plain.some((c) => !fieldOf(c.name)))
        return { reason: 'a searched column has no backend field' };
    const paths = [];
    for (const c of pathColumns) {
        const p = plan.paths.get(c.name);
        if (!p || p.kind !== 'toOne')
            return { reason: `path column '${c.name}' can not be resolved` };
        paths.push(p);
    }
    const projection = (0, alias_maps_1.collectProjectionColumns)(input.entityDef);
    const calcDefs = calcColumns.map((c) => projection.find((col) => col?.as === c.name));
    if (calcDefs.some((d) => !d))
        return { reason: 'a calculated column has no projection expression' };
    const ignoreCase = input.mode === 'insensitive';
    const memo = new Map();
    const words = new Map();
    const wordCond = (word) => {
        let cond = words.get(word);
        if (!cond) {
            cond = (async () => {
                const parts = new Map(); // de-duplicated (a calculated column repeats its source field)
                const add = (c) => { if (c !== 'false')
                    parts.set(JSON.stringify(c), c); };
                // only columns that are long enough to hold the word: fewer contains() clauses, and none can fail on length
                for (const c of plain)
                    if (word.length <= c.length)
                        add((0, exports.containsCond)(fieldOf(c.name), word, ignoreCase));
                for (const def of calcDefs) {
                    const c = calcCond(def, word, plan.sourceDef, ignoreCase);
                    if (c === 'true')
                        return 'true'; // not pushable: the word is not restricted
                    add(c);
                }
                const byFks = new Map();
                const matches = await Promise.all(paths.map((p) => matchingKeys(input, plan.sourceDef, p.hops, p.leaf, word, log, memo)));
                for (const m of matches) {
                    if (!m)
                        return 'true'; // this association can not be pushed: the word is not restricted
                    const group = byFks.get(m.fks.join('|')) ?? { fks: m.fks, tuples: new Map() };
                    for (const t of m.tuples)
                        group.tuples.set(JSON.stringify(t), t);
                    byFks.set(m.fks.join('|'), group);
                }
                for (const g of byFks.values())
                    add(tupleCond(g.fks, [...g.tuples.values()], true));
                return orOf([...parts.values()]);
            })();
            words.set(word, cond);
        }
        return cond;
    };
    const combine = async (node) => {
        if (node.k === 'term')
            return wordCond(node.v);
        if (node.k === 'not')
            return 'true';
        const parts = await Promise.all(node.n.map(combine));
        return node.k === 'and' ? andOf(parts) : orOf(parts);
    };
    const cond = await combine(tree);
    log.debug('buildSearchPushdown', 'Planned', {
        words: [...(0, search_1.searchTerms)(tree)],
        outcome: cond === 'true' ? 'nothing pushed' : cond === 'false' ? 'no row can match' : 'filter',
    });
    if (cond === 'true')
        return { reason: 'the term can not be restricted (NOT, unpushable column or association)' };
    if (cond === 'false')
        return { none: true };
    const wheres = expandChunks(cond);
    if (!wheres)
        return { reason: 'more than one association has too many matching keys for one query' };
    return { wheres };
};
exports.buildSearchPushdown = buildSearchPushdown;
