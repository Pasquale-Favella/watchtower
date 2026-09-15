# Query-time custom pricing in every section

Status: accepted

Custom pricing (Alias and Price override, per the glossary) resolves at query time from the live config in every section through the single aggregation seam — never by rewriting stored ledger rows, so no rescan is ever needed. An Alias merges model identity into its target everywhere except Compare and the Models audit lens, which keep raw identity (Compare still reprices its cost column), and merged rows outside Models must show which raw models they aggregate.

Considered options: rewriting ledger rows on each pricing edit (rejected — destroys the audit trail, forces rescans, contradicts the raw-facts ledger); patching each section's pricing separately (rejected — diverges again at the next edit); keeping Compare fully raw including money (rejected — its totals would not reconcile).

Consequences: the aggregation test locking session summaries to the stored base cost moves to display cost, and the Compare raw-identity deviation is narrowed to grouping only, never money.
