"use strict";
/**
 * @file join-parser.ts
 * @description Parses JOIN and $expand structures out of incoming CQN.
 *
 * These helpers are pure syntax processors — they turn one AST shape into
 * a more convenient one for the join-mashup and expand-materialiser pipelines.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildChildJoinKey = exports.buildParentJoinKey = exports.parseExpandTree = exports.getProjectionMappings = exports.parseJoinKeys = exports.flattenJoinStructure = void 0;
/**
 * Flattens a nested CQN JOIN tree into a linear sequence of
 * `{ entityPath, alias, onCondition? }` entries in evaluation order.
 * The first element is the primary source; subsequent elements each bring
 * their own `ON` condition.
 *
 * @param from  CQN FROM node (with or without JOIN nodes).
 */
const flattenJoinStructure = (from) => {
    const sequence = [];
    const traverse = (node) => {
        if (!node)
            return;
        if (node.join) {
            traverse(node.args[0]);
            traverse(node.args[1]);
            sequence.push({
                entityPath: node.args[1].ref[0],
                alias: node.args[1].as || node.args[1].ref[0],
                onCondition: node.on
            });
        }
        else if (node.ref) {
            sequence.unshift({ entityPath: node.ref[0], alias: node.as || node.ref[0] });
        }
    };
    traverse(from);
    return sequence;
};
exports.flattenJoinStructure = flattenJoinStructure;
/**
 * Extracts the pair of join keys (left / parent alias vs. this join alias)
 * from a CQN `ON` condition. Only equi-joins are supported.
 *
 * @param on          CQN `ON` node.
 * @param leftAlias   Alias of the left (parent) source.
 * @param rightAlias  Alias of the right (current) source.
 * @returns           `{ leftKey, rightKey }`; either may be empty when no match found.
 */
const parseJoinKeys = (on, leftAlias, rightAlias) => {
    const result = { leftKey: '', rightKey: '' };
    const items = on?.xpr || (Array.isArray(on) ? on : null);
    if (!items)
        return result;
    for (let i = 0; i < items.length; i++) {
        if (items[i] !== '=')
            continue;
        const left = items[i - 1];
        const right = items[i + 1];
        if (!left?.ref || !right?.ref)
            continue;
        for (const ref of [left.ref, right.ref]) {
            if (ref[0] === leftAlias && ref[1])
                result.leftKey = ref[1];
            else if (ref[0] === rightAlias && ref[1])
                result.rightKey = ref[1];
        }
    }
    return result;
};
exports.parseJoinKeys = parseJoinKeys;
/**
 * Extracts projection-level `<alias>.<field> AS <name>` mappings out of a
 * JOIN mashup's SELECT columns. Only 2-segment refs matching the given alias
 * are considered, so predicates from other tables are ignored.
 *
 * @param columns  CQN columns.
 * @param alias    Table alias to filter by.
 * @returns        Array of `{ sourceField, projectedAs }` entries.
 */
const getProjectionMappings = (columns, alias) => {
    const mappings = [];
    for (const col of columns || []) {
        if (col.ref && col.ref[0] === alias && col.ref.length === 2) {
            mappings.push({ sourceField: col.ref[1], projectedAs: col.as || col.ref[1] });
        }
    }
    return mappings;
};
exports.getProjectionMappings = getProjectionMappings;
/**
 * Parses `$expand` nodes out of an incoming CQN columns array.
 *
 * @param columns  CQN columns from the SELECT.
 * @returns        Array of {@link ExpandNode}s (may be empty).
 */
const parseExpandTree = (columns) => {
    const expands = [];
    for (const col of columns || []) {
        if (col?.expand && col?.ref) {
            expands.push({
                name: col.ref[col.ref.length - 1],
                as: col.as,
                columns: col.expand,
                orderBy: col.orderBy,
                where: col.where,
                limit: col.limit,
                count: col.count
            });
        }
    }
    return expands;
};
exports.parseExpandTree = parseExpandTree;
/**
 * Builds a stable string key from a parent record's join fields. Used to
 * look up children in the map returned by the fetch helper.
 *
 * @param row        Parent record.
 * @param localKeys  Parent-side join key names.
 */
const buildParentJoinKey = (row, localKeys) => {
    if (!localKeys?.length)
        return row.ID !== undefined ? String(row.ID) : JSON.stringify(row);
    if (localKeys.length === 1)
        return row[localKeys[0]] !== undefined ? String(row[localKeys[0]]) : '';
    return JSON.stringify(localKeys.map((k) => row[k] ?? ''));
};
exports.buildParentJoinKey = buildParentJoinKey;
/**
 * Builds a stable string key from a child record's join fields. Matches the
 * format produced by {@link buildParentJoinKey}.
 *
 * @param row         Child record.
 * @param targetKeys  Target-side join key names.
 */
const buildChildJoinKey = (row, targetKeys) => {
    if (!targetKeys?.length)
        return row.ID !== undefined ? String(row.ID) : JSON.stringify(row);
    if (targetKeys.length === 1)
        return row[targetKeys[0]] !== undefined ? String(row[targetKeys[0]]) : '';
    return JSON.stringify(targetKeys.map((k) => row[k] ?? ''));
};
exports.buildChildJoinKey = buildChildJoinKey;
