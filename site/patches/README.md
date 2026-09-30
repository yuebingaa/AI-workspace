# Graphic Walker 0.5.2: multi-channel field index

The pinned official component hard-codes index `0` in both the delete and
aggregate callbacks of `multiEncodeEditor.tsx`. Acting on a later Tooltip field
therefore changes the first field. This was reproduced through the actual UI.

`@kanaries__graphic-walker@0.5.2.patch` changes only those two indices to the
current mapped index. It patches the source and the ESM distribution consumed
by this website's Vite build. The unused UMD distribution is **not** patched;
do not claim this as a general-purpose replacement distribution.

The patch is registered in `pnpm-workspace.yaml` and hashed in `pnpm-lock.yaml`.
Install with the repository's pinned pnpm workflow; do not edit `node_modules`
or replace it with `npm install` (which does not apply pnpm patches).
After upstream upgrades, inspect whether the fix is included, remove/rebase the
patch if appropriate, and repeat the later-Tooltip aggregation/removal browser
checks plus the native adapter tests. Existing Vite dependency caches may need
the managed development service to be restarted with user approval.

No branding, layout fork, or new runtime dependency is introduced by this patch.
