# @cap-ts/remote-service-adapter

[![Version npm](https://img.shields.io/npm/v/@cap-ts/remote-service-adapter.svg)](https://www.npmjs.com/package/@cap-ts/remote-service-adapter)

> **A CAP service implementation that turns CDS projections and views into working OData endpoints over remote
> backends (read, write, actions), without per-entity handler code.**
> `@sap/cds` ^9.9.1 or ^10, plain CommonJS output, TypeScript typings included.

## 📦 About

`@cap-ts/remote-service-adapter` exports one class, `RemoteApplicationService`. Make it the implementation of a CDS
service (annotate the service `@remote`, or extend the class) and every entity of that service is served from the
entity's source: a remote OData V2 / V4 service, a SOAP service (via `@cap-ts/soap-adapter`), another CAP service of the
same application, or the database. The service reads the mapping from the projection itself (aliases, calculated
columns, association paths, structured fields, the projection's `where`) and translates every request to the backend's
names and every answer back.

What you get without writing a handler:

| Area | Features |
| --- | --- |
| Reading | Hybrid `$filter` push-down, field aliases, calculated columns, association path columns, structured fields, the projection's own `where`, `$expand` across services, `$search`, `$orderby`, paging, `$count`, DISTINCT / GROUP BY / aggregates, JOIN views, static data |
| Filters through associations | `_A/_B/Field eq 'v'` and OData `any()` through to-one and to-many associations, answered by key semi-joins instead of full reads |
| Reads by key | A filter that pins the source key (or lists several keys) becomes one read by key per key; unknown keys answer 404 |
| Writing | CREATE / UPDATE / DELETE on the projection written to its source; write rules checked before the backend is written; deep writes; non-CRUD APIs (every change a POST) |
| Operations | Bound and unbound actions / functions forwarded to the source operation |
| Backend quirks | Opt-in annotations for fields a backend cannot filter, flags it cannot compare, date-time fields exposed as dates |
| Operations support | `[remote]` log line of every backend request, request-scoped tracing, secret redaction |

It has no authentication or authorization model of its own (CAP's `@requires` / `@restrict` apply as usual), no
business logic and no override seams: bespoke behavior goes into ordinary CAP handlers of your service.

---

## 📑 Table of Contents

📥 [Installation](#-installation)\
🧭 [How it works](#-how-it-works)\
⚡ [Quick start](#-quick-start)\
🏷️ [Annotation reference](#️-annotation-reference)\
📝 [Modelling reference](#-modelling-reference)\
🔍 [Reading data](#-reading-data)\
🔗 [Filters through associations](#-filters-through-associations)\
🔑 [Reads by key](#-reads-by-key)\
✏️ [Writing data](#️-writing-data)\
⚙️ [Actions and functions](#️-actions-and-functions)\
🔌 [Class API](#-class-api)\
🧩 [CAP plugin: the `@remote` annotation](#-cap-plugin-the-remote-annotation)\
🧼 [SOAP backends](#-soap-backends)\
🛠️ [Configuration and logging](#️-configuration-and-logging)\
🚦 [Errors and results](#-errors-and-results)\
🚀 [Performance guide](#-performance-guide)\
🔒 [Boundaries and security](#-boundaries-and-security)\
🩺 [Troubleshooting](#-troubleshooting)\
⚠️ [Known limitations](#️-known-limitations)\
💬 [Support and feedback](#-support-and-feedback)\
📄 [License](#-license)

---

## 📥 Installation

[↑ Table of Contents](#-table-of-contents)

```bash
npm install @cap-ts/remote-service-adapter
```

The package registers itself as a CAP plugin (`cds-plugin.js`): no `require()` is needed for the `@remote` annotation.
`cds watch` and `cds build` pick it up. Importing the class (`import { RemoteApplicationService } from
'@cap-ts/remote-service-adapter'`) works either way.

| Peer | Version | Notes |
| --- | --- | --- |
| `@sap/cds` | `^9.9.1 \|\| ^10` | CAP runtime. Node.js >= 20 (cds 10 needs >= 22). |
| `@cap-ts/soap-adapter` | `^0.2.0 \|\| ^0.3.0-beta.0` | Used at runtime only for services of `kind: 'soap'`; a required peer because the SOAP dispatch imports it. |
| `@sap-cloud-sdk/connectivity`, `@sap-cloud-sdk/http-client` | `^4.7.0` | Destination lookup and HTTP for `@cap-ts/soap-adapter`. |
| `@cap-js/cds-types` | `>=0.18.0`, optional | TypeScript types for `@sap/cds`. |

No runtime `dependencies` of its own (everything else is a peer or a Node.js built-in).

---

## 🧭 How it works

[↑ Table of Contents](#-table-of-contents)

```diagram
Client (OData V4 / Fiori)
      │
      ▼
Your CAP service (implementation: RemoteApplicationService, via @remote or a subclass)
      │  READ / CREATE / UPDATE / DELETE / actions of every entity
      ▼
RemoteApplicationService: query in local names → query in source names → backend → rows in local names
      │  cds.connect.to() / a service of this application / cds.db / soap.read()
      ▼
Backends: OData V2 / V4, SOAP (@cap-ts/soap-adapter), other CAP services of this application, the database
```

For every request the service:

1. Splits the `$filter` into the part the backend can evaluate (pushed) and the rest (evaluated in memory).
2. Translates the pushed part, `$select`, `$orderby`, keys and paging to the source's names.
3. Sends the query to the service that owns the source entity (paging through the backend when it needs every row).
4. Maps the answer back: aliases, calculated columns, structured fields, association paths, `$expand`.
5. Applies what was not pushed (filter, `$search`, sort, paging, `$count`) and prunes to the requested shape.

Services can be stacked: a projection on an entity of another `@remote` service is served the same way, and each layer
pushes down what it can to the layer below.

---

## ⚡ Quick start

[↑ Table of Contents](#-table-of-contents)

**1. Configure the external service** (`package.json` or `.cdsrc.json`):

```json
{
  "cds": {
    "requires": {
      "RemoteOrders": {
        "kind": "odata-v4",
        "model": "srv/external/RemoteOrders",
        "credentials": { "destination": "ORDERS_DESTINATION" }
      }
    }
  }
}
```

`kind` is `odata`, `odata-v2`, `odata-v4` or `soap`. It decides the `$search` case rule and, for `soap`, the dispatch.

**2. Declare the projection service, annotated `@remote`:**

```cds
using { RemoteOrders } from './external/RemoteOrders';

@remote
service OrderService {
    entity Orders as projection on RemoteOrders.Orders {
        key ID,
        OrderName as Title,              // alias: local Title <-> remote OrderName
        Amount,                          // same name
        _Customer.Name as CustomerName,  // to-one association path
        _Items                           // association, for $expand
    };
}
```

**3. Run `cds watch`.** `GET /odata/v4/order/Orders` is live: no handler file.

**Alternative: extend the class**, when the service also needs handlers of its own:

```ts
// srv/OrderService.ts
import { RemoteApplicationService } from '@cap-ts/remote-service-adapter';

export class OrderService extends RemoteApplicationService {
    async init(): Promise<void> {
        // Handlers registered here run BEFORE the generic ones (READ, writes, operations of every entity).
        this.before('CREATE', 'Orders', (req) => { /* validation, derived values */ });
        await super.init();
    }
}
```

With a handler file (or `@impl`, or `cds.requires.<Service>.impl`), the plugin leaves the service alone.

---

## 🏷️ Annotation reference

[↑ Table of Contents](#-table-of-contents)

Every annotation goes on the definition it describes, in the local (projection) service.

| Annotation | On | Effect | Section |
| --- | --- | --- | --- |
| `@remote` | service | Makes `RemoteApplicationService` the service's implementation (CAP plugin). | [CAP plugin](#-cap-plugin-the-remote-annotation) |
| `@response.data: [ {...} ]` | entity | Static rows: returned as they are, no backend call. Not writable. | [Static data](#static-data) |
| `@remote.filter.local` | element / entity | Request `$filter` and `$search` on the element run in memory. On the entity: every element whose source field is `@sap.filterable: 'false'`; `@remote.filter.local: false` on an element opts it out. | [Fields the backend cannot filter](#fields-the-backend-cannot-filter) |
| `@remote.pushdown: false` | calculated element | Filters on the element stay in memory (no boolean-flag push-down). | [Calculated columns](#calculated-columns) |
| `@remote.operation: 'Name'` / `'<Service>.<Name>'` | action / function | Forwards to the bound operation `Name` of the source entity, or to the unbound operation of another service. | [Actions and functions](#️-actions-and-functions) |
| `@remote.write.asInsert: ['UPDATE', 'DELETE']` | entity | Sends these events as `INSERT` (POST) with the source keys in the body. | [Non-CRUD backends](#non-crud-backends) |
| `@remote.write.operation: { field, CREATE, UPDATE, DELETE }` | entity | Sets the source field `field` to the event's code in the body. | [Non-CRUD backends](#non-crud-backends) |
| `@remote.write.truncate` | entity / element | Cuts strings to the element's length before the write (`false` on an element opts out). | [Writing data](#️-writing-data) |
| `@remote.write.deep` | association | Data of the association is written with the parent (upsert per child row). | [Deep writes](#deep-writes) |
| `@remote.assert: (case when <cond> then '<message>' end)` | element | Check evaluated before the backend write; the first matching `when` is the error. | [Write rules](#write-rules) |
| `@remote.assert.args: [ ... ]` | element | Message arguments (`{0}`, `{1}`, ...) of `@remote.assert`: paths or `(<expression>)`. | [Write rules](#write-rules) |
| `@remote.assert.target` | to-one association | The target must exist (`ASSERT_TARGET`). | [Write rules](#write-rules) |
| `@remote.write.value: (<expression>)` | element | Value computed before the write when the data has none. | [Write rules](#write-rules) |

Standard annotations the service reads:

| Annotation | Effect |
| --- | --- |
| `@cds.search: false` / `true` (element), `@cds.search: { A, B }` (entity) | Which columns `$search` uses. |
| `@cds.query.limit: { default, max }` (source entity or its service) | Page size when every source row is read (GROUP BY, DISTINCT, association fetches). |
| `@sap.filterable: 'false'` (source element, from the EDMX) | Terms of the projection's own `where` on it are evaluated in memory; request filters with `@remote.filter.local`. |
| `@odata.Type: 'Edm.Date'` (local element) | A date-time source value is delivered as a date, date literals are compared as days. |
| `@mandatory` (child element) | Checked on every child row of a deep write (CAP checks the root only). |
| `@readonly` | CAP drops client values; your handler may set them (backend-only values). |

---

## 📝 Modelling reference

[↑ Table of Contents](#-table-of-contents)

The local ↔ remote mapping comes from the projection's columns. Never hard-code remote field names in TypeScript.

```cds
entity Orders as projection on RemoteOrders.Orders {
    key ID,
    OrderName as Title,                           // alias
    Amount,                                       // same name
    virtual Flag : Boolean,                       // never requested from the backend
    left(OrderName, 2) as Prefix : String(2),     // calculated in memory
    case when Status = 'X' then true else false end as IsClosed : Boolean,   // boolean flag, filter pushed
    Address.City as City,                         // field of a structured element
    _Customer.Name as CustomerName,               // to-one association path, any depth
    _Items,                                       // association, $expand
    _Customer : redirected to Customers           // association to another entity of this service
} where Kind = 'A';                              // the projection's own WHERE, applied to every read and write
```

| Element | Behavior |
| --- | --- |
| `Remote as Local` | Translated both ways. A remote field exposed under several names (`*` plus `Field as Alias`) is requested once and fills every name. |
| `virtual` | Never requested; filters on it run in memory. |
| Calculated (`<expr> as Name`) | Computed in memory from the source values: a CASE, or one function call (`left(Field, 2)` reads the source's `Field` even when the projection renames it). Its source fields are requested automatically. Never sent to the backend. |
| Boolean flag (`case when Field = 'v' then true else false end`) | Computed in memory; a filter `Flag = true / false` is pushed as `Field = 'v'` / `Field != 'v'`. |
| Structured field (`Struct.Field as X`) | The backend is asked for the structure, the answer flattened. Filters on it run in memory. Written back as `{ Struct: { Field } }`. |
| Path column (`_A._B.Field as X`) | Resolved across to-one associations at any depth, one batched key fetch per hop. A to-many hop or filtered segment requested explicitly is 501. |
| Association | Declare the ON condition (or managed keys). Used for `$expand`, path columns, filters through associations, write rules and deep writes. |
| `Date` element over a date-time source field | Delivered as `yyyy-mm-dd`; date literals compared with it are sent as day ranges. |
| `String(n)` | A `$search` word longer than `n` is not pushed for that column. |

### Static data

```cds
@response.data: [{ ID: 'A', Name: 'Alpha' }, { ID: 'B', Name: 'Beta' }]
entity Codes as projection on RemoteOrders.Codes { key ID, Name };
```

Returned as is, no backend call, never written.

### JOIN views

```cds
entity OrderLines as select from RemoteOrders.Orders as o join RemoteOrders.Items as i on i.OrderID = o.ID {
    key i.ID, o.Title, i.Quantity
};
```

The first source is read, the joined sources are fetched by key in batches and merged. A JOIN view with its own `where`
is 501; JOIN views are not writable. See [Known limitations](#️-known-limitations).

---

## 🔍 Reading data

[↑ Table of Contents](#-table-of-contents)

### `$filter` push-down

The WHERE is split at its top-level `and`. Each term is pushed to the backend when it only reads plain mapped fields;
otherwise it is evaluated in memory after the fetch. Evaluated in memory: virtual, calculated, path and unmapped
fields, structured fields, fields with `@remote.filter.local`, and (for SOAP) any function. The in-memory evaluator
understands `and` / `or` / `not`, comparisons, `[not] in`, `is [not] null`, `exists` (OData `any()`), and the functions
`contains`, `startswith`, `endswith`, `indexof`, `tolower` / `toupper`, `length`, `trim`, `substring`, `concat`,
`replace`, `left`, `right`, `coalesce` / `ifnull`, `round`, `floor`, `ceiling`, `abs`, `year`, `month`, `day`.

Pushed in a backend-friendly form:

| Request term | Sent as |
| --- | --- |
| `Prefix = 'AB'` on `left(Field, 2) as Prefix` | `startswith(Field, 'AB')` |
| `IsClosed = true` on `case when Status = 'X' then true else false end as IsClosed` | `Status = 'X'` (`false`: `Status != 'X'`) |
| `Day >= 2026-09-28` on a `Date` element over a date-time source | `Day >= 2026-09-28T00:00:00Z` (only `>=` / `<=`; `=` becomes the day range) |
| The same condition twice (e.g. from two stacked layers) | Once |
| A literal comparison that is false (`'1' = '2'`, written by CAP for a restriction whose `$user` attribute is missing) | Nothing: the answer is empty, the backend is not called |

If the backend rejects the pushed filter (an error with `400` or `filter` in it, or an association path complaint),
the read is repeated without the filter and the whole WHERE is applied in memory.

A filter or sort on an element that `$select` leaves out works: rows are filtered and sorted before they are pruned.

### Fields the backend cannot filter

OData V2 services declare some fields `sap:filterable="false"` and ignore a `$filter` on them without an error (every
row comes back). Opt in to in-memory evaluation:

```cds
@remote.filter.local                                   // every sap:filterable=false field of the source
entity Entries as projection on Remote.Entries {
    *,
    @remote.filter.local: false Note                   // ...except this one: pushed
};

entity Tasks as projection on Remote.Tasks {
    key ID, Owner,
    @remote.filter.local Label                         // just this element, whatever the EDMX says
};
```

The read then fetches every row the rest of the filter leaves, so opt in where that set is small (for example when
another pushed term restricts it to one user's rows). Terms of the projection's own `where` on such fields are always
evaluated in memory, without annotation.

### The projection's own WHERE

```cds
entity OpenOrders as projection on RemoteOrders.Orders {
    key ID, Amount, _Customer.ValidTo as CustomerValidTo
} where Status != 'CANCELLED' and _Customer.ValidTo >= current_date;
```

- Plain source fields are pushed with the request's filter (they need not be projected).
- To-one association paths are resolved and evaluated in memory.
- `$user`, `$user.<attribute>`, `$now`, `current_date`, `current_time`, `current_timestamp` take the request's values.
- Reads by key re-check every term in memory; a row that fails is 404. Projections on top inherit the filter.
- Writes respect it: CREATE fills `Field = 'v'` terms (a different value is 400), UPDATE / DELETE of a row outside is 404.
- What can be neither pushed nor evaluated (`exists`, a sub-select, `$at`, a to-many or filtered path, `like` /
  `between` / an unknown function in an in-memory term) is 501, never ignored.

### Paging and `$count`

- `$top` / `$skip` go to the backend only when nothing is evaluated in memory afterwards; otherwise every row matching
  the pushed part is read and the page is cut here (logged once per entity as a warning on `cds.log('remote-service')`).
- `$count` is always a number. It is the backend's count when nothing is filtered in memory, else the count after local
  processing. OData V2 sends its count as text; the service converts it.
- A count only (`$top=0&$count=true`) is one `GET <Entity>/$count?$filter=...`: no rows move. Fallbacks: one row plus
  the total, then reading in pages. A count never reads every row in one request.
- When every source row is needed (GROUP BY, DISTINCT, association fetches of a stacked service), the source is read in
  pages of its `@cds.query.limit.max` (entity, then service, then `cds.query.limit.max`, CAP default 1000), ordered by
  the source key, until the backend's total is reached. A backend that caps its pages below that size just needs more
  pages. Ending short of the total is a 502, never a partial result.
- A page past the end returns `[]` with the full `$count`.
- In-memory sorts compare numeric elements as numbers, also when the values arrive as strings.

### `$expand`

- Declare the association; `$expand=_Items` becomes batched `<key> in (...)` reads of the target (at most 200 parent
  keys per request), grouped per parent. Nested expands, `$filter`, `$orderby` and `$count` inside the expand work.
- Children the backend delivered inline are mapped, filtered, limited and expanded further in place.
- A target served by another `RemoteApplicationService` is read without a page limit, in pages up to its total.
- A managed to-one association is joined on its foreign key elements (`<assoc>_<key>`); an association from an EDMX
  model without ON condition joins on the key names it shares with its target.
- A backend that rejects the expand query is asked again without columns, filter and order.

### Path columns

`_A._B.Field as X` is resolved after the main read: one batched key fetch per hop level for all rows. To-many hops and
filtered segments are 501 when requested in `$select`, `$filter` or `$orderby` (left out otherwise). `$orderby` on a
path sorts by the resolved value.

### Calculated columns

Computed in memory on the source values: a CASE expression (simple or searched; conditions with comparisons, `and` /
`or` / `not`, `in`, `is null`), or one function call (`left(Field, 2)`, `concat(A, B)`, `coalesce(A, B)`, any function
listed above, also inside an expression). Operators outside a CASE (`A || B`, `A + B`) are not computed: write
`concat(A, B)`, or compute the value in a handler. A calculated element of an association target served by another `RemoteApplicationService` is computed by that service.
An association whose ON condition uses a calculated column is resolved with the computed value.
`@remote.pushdown: false` keeps filters on a calculated column in memory, for a backend that mishandles the comparison
of its source field (for example `Status != 'X'`).

### Structured fields

`Address.City as City` asks the backend for `Address` and flattens the answer. Filters, `$search` and the `left()`
push-down on structured fields run in memory. Writes send `{ Address: { City } }`.

### `$search`

OData V4 syntax: words ANDed, `OR`, `NOT`, parentheses, `"phrases"`. Searched: string elements (keys included), to-one
path strings and calculated string columns; not LargeString, UUID, virtual, to-many paths, `String(n)` with n > 500.
Tune with `@cds.search`. The case rule follows the backend the data comes from (`cds.requires.<service>.kind`):
`odata-v2` case-sensitive, `odata` / `odata-v4` and local case-insensitive (`tolower`), `soap` not supported (the term
is ignored). A backend that rejects `tolower` is remembered and searched case-sensitively.

A sound `contains(field, word)` filter is pushed where possible (including key lists of matching associated rows);
the local match always has the final say. Without any push the read is bounded at 5000 rows; more is a 502 asking for
a `$filter`.

### DISTINCT and GROUP BY

Only when the entity itself declares `distinct` / `group by`. Computed in memory over every source row (read in pages):
`count`, `count_distinct`, `sum`, `avg`, `min`, `max`. When every aggregate is a row count and the `$filter` fixes
every group column (`=` / `in`, at most 25 combinations), one `$count` request per combination replaces the read.

```cds
entity ItemCounts as projection on RemoteOrders.Items { key Category, Status, count(ID) as N : Integer } group by Category, Status;
annotate RemoteOrders.Items with @cds.query.limit: { default: 1000, max: 5000 };   // page size for reading every row
```

---

## 🔗 Filters through associations

[↑ Table of Contents](#-table-of-contents)

Filters may go several associations deep, through to-one and to-many associations:

```http
GET /odata/v4/order/Orders?$filter=_Customer/_Group/Region eq 'EMEA'
GET /odata/v4/order/Orders?$filter=_Customer/_Contacts/any(c: c/_Mails/any(m: m/Address eq 'x@example.com'))
```

The main entity's backend cannot evaluate these. Instead of reading every order and expanding the associations, the
service answers them with **semi-joins**, hop by hop:

1. The first association's target (`Customers`) is read with the rest of the condition (`_Group/Region eq 'EMEA'`),
   selecting only its join keys. Its own service answers that rest the same way, so a chain of any length resolves
   level by level.
2. The main entity is filtered by the keys found:
   - at most 200 key values: pushed as `CustomerID in (...)` (backend `$top` and `$count` stay correct);
   - at most 5000 keys: the same filter in memory (the main entity is read without any expand);
   - no key: an empty answer, the main entity is not read.
3. Above 5000 keys, or when the target's `$count` does not prove the key list complete, the filter is evaluated in
   memory on hidden expands of the associations (correct, slower).

Rules per hop:

- The hop is joined on key pairs: the ON condition, managed foreign keys, or (EDMX associations without ON) the key
  names it shares with its target. Composite keys are pushed as `(k1 = a and k2 = b) or ...`; empty-string values are
  left out of the pushed filter (OData V2 backends answer `X eq ''` with no row) and the exact filter is applied in
  memory.
- A constant on the target side of the ON condition (`and _Partner.Role = 'BP'`) filters the target read; a constant on
  the parent side keeps the term in memory.
- Supported terms: `=`, `in`, `contains`, `startswith`, `endswith` on the leaf, and `exists` / `any()` with infix
  filters (nested). A hop whose target is an external service (not a projection served by this application) only
  accepts a filter on a field of its own.
- The target's key reads use the request's user, tenant and locale, so the target's `@restrict` applies.

A filter or sort through an association that cannot be a semi-join (for example `or` across associations) is evaluated
in memory: the associations it reads are expanded with just the needed fields and removed from the answer again.

---

## 🔑 Reads by key

[↑ Table of Contents](#-table-of-contents)

| Request | Backend call |
| --- | --- |
| `Orders('O1')` | `Orders('O1')` (key in the source's names); no `$top`, no count |
| `$filter=ID eq 'O1'` (every source key pinned with `=`, or `in` with one value) | read by key, answer shaped back (list with `$count`, or `SELECT.one`) |
| `$filter=ID in ('O1','O2','O3')` | one read by key per value (at most 50), merged, sorted, counted and paged here |
| `$filter=(Company eq 'C1' and No eq '1') or (Company eq 'C2' and No eq '7')` | one read by key per key tuple |
| a key tuple that contradicts another pinned key (`Owner eq 'A' and ((Owner eq 'B' and ...) or ...)`) | dropped: no row, no call |
| an unknown key | 404 `Entity '<name>' not found` for a key read, an empty list for a filter |

Backends answer keys in a `$filter` slowly (a scan) or wrongly; the key in the URL addresses the row. The rest of the
WHERE is re-checked on the row (also the projection's own `where`); a row that fails is 404 (key read) or left out.

When the entity's key is not the source's key (a DISTINCT view, a different key element), `Entity('x')` is read with a
filter instead.

---

## ✏️ Writing data

[↑ Table of Contents](#-table-of-contents)

CREATE / UPDATE / DELETE on a simple projection are written to its source entity:

```cds
entity Orders as projection on RemoteOrders.Orders { key Company, key No, Note as Text, Header.Title as Title } where Kind = 'A';
```

- `POST Orders` sends `INSERT` into `RemoteOrders.Orders` with `Note`, `{ Header: { Title } }` and `Kind = 'A'` (from
  the `where`).
- `PATCH Orders(Company='C1',No='1')` reads the row by key first (404 when it is outside the `where`), then sends
  `PATCH Orders(Company='C1',No='1')`. After an answer without a row (OData V2: 204) the entity is read again.
- `DELETE` reads the row the same way, then deletes it.
- Keys: the source's keys come from the URL key and `req.data` (local names). When the entity's key is not the source's
  key, the missing source keys are read by the entity's own key (a handler that knows them can put them into
  `req.data` and save that read).
- Calculated, virtual and path elements are dropped from the data; an unknown element is 400; data for an association
  without `@remote.write.deep` is 501.
- Database sources are written by CAP's generic handler. JOIN views, static data and SOAP sources are 501.
- Backend errors keep their status (502 without one), code and message.
- `@remote.write.truncate` on the entity or an element cuts strings to the element's length.

Handlers of your service run first: a `before` handler validates or sets values; an `on` handler registered before
`super.init()` replaces the generic write unless it calls `next()`.

### Backend-only values

Values the backend needs but clients never send are projected as `@readonly` (often `@UI.Hidden`) elements and set by
your handler. CAP drops client values of `@readonly` elements, not the values your handler puts into `req.data`.

### Non-CRUD backends

For APIs where every change is a POST that names the operation in a field:

```cds
@remote.write.asInsert: ['UPDATE', 'DELETE']
@remote.write.operation: { field: 'Op', CREATE: 'C', UPDATE: 'U', DELETE: 'D' }
entity Entries as projection on Remote.Entries { key Company, key Rec, Note, @readonly @UI.Hidden Released };
```

`PATCH Entries(...)` becomes `POST Entries` with `{ Note, Company, Rec, Op: 'U' }`. A DELETE sent this way returns
the backend's row when it answers one. Invalid settings (another event in `asInsert`, an operation field that is not
an element of the source, codes without a field) are a 500 naming the entity.

### Write rules

CAP checks `@assert` after the write, against the database, and rolls back on failure. A remote backend cannot roll
back, so declare the rules with `@remote.*`; they are evaluated in memory before anything is written:

```cds
entity Bookings as projection on Remote.Bookings {
    key ID,
    Customer,
    @remote.assert.target
    _Customer : Association to one Customers on _Customer.ID = $self.Customer,       // ASSERT_TARGET on Customer
    Project,
    @remote.assert: (case when not exists _Project or _Project.Customer != Customer then 'ASSERT_TARGET' end)
    _Project : Association to one Projects on _Project.ID = $self.Project,
    @remote.assert: (case when Day < _Project.StartDate or Day > _Project.EndDate then 'BOOKING_OUTSIDE_PROJECT' end)
    @remote.assert.args: [Project, (left(_Project.StartDate, 10)), (left(_Project.EndDate, 10))]
    Day,
    @remote.write.truncate
    @remote.write.value: (Customer || ' - ' || _Customer.Name)
    CustomerText
};
```

- `@remote.assert`: a CASE expression; the first matching `when` gives the message (text or i18n key, looked up like
  CAP's `@assert`), target = the element. `@remote.assert.args` gives `{0}`, `{1}`, ... (paths or `(<expression>)`).
- `@remote.assert.target` on a to-one association: the target must exist (`ASSERT_TARGET`, target = its foreign key).
- `@remote.write.value`: computed when the write's data has no value (a value from the caller or a handler wins); on
  UPDATE computed from the stored row merged with the data.
- Expressions read the entity's elements and one-hop to-one paths (`_Assoc.Field`, `exists _Assoc`, `not exists
  _Assoc`), with CASE, `||`, `+ - * /`, comparisons, `and` / `or` / `not`, `is [not] null` and the in-memory functions.
  Each association is read once per write through the service that owns its target. Deeper or to-many paths are 501.
- All failing checks are collected: one 400 error, or `MULTIPLE_ERRORS` with `details`.
- A date compared with a date-time compares as instants.

### Deep writes

```cds
entity Projects as projection on Remote.Projects {
    key ProjectID, Name,
    @remote.write.deep
    _Packages : Association to many Packages on _Packages.ProjectID = $self.ProjectID
};
entity Packages as projection on Remote.Packages { key ProjectID, @mandatory key PackageID, Description };
```

- `POST` / `PATCH Projects` with `_Packages: [...]` writes the project, then every package row as an upsert (`PATCH`
  when a row with its key exists, else `POST`; a row without all its keys is created), the join keys filled in from the
  parent, recursively for the packages' own `@remote.write.deep` associations.
- Checked before anything is written: the shape (to-many: an array of objects, to-one: an object; 400) and `@mandatory`
  of every child row (join keys from the parent excepted).
- A failing row does not stop its siblings (its own children are skipped). All failures come back as one
  `MULTIPLE_ERRORS` (400 when all are 4xx, else 502) with the path of each row (`_Packages[1]/_Items[0]`). Rows written
  before stay written: there is no transaction across backend requests. Children left out of the payload are not
  deleted. No ETag handling.

---

## ⚙️ Actions and functions

[↑ Table of Contents](#-table-of-contents)

Operations of the local service are forwarded to the source without a handler:

```cds
entity Documents as projection on Remote.Documents { key DocNo as No, Title } actions {
    action Cancel() returns many Remote.CancelResult;   // bound operation of the same name on Remote.Documents
    function GetPDF() returns Remote.PDF;
    @remote.operation: 'Release'
    action ReleaseDocument();                           // bound operation `Release` of Remote.Documents
};

@remote.operation: 'Remote.upsertStatus'               // unbound operation of another service
action setStatus(DocNo : String(10), Status : String(20)) returns Statuses;
```

- Bound: the URL key is translated to the source's names and sent as the binding parameter (OData V2: a function import
  with the keys as parameters), the parameters as data.
- Unbound: the parameters are sent as they are (their names must be the source operation's names).
- `returns X` / `returns many X` with `X` an entity of this service over a remote source: rows mapped to local names
  (calculated columns included). Other answers are returned as they come.
- A handler you register before `super.init()` wins. `@remote.operation` naming no existing operation fails `init()`.
- Backend errors keep their status (502 without one) and message.

---

## 🔌 Class API

[↑ Table of Contents](#-table-of-contents)

```ts
import { RemoteApplicationService } from '@cap-ts/remote-service-adapter';

export class OrderService extends RemoteApplicationService {
    async init(): Promise<void> {
        this.after('CREATE', 'Entries', async (row, req) => {
            // a further write inside the same, already authorized request
            await this.writeSource('UPDATE', 'Entries', { ...row, Released: true }, { checkWhere: false });
        });
        await super.init();
    }
}
```

| Member | Description |
| --- | --- |
| `init()` | Registers READ, CREATE / UPDATE / DELETE and the operation forwarding for every entity, then `super.init()`. Called by CAP. |
| `readSource(entity, where, { columns }?)` | One row through the read pipeline without the service's handlers (aliases, calculated columns, the projection's `where`; a filter on the source key is a read by key). `where` = element values compared with `=`. Returns the row in local names or `undefined`. |
| `writeSource(event, entity, data, { checkWhere, checks }?)` | The generic write without the service's handlers and without CAP's authorization and input checks; `@readonly` values are kept. `checkWhere: false` skips the read of the row against the projection's `where`; `checks: false` skips the write rules. Only from a handler that has authorized the request. |
| `supportsSkipPagination` | `true`: other instances may send this service the internal "all rows" hint of association fetches. |

`entity` is the definition or the name (with or without the service prefix); user, tenant, locale and headers come
from `cds.context`. Both methods are 501 for an entity without a remote source.

Every request gets an 8-character correlation id that appears in every log line of that request.

---

## 🧩 CAP plugin: the `@remote` annotation

[↑ Table of Contents](#-table-of-contents)

```cds
@remote
service Catalog {
    entity Partners as projection on ExternalPartners.Partners { key ID, Name as Title };
}
```

- `@remote` on the local service is the entire opt-in. The plugin does not look at what the entities project on or at
  `cds.requires`; `cds.requires.<name>` only configures how the sources are reached.
- A service keeps its own implementation when it has `@impl`, `cds.requires.<service>.impl`, or a handler file CAP
  would load (`<name>.js` / `.mjs`, `.ts` with TypeScript, next to the `.cds`, in `lib/` or `handlers/`). To combine
  both, extend `RemoteApplicationService` in that file.
- A service marked external (`@cds.external`, `@external`, `cds.requires.<name>.external`) is never patched.
- Do not point `cds.requires.<external>.impl` at `RemoteApplicationService`: it reads through
  `cds.connect.to(<external>)`, which would return itself.
- `DEBUG=remote-service` logs which services were patched.

---

## 🧼 SOAP backends

[↑ Table of Contents](#-table-of-contents)

```json
{ 
  "cds": { 
    "requires": { 
      "Partners": { 
        "kind": "soap", 
        "wsdl": "srv/external/wsdl/Partners.wsdl", 
        "credentials": { 
          "destination": "PARTNERS_DESTINATION" 
        } 
      } 
    } 
  }
}
```

Annotate the external model as `@cap-ts/soap-adapter` documents. Reads go through `soap.read` (a fresh request per
call, forbidden headers stripped), results are de-duplicated by the entity's keys, filter functions run in memory,
`$search` is ignored (all rows come back, the local match decides). SOAP sources are not writable, and a filter on
the key is not turned into a read by key (the SOAP operation gets its parameters from the URL key or a flat `and` of
equalities).

---

## 🛠️ Configuration and logging

[↑ Table of Contents](#-table-of-contents)

No package-specific config block is required; everything is driven by `cds.requires.<Service>` and the annotations.

| Setting | Description |
| --- | --- |
| `cds.requires.<Service>.kind` | `odata`, `odata-v2`, `odata-v4`, `soap`: `$search` case rule, SOAP dispatch. |
| `cds.requires.<Service>.model`, `.credentials.destination`, `.credentials.url` | Standard CAP: model of the external service, BTP destination, or a URL for local development. |
| `cds.requires.<Service>.impl` | Your own implementation: the plugin leaves the service alone. |
| `cds.remote-service.capRemoteLog: true` | Keep CAP's own remote-client debug lines (dropped by default, see below). |
| `@cds.query.limit.max` / `cds.query.limit.max` | Page size for reads of every source row. |

### `[remote]` query log

Every request sent to an external system (remote OData or SOAP, not the database or a service of this application)
is logged on `cds.log('remote')`:

- `info`: `[remote] - GET <destination>:<path>/<Entity>?$select=...&$filter=...` (SOAP: `[remote] - SOAP <service> <entity>`)
- `debug`: the query in the backend's names as one JSON line.

Both contain filter values. Silence them with `cds.log.levels.remote: 'warn'` or `CDS_LOG_LEVELS_REMOTE=warn`. CAP's
own remote-client lines on that channel (the request with headers, "Executing via @sap-cloud-sdk/http-client.") are
dropped, so debug shows exactly these two lines; `cds.remote-service.capRemoteLog: true` keeps them.

### Tracing (environment variables, read once at start)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEBUG` | unset | Must contain `remote-service` or `*`. Unset: no-op logger, zero cost. |
| `LOG_LEVEL` | `debug` with `DEBUG`, else `error` | `trace` < `debug` < `info` < `warn` < `error`; falls back to `CDS_LOG_LEVELS_ESI`. |
| `LOG_TO_CONSOLE` | `true` with `DEBUG` | `warn` / `error` to stderr, the rest to stdout. |
| `LOG_TO_FILE` | `false` | Also write `${LOG_DIR:-logs}/remote-service-YYYYMMDD-HHMMSS.log` (plus `remote-service-latest.log`). Disabled when `NODE_ENV=production`. |
| `LOG_DIR` | `logs` | Directory of the log file. |

```bash
DEBUG=remote-service LOG_TO_FILE=true npm run watch
```

Each line: ISO timestamp, level, correlation id (`[boot]` outside a request), `[module.method]`, message, redacted JSON
context. Redacted keys (case-insensitive, recursive): `authorization`, `auth`, `password`, `pwd`, `token`,
`access_token`, `refresh_token`, `apikey`, `api_key`, `secret`, `cookie`, `set-cookie`, `x-csrf-token`.

---

## 🚦 Errors and results

[↑ Table of Contents](#-table-of-contents)

| Situation | Result |
| --- | --- |
| Backend rejects the pushed filter (400-like, or an association path) | Read again without the filter, whole WHERE in memory |
| Read by key of an unknown key | **404** `Entity '<name>' not found` (also when CAP wraps the backend's 404 as 502) |
| Read by key whose WHERE re-check (request or projection) drops the row | **404** |
| Filter on the key that finds no row | `[]` with `$count = 0` |
| `SELECT.one` | One object, `undefined` without a row (OData: 404, or 204 for a nullable singleton) |
| Empty result | `[]`; with `$count`, `$count = 0` |
| WHERE with a false literal comparison | `[]`, no backend call |
| Path column across a to-many / filtered segment requested; path column on DISTINCT / GROUP BY | **501** before any backend call |
| Projection `where` that can be neither pushed nor evaluated; JOIN view with a `where` | **501** |
| `$search` not pushable on more than 5000 rows | **502** naming the backend's rejection when a push failed |
| Paged read ends short of the backend's total | **502** (no partial aggregates) |
| Write to a JOIN view, static data, a SOAP source; association data without `@remote.write.deep`; source key not exposed | **501** |
| Write: unknown element, missing key, value contradicting the projection's `where`, deep data of the wrong shape | **400** |
| Write: row outside the projection's `where`, or no row for the entity's own key | **404** |
| Write rule fails | **400** with the rule's message; several: `MULTIPLE_ERRORS` with `details` |
| Write rule not serviceable (`@remote.assert` not a CASE, deeper / to-many path) | **501** |
| Invalid write settings | **500** naming the entity |
| Deep write with failed child rows | `MULTIPLE_ERRORS` (400 when all are 4xx, else 502), `details[].target` = row path |
| `writeSource` / `readSource` on an entity without a remote source | **501** |
| Any other backend error (read, write, operation) | Its status (502 without one), code and message |
| SOAP returns several rows per key | One per key |

---

## 🚀 Performance guide

[↑ Table of Contents](#-table-of-contents)

| Concern | Guidance |
| --- | --- |
| Filters evaluated in memory | Every row matching the pushed part is read. Keep filters on plain mapped fields; push a restricting term along. |
| Filters through associations | Semi-joins are fast when the matching keys are few (pushed up to 200, in memory up to 5000) and each hop is joined on keys of projections served by this application. Declare an explicit ON when a managed association's derived keys are wrong. |
| Keys in a `$filter` | Lists of keys become reads by key (up to 50). |
| `$expand` / path columns on many rows | One batched request per association / hop and 200 parents; large parent sets mean several requests. |
| `$search` without push-down | Bounded at 5000 rows; add a `$filter`. |
| DISTINCT / GROUP BY | Every source row, in pages; prefer count requests (filter fixing every group column). |
| Fields the backend ignores in `$filter` | `@remote.filter.local`, only where the remaining set is small. |
| Metadata | Alias maps, column plans and association metadata are cached per definition: free after the first request. |

---

## 🔒 Boundaries and security

[↑ Table of Contents](#-table-of-contents)

| Boundary | Detail |
| --- | --- |
| No authentication or authorization of its own | The request's user, tenant and locale are propagated to the connected services; CAP's `@requires` / `@restrict` on your service apply, and the target's restrictions apply to semi-join and association reads. |
| No business logic | Validation and derived values are declared (`@remote.assert`, `@remote.write.value`) or written in your handlers. |
| Writes are pass-through | No transaction across backend requests (deep writes stay partially written on failure). |
| No CDS definitions of its own | It only reads `cds.model`. |
| Minimal public surface | The package exports `RemoteApplicationService`; nothing else is part of the published typings. No override seams. |
| Logs | Filter values appear in `[remote]` lines; secrets are redacted in the tracing log. |

---

## 🩺 Troubleshooting

[↑ Table of Contents](#-table-of-contents)

| Symptom | Cause and fix |
| --- | --- |
| A filter is not pushed | The term reads a virtual, calculated, path, structured or unmapped field (or a function on SOAP). Map the field 1:1, or accept the in-memory evaluation. |
| A filter is ignored (every row comes back) | The backend cannot filter that field (`sap:filterable="false"`). Add `@remote.filter.local`. |
| A filter through an association is slow | More than 5000 matching keys, or a hop without key join: the filter runs on expands. Check the `path-semijoin` log line ("Target read for a path filter"). |
| A boolean flag filter stalls the backend | The backend mishandles `Field != 'v'`: `@remote.pushdown: false` on the flag. |
| A date filter is rejected ("Invalid token") | A `Date` element over a date-time source without the date type: declare the element `Date` or `@odata.Type: 'Edm.Date'`. |
| 501 on `$select` / `$filter` / `$orderby` | Path across a to-many association or a filtered segment, or a path column on DISTINCT / GROUP BY. |
| 501 "The WHERE of `<entity>` can not be applied" | The projection's `where` uses `exists`, a sub-select, `$at`, a to-many path, or `like` / `between` in an in-memory term. Move it into a `before('READ')` handler. |
| 502 `$search` "more than 5000 rows" | Add a `$filter`. |
| 404 on a read by key | Unknown key, or the WHERE re-check (request or projection) dropped the row. |
| `$expand` children missing | The association's join keys are wrong (managed association without declared keys). Declare the ON condition. |
| Write 400 `ASSERT_*` / `MULTIPLE_ERRORS` | A write rule failed; `details` name each element or child row. |
| Nothing in the log | `DEBUG` must contain `remote-service`; check `LOG_LEVEL`, the sinks, `NODE_ENV=production` (no file), and the boot line "Registering READ and write handlers". |

Follow one request: find its correlation id and `grep '\[<id>\]' logs/remote-service-latest.log`.

---

## ⚠️ Known limitations

[↑ Table of Contents](#-table-of-contents)

Pinned by the package's regression tests:

1. **JOIN views** with more than two sources can pick the wrong primary source (an internal flattening defect); simple
   two-way joins work in practice.
2. **An `$expand`'s `$top`** applies to the whole batch of parents, not per parent.
3. **In-memory filters** (path, calculated, structured, `@remote.filter.local` fields, filters through associations
   above 5000 keys) read every row the pushed part leaves: correct, but slow on very large sets. The first full read
   per entity is logged as a warning.
4. **Deep writes** are not transactional and do not delete children missing from the payload.

---

## 💬 Support and feedback

[↑ Table of Contents](#-table-of-contents)

- Bug reports and feature requests: [GitHub issues](https://github.com/cap-ts/remote-service-adapter/issues).
- Questions: [GitHub Discussions](https://github.com/orgs/cap-ts/discussions).

---

## 📄 License

[↑ Table of Contents](#-table-of-contents)

This package is provided under the terms of the **SAP-Code-World** [Usage License Agreement](LICENSE).

© 2025 **SAP-Code-World**. All rights reserved.
