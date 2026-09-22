"use strict";
/**
 * @file association-meta.ts
 * @description Resolves and caches association metadata (join keys, cardinality,
 * constant filters) for CDS associations.
 *
 * The heavy lifting is in {@link parseOnCondition}, which turns an unmanaged
 * association's `ON` expression into the three parts that the expand
 * materialiser needs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAssociationMeta = exports.parseOnCondition = void 0;
const cds_1 = require("@sap/cds");
const alias_maps_1 = require("./alias-maps");
/**
 * Parses an unmanaged association's `ON` condition into three parts:
 * - **localKeys**       — fields on the parent (`$self.<field>` or bare `<field>`).
 * - **targetKeys**      — fields on the target (`<side>.<field>`).
 * - **constantFilters** — predicates comparing an association field to a
 *                         literal value (`ON x.status = 'A'`), applied
 *                         as-is when fetching children.
 *
 * @param on    CQN `ON` node.
 * @param side  Alias used for the target side inside the ON condition.
 */
const parseOnCondition = (on, side) => {
    const localKeys = new Set();
    const targetKeys = new Set();
    const constantFilters = [];
    const getLiteral = (n) => {
        if (n === null || n === undefined)
            return { isLiteral: false };
        if (typeof n !== 'object')
            return { isLiteral: true, value: n };
        if (n.val !== undefined)
            return { isLiteral: true, value: n.val };
        return { isLiteral: false };
    };
    const addConstant = (ref, value) => {
        if (ref[0] === '$self' && ref[1])
            constantFilters.push({ [ref[1]]: value });
        else if (ref.length !== 1 && ref[0] === side && ref[1])
            constantFilters.push({ [ref[1]]: value });
    };
    const classifyRef = (ref) => {
        if (ref[0] === '$self' && ref[1])
            return { type: 'local', key: ref[1] };
        if (ref.length === 1)
            return { type: 'local', key: ref[0] };
        if (ref[0] === side && ref[1])
            return { type: 'target', key: ref[1] };
        return null;
    };
    const walk = (node) => {
        if (!node)
            return;
        const items = node.xpr || (Array.isArray(node) ? node : null);
        if (!items) {
            if (typeof node === 'object')
                for (const val of Object.values(node))
                    walk(val);
            return;
        }
        for (let i = 0; i < items.length; i++) {
            const op = items[i];
            if (op !== '=' && op !== '==' && op?.op !== '=' && op?.op !== '==')
                continue;
            const left = items[i - 1];
            const right = items[i + 1];
            if (!left || right === undefined)
                continue;
            const isLeftRef = left.ref !== undefined;
            const isRightRef = right?.ref !== undefined;
            const leftLiteral = getLiteral(left);
            const rightLiteral = getLiteral(right);
            if (isLeftRef && rightLiteral.isLiteral) {
                addConstant(left.ref, rightLiteral.value);
            }
            else if (leftLiteral.isLiteral && isRightRef) {
                addConstant(right.ref, leftLiteral.value);
            }
            else if (isLeftRef && isRightRef) {
                const leftSide = classifyRef(left.ref);
                const rightSide = classifyRef(right.ref);
                if (leftSide && rightSide) {
                    (leftSide.type === 'local' ? localKeys : targetKeys).add(leftSide.key);
                    (rightSide.type === 'local' ? localKeys : targetKeys).add(rightSide.key);
                }
                else {
                    for (const ref of [left.ref, right.ref]) {
                        if (ref[0] === '$self' && ref[1])
                            localKeys.add(ref[1]);
                        else if (ref.length === 1)
                            localKeys.add(ref[0]);
                        else if (ref[0] === side && ref[1])
                            targetKeys.add(ref[1]);
                    }
                }
            }
        }
        for (const item of items)
            if (typeof item === 'object')
                walk(item);
    };
    walk(on);
    return { localKeys: [...localKeys], targetKeys: [...targetKeys], constantFilters };
};
exports.parseOnCondition = parseOnCondition;
/**
 * Resolves and caches {@link AssocMeta} for a CDS association element.
 *
 * Handles both:
 * - **Unmanaged** associations: parses the `ON` condition via {@link parseOnCondition}.
 * - **Managed** associations (no `ON`): infers local + target join keys from
 *   entity key definitions, preferring matching field names.
 *
 * @param assocName  Local association name.
 * @param sourceDef  Parent entity definition.
 * @param target     Fully qualified target entity name.
 * @param element    CDS element descriptor.
 * @param cache      Per-service metadata cache.
 * @returns          Cached {@link AssocMeta}, or `null` when `element` is falsy.
 */
const resolveAssociationMeta = (assocName, sourceDef, target, element, cache) => {
    if (!element)
        return null;
    const cached = cache.assocMeta.get(element);
    if (cached !== undefined)
        return cached;
    const cardinality = element.cardinality || {};
    const isToMany = cardinality.max === '*' || cardinality.max > 1;
    let originalName = assocName;
    if (element.original)
        originalName = element.original;
    else if (element.value?.ref?.length)
        originalName = element.value.ref[element.value.ref.length - 1];
    else if (element.base)
        originalName = element.base.split('/').pop();
    if (!originalName || originalName === assocName) {
        const mappedRemoteName = (0, alias_maps_1.getAliasMaps)(sourceDef, cache).localToRemote[assocName];
        if (mappedRemoteName)
            originalName = mappedRemoteName;
    }
    let { localKeys, targetKeys, constantFilters } = (0, exports.parseOnCondition)(element.on, assocName);
    let isManaged = false;
    if (!element.on || (localKeys.length === 0 && targetKeys.length === 0)) {
        isManaged = true;
        const targetDef = cds_1.default.model.definitions[target];
        if (targetDef) {
            const targetKeysFromDef = Object.keys(targetDef.elements || {}).filter((k) => targetDef.elements[k].key);
            const sourceKeysFromDef = Object.keys(sourceDef?.elements || {}).filter((k) => sourceDef.elements[k].key);
            const matchingKeys = targetKeysFromDef.filter((keyName) => {
                const sourceEl = sourceDef.elements?.[keyName];
                return sourceEl !== undefined && !(0, alias_maps_1.isAssociationElement)(sourceEl);
            });
            if (matchingKeys.length > 0) {
                localKeys = [...matchingKeys];
                targetKeys = [...matchingKeys];
            }
            else {
                localKeys = sourceKeysFromDef.length > 0 ? sourceKeysFromDef : ['ID'];
                targetKeys = targetKeysFromDef.length > 0 ? targetKeysFromDef : ['ID'];
            }
        }
        else {
            localKeys = ['ID'];
            targetKeys = ['ID'];
        }
    }
    const meta = {
        name: assocName,
        originalName,
        target,
        isToMany,
        localKeys,
        targetKeys,
        constantFilters,
        cardinality,
        element,
        isManaged
    };
    cache.assocMeta.set(element, meta);
    return meta;
};
exports.resolveAssociationMeta = resolveAssociationMeta;
