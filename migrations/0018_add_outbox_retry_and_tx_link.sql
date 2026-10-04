-- Fix requested 2026-10-04: real production bug (transaction UMR-260002)
-- where closeTransactionToSupplier() reported "✅ تم الرفع." to the agent
-- and advanced the transaction to WAITING_HOSTING, while the actual
-- group_outbox delivery to the supplier's group silently failed
-- (error='Connection Closed', swallowed by a bare `.catch(() => {})` in
-- smartEmployee.ts) — the supplier never received anything, with zero
-- visible signal anywhere that anything had gone wrong.
--
-- Two additions to close this gap:
--
-- 1) `attempts` — lets /webhook/bridge/outbox/:id/ack retry a failed
--    delivery automatically (up to MAX_OUTBOX_ATTEMPTS, see webhook.ts)
--    before giving up, instead of a single try then permanent silent
--    'failed'. Historical data showed 104/130 (80%) of all group_outbox
--    rows ever created ended in 'failed' with zero retry — this was not
--    a one-off, it is the normal behavior today.
--
-- 2) `transaction_id` — optional link from an outbox row back to the
--    transaction it was delivering a summary/attachment for. When
--    retries are exhausted, the ack handler uses this to flip the
--    transaction to NEEDS_REVIEW (reason: delivery failure) AND queue a
--    visible warning back into the AGENT's own group, so a permanently
--    failed transfer is surfaced loudly instead of sitting silently in
--    WAITING_HOSTING forever while the supplier never got anything.
ALTER TABLE group_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_outbox ADD COLUMN transaction_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_group_outbox_transaction ON group_outbox(transaction_id);
