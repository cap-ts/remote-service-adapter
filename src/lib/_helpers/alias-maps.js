"use strict";
/**
 * @file alias-maps.ts
 * @description Field-name alias resolution and caching. Every helper that
 * needs to translate between local CAP names and remote backend names uses
 * these functions.
 *
 * Alias maps are memoised against the immutable CDS entity definition object
 * (see {@link MetadataCache}) so we compute them at most once per entity for
 * the lifetime of the loaded CDS model.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAssociationAliasMaps = exports.findRemoteAssociationName = exports.getAliasMaps = exports.collectProjectionColumns = exports.isAssociationElement = void 0;
const cds_1 = require("@sap/cds");
const path_columns_1 = require("./path-columns");
/**
 * Returns `true` when the element is a CDS Association or Composition.
 *
 * @param element  CDS element descriptor.
 */
const isAssociationElement = (element) => element?.type === 'cds.Association' || element?.type === 'cds.Composition';
exports.isAssociationElement = isAssociationElement;
/**
 * Returns the projection columns for the given entity definition, falling
 * back to the corresponding model-level definition when the runtime entity
 * is a lightweight clone.
 *
 * @param entityDef  CDS entity definition.
 */
const collectProjectionColumns = (entityDef) => entityDef?.query?.SELECT?.columns
    || cds_1.default.model?.definitions?.[entityDef?.name]?.query?.SELECT?.columns
    || [];
exports.collectProjectionColumns = collectProjectionColumns;
/**
 * Returns the {@link AliasMaps} for an entity, building them lazily from
 * projection columns + element metadata and caching per-definition.
 *
 * @param entityDef  CDS entity definition.
 * @param cache      Per-service metadata cache.
 */
const getAliasMaps = (entityDef, cache) => {
    if (!entityDef)
        return { localToRemote: {}, remoteToLocal: {} };
    const cached = cache.aliasMaps.get(entityDef);
    if (cached)
        return cached;
    const localToRemote = {};
    const remoteToLocal = {};
    // Association-path columns (`_A._B.Field as X`) do not exist on the main remote entity:
    // mapping `X -> Field` there would request/route a wrong field. They are resolved separately.
    const pathAliases = (0, path_columns_1.getColumnPlan)(entityDef, cache).paths;
    for (const col of (0, exports.collectProjectionColumns)(entityDef)) {
        if (!col?.ref)
            continue;
        if (col.ref.length > 1 && pathAliases.has(col.as || col.ref[col.ref.length - 1]))
            continue;
        const remote = col.ref[col.ref.length - 1];
        const local = col.as || remote;
        localToRemote[local] = remote;
        remoteToLocal[remote] = local;
    }
    for (const key of Object.keys(entityDef.elements || {})) {
        if (pathAliases.has(key))
            continue;
        if (!localToRemote[key])
            localToRemote[key] = key;
        if (!remoteToLocal[key])
            remoteToLocal[key] = key;
    }
    const maps = { localToRemote, remoteToLocal };
    cache.aliasMaps.set(entityDef, maps);
    return maps;
};
exports.getAliasMaps = getAliasMaps;
/**
 * Attempts to resolve the remote-side association name for a locally-named
 * association. Checks (in order): projection alias, `element.original`,
 * `element.value.ref`, `element.base`. Deliberately does *not* infer from
 * sibling associations — that would risk aliasing one expand to another.
 *
 * @param sourceDef  Local entity definition.
 * @param assocName  Local association name.
 * @param cache      Per-service metadata cache.
 * @param assocEl    Optional element (defaults to `sourceDef.elements[assocName]`).
 * @returns          Remote name, or `undefined` when no explicit mapping exists.
 */
const findRemoteAssociationName = (sourceDef, assocName, cache, assocEl) => {
    const elements = sourceDef?.elements || {};
    const current = assocEl || elements[assocName];
    if (!current || !(0, exports.isAssociationElement)(current) || !current.target)
        return undefined;
    const byProjection = (0, exports.getAliasMaps)(sourceDef, cache).localToRemote[assocName];
    if (byProjection && byProjection !== assocName)
        return byProjection;
    const byMetadata = current.original ||
        current.value?.ref?.[current.value.ref.length - 1] ||
        (typeof current.base === 'string' ? current.base.split('/').pop() : undefined);
    if (byMetadata && byMetadata !== assocName)
        return byMetadata;
    // Deliberately no sibling-based inference.
    return undefined;
};
exports.findRemoteAssociationName = findRemoteAssociationName;
/**
 * Like {@link getAliasMaps}, but restricted to association elements only.
 * Union of aliases derived from projection, `element.original`,
 * `element.value.ref`, and structural inference.
 *
 * @param entityDef  CDS entity definition.
 * @param cache      Per-service metadata cache.
 */
const getAssociationAliasMaps = (entityDef, cache) => {
    if (!entityDef)
        return { localToRemote: {}, remoteToLocal: {} };
    const cached = cache.assocAliasMaps.get(entityDef);
    if (cached)
        return cached;
    const localToRemote = {};
    const remoteToLocal = {};
    const aliasMaps = (0, exports.getAliasMaps)(entityDef, cache);
    for (const [localName, el] of Object.entries(entityDef.elements || {})) {
        if (!(0, exports.isAssociationElement)(el))
            continue;
        const byProjection = aliasMaps.localToRemote[localName];
        if (byProjection && byProjection !== localName) {
            localToRemote[localName] = byProjection;
            remoteToLocal[byProjection] = localName;
        }
        const byMetadata = el.original || el.value?.ref?.[el.value?.ref?.[el.value?.ref?.length - 1]];
        if (byMetadata && byMetadata !== localName) {
            localToRemote[localName] ||= byMetadata;
            remoteToLocal[byMetadata] = localName;
        }
        const inferred = (0, exports.findRemoteAssociationName)(entityDef, localName, cache, el);
        if (inferred && inferred !== localName) {
            localToRemote[localName] ||= inferred;
            remoteToLocal[inferred] = localName;
        }
    }
    const maps = { localToRemote, remoteToLocal };
    cache.assocAliasMaps.set(entityDef, maps);
    return maps;
};
exports.getAssociationAliasMaps = getAssociationAliasMaps;
