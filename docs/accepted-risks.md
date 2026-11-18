# Accepted risks for lifecycle reviews

Cite an entry by ID in the lifecycle design note and explain how the path under
review stays within its bound. A pending entry is a proposal. Only a dated owner
sign-off makes it an accepted risk, and only for paths where the stated bound
holds. Raise any behavior outside that bound in review.

| ID | Risk | Bound | Owner sign-off |
| --- | --- | --- | --- |
| AR-01 | A credential is revoked while an already-authorized provider create is in flight. | One allocation for that admitted create, bounded by the machine's enforced compute TTL. Each new create must pass current authorization. This entry covers the allocation only. | Pending |
| AR-02 | A crash after provider allocation and before the sandbox row commits leaves a machine without a DB owner. | [#2725](https://github.com/The-Vibe-Company/armada/issues/2725) targets deletion at about 15 minutes for machines tagged to this deployment. The 15-minute age grace period precedes eligibility, so sweep timing and provider failures can extend cleanup. Apply this bound only on paths with inventory deletion enabled and an enforced compute TTL. | Pending |
| AR-03 | A webhook is delivered again after the receiver accepts it and the sender fails to record the response. | The sender retries with the same delivery ID, with at most five attempts. The receiver deduplicates by persisting that ID atomically with its side effects. See the [outbound webhook contract](outbound-webhooks.md). | Pending |
| AR-04 | Account spend exceeds the monthly estimate cap as already-admitted work finishes. | Under [#2818](https://github.com/The-Vibe-Company/armada/issues/2818), admission refuses new launches and turns once the ledger reaches the cap. The accepted exposure would be the remaining spend of work already admitted at that point. This is a scope bound, with no fixed USD ceiling. | Pending |

Record each owner's approval date in YYYY-MM-DD format and link to the approval.
Example design-note reference: `[AR-03](accepted-risks.md#accepted-risks-for-lifecycle-reviews)`.
