-- CAR-96: the contacts list paginates each network tier with
-- `where user_id = ? and network_status in (...) order by name limit N`.
-- The existing contacts_user_network_status_idx (user_id, network_status)
-- covers the filter but not the ORDER BY, so Postgres sorts the whole tier
-- before returning each page — slow even for the first 50 rows on large
-- (bundle-imported) networks.
--
-- This composite index appends `name`, letting the paginated read walk the
-- index in name order and stop at LIMIT with no sort. Keep the narrower
-- (user_id, network_status) index: it stays the better choice for the
-- count-only tier-chip queries.
CREATE INDEX IF NOT EXISTS contacts_user_network_status_name_idx
  ON public.contacts (user_id, network_status, name);
