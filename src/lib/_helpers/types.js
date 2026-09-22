"use strict";
/**
 * @file types.ts
 * @description Shared type definitions for the RemoteApplicationService helper package.
 *
 * All types here are structural — they describe the shape of CDS entity
 * definitions, CQN nodes, and internal alias/metadata caches. They exist to
 * document intent at helper boundaries; runtime enforcement is not attempted
 * because `@sap/cds` itself types most of these values as `any`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMetadataCache = void 0;
/**
 * Factory for a fresh {@link MetadataCache}. Prefer constructing one per
 * service instance in `init()`.
 */
const createMetadataCache = () => ({
    aliasMaps: new WeakMap(),
    assocAliasMaps: new WeakMap(),
    assocMeta: new WeakMap(),
    columnPlan: new WeakMap(),
    searchColumns: new WeakMap(),
});
exports.createMetadataCache = createMetadataCache;
