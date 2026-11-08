## Behavior

Describe the problem and the resulting behavior. Include any compatibility or data migration impact.

## Validation

List commands run and their results. State any checks not run and why. For a failed check, include the [failure record](https://github.com/theopoc/pocketmark/blob/main/docs/CI.md#local-preflight-and-failure-records), its disposition and any rerun result.

- [ ] Applicable local checks passed (see [CI instructions](https://github.com/theopoc/pocketmark/blob/main/docs/CI.md)).
- [ ] Diff and staged paths reviewed; redacted secret scan passed.
- [ ] PR title is a Conventional Commit suitable for the squash commit.
- [ ] Latest commit passes every required CI check; branch is up to date with `main`.

For a release PR, merging authorizes publication; review the version and generated notes.
