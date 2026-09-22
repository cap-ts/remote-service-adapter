"use strict";
/**
 * @file aggregation.ts
 * @description In-memory emulation of DISTINCT, GROUP BY, and aggregate
 * functions (`count`, `count_distinct`, `sum`, `avg`, `min`, `max`).
 *
 * Aggregation runs after the remote backend has returned raw rows, so any
 * physical source column referenced by an aggregate function must be
 * present in the SELECT — {@link injectAggregationSourceFields} guarantees this.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyGroupBy = exports.applyDistinct = exports.aggregate = exports.injectAggregationSourceFields = void 0;
const alias_maps_1 = require("./alias-maps");
/**
 * Ensures physical source columns referenced by aggregation functions are
 * fetched from the remote backend, even when the incoming SELECT does not
 * list them explicitly. Without this, `sum(Amount)` would fail because
 * `Amount` was never selected.
 *
 * @param entityDef      Local entity definition.
 * @param remoteQuery    Mutable remote query CQN.
 * @param localToRemote  Alias map.
 */
const injectAggregationSourceFields = (entityDef, remoteQuery, localToRemote) => {
    const columns = remoteQuery.SELECT.columns;
    if (!Array.isArray(columns) || columns[0] === '*')
        return;
    const projColumns = entityDef.projection?.columns || [];
    for (const col of projColumns) {
        if (!col.func || !col.args)
            continue;
        for (const arg of col.args) {
            if (!arg || typeof arg !== 'object' || !Array.isArray(arg.ref))
                continue;
            const field = arg.ref[0];
            const remoteField = localToRemote[field] || field;
            const exists = columns.some((c) => {
                const r = c.ref?.[0] || c;
                return r === remoteField || r === field;
            });
            if (!exists)
                columns.push({ ref: [remoteField] });
        }
    }
};
exports.injectAggregationSourceFields = injectAggregationSourceFields;
/**
 * Applies a single aggregation function over a group of records.
 *
 * Supported:
 * - `count`: including `count(*)` and `count(distinct field)`.
 * - `sum`:   coerces to Number, defaults to 0.
 * - `min` / `max`: numeric when all values are numeric, otherwise lexicographic.
 *
 * @param func        Aggregation function name (case-insensitive).
 * @param targetArg   Source field or `'*'`.
 * @param getValues   Lazy value provider (skips work for `count(*)`).
 * @param rowCount    Total row count in the current group.
 * @param isDistinct  `true` to deduplicate values before aggregating.
 */
const aggregate = (func, targetArg, getValues, rowCount, isDistinct) => {
    switch (func) {
        case 'count': {
            if (targetArg === '*')
                return rowCount;
            const values = getValues();
            return isDistinct ? new Set(values).size : values.length;
        }
        case 'count_distinct':
            return new Set(getValues()).size;
        case 'sum':
            return getValues().reduce((sum, v) => sum + Number(v || 0), 0);
        case 'avg': {
            const values = getValues();
            if (values.length === 0)
                return null;
            const nums = values.map((v) => Number(v));
            return nums.some((n) => isNaN(n)) ? null : nums.reduce((sum, n) => sum + n, 0) / nums.length;
        }
        case 'min':
        case 'max': {
            const values = getValues();
            if (values.length === 0)
                return null;
            const numeric = values.every((v) => !isNaN(Number(v)));
            if (numeric) {
                const nums = values.map((v) => Number(v));
                return func === 'min' ? Math.min(...nums) : Math.max(...nums);
            }
            return values.reduce((acc, cur) => (func === 'min' ? (cur < acc ? cur : acc) : cur > acc ? cur : acc), values[0]);
        }
        default:
            return undefined;
    }
};
exports.aggregate = aggregate;
/**
 * In-memory DISTINCT emulation. Deduplicates records by the concatenation
 * of all non-association, non-calculated key fields, and populates any
 * dynamic `count`-annotated elements with the size of each dedup group.
 *
 * @param entityDef      Local entity definition.
 * @param records        Raw remote records.
 * @param localToRemote  Alias map.
 * @returns              Deduplicated record set.
 */
const applyDistinct = (entityDef, records, localToRemote) => {
    const elements = entityDef.elements || {};
    const countElements = Object.keys(elements).filter((k) => elements[k].$calc?.func === 'count');
    const keyFields = Object.keys(elements).filter((k) => !(0, alias_maps_1.isAssociationElement)(elements[k]) && !elements[k].$calc);
    const uniqueRecords = new Map();
    for (const record of records) {
        const compositeKey = keyFields.map((k) => String(record[localToRemote[k] || k] ?? '')).join('|');
        const existing = uniqueRecords.get(compositeKey);
        if (existing) {
            existing.count += 1;
            for (const name of countElements)
                existing.ref[name] = existing.count;
        }
        else {
            for (const name of countElements)
                record[name] = 1;
            uniqueRecords.set(compositeKey, { ref: record, count: 1 });
        }
    }
    return Array.from(uniqueRecords.values(), (item) => item.ref);
};
exports.applyDistinct = applyDistinct;
/**
 * In-memory GROUP BY / aggregation emulation. Groups records by all projected
 * scalar fields and computes each aggregate function declared in the
 * projection's `columns` list.
 *
 * @param entityDef      Local entity definition.
 * @param records        Raw remote records.
 * @param localToRemote  Alias map.
 * @returns              Aggregated record set (one row per group).
 */
const applyGroupBy = (entityDef, records, localToRemote) => {
    const elements = entityDef.elements || {};
    const projColumns = entityDef.projection?.columns || [];
    const groupByFields = Object.keys(elements).filter((k) => {
        const el = elements[k];
        const colDef = projColumns.find((c) => c.as === k || (c.ref?.[0] === k && !c.func));
        return !(0, alias_maps_1.isAssociationElement)(el) && !el.$calc && !el.value && colDef;
    });
    const groups = new Map();
    for (const record of records) {
        const compositeKey = groupByFields
            .map((k) => String(record[localToRemote[k] || k] ?? record[k] ?? ''))
            .join('|');
        const existing = groups.get(compositeKey);
        if (existing)
            existing.sourceRecords.push(record);
        else
            groups.set(compositeKey, { ref: { ...record }, sourceRecords: [record] });
    }
    const output = [];
    for (const { ref: summarizedRow, sourceRecords } of groups.values()) {
        for (const col of projColumns) {
            if (!col.func)
                continue;
            const keyName = col.as || col.ref?.[0];
            if (!keyName)
                continue;
            const func = col.func.toLowerCase();
            const firstArg = (col.args || [])[0];
            let targetArg = '*';
            if (firstArg && typeof firstArg === 'object' && Array.isArray(firstArg.ref))
                targetArg = firstArg.ref[0];
            else if (typeof firstArg === 'string')
                targetArg = firstArg;
            const remoteProp = localToRemote[targetArg] || targetArg;
            const values = () => sourceRecords
                .map((r) => r[remoteProp] ?? r[targetArg])
                .filter((v) => v !== undefined && v !== null && v !== '');
            summarizedRow[keyName] = (0, exports.aggregate)(func, targetArg, values, sourceRecords.length, !!col.distinct);
        }
        output.push(summarizedRow);
    }
    return output;
};
exports.applyGroupBy = applyGroupBy;
