-- Server-only, owner/org scoped admission. No prompt, credentials or raw error is retained.
CREATE TABLE public.ordinary_launch_receipts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 16 AND 128),
  fingerprint text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, owner_id, request_key)
);
ALTER TABLE public.ordinary_launch_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ordinary_launch_receipts FROM anon, authenticated;
GRANT ALL ON public.ordinary_launch_receipts TO service_role;
