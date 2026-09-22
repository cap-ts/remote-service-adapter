"use strict";
/**
 * @file where-eval.ts
 * @description In-memory evaluator for CQN WHERE expressions.
 *
 * A tiny recursive-descent parser (`parseOr` → `parseAnd` → `parsePrimary`)
 * plus operand and OData-function evaluation. Used when predicates cannot be
 * pushed to the remote backend (see {@link ./where-split.ts splitWhereClause}).
 *
 * ### Supported OData functions
 * - **Search / logical**: `startswith`, `endswith`, `contains`, `indexof`
 * - **String transforms**: `tolower`/`lower`, `toupper`/`upper`, `length`, `trim`
 * - **String slicing**: `left`, `right`, `substring`/`substr`, `concat`, `replace`
 * - **Null guards**: `coalesce`, `ifnull`
 * - **Math**: `round`, `floor`, `ceil`/`ceiling`, `abs`
 * - **Date parts**: `year`, `month`, `day`
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateWhereOnRecord = exports.evaluateOperand = exports.evaluateFunctionOperand = exports.toBoolean = exports.compareValues = exports.isComparisonOperator = exports.readPathValue = void 0;
/**
 * Reads a dotted / slash-separated navigation path from a record.
 * When intermediate values are arrays, the read "fans out" and collects
 * all non-null child values into an array.
 *
 * @param row  Source record.
 * @param ref  CQN ref array (e.g. `['to_Partner', 'Country']`) or
 *             a single slash-encoded path (`['to_Partner/Country']`).
 * @returns    The resolved value (scalar or array).
 */
const readPathValue = (row, ref) => {
    const expandedRef = ref.length === 1 && typeof ref[0] === 'string' && ref[0].includes('/')
        ? ref[0].split('/').filter(Boolean)
        : ref;
    let current = row;
    for (const segment of expandedRef) {
        if (current === null || current === undefined)
            return undefined;
        if (Array.isArray(current)) {
            current = current
                .map((item) => item?.[segment])
                .filter((v) => v !== undefined && v !== null);
        }
        else {
            current = current[segment];
        }
    }
    return current;
};
exports.readPathValue = readPathValue;
/**
 * Recognises CQN / OData comparison operators (`=`, `==`, `eq`, `!=`, `<>`,
 * `ne`, `>`, `>=`, `<`, `<=`). Case-insensitive.
 *
 * @param op  Operator token candidate.
 */
const isComparisonOperator = (op) => {
    if (typeof op !== 'string')
        return false;
    const normalized = op.toLowerCase();
    return normalized === '='
        || normalized === '=='
        || normalized === 'eq'
        || normalized === '!='
        || normalized === '<>'
        || normalized === 'ne'
        || normalized === '>'
        || normalized === '>='
        || normalized === '<'
        || normalized === '<=';
};
exports.isComparisonOperator = isComparisonOperator;
/**
 * Compares two values (or value arrays) with the given CQN operator.
 * Array operands succeed if **any** left value matches **any** right value —
 * required so array-fanned associations behave like OData `any()`.
 *
 * @param left   Left-hand operand (scalar or array).
 * @param right  Right-hand operand (scalar or array).
 * @param op     Comparison operator as returned by {@link isComparisonOperator}.
 */
const compareValues = (left, right, op) => {
    const lhs = Array.isArray(left) ? left : [left];
    const rhs = Array.isArray(right) ? right : [right];
    const normalized = op.toLowerCase();
    for (const l of lhs) {
        for (const r of rhs) {
            if (normalized === '=' || normalized === '==' || normalized === 'eq') {
                if (l == r)
                    return true;
            }
            else if (normalized === '!=' || normalized === '<>' || normalized === 'ne') {
                if (l != r)
                    return true;
            }
            else if (normalized === '>') {
                if (l > r)
                    return true;
            }
            else if (normalized === '>=') {
                if (l >= r)
                    return true;
            }
            else if (normalized === '<') {
                if (l < r)
                    return true;
            }
            else if (normalized === '<=') {
                if (l <= r)
                    return true;
            }
        }
    }
    return false;
};
exports.compareValues = compareValues;
/**
 * Coerces a value to boolean; arrays are truthy when any element is truthy.
 */
const toBoolean = (value) => {
    if (Array.isArray(value))
        return value.some((v) => !!v);
    return !!value;
};
exports.toBoolean = toBoolean;
/**
 * Evaluates OData-style function calls against a record. See file JSDoc for
 * the full function catalogue.
 *
 * @param token  CQN function node (`{ func, args }`).
 * @param row    Record providing field values.
 * @returns      Function result, or `undefined` for unsupported functions.
 */
const evaluateFunctionOperand = (token, row) => {
    const func = String(token.func || '').toLowerCase();
    const args = (token.args || []).map((a) => (0, exports.evaluateOperand)(a, row));
    const normalizePathArg = (value) => {
        if (typeof value === 'string' && value.includes('/')) {
            return (0, exports.readPathValue)(row, [value]);
        }
        return value;
    };
    const getSingleString = (arg) => {
        const val = normalizePathArg(arg);
        if (Array.isArray(val))
            return String(val[0] ?? '');
        return String(val ?? '');
    };
    if (func === 'startswith') {
        const value = normalizePathArg(args[0]);
        const prefix = args[1];
        if (Array.isArray(value))
            return value.some((v) => String(v ?? '').startsWith(String(prefix ?? '')));
        return String(value ?? '').startsWith(String(prefix ?? ''));
    }
    if (func === 'contains') {
        const value = normalizePathArg(args[0]);
        const part = args[1];
        if (Array.isArray(value))
            return value.some((v) => String(v ?? '').includes(String(part ?? '')));
        return String(value ?? '').includes(String(part ?? ''));
    }
    if (func === 'endswith') {
        const value = normalizePathArg(args[0]);
        const suffix = args[1];
        if (Array.isArray(value))
            return value.some((v) => String(v ?? '').endsWith(String(suffix ?? '')));
        return String(value ?? '').endsWith(String(suffix ?? ''));
    }
    if (func === 'indexof') {
        const value = getSingleString(args[0]);
        const part = String(args[1] ?? '');
        return value.indexOf(part);
    }
    if (func === 'tolower' || func === 'lower')
        return getSingleString(args[0]).toLowerCase();
    if (func === 'toupper' || func === 'upper')
        return getSingleString(args[0]).toUpperCase();
    if (func === 'length')
        return getSingleString(args[0]).length;
    if (func === 'trim')
        return getSingleString(args[0]).trim();
    if (func === 'left') {
        const value = getSingleString(args[0]);
        const length = Number(args[1] ?? 0);
        return value.substring(0, length);
    }
    if (func === 'right') {
        const str = getSingleString(args[0]);
        const len = Number(args[1] ?? 0);
        return str.length <= len ? str : str.slice(-len);
    }
    if (func === 'substring' || func === 'substr') {
        const str = getSingleString(args[0]);
        const start = Number(args[1] ?? 0);
        const length = args[2] !== undefined ? Number(args[2]) : undefined;
        return length !== undefined ? str.substring(start, start + length) : str.substring(start);
    }
    if (func === 'concat') {
        return args.map((a) => getSingleString(a)).join('');
    }
    if (func === 'replace') {
        const str = getSingleString(args[0]);
        const search = String(args[1] ?? '');
        const replace = String(args[2] ?? '');
        return str.split(search).join(replace);
    }
    if (func === 'coalesce') {
        return args.map(normalizePathArg).find((a) => a !== null && a !== undefined && a !== '') ?? null;
    }
    if (func === 'ifnull') {
        const val = normalizePathArg(args[0]);
        return (val !== null && val !== undefined) ? val : normalizePathArg(args[1]);
    }
    if (func === 'round') {
        const num = Number(normalizePathArg(args[0]) ?? 0);
        const decimals = Number(args[1] ?? 0);
        return Number(Math.round(Number(num + 'e' + decimals)) + 'e-' + decimals);
    }
    if (func === 'floor')
        return Math.floor(Number(normalizePathArg(args[0]) ?? 0));
    if (func === 'ceil' || func === 'ceiling')
        return Math.ceil(Number(normalizePathArg(args[0]) ?? 0));
    if (func === 'abs')
        return Math.abs(Number(normalizePathArg(args[0]) ?? 0));
    if (func === 'year') {
        const raw = normalizePathArg(args[0]);
        return raw ? new Date(raw).getUTCFullYear() : null;
    }
    if (func === 'month') {
        const raw = normalizePathArg(args[0]);
        return raw ? new Date(raw).getUTCMonth() + 1 : null;
    }
    if (func === 'day') {
        const raw = normalizePathArg(args[0]);
        return raw ? new Date(raw).getUTCDate() : null;
    }
    return undefined;
};
exports.evaluateFunctionOperand = evaluateFunctionOperand;
/**
 * Resolves a single CQN operand node against a record: literal values,
 * `ref` (field paths), `func` (OData functions), `xpr` (sub-expressions),
 * and `list` (IN-clause value lists).
 *
 * @param token  CQN operand node.
 * @param row    Record providing field values.
 */
const evaluateOperand = (token, row) => {
    if (token === null || token === undefined)
        return token;
    if (Array.isArray(token))
        return (0, exports.evaluateWhereOnRecord)(token, row);
    if (typeof token !== 'object')
        return token;
    if (Object.prototype.hasOwnProperty.call(token, 'val'))
        return token.val;
    if (Array.isArray(token.ref))
        return (0, exports.readPathValue)(row, token.ref);
    if (token.func)
        return (0, exports.evaluateFunctionOperand)(token, row);
    if (token.xpr)
        return (0, exports.evaluateWhereOnRecord)(token.xpr, row);
    if (Array.isArray(token.list))
        return token.list.map((x) => (0, exports.evaluateOperand)(x, row));
    return token;
};
exports.evaluateOperand = evaluateOperand;
/**
 * Evaluates a CQN WHERE expression against a single record in memory.
 * Uses a small recursive-descent parser with `parseOr` → `parseAnd` →
 * `parsePrimary` and supports parenthesised sub-expressions.
 *
 * @param where  CQN WHERE token array (or a single expression node).
 * @param row    The record to test.
 * @returns      `true` when the record matches the WHERE expression.
 */
const evaluateWhereOnRecord = (where, row) => {
    if (!Array.isArray(where))
        return (0, exports.toBoolean)((0, exports.evaluateOperand)(where, row));
    const tokens = where;
    let index = 0;
    const peek = () => tokens[index];
    const consume = () => tokens[index++];
    const parsePrimary = () => {
        const token = peek();
        if (token === '(') {
            consume();
            const value = parseOr();
            if (peek() === ')')
                consume();
            return value;
        }
        const left = (0, exports.evaluateOperand)(consume(), row);
        const op = peek();
        if ((0, exports.isComparisonOperator)(op)) {
            consume();
            const right = (0, exports.evaluateOperand)(consume(), row);
            return (0, exports.compareValues)(left, right, op);
        }
        return (0, exports.toBoolean)(left);
    };
    const parseAnd = () => {
        let value = parsePrimary();
        while (typeof peek() === 'string' && String(peek()).toLowerCase() === 'and') {
            consume();
            value = value && parsePrimary();
        }
        return value;
    };
    const parseOr = () => {
        let value = parseAnd();
        while (typeof peek() === 'string' && String(peek()).toLowerCase() === 'or') {
            consume();
            value = value || parseAnd();
        }
        return value;
    };
    return parseOr();
};
exports.evaluateWhereOnRecord = evaluateWhereOnRecord;
