# @cap-ts/remote-service-adapter

[![Version npm](https://img.shields.io/npm/v/@cap-ts/remote-service-adapter.svg)](https://www.npmjs.com/package/@cap-ts/remote-service-adapter)

> **CAP service implementation that turns a CDS projection / view entity into a working READ endpoint over a remote
> backend, without per-entity handler code.**
> `@sap/cds` ^9.9.1 or ^10, TypeScript output is plain CommonJS.

## 📦 About

`@cap-ts/remote-service-adapter` exports one class, `RemoteApplicationService`. Register it as the implementation of a
CDS service and every entity of that service gets a READ handler that reads through to a remote backend — OData V2/V4,
SOAP (via `@cap-ts/soap-adapter`), another locally served CAP service, or the database — and translates between your
projection's field names and the backend's. It handles the parts that would otherwise be hand-written per entity:
hybrid `$filter` push-down, field alias translation, `$expand` across service boundaries, JOIN mashups, association
path columns, calculated columns, `$search`, and in-memory DISTINCT / GROUP BY / aggregation.

It is READ only. No CREATE / UPDATE / DELETE handlers, no authentication or authorization model, no override seams —
bespoke behavior is composed from helper functions, not from subclassing hooks.

---

## 📑 Table of Contents

📥 [Installation](#-installation)\
📖 [Usage Guidelines](#-usage-guidelines)\
⚡ [Quick start (5 minutes)](#-quick-start-5-minutes)\
📝 [Modelling reference: projection → remote entity](#-modelling-reference-projection--remote-entity)\
🔌 [`RemoteApplicationService` class API](#-remoteapplicationservice-class-api)\
🧩 [CAP plugin: the `@remote` annotation](#-cap-plugin-the-remote-annotation)\
🔍 [Query features in depth](#-query-features-in-depth)\
🧼 [SOAP backends](#-soap-backends)\
⚙️ [Configuration](#️-configuration)\
🚦 [Error & result behavior](#-error--result-behavior)\
🔒 [Boundaries & security](#-boundaries--security)\
🛠️ [Troubleshooting](#️-troubleshooting)\
⚠️ [Known limitations](#️-known-limitations)\
💬 [Support & feedback](#-support--feedback)\
📄 [License](#-license)

---

## 📥 Installation

[↑ Table of Contents](#-table-of-contents)

```bash
npm install @cap-ts/remote-service-adapter
```

The package registers itself as a CAP plugin via `cds-plugin.js` — no explicit `require()` is needed for the `@remote`
annotation opt-in path. `cds watch` and `cds build` pick it up automatically. Importing the class yourself
(`import { RemoteApplicationService } from '@cap-ts/remote-service-adapter'`) works either way.

### Peer requirements

| Peer | Version | Notes |
| --- | --- | --- |
| `@sap/cds` | `^9.9.1 \|\| ^10` | CAP runtime. Tested against 9.9.3 and 10.1.1; Node >=20 (cds 10 needs 22). |
| `@cap-js/cds-types` | >=0.18.0, optional | TypeScript types for `@sap/cds`; not needed at runtime. |
| `@cap-ts/soap-adapter` | ^0.1.12 | Only exercised at runtime when a backend's `kind` is `soap`; still a required peer because the SOAP dispatch helper imports it unconditionally. |
| `@sap-cloud-sdk/connectivity`, `@sap-cloud-sdk/http-client` | ^4.7.0 | Needed by `@cap-ts/soap-adapter` for destination lookup and HTTP calls. |

The package declares no runtime `dependencies` of its own — everything else is a peer or a Node built-in
(`crypto.randomUUID`, `structuredClone`). `engines` requires Node.js ≥ 20 (cds 10 itself requires ≥ 22); the test
suite runs on Node ≥ 22.18 (native TypeScript execution).

---

## 📖 Usage Guidelines

[↑ Table of Contents](#-table-of-contents)

```diagram
Client (OData V4 / Fiori)
      │
      ▼
CAP service (your service class, registered with RemoteApplicationService as implementation)
      │  this.on('READ', <entity>) — one handler per exposed entity, registered by init()
      ▼
RemoteApplicationService
      │  cds.connect.to() / locally served service / cds.db / soap.read()
      ▼
Backends: OData V2 / V4, SOAP (via @cap-ts/soap-adapter), other CAP services of the same process, the database
```

Two ways to wire `RemoteApplicationService` up as the implementation of a CDS service:

1. **Let the CAP plugin do it** — annotate the service `@remote` in the CDS source. No handler file at all.
2. **Import and subclass it yourself** — for the odd service that also needs a handler for a non-READ event
   alongside the automatic READ dispatch.

Field names, associations, aliases and structure of the projection may differ freely from the remote backend — the
service reads them from the CSN projection columns and translates both directions on every request.

---

## ⚡ Quick start (5 minutes)

[↑ Table of Contents](#-table-of-contents)

Assume a CAP project laid out like:

```diagram
srv/
  external/
    RemoteOrders.cds     ← model for the external OData service (cds import / cds-dk generated)
  Orders.cds              ← your projection service
package.json
```

**1. Configure the external service in `package.json`.**

```json
{
  "cds": {
    "requires": {
      "RemoteOrders": {
        "kind": "odata-v4",
        "model": "srv/external/RemoteOrders",
        "credentials": { "destination": "DEST_ORDERS" }
      }
    }
  }
}
```

- `kind` — one of `odata`, `odata-v2`, `odata-v4`, `soap`. Drives the search case rule and, for `soap`, the dispatch
  path; it does **not** gate whether `RemoteApplicationService` is used (see the next step).
- `credentials.destination` — SAP BTP destination name, resolved by CAP's own connectivity layer.

**2. Declare your projection service in `srv/Orders.cds`, annotated `@remote`.**

```cds
using { RemoteOrders } from './external/RemoteOrders';

@remote
service Orders {
    entity Order as projection on RemoteOrders.Orders {
        key ID,
        OrderName as Title,      // alias: local Title <-> remote OrderName
        Amount,                  // same name: identity mapping
        Customer.Name as CustomerName   // to-one path, resolved by a batched lookup
    };
}
```

`@remote` is the entire opt-in surface. The plugin does not inspect what the entities project on — it just gives
every entity of this service a READ handler backed by `RemoteApplicationService`.

**3. Start `cds watch`.** No handler file, no `srv/Orders.js` — `GET /odata/v4/Orders/Order` is live.

**Alternative: register it yourself**, e.g. when the service also needs a non-READ handler:

```ts
// srv/Orders.ts
import { RemoteApplicationService } from '@cap-ts/remote-service-adapter';

export class Orders extends RemoteApplicationService {
    async init(): Promise<void> {
        // READ is already handled for every entity by the base class.
        // Add handlers for other events here if you need them.
        await super.init();
    }
}
```

With a handler file present (or `@impl` already set, or `cds.requires.<Name>.impl`), the plugin leaves the service
alone — no `@remote` needed, and no double registration.

---

## 📝 Modelling reference: projection → remote entity

[↑ Table of Contents](#-table-of-contents)

The local ↔ remote mapping is read entirely from the entity's projection / query columns — never hard-code remote
field names in TypeScript.

```cds
entity Order as projection on RemoteOrders.Orders {
    key ID,
    OrderName as Title,                         // alias: local Title <-> remote OrderName
    Amount,                                      // same name: identity
    virtual Flag : Boolean,                      // never requested from the backend
    left(OrderName, 2) as Prefix : String(2),    // calculated in memory
    Customer.Name as CustomerName,                // to-one association path, one batched lookup
    Items                                         // association, materialised for $expand
};
```

| Element | Behavior |
| --- | --- |
| `Remote as Local` | `localToRemote[Local] = Remote`. No alias means identity. A remote field exposed under several names (`*` and `Field as Alias`) is requested once, and every name gets its value. |
| `virtual` | Never requested; predicates on it are evaluated locally. |
| Calculated (`<expr> as Name`) | Computed in memory from the source values (`left(Field, 2)` reads the source's `Field`, also when the projection renames it); its source fields are requested automatically even if not otherwise projected. |
| Path column (`_A._B.Field as X`) | Resolved across to-one associations at any depth via one batched key-IN fetch per hop. A to-many hop or a filtered segment requested in `$select` / `$filter` / `$orderby` is **501** before any remote call. |
| `String(n)` | Sizes matter for `$search` — a search word longer than `n` is not pushed for that column. |
| Association (`Items`) | Declare the ON condition or managed keys in CDS; `$expand=Items` becomes one batched `WHERE <fk> IN (...)` query. |

### Static data

```cds
@response.data: [{ ID: 'A', Name: 'Alpha' }, { ID: 'B', Name: 'Beta' }]
entity CodeList as projection on Remote.Codes { key ID, Name };
```

Returned as-is, no backend call, and `$search` is never pushed for it.

---

## 🔌 `RemoteApplicationService` class API

[↑ Table of Contents](#-table-of-contents)

```ts
import { RemoteApplicationService } from '@cap-ts/remote-service-adapter';

export class MyDataService extends RemoteApplicationService {
    async init(): Promise<void> {
        // custom handlers for OTHER events can go here; READ is handled for every entity
        await super.init();
    }
}
```

- **`init()`** — for every entity in `this.entities`, registers `this.on('READ', entityName, ...)`, then calls
  `super.init()`. Called automatically by CAP; do not call it yourself.
- **Correlation IDs** — every dispatched READ gets an 8-character correlation id (`randomUUID()`), threaded through
  every log line for that request. See [Troubleshooting](#️-troubleshooting).


---

## 🧩 CAP plugin: the `@remote` annotation

[↑ Table of Contents](#-table-of-contents)

The package ships `cds-plugin.js`, so CAP activates the loader automatically once the package is a dependency.

```cds
@remote
service Catalog {
    entity Partners as projection on MyExternalService.A_BusinessPartner { key ID, Name as Title };
}
```

- `@remote` is the **entire** opt-in surface. The plugin does not inspect what the service's entities project on (it
  does not matter whether they select from OData, SOAP, another local service, or the database), and it does not
  look at `cds.requires` to decide who gets patched. `cds.requires.<name>` still configures **how**
  `RemoteApplicationService` reads once it is the implementation (`kind`, `credentials` / destination, etc.).
- A service **without** `@remote` is left alone entirely, whatever its entities project on.
- `DEBUG=remote-service` shows which services were patched and which kept their own implementation.

**Do not** point `cds.requires.<external>.impl` at `RemoteApplicationService`: it reads through
`cds.connect.to(<owning service>)`, which would return the same cached instance and make the service call itself.
The external service's own `impl` (a custom client extension) keeps working untouched.

---

## 🔍 Query features in depth

[↑ Table of Contents](#-table-of-contents)

### Hybrid `$filter` (WHERE) push-down

Every WHERE clause is split at the top-level AND boundary. A predicate stays local (evaluated in memory after the
fetch) when it references a `virtual`, calculated, association-path or unmapped field — or, against a SOAP backend,
any function call. Everything else is pushed to the backend. One calculated case is pushed as well: a comparison
`Name = 'v'` on a column `left(Field, n) as Name` where `'v'` has exactly `n` characters is the same as
`startswith(Field, 'v')` and is sent in that form (not to SOAP backends). If the backend rejects the pushed WHERE (an error whose
code contains `400` or whose message mentions `filter`, or an association-path complaint), the read is retried
**without** the WHERE and the original filter is applied to the full result set in memory instead.
A `$filter` or `$orderby` on an element that `$select` leaves out works: the rows are filtered and sorted before they
are cut down to the selected elements.

### The projection's own WHERE

A `where` on the entity itself is applied to every read of it, like CDS defines it:

```cds
entity OpenOrders as projection on Sales.Orders {
    key OrderID, Amount, _Customer.ValidTo as CustomerValidTo
} where Status != 'CANCELLED' and _Customer.ValidTo >= current_date;
```

- Conditions on plain fields of the source are sent to the backend together with the query's own `$filter`; the fields
  need not be part of the projection.
- Conditions on to-one association paths (`_Customer.ValidTo`) are evaluated in memory after the paths are resolved
  (like a filter on a path column: the backend `$top` is then dropped and the page is cut here).
- `$user`, `$user.<attribute>`, `$now`, `current_date`, `current_time` and `current_timestamp` take the request's values.
- On a read by key every condition is checked in memory (backends ignore `$filter` on a by-key URL): a row that fails
  one is **404**. Projections on top of the entity inherit the filter.
- A condition that can be neither sent nor evaluated in memory is rejected with **501**, never ignored: `exists`, a
  sub-select, `$at` / `$valid`, a to-many or filtered path, or `like` / `between` / an unknown function in a condition
  that has to be evaluated in memory. A JOIN view with a `where` is **501** as well.

### Paging, `$count` and local filters

- `$top` / `$skip` are forwarded to the backend only when nothing has to be done locally afterwards. They are
  **dropped** (and applied in memory instead) when there is a local-only filter, a `$search`, a GROUP BY, or a read
  by key. A local-only filter then reads every row that matches the rest of the filter, which can be slow or time out
  on a large entity set: the first time per entity this is logged as a warning on `cds.log('remote-service')`
  (`<entity>: $top is not sent to the backend because the filter on <fields> is evaluated in memory ...`), visible
  without `DEBUG`.
- `$count` comes from the backend only when there is no local filter and it is not a key read. With a local filter,
  a search, DISTINCT or GROUP BY, the count is computed after local processing.
- A count only (`$top=0&$count=true`) on a projection of a remote entity is one `/$count` request to the backend
  (`GET <entity>/$count?$filter=...`): no rows move. (CAP leaves a `$top` of 0 out of the URL, so asking with
  `$top=0` and `$count` would make the backend return every matching row.) A backend without `/$count` is asked for
  one row plus the total (`$top=1&$inlinecount=allpages`); only a backend that gives no count at all has its rows
  read, in pages, and counted. A count never turns into one request for every row.
- When the source is another service of the same application and every row is needed (a local-only filter, DISTINCT,
  GROUP BY), the inner read is sent without a limit (`limit: null`), so CAP's default page size does not cut it.
- When sorting has to happen in memory (after a local filter, or for the children of an `$expand`), elements with
  a numeric CDS type (Integer, Int64, Decimal, Double, …) are compared as numbers, also when the values arrive as
  strings (OData `IEEE754Compatible`, and from cds 10 on Decimal / Int64 read from a database). Other elements keep
  plain text order.
- Reads by key (`Entity('K1')`) get no backend count and no limit; the entity's remaining WHERE is re-checked on the
  returned row, and a row that fails the re-check becomes **404**.

### `$expand`

Declare the association in CDS; `$expand=Items` becomes one batched `WHERE <fk> IN (...)` query against the target.
Children the backend already delivered inline are mapped, filtered, limited and nested-expanded in place; missing
children are fetched in one batched key-IN query per association, grouped per parent key. Nested expands, `$filter`,
`$orderby` and `$count` inside the expand are all supported. A backend that rejects the expand query is retried
without columns, filter and order.

> **Known limitation** — an expand node's `$top` is sent to the backend for the whole batch of parents at once, so
> only the first parent(s) get their full child set. See [Known limitations](#️-known-limitations).

### Association path columns (`_A._B.Field as X`)

Classified once per entity definition (cached): `toOne` (every hop to-one, resolvable), `toMany` (rejected), or
`unsupported` (a filtered segment, a non-association after an association, or a target not in the model). A `toMany`
or `unsupported` path requested in `$select`, `$filter` or `$orderby` is **501 before any remote call**; if it's not
explicitly requested (no `$select`), the element is silently left out instead. A `$filter` on a path element is
always evaluated locally.

### Calculated columns

A projection column `<expr> as Name` (a `CASE`, a function call, `left()`, ...) is computed in memory from the
values of the source entity, as CDS defines it: `left(Field, 2)` reads the source's `Field`, also when the projection
exposes that field under another name (`Field as Alias`). The source fields it reads are requested from the
backend automatically, even when the projection doesn't otherwise expose them. Calculated columns are never sent to
the backend. A filter on one is evaluated in memory, except `Name = 'v'` on a `left(Field, n)` column with an `n`
character value, which is pushed as `startswith(Field, 'v')` (see the WHERE push-down above). An association whose ON
condition uses a calculated column (`on _Target.Key = $self.Prefix`) is resolved with the computed value.
A calculated column of an association target that another `RemoteApplicationService` of the application serves
(read through a path column `_Target.Text as Text` or `$expand`) is computed by that service, from its own source
values: the reading projection need not select the fields it depends on.

### `$search`

OData V4 syntax: words ANDed, `OR`, `NOT`, parentheses, `"phrases"`. Searches string elements (including to-one path
strings and calculated string columns); tune with `@cds.search: false` (element) or `@cds.search: { Title, Note }`
(entity). The case rule follows `cds.requires.<service>.kind`: `odata-v2` case-sensitive, `odata` / `odata-v4` and
local case-insensitive, `soap` not supported (the term is ignored — all rows come back and the local match decides).

Sound `contains(field, word)` push-down narrows what's fetched when possible; whatever can't be pushed leaves the
word unrestricted, and the **local match always has the final say**. Without any push-down the read is bounded at
5000 rows — beyond that it's a **502** telling the caller to add `$filter` instead.

### DISTINCT and GROUP BY

Only when the CDS entity itself declares `distinct` / `groupBy`. Computed in memory on the full fetched result:
`count`, `count_distinct`, `sum`, `avg`, `min`, `max`. Aggregate source fields are added to the remote columns
automatically. Because this needs every row, `$top` / `$skip` are never pushed for a GROUP BY entity.

- **Every source row is read, in pages.** The source is read in pages (`$top` / `$skip`, ordered by the source key),
  so no single request has to return a large entity set. The first page also asks for the total (`$count` /
  `$inlinecount`); the next pages follow until it is reached. A backend that returns fewer rows per page than asked
  (server-side paging) simply needs more pages.
- **Page size.** The page size is the maximum CAP allows for a read of the source entity: `@cds.query.limit.max` on
  the source entity, else on its service, else `cds.query.limit.max` in the configuration (CAP's default: 1000).
  Annotate the entity the GROUP BY projection is written on, not the GROUP BY entity itself. A projection inherits the
  annotation of the entity it projects on, so annotating the imported remote entity covers the projections on it.
  Set the default together with the maximum, otherwise CAP uses the maximum as the default page size for clients too:

  ```cds
  annotate MyService.Items with @cds.query.limit: { default: 1000, max: 5000 };
  ```
- **No partial totals.** If the rows stop before the total is reached, the request fails with **502**
  (`<entity>: the backend returned <n> of <total> rows, ...`) instead of returning totals over a part of the data.
- **Count requests.** When every aggregate is a row count (`count(*)`, `count(1)`, or `count` of a key of the source)
  and the `$filter` fixes every group column (`=` or `in`, joined by `and`, at most 25 combinations), no rows are read:
  one count request per combination of group values is sent (`GET <source>/$count?$filter=...`), and groups with a count of 0
  are left out. Example: for `projection on Items { key Category, Status, count(ID) as N } group by Category, Status`,
  `$filter=Category eq 'A' and Status in ('open','done')` sends two count requests. This also works when a group
  column is a calculated column of the source that can be pushed (`left(Field, n)`, see Calculated columns).
- An element that a projection only takes over from its source (for example a calculated column of the underlying
  projection) is read from the source like any other field; it can be grouped, filtered and selected.

---

## 🧼 SOAP backends

[↑ Table of Contents](#-table-of-contents)

Configure the backend service as SOAP and let `@cap-ts/soap-adapter` handle WSDL / destination / XML concerns:

```json
{
  "cds": {
    "requires": {
      "BP": {
        "kind": "soap",
        "wsdl": "srv/external/wsdl/BP.wsdl",
        "credentials": { "destination": "DEST_BP" }
      }
    }
  }
}
```

`RemoteApplicationService` detects a SOAP backend (`isSoapService`) and dispatches through `soap.read` from
`@cap-ts/soap-adapter` instead of `cds.connect.to(...).run(query)`. Because a SOAP backend can return several rows
per logical key, results are **deduplicated by entity key fields** before being mapped back to local names.
`$search` is not supported against SOAP (the term is ignored); filter functions are always evaluated in memory for
SOAP targets.

---

## ⚙️ Configuration

[↑ Table of Contents](#-table-of-contents)

There is no package-specific config block (no `cds.env.remote_service_adapter`, unlike some CAP plugins) — everything
is driven by the standard `cds.requires.<ServiceName>` entry and by environment variables for logging.

### Per-service (`cds.requires.<ServiceName>`)

| Key | Type | Description |
| --- | --- | --- |
| `kind` | `"odata"` \| `"odata-v2"` \| `"odata-v4"` \| `"soap"` | Drives the `$search` case rule and, for `soap`, the dispatch path. |
| `model` | `string` | Path to the external service's CSN/CDS model, for OData services. |
| `credentials.destination` | `string` | BTP destination name. |
| `credentials.url` | `string` | Direct endpoint URL for local development without a BTP destination. |
| `impl` | `string` | Set by you (or by `cds build`) to opt a service OUT of `@remote` auto-patching, or to point a handler file at something else. |

### Logging (environment variables, read once at module load)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEBUG` | unset | Master switch: must contain `remote-service` or `*`. Unset → no-op logger, zero cost. |
| `LOG_LEVEL` | `debug` with `DEBUG`, else `error` | `trace` < `debug` < `info` < `warn` < `error`; falls back to `CDS_LOG_LEVELS_ESI`. |
| `LOG_TO_CONSOLE` | `true` with `DEBUG` | `warn` / `error` → stderr, others → stdout. |
| `LOG_TO_FILE` | `false` | Also append to `${LOG_DIR:-logs}/remote-service-YYYYMMDD-HHMMSS.log`. Development only — hard-disabled when `NODE_ENV=production`. |
| `LOG_DIR` | `logs` | Directory for the log file, when `LOG_TO_FILE=true`. |

```bash
DEBUG=remote-service LOG_TO_FILE=true npm run watch          # console + file
DEBUG=remote-service LOG_LEVEL=trace npm run watch           # also per-row key diagnostics
```

Every logged context is redacted (case-insensitive, recursive) for keys matching: `authorization`, `auth`,
`password`, `pwd`, `token`, `access_token`, `refresh_token`, `apikey`, `api_key`, `secret`, `cookie`, `set-cookie`,
`x-csrf-token`.

---

## 🚦 Error & result behavior

[↑ Table of Contents](#-table-of-contents)

| Situation | Behavior |
| --- | --- |
| Backend rejects the filter (400-ish error, or an association-path complaint) | Warn, drop WHERE and limit, refetch everything, apply the original WHERE (and the projection's own WHERE) in memory |
| The projection's own WHERE can't be applied (see [The projection's own WHERE](#the-projections-own-where)), or a JOIN view has one | **501** before any remote call |
| Any other backend error | Logged at error level and re-thrown unchanged |
| Path column crossing a to-many association / filtered segment, requested explicitly | **501** before any remote call |
| Path column on a DISTINCT / GROUP BY entity | **501** |
| `$search` that can't be pushed and the entity has more than 5000 rows | **502** (`searchTooLarge`); message names the backend's rejection when a push was attempted and failed |
| Key read whose WHERE re-check (the query's or the projection's) removes the row | **404** `Entity '<name>' not found` |
| `SELECT.one` | One object, whatever shape the backend answered in; `undefined` when no row matches, like every CAP service (OData: **404**, or **204** for a nullable singleton) |
| Empty result | `[]` (or `undefined` for `SELECT.one`); with `$count`, the empty array carries `$count = 0` |
| Entity with `@response.data` | The annotation value is returned, no backend call |
| SOAP backend returns several rows per key | Reduced to one per key automatically |
| `$search` against a SOAP backend | Ignored — all rows come back, local match decides |

---

## 🔒 Boundaries & security

[↑ Table of Contents](#-table-of-contents)

| Guarantee / boundary | Detail |
| --- | --- |
| **READ only** | No CREATE / UPDATE / DELETE handlers are registered, ever. |
| **No authentication or authorization of its own** | The incoming request is propagated as-is to the connected service (`cds.connect.to`); roles and restrictions belong to the concrete CDS service and to CAP's own `@requires` / `@restrict` enforcement. |
| **No CDS ownership** | The package owns no definitions of its own; it only reads `cds.model`. |
| **No override seams** | No `protected` members, nothing to subclass into. Composition (deep-importing `_helpers`) is the only extension point, and it is explicitly unstable / not part of the published typings. |
| **Minimal public surface** | The package exports exactly one symbol: `RemoteApplicationService`. Enforced by the package's own test suite. |

---

## 🛠️ Troubleshooting

[↑ Table of Contents](#-table-of-contents)

### A filter is not pushed to the backend

**Cause:** the predicate references a `virtual`, calculated, association-path or unmapped field (or, against SOAP,
any function). **Fix:** map the field 1:1 in the projection, or accept the in-memory evaluation.

### 501 on a `$select` / `$filter` / `$orderby`

**Cause:** the requested element is a path across a to-many association, a filtered segment, or a path column on a
DISTINCT / GROUP BY entity. **Fix:** leave it out of the explicit `$select`, or remodel the projection.

### 502 `$search` "more than 5000 rows"

**Cause:** the search term couldn't be soundly pushed to the backend and the entity is too large to search fully in
memory. **Fix:** add `$filter` to narrow the set first. `$search` on a SOAP entity is silently ignored, not failed.

### 404 on a read by key

**Cause:** the entity's own WHERE clause (the query's, or the `where` of the projection) doesn't hold for that row once
it comes back from the backend (the post-fetch re-check removed it). This is by design, not a bug.

### `$expand` children are missing

**Cause:** usually a managed association whose join keys were guessed rather than declared explicitly. **Fix:**
declare the ON condition or managed keys precisely in CDS; enable `DEBUG=remote-service` and look for "Association
not resolvable" or an empty fetch trace.

### Nothing shows up in the log

**Checklist:** `DEBUG` is set and contains `remote-service` or `*`; `LOG_LEVEL` isn't filtering everything out; at
least one sink is on (`LOG_TO_CONSOLE` or `LOG_TO_FILE`); `NODE_ENV` isn't `production` (file logging is hard-disabled
there); and the request actually reaches `RemoteApplicationService` — look for "Registering READ handlers" at boot.

### Enable verbose logging

```bash
DEBUG=remote-service LOG_TO_FILE=true npm run watch
```

Each line: ISO timestamp, level, an 8-character correlation id (`[boot]` outside a request), `[module.method]`,
message, and an optional redacted JSON context. Filter one request with
`grep '\[<correlation-id>\]' logs/remote-service-*.log`.

---

## ⚠️ Known limitations

[↑ Table of Contents](#-table-of-contents)

Pinned by the package's own regression tests — these are known, not silently wrong:

1. **JOIN mashup entities** (`select from A as a join B as b on ...`) can mis-order which source is treated as
   primary for entities with more than two participants, due to a known defect in the internal JOIN-structure
   flattening. Simple two-way joins are unaffected in practice.
2. **`$expand`'s `$top`** is sent to the backend for the whole batch of parents at once, not per parent — only the
   first parent(s) in a batch get their full child set when several parents are expanded together.
3. **Filters on path or calculated columns are evaluated in memory** (correct results, but can be slow on very
   large remote sets). The exception is `Name = 'v'` on a `left(Field, n)` column with an `n`-character value, which
   is pushed as `startswith(Field, 'v')`. A full read caused by such a filter is logged as a warning once per entity.

---

## 💬 Support & feedback

[↑ Table of Contents](#-table-of-contents)

- **Bug reports & feature requests:** open an issue on the [GitHub repository](https://github.com/cap-ts/remote-service-adapter/issues).
- **Questions:** use [GitHub Discussions](https://github.com/orgs/cap-ts/discussions).

---

## 📄 License

[↑ Table of Contents](#-table-of-contents)

This package is provided under the terms of the **SAP-Code-World** [Usage License Agreement](LICENSE).

© 2025 **SAP-Code-World**. All rights reserved.
