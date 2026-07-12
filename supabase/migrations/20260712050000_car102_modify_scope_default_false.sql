-- CAR-102 Phase E: flip the modify_scope_granted default to false.
--
-- With the scope flip live, a NEW connect requests only sensitive scopes
-- (sign-in + gmail.send, optionally calendar) and no gmail.modify, so the
-- callback persists modify_scope_granted = false for it. Making false the column
-- default keeps a row correct even if the callback ever omits the value. Existing
-- rows are untouched: every current connection genuinely holds gmail.modify and
-- stays premium (premium = modify_scope_granted AND premium_enabled). Deploying
-- this alongside the scope flip is what makes the live consent screen
-- sensitive-only, unblocking free OAuth verification.

ALTER TABLE public.gmail_connections
  ALTER COLUMN modify_scope_granted SET DEFAULT false;

COMMENT ON COLUMN public.gmail_connections.modify_scope_granted IS
  'CAR-102: whether this connection holds the gmail.modify scope (a truthful token-fact set by the OAuth callback). Default false as of the sensitive-scope flip; a premium connect re-adds gmail.modify and sets this true.';
