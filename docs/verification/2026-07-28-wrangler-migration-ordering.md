# wrangler d1 migrations — ordering and gap tolerance

**Verified:** 2026-07-28, against `wrangler@4.35.0` as vendored in
`node_modules/wrangler/wrangler-dist/cli.js`, plus the live `d1_migrations`
table on the `skeptic-wire` database.

Written because `p2r-01` introduces a deliberate numbering gap: migrations
0026–0030 are reserved for the P2-R track and only 0026 is used, so applied
filenames run `...0025, 0026, 0031, 0032, ...`.

## Finding: gaps are safe

`d1 migrations apply` sorts by the **integer prefix**, numerically:

```js
const migrationNumberA = parseInt(a6.name.split("_")[0]);
const migrationNumberB = parseInt(b6.name.split("_")[0]);
```

The pending set is a plain filename difference against the ledger:

```js
const projectMigrations = getMigrationNames(migrationsPath);
for (const migration of projectMigrations) {
  if (!appliedMigrations.includes(migration)) unappliedMigrations.push(migration);
}
```

Contiguity is never consulted. Only relative numeric order and filename
uniqueness matter.

Confirmed live rather than only from source. The `d1_migrations` ledger keys on
`name`, with `id` as insertion order only:

```sql
CREATE TABLE d1_migrations(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

and production already contains `id 26 -> 0031_norges_boj.sql`, i.e. wrangler
applied 0031 directly after 0025 across a five-number gap, on four separate
occasions the same night, with no warning.

## Trap: `list` and `apply` do not order the same way

`getMigrationNames` reads the directory with `opendirSync`/`readSync` and
returns entries in **directory-iteration order with no sort**:

```js
const dir = fs.opendirSync(migrationsPath);
while ((dirent = dir.readSync()) !== null) {
  if (dirent.name.endsWith(".sql")) migrations.push(dirent.name);
}
```

`apply` sorts this list before executing. **`list` does not.** So
`wrangler d1 migrations list` can print pending migrations out of order while
`apply` still executes them correctly.

Consequence for triage: do not diagnose migration state from `list` output
ordering. It is cosmetic. The authoritative answers are the `d1_migrations`
table for what has been applied, and the numeric prefix for what order things
will run in.

## Practical rules

- Reserving a block of migration numbers across parallel tracks is safe.
- Never reuse a number: the ledger's `UNIQUE` is on the filename, so two files
  sharing a prefix are two separate migrations that both run, in an order
  decided by a `parseInt` tie and then directory order.
- Renumbering an already-applied migration re-runs it under its new filename.
  Never renumber anything that has shipped.
