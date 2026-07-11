-- CAR-78: wrap auth.uid() as (select auth.uid()) in the bundle-sync hot-path
-- policies (Supabase `auth_rls_initplan` lint). Unwrapped, Postgres re-evaluates
-- the uid per row; on the sync's 500-row bulk inserts the child-table policies
-- (`contact_id IN (SELECT id FROM contacts WHERE user_id = auth.uid())`) ran
-- their subquery per inserted row. The initplan form evaluates once per
-- statement. Predicates are otherwise byte-identical to the originals in
-- 20260214065459_add_rls_policies.sql, 20260707000000 (suppressed_imports),
-- 20260709000000 (bundle tables), and 20260709140000 (visibility rewrite).

-- ── contacts ───────────────────────────────────────────────
DROP POLICY IF EXISTS "contacts_select_own" ON "contacts";
CREATE POLICY "contacts_select_own" ON "contacts"
  FOR SELECT USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "contacts_insert_own" ON "contacts";
CREATE POLICY "contacts_insert_own" ON "contacts"
  FOR INSERT WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "contacts_update_own" ON "contacts";
CREATE POLICY "contacts_update_own" ON "contacts"
  FOR UPDATE USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "contacts_delete_own" ON "contacts";
CREATE POLICY "contacts_delete_own" ON "contacts"
  FOR DELETE USING (user_id = (select auth.uid()));

-- ── contact_emails ─────────────────────────────────────────
DROP POLICY IF EXISTS "contact_emails_select" ON "contact_emails";
CREATE POLICY "contact_emails_select" ON "contact_emails"
  FOR SELECT USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_emails_insert" ON "contact_emails";
CREATE POLICY "contact_emails_insert" ON "contact_emails"
  FOR INSERT WITH CHECK (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_emails_update" ON "contact_emails";
CREATE POLICY "contact_emails_update" ON "contact_emails"
  FOR UPDATE USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_emails_delete" ON "contact_emails";
CREATE POLICY "contact_emails_delete" ON "contact_emails"
  FOR DELETE USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

-- ── contact_companies ──────────────────────────────────────
DROP POLICY IF EXISTS "contact_companies_select" ON "contact_companies";
CREATE POLICY "contact_companies_select" ON "contact_companies"
  FOR SELECT USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_companies_insert" ON "contact_companies";
CREATE POLICY "contact_companies_insert" ON "contact_companies"
  FOR INSERT WITH CHECK (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_companies_update" ON "contact_companies";
CREATE POLICY "contact_companies_update" ON "contact_companies"
  FOR UPDATE USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_companies_delete" ON "contact_companies";
CREATE POLICY "contact_companies_delete" ON "contact_companies"
  FOR DELETE USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

-- ── contact_schools ────────────────────────────────────────
DROP POLICY IF EXISTS "contact_schools_select" ON "contact_schools";
CREATE POLICY "contact_schools_select" ON "contact_schools"
  FOR SELECT USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_schools_insert" ON "contact_schools";
CREATE POLICY "contact_schools_insert" ON "contact_schools"
  FOR INSERT WITH CHECK (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_schools_update" ON "contact_schools";
CREATE POLICY "contact_schools_update" ON "contact_schools"
  FOR UPDATE USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_schools_delete" ON "contact_schools";
CREATE POLICY "contact_schools_delete" ON "contact_schools"
  FOR DELETE USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

-- ── tags ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "tags_select_own" ON "tags";
CREATE POLICY "tags_select_own" ON "tags"
  FOR SELECT USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "tags_insert_own" ON "tags";
CREATE POLICY "tags_insert_own" ON "tags"
  FOR INSERT WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "tags_update_own" ON "tags";
CREATE POLICY "tags_update_own" ON "tags"
  FOR UPDATE USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "tags_delete_own" ON "tags";
CREATE POLICY "tags_delete_own" ON "tags"
  FOR DELETE USING (user_id = (select auth.uid()));

-- ── contact_tags ───────────────────────────────────────────
DROP POLICY IF EXISTS "contact_tags_select" ON "contact_tags";
CREATE POLICY "contact_tags_select" ON "contact_tags"
  FOR SELECT USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_tags_insert" ON "contact_tags";
CREATE POLICY "contact_tags_insert" ON "contact_tags"
  FOR INSERT WITH CHECK (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "contact_tags_delete" ON "contact_tags";
CREATE POLICY "contact_tags_delete" ON "contact_tags"
  FOR DELETE USING (
    contact_id IN (SELECT id FROM contacts WHERE user_id = (select auth.uid()))
  );

-- ── suppressed_imports ─────────────────────────────────────
DROP POLICY IF EXISTS "suppressed_imports_select_own" ON suppressed_imports;
CREATE POLICY "suppressed_imports_select_own" ON suppressed_imports
  FOR SELECT USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "suppressed_imports_insert_own" ON suppressed_imports;
CREATE POLICY "suppressed_imports_insert_own" ON suppressed_imports
  FOR INSERT WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "suppressed_imports_delete_own" ON suppressed_imports;
CREATE POLICY "suppressed_imports_delete_own" ON suppressed_imports
  FOR DELETE USING (user_id = (select auth.uid()));

-- ── bundle_subscriptions ───────────────────────────────────
-- insert_own carries the CAR-25 visibility check (20260709140000).
DROP POLICY IF EXISTS "bundle_subscriptions_select_own" ON bundle_subscriptions;
CREATE POLICY "bundle_subscriptions_select_own" ON bundle_subscriptions
  FOR SELECT USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "bundle_subscriptions_insert_own" ON bundle_subscriptions;
CREATE POLICY "bundle_subscriptions_insert_own" ON bundle_subscriptions
  FOR INSERT WITH CHECK (
    user_id = (select auth.uid()) AND bundle_visible_to(bundle_id, (select auth.uid()))
  );

DROP POLICY IF EXISTS "bundle_subscriptions_update_own" ON bundle_subscriptions;
CREATE POLICY "bundle_subscriptions_update_own" ON bundle_subscriptions
  FOR UPDATE USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "bundle_subscriptions_delete_own" ON bundle_subscriptions;
CREATE POLICY "bundle_subscriptions_delete_own" ON bundle_subscriptions
  FOR DELETE USING (user_id = (select auth.uid()));

-- ── bundle_subscription_contacts ───────────────────────────
DROP POLICY IF EXISTS "bundle_subscription_contacts_select_own" ON bundle_subscription_contacts;
CREATE POLICY "bundle_subscription_contacts_select_own" ON bundle_subscription_contacts
  FOR SELECT USING (
    subscription_id IN (SELECT id FROM bundle_subscriptions WHERE user_id = (select auth.uid()))
  );

DROP POLICY IF EXISTS "bundle_subscription_contacts_insert_own" ON bundle_subscription_contacts;
CREATE POLICY "bundle_subscription_contacts_insert_own" ON bundle_subscription_contacts
  FOR INSERT WITH CHECK (
    subscription_id IN (SELECT id FROM bundle_subscriptions WHERE user_id = (select auth.uid()))
    AND EXISTS (
      SELECT 1 FROM contacts c WHERE c.id = contact_id AND c.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "bundle_subscription_contacts_update_own" ON bundle_subscription_contacts;
CREATE POLICY "bundle_subscription_contacts_update_own" ON bundle_subscription_contacts
  FOR UPDATE USING (
    subscription_id IN (SELECT id FROM bundle_subscriptions WHERE user_id = (select auth.uid()))
  ) WITH CHECK (
    subscription_id IN (SELECT id FROM bundle_subscriptions WHERE user_id = (select auth.uid()))
    AND EXISTS (
      SELECT 1 FROM contacts c WHERE c.id = contact_id AND c.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "bundle_subscription_contacts_delete_own" ON bundle_subscription_contacts;
CREATE POLICY "bundle_subscription_contacts_delete_own" ON bundle_subscription_contacts
  FOR DELETE USING (
    subscription_id IN (SELECT id FROM bundle_subscriptions WHERE user_id = (select auth.uid()))
  );

-- ── bundle_contact_state ───────────────────────────────────
DROP POLICY IF EXISTS "bundle_contact_state_select_own" ON bundle_contact_state;
CREATE POLICY "bundle_contact_state_select_own" ON bundle_contact_state
  FOR SELECT USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "bundle_contact_state_insert_own" ON bundle_contact_state;
CREATE POLICY "bundle_contact_state_insert_own" ON bundle_contact_state
  FOR INSERT WITH CHECK (
    user_id = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM contacts c WHERE c.id = contact_id AND c.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "bundle_contact_state_update_own" ON bundle_contact_state;
CREATE POLICY "bundle_contact_state_update_own" ON bundle_contact_state
  FOR UPDATE USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "bundle_contact_state_delete_own" ON bundle_contact_state;
CREATE POLICY "bundle_contact_state_delete_own" ON bundle_contact_state
  FOR DELETE USING (user_id = (select auth.uid()));

-- ── bundle content reads (per-chunk 1,000-row scans) ───────
DROP POLICY IF EXISTS "data_bundles_select_published" ON data_bundles;
CREATE POLICY "data_bundles_select_published" ON data_bundles
  FOR SELECT TO authenticated
  USING (status = 'published' AND bundle_visible_to(id, (select auth.uid())));

DROP POLICY IF EXISTS "bundle_prospects_select_subscribed" ON bundle_prospects;
CREATE POLICY "bundle_prospects_select_subscribed" ON bundle_prospects
  FOR SELECT TO authenticated USING (
    bundle_visible_to(bundle_id, (select auth.uid()))
    AND EXISTS (
      SELECT 1 FROM bundle_subscriptions bs
      WHERE bs.bundle_id = bundle_prospects.bundle_id
        AND bs.user_id = (select auth.uid())
        AND bs.status = 'active'
    )
  );

DROP POLICY IF EXISTS "bundle_companies_select_subscribed" ON bundle_companies;
CREATE POLICY "bundle_companies_select_subscribed" ON bundle_companies
  FOR SELECT TO authenticated USING (
    bundle_visible_to(bundle_id, (select auth.uid()))
    AND EXISTS (
      SELECT 1 FROM bundle_subscriptions bs
      WHERE bs.bundle_id = bundle_companies.bundle_id
        AND bs.user_id = (select auth.uid())
        AND bs.status = 'active'
    )
  );
