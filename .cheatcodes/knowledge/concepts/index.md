# Concepts

## Gotcha

- [workflow_transition checkpoint forbids extra properties (data, majorWins, opportunities)](90bcb98d43.md) [draft] - The workflow_transition tool validates its checkpoint argument with additionalProperties: false. Nesting arbitrary content such as data, majorWins, or opportunities inside checkpoint fails validation with 'checkpoint: must not have additional properties'. Only the schema-defined checkpoint fields are accepted; summary payloads like the S-A/S-B/S-C1 strip-opportunity data in this episode must be kept out of the checkpoint object.
