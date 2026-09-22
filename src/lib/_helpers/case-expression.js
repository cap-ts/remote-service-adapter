"use strict";
/**
 * @file case-expression.ts
 * @description In-memory evaluation of CQN `CASE` expressions used by
 * projection columns:
 *
 *   `CASE T WHEN 'E' THEN 'Employee' ELSE 'Unknown' END`        (simple form)
 *   `CASE WHEN Amount > 15 THEN 'big' ELSE 'small' END`         (searched form)
 *
 * CQN shape: `xpr: ['case', [subject], 'when', <cond|value…>, 'then', <result>, …, 'else', <result>, 'end']`.
 * Branches are evaluated top-down; no matching branch and no ELSE yields `null`.
 * Results may be nested CASE expressions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateCaseExpression = exports.isCaseExpression = void 0;
const where_eval_1 = require("./where-eval");
const isKeyword = (t, kw) => typeof t === 'string' && t.toLowerCase() === kw;
/** `true` when `xpr` is a CASE expression. */
const isCaseExpression = (xpr) => Array.isArray(xpr) && isKeyword(xpr[0], 'case');
exports.isCaseExpression = isCaseExpression;
const operand = (tokens, row) => {
    if (tokens.length === 0)
        return undefined;
    const t = tokens[0];
    if (t && typeof t === 'object' && (0, exports.isCaseExpression)(t.xpr))
        return (0, exports.evaluateCaseExpression)(t.xpr, row);
    return (0, where_eval_1.evaluateOperand)(t, row);
};
/**
 * Evaluates a CASE expression against a (mapped, local) record.
 *
 * @param xpr  CQN `xpr` array starting with `'case'`.
 * @param row  Record providing field values.
 * @returns    Result of the first matching branch, the ELSE result, or `null`.
 */
const evaluateCaseExpression = (xpr, row) => {
    let i = 1;
    let subject;
    if (!isKeyword(xpr[i], 'when')) {
        subject = [xpr[i]];
        i++;
    }
    const until = (stops) => {
        const out = [];
        while (i < xpr.length && !stops.some((s) => isKeyword(xpr[i], s)))
            out.push(xpr[i++]);
        return out;
    };
    const subjectValue = subject ? operand(subject, row) : undefined;
    while (i < xpr.length && isKeyword(xpr[i], 'when')) {
        i++;
        const whenTokens = until(['then']);
        i++; // 'then'
        const resultTokens = until(['when', 'else', 'end']);
        const matched = subject
            ? (0, where_eval_1.compareValues)(subjectValue, operand(whenTokens, row), '=')
            : (0, where_eval_1.evaluateWhereOnRecord)(whenTokens, row);
        if (matched)
            return operand(resultTokens, row) ?? null;
    }
    if (isKeyword(xpr[i], 'else')) {
        i++;
        return operand(until(['end']), row) ?? null;
    }
    return null;
};
exports.evaluateCaseExpression = evaluateCaseExpression;
