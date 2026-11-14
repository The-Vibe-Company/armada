-- One encrypted account may supply both compatible harnesses.
ALTER TYPE public.credential_kind ADD VALUE IF NOT EXISTS 'morph';
