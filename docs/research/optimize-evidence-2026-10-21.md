# Optimize evidence and accounting

Optimize separates observed usage, session spending associated with a pattern,
and an estimate of avoidable usage. These values answer different questions.
A costly session can deliver useful research, and a session with no matched
commit can still be work in progress.

## Delivery outcomes

Local Git inspection assigns scoped session spending to mutually exclusive
outcome buckets. Attribution uses a timestamp window and remains a heuristic.
The outcomes are productive, reverted, mixed, unmatched, unmerged, ambiguous,
and unknown. A session with surviving and reverted main commits has mixed
evidence. A missing repository or failed inspection has unknown evidence.

No outcome amount claims that the corresponding session spending was wasted.
The UI exposes the matched commits, attribution window, inspection limitations,
and observation time. Current local history can change a past report after a
merge or revert. The selected spending period remains separate from the
additional one-hour commit allowance.

Unmatched means no commit was credited. Unmerged means credited commits were
not found on the inspected main ref. Neither establishes that work was
discarded. Research, explanation, review, and other non-code deliverables can
complete without a Git commit. Ambiguous means a competing session won the
same commit. Unknown means inspection could not establish an outcome.

## Findings

Findings distinguish setup recommendations, habits, and information for review.
Each finding states whether its quantity is observed or modeled, explains
its assumptions, and identifies supporting sessions where the facts permit.
Associated spend is the scoped spending of those sessions. It is not an
estimate of what changing a setting would save.

Claude setup recommendations require eligible Claude observations. Delegated
sessions retain their spending but are excluded from comparisons whose unit
is a human-started session. Current configuration cannot establish historical
exposure on its own. Unsupported evidence stays unknown.

Read/edit ratios exclude new-file writes. Repeated reads after an intervening
edit can be necessary. Required dependency instructions are not automatically
waste. An edit followed by a shell step and another edit is a rework signal;
it does not establish a failed test. Error and interruption diagnostics use
explicit captured facts and identify their coverage.

## Monetary estimates

The blended input-cost shortcut is removed. Optimize does not add overlapping
modeled quantities into a combined savings claim. Unsupported savings remain
unknown. A future estimate must identify its affected usage, counterfactual,
unique exposure, and applicable prices through the existing pricing engine.
Unknown rates stay unknown under ADR 0033.

Fixes are copyable suggestions. Copying one does not mean it was applied or
that it reduced spending. Applying configuration changes, backups, undo, and
before/after evaluation require a separate workflow.

## Boundaries

The implementation retains local inspection, query-time derivation, db-worker
ownership, and shared Effect Schema contracts. It introduces no hosted PR
verification, automatic fetching, new provider, or configuration editing.
Squash/rebase attribution and output/context analysis require stronger evidence
than temporal proximity or a configured maximum. These limitations must remain
visible rather than becoming inferred waste.

## Windows Git inspection

Windows worker threads expose environment keys with case-sensitive lookup.
Executable discovery must recognize `Path` as the Windows search path. Missing
that key can send Git through a command shell, where a format argument containing
a pipe is interpreted as a pipeline and inspection fails. The executable lookup
handles Windows key casing without changing the environment or shell behavior.
