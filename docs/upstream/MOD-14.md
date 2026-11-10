# MOD-14 — `entity-retype` renames the file but leaves the graph typed as person

Target: `personal-model` 0.3.2. Status: not filed, not applied. Found by OG-00b (2026-11-05).

## Observed (`docs/test-evidence/MOD-14/2026-11-05-raw.json`)
- `persome entity-retype "Research Team" --kind org` → `ValueError: retype: no person entity file for 'Research Team'`; `--help` says "Exact entity display name", but the lookup (`evomem/retype.py::_find_entity_file`) compares against the slug (`research-team`).
- `persome entity-retype research-team --kind org` → `person-research-team.md → org-research-team.md (evo=2 entries=0 md=absent)`. Afterwards the live Point still has tag `person-entity`, and all relation Lines keep `source/target_entity_kind=person` for Research Team, including 3 `knows` edges (a predicate legal only between persons).

## Suggested fix
1. `_find_entity_file`: accept display name or slug (normalize with `_entity_slug`).
2. `retype_entity`: also update `relation_edges.src_kind/dst_kind` for the identity, close edges whose predicate is illegal for the new kind (`_LEGAL_ENDPOINTS`), and re-tag the PersonGraph node (or drop it from PersonGraph).
