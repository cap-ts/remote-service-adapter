"use strict";
/**
 * @file search.ts
 * @description In-memory `$search` (`req.query.SELECT.search`).
 *
 * `SELECT.search` is never forwarded as such: backends either do not support it or search their own field
 * names, not the projection's. Instead the term is (1) pushed down as far as it is safe (`search-pushdown.ts`:
 * `contains(field, word)` on the entity and on associated entities, so fewer rows come back) and
 * (2) always matched again here on the rows that came back, after mapping and after association-path and
 * calculated elements are resolved. (2) has the final say; (1) only narrows.
 *
 * ## Semantics (OData V4 `$search` syntax, "contains")
 * - Words are ANDed (`a b` = `a AND b`), `OR` and `NOT` are supported, precedence `NOT` > `AND` > `OR`,
 *   `( )` group, `"a phrase"` matches the phrase. Keywords are upper case only, as in OData.
 * - A word matches a row when it is contained in ANY searched column: exactly as typed (case-sensitive) or ignoring
 *   case, depending on the backend the entity's data comes from (`search-backend.ts`: OData V2 = case-sensitive,
 *   local / OData V4 = case-insensitive, SOAP = no search). It is what the backend's `contains` can do, so the pushed
 *   filter is exact.
 * - Blank / operator-only terms search nothing and return the rows unchanged.
 *
 * ## Searched columns ({@link getSearchColumns})
 * String elements of the entity, keys included, string elements read through to-one associations
 * (`_Parent.Name as ParentName`) and calculated string columns (`LEFT(x, 2) as Short`; searched locally only).
 * Never searched: to-many paths (1:N, M:N), associations, virtual elements, `LargeString`, `UUID`, and
 * `String(n)` longer than {@link MAX_SEARCH_COLUMN_LENGTH}. `@cds.search: false` on an element excludes it (also a
 * key), `@cds.search: true` forces it in (also a long string), and an entity-level `@cds.search: { A, B }`
 * restricts the search to A and B.
 *
 * ## Cost
 * Local matching is O(rows x searched columns): one string per row, one `includes` per word. The
 * backend can not page (the local pass may drop more rows), so `$top` / `$count` are applied afterwards.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSearchColumns = exports.getSearchColumnInfo = exports.explicitSearchNames = exports.applySearch = exports.searchToTerm = exports.searchTerms = exports.parseSearchTerm = exports.DEFAULT_STRING_LENGTH = exports.SEARCH_WARN_ROWS = exports.SEARCH_LOCAL_MAX_ROWS = exports.MAX_SEARCH_COLUMN_LENGTH = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
const calc_dependencies_1 = require("./calc-dependencies");
const path_columns_1 = require("./path-columns");
/** `String(n)` columns longer than this are treated as free text (descriptions, notes) and are not searched. */
exports.MAX_SEARCH_COLUMN_LENGTH = 500;
/**
 * Most rows a search may read when it can NOT be pushed to the backend (the local match then needs every row). An
 * entity with more rows fails with a clear message instead of an unbounded read (time-outs, responses too large to hold).
 */
exports.SEARCH_LOCAL_MAX_ROWS = 5000;
/** Rows scanned above which the pipeline logs a warning: a search then means a large in-memory scan. */
exports.SEARCH_WARN_ROWS = 5000;
/** Separates column values in a row's haystack so a term can never match across two columns. */
const SEP = '\u0001';
/** Length assumed for a string element without a declared length (the CDS default of `cds.String`). */
exports.DEFAULT_STRING_LENGTH = 255;
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
/** Splits a term into words, phrases, operators and parentheses. Never throws; unmatched `)` are dropped. */
const tokenize = (input) => {
    const out = [];
    let depth = 0;
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (isSpace(ch)) {
            i++;
            continue;
        }
        if (ch === '(') {
            depth++;
            out.push({ t: '(' });
            i++;
            continue;
        }
        if (ch === ')') {
            if (depth > 0) {
                depth--;
                out.push({ t: ')' });
            }
            i++;
            continue;
        }
        if (ch === '"') {
            let phrase = '';
            i++;
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '\\' && i + 1 < input.length)
                    i++;
                phrase += input[i++];
            }
            i++; // closing quote (a missing one ends the phrase at the end of the input)
            if (phrase)
                out.push({ t: 'term', v: phrase });
            continue;
        }
        let j = i;
        while (j < input.length && !isSpace(input[j]) && input[j] !== '(' && input[j] !== ')' && input[j] !== '"')
            j++;
        const word = input.slice(i, j);
        i = j;
        out.push(word === 'AND' ? { t: 'and' } : word === 'OR' ? { t: 'or' } : word === 'NOT' ? { t: 'not' } : { t: 'term', v: word });
    }
    return out;
};
const join = (k, parts) => parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { k, n: parts };
/** Recursive descent over the tokens; tolerant: dangling operators are ignored, every loop consumes input. */
const parse = (tokens) => {
    let p = 0;
    const peek = () => tokens[p];
    const primary = () => {
        const tk = peek();
        if (!tk)
            return undefined;
        if (tk.t === 'term') {
            p++;
            return { k: 'term', v: tk.v };
        }
        if (tk.t === '(') {
            p++;
            const inner = orExpr();
            if (peek()?.t === ')')
                p++;
            return inner;
        }
        return undefined;
    };
    const notExpr = () => {
        if (peek()?.t === 'not') {
            p++;
            const inner = notExpr();
            return inner ? { k: 'not', n: inner } : undefined;
        }
        return primary();
    };
    const andExpr = () => {
        const parts = [];
        for (;;) {
            const tk = peek();
            if (tk?.t === 'and') {
                p++;
                continue;
            }
            if (!tk || tk.t === 'or' || tk.t === ')')
                break;
            const part = notExpr();
            if (part)
                parts.push(part);
        }
        return join('and', parts);
    };
    const orExpr = () => {
        const parts = [];
        for (;;) {
            const part = andExpr();
            if (part)
                parts.push(part);
            if (peek()?.t === 'or') {
                p++;
                continue;
            }
            break;
        }
        return join('or', parts);
    };
    return orExpr();
};
/**
 * Parses an OData `$search` term (see the file header). Never throws.
 *
 * @param term  The term as typed.
 * @returns     The parse tree, or `undefined` for a blank / operator-only term (nothing to search for).
 */
const parseSearchTerm = (term) => parse(tokenize(String(term ?? '')));
exports.parseSearchTerm = parseSearchTerm;
/** The distinct words / phrases of a parse tree. */
const searchTerms = (node, out = new Set()) => {
    if (!node)
        return out;
    if (node.k === 'term')
        out.add(node.v);
    else if (node.k === 'not')
        (0, exports.searchTerms)(node.n, out);
    else
        for (const child of node.n)
            (0, exports.searchTerms)(child, out);
    return out;
};
exports.searchTerms = searchTerms;
const toPredicate = (node, ignoreCase) => {
    if (node.k === 'term') {
        const v = ignoreCase ? node.v.toLowerCase() : node.v;
        return (h) => h.includes(v);
    }
    if (node.k === 'not') {
        const inner = toPredicate(node.n, ignoreCase);
        return (h) => !inner(h);
    }
    const parts = node.n.map((n) => toPredicate(n, ignoreCase));
    return node.k === 'and' ? (h) => parts.every((f) => f(h)) : (h) => parts.some((f) => f(h));
};
/**
 * Renders `SELECT.search` (CQN) as an OData `$search` term. CAP puts the raw `$search` string into one `{ val }`;
 * `SELECT.search('a', 'b')` gives `[{ val: 'a' }, 'or', { val: 'b' }]`.
 *
 * @param search  `SELECT.search` of the incoming CQN.
 * @returns       The term, or `''` when there is none.
 */
const searchToTerm = (search) => {
    if (!Array.isArray(search) || search.length === 0)
        return '';
    const render = (tokens) => {
        const single = tokens.length === 1;
        return tokens
            .map((tk) => {
            if (typeof tk === 'string') {
                const op = tk.toLowerCase();
                return op === 'and' ? 'AND' : op === 'or' ? 'OR' : op === 'not' ? 'NOT' : '';
            }
            if (tk?.xpr)
                return `(${render(tk.xpr)})`;
            if (tk?.val !== undefined && tk.val !== null)
                return single ? String(tk.val) : `(${String(tk.val)})`;
            return '';
        })
            .filter(Boolean)
            .join(' ');
    };
    return render(search);
};
exports.searchToTerm = searchToTerm;
// ============================================================================
// Matching
// ============================================================================
/** One string holding every searched value of the row. */
const haystackOf = (row, columns, ignoreCase) => {
    let hay = '';
    for (const col of columns) {
        const v = row?.[col];
        if (v === null || v === undefined || v === '')
            continue;
        const text = typeof v === 'string' ? v : String(v);
        hay += (ignoreCase ? text.toLowerCase() : text) + SEP;
    }
    return hay;
};
/**
 * Keeps the rows in which `term` is contained (case-sensitive unless `options.ignoreCase`) in at least one of `columns`.
 * See the file header for the term syntax. Does not mutate `data`.
 *
 * @param data     Rows (plain objects, already in the shape the columns refer to).
 * @param term     OData `$search` term.
 * @param columns  Property names to search. Duplicates are ignored; with none, no positive term can match.
 * @param options  `ignoreCase`: compare upper / lower case alike (default: exactly as typed).
 * @returns        The matching rows, in their original order. All rows when `term` is blank.
 */
const applySearch = (data, term, columns, options = {}) => {
    if (!Array.isArray(data) || data.length === 0)
        return data;
    const tree = (0, exports.parseSearchTerm)(term);
    if (!tree)
        return data;
    const ignoreCase = !!options.ignoreCase;
    const match = toPredicate(tree, ignoreCase);
    const cols = [...new Set(columns)];
    return data.filter((row) => match(haystackOf(row, cols, ignoreCase)));
};
exports.applySearch = applySearch;
// ============================================================================
// Column selection
// ============================================================================
const STRING_TYPES = new Set(['cds.String', 'cds.hana.VARCHAR', 'cds.hana.NVARCHAR', 'cds.hana.CHAR', 'cds.hana.NCHAR']);
/** Resolves a (custom) type name down to its `cds.*` built-in. */
const builtinType = (type) => {
    let t = type;
    for (let i = 0; typeof t === 'string' && !t.startsWith('cds.') && i < 10; i++)
        t = cds_1.default.model?.definitions?.[t]?.type;
    return typeof t === 'string' ? t : undefined;
};
/**
 * Element names listed by an entity-level `@cds.search: { A, B }` (compiled to `@cds.search.A = true`, ...).
 * They must be elements of the entity that is read (for a path column its alias, e.g. `SearchTerm`, not
 * `SearchTerm1`); other names are ignored, the pipeline logs them.
 *
 * @param entityDef  CDS entity definition.
 */
const explicitSearchNames = (entityDef) => Object.keys(entityDef ?? {})
    .filter((k) => k.startsWith('@cds.search.') && entityDef[k] === true)
    .map((k) => k.slice('@cds.search.'.length));
exports.explicitSearchNames = explicitSearchNames;
/**
 * The columns `$search` looks at, in definition order (memoised per entity when `opts` is omitted).
 * Includes string elements read through to-one associations; the pipeline resolves those before matching.
 *
 * @param entityDef  CDS entity definition.
 * @param cache      Per-service metadata cache.
 * @param opts       See {@link SearchOptions}.
 */
const getSearchColumnInfo = (entityDef, cache, opts = {}) => {
    const cacheable = opts.includeKeys === undefined && opts.maxLength === undefined;
    if (cacheable) {
        const hit = cache.searchColumns.get(entityDef);
        if (hit)
            return hit;
    }
    const plan = (0, path_columns_1.getColumnPlan)(entityDef, cache);
    const computed = (0, calc_dependencies_1.getComputedAliases)(entityDef);
    const includeKeys = opts.includeKeys ?? true;
    const maxLength = opts.maxLength ?? exports.MAX_SEARCH_COLUMN_LENGTH;
    const explicit = new Set((0, exports.explicitSearchNames)(entityDef));
    /** Element kinds that can never be searched, whatever the annotations say. */
    const isSearchableKind = (name, el) => !!el
        && !name.startsWith('$')
        && !(0, alias_maps_1.isAssociationElement)(el)
        && !el['@odata.foreignKey4']
        && !el.virtual
        && (computed.has(name) || (!el.$calc && !el.value))
        && STRING_TYPES.has(builtinType(el.type))
        && (plan.paths.get(name)?.kind ?? 'toOne') === 'toOne'; // never 1:N / M:N
    const columns = [];
    for (const [name, el] of Object.entries(entityDef?.elements ?? {})) {
        if (!isSearchableKind(name, el) || el['@cds.search'] === false)
            continue;
        if (explicit.size > 0) {
            if (!explicit.has(name))
                continue;
        }
        else if (el['@cds.search'] !== true) {
            if (el.key && !includeKeys)
                continue;
            if (typeof el.length === 'number' && el.length > maxLength)
                continue;
        }
        columns.push({
            name,
            kind: plan.paths.has(name) ? 'path' : computed.has(name) ? 'calc' : 'plain',
            length: typeof el.length === 'number' ? el.length : exports.DEFAULT_STRING_LENGTH,
        });
    }
    if (cacheable)
        cache.searchColumns.set(entityDef, columns);
    return columns;
};
exports.getSearchColumnInfo = getSearchColumnInfo;
/** Names of the columns `$search` looks at (see {@link getSearchColumnInfo}). */
const getSearchColumns = (entityDef, cache, opts = {}) => (0, exports.getSearchColumnInfo)(entityDef, cache, opts).map((c) => c.name);
exports.getSearchColumns = getSearchColumns;
