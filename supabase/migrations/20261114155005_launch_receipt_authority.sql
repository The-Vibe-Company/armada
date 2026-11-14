-- Non-secret immutable management locator; legacy receipts remain explicitly blocked.
ALTER TABLE public.ordinary_launch_receipts ADD COLUMN authority jsonb;
