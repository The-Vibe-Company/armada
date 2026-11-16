-- Server-only typed refusals. NULL continues to fence unfinished/uncertain launches.
ALTER TABLE public.ordinary_launch_receipts ADD COLUMN failure jsonb;
ALTER TABLE public.ordinary_launch_receipts ADD CONSTRAINT ordinary_launch_receipts_one_outcome
  CHECK (response IS NULL OR failure IS NULL);
