"use strict";
/**
 * @file RemoteApplicationService.ts
 * @description Generic CAP `ApplicationService` that proxies READ requests
 * from the local CDS service layer to remote backends (OData V2/V4, SOAP,
 * local CAP services, or the database).
 *
 * ## Responsibilities
 * - Hybrid WHERE split: push down only backend-safe predicates; evaluate
 *   local-only filters (virtual, calculated, association-path) in memory.
 * - Field-name alias translation via projection-column metadata (cached).
 * - `$expand` materialisation across service boundaries.
 * - Complex JOIN mashups: fan-out SELECTs across multiple remote services.
 * - In-memory DISTINCT / GROUP BY / aggregation.
 * - SOAP deduplication for backends that return multiple rows per logical key.
 *
 * ## Architecture
 * See `.claude/docs/module-layout.md` for the modular layout under
 * `./_helpers/`.
 *
 * ## Extension
 * No override seams. Compose against the module functions in `./_helpers`
 * if you need bespoke behaviour.
 *
 * ## Logging
 * Every request is tagged with a short correlation ID (`reqId`) which is
 * threaded through every helper. Enable local-dev logging with:
 *
 * ```bash
 * DEBUG=remote-service LOG_TO_FILE=true npm run watch
 * ```
 *
 * See `.claude/docs/troubleshooting.md` for the full guide.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteApplicationService = void 0;
const cds_1 = require("@sap/cds");
const crypto_1 = require("crypto");
const _helpers_1 = require("./_helpers");
/**
 * Base service that proxies CAP READ requests to remote backends.
 * Auto-registers a READ handler for every entity it exposes.
 *
 * Register it as the implementation class for a CDS service:
 * ```ts
 * import { RemoteApplicationService } from './RemoteApplicationService';
 * export = RemoteApplicationService;
 * ```
 */
class RemoteApplicationService extends cds_1.default.ApplicationService {
    /**
     * This service's READ pipeline understands the internal `SELECT.__skipPagination` hint (all rows, no page cap)
     * that association fetches attach to their sub-queries. Services without it must not be sent the hint.
     */
    supportsSkipPagination = true;
    /**
     * Metadata cache shared across every request handled by this service
     * instance. Entries are keyed on immutable CDS element/entity definition
     * objects and are garbage-collected together with the model.
     */
    _cache = (0, _helpers_1.createMetadataCache)();
    /**
     * Module-scoped logger used for `init()` and dispatch traces. Per-request
     * loggers (with a correlation ID) are derived from this via `forRequest`.
     */
    _log = (0, _helpers_1.createLogger)('RemoteApplicationService');
    /**
     * Registers a READ handler for every entity this service exposes.
     * Called automatically by the CAP framework during initialisation.
     */
    async init() {
        this._log.info('init', `Registering READ handlers for service '${this.name}'`, {
            entities: Object.keys(this.entities),
        });
        for (const entityName in this.entities) {
            const entityDef = this.entities[entityName];
            this.on('READ', entityName, (req, next) => this._handleDynamicRead(req, next, entityDef));
            this._log.debug('init', `Handler bound`, { entity: entityName });
        }
        await super.init();
        this._log.info('init', `Service '${this.name}' ready`);
    }
    /**
     * Top-level READ handler. Generates a correlation ID for the request,
     * derives a per-request logger, then routes to either the simple-projection
     * pipeline (single remote entity) or the complex-join-mashup pipeline.
     *
     * @param req        Incoming CAP request.
     * @param next       CAP next-handler continuation.
     * @param entityDef  CDS entity definition for the requested entity.
     */
    async _handleDynamicRead(req, next, entityDef) {
        const reqId = (0, crypto_1.randomUUID)().slice(0, 8);
        const log = this._log.forRequest(reqId);
        const started = Date.now();
        const currentEntityDef = entityDef || req.target;
        if (!currentEntityDef) {
            log.warn('_handleDynamicRead', 'No entity definition on request; forwarding to next handler');
            return next();
        }
        const selectSpec = currentEntityDef.query?.SELECT;
        const flow = selectSpec?.from?.join ? 'join-mashup' : 'simple-projection';
        log.info('_handleDynamicRead', `READ '${currentEntityDef.name}' begin`, {
            flow,
            user: req.user?.id,
            tenant: req.tenant,
            query: req.query,
        });
        try {
            const results = selectSpec?.from?.join
                ? await (0, _helpers_1.handleComplexJoinMashup)(this.name, req, next, currentEntityDef, selectSpec, this._cache, log)
                : await (0, _helpers_1.handleSimpleProjection)(this.name, req, next, currentEntityDef, this._cache, log);
            const shape = Array.isArray(results)
                ? { kind: 'array', count: results.length, hasCount: results.$count !== undefined }
                : { kind: results == null ? 'null' : 'object' };
            log.info('_handleDynamicRead', `READ '${currentEntityDef.name}' end`, {
                flow,
                elapsedMs: Date.now() - started,
                result: shape,
            });
            if (results == null)
                return req.query.SELECT?.one ? {} : [];
            return results;
        }
        catch (err) {
            log.error('_handleDynamicRead', `READ '${currentEntityDef.name}' failed`, {
                flow,
                elapsedMs: Date.now() - started,
                error: { message: err?.message, code: err?.code, stack: err?.stack?.split('\n').slice(0, 5) },
            });
            throw err;
        }
    }
}
exports.RemoteApplicationService = RemoteApplicationService;
exports.default = RemoteApplicationService;
