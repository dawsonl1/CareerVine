-- CAR-156 / R4.5: analytics_events and user_milestones were created FK-less
-- (20260710120000_analytics_events_and_milestones.sql), so account deletion
-- left analytics rows behind — user_id values pointing at deleted accounts,
-- contradicting the delete route's "cascades into all of the user's data"
-- contract and the privacy policy's deletion promise.
--
-- Clean up any rows already orphaned during the FK-less window first, so the
-- constraints validate against real data, then wire both tables into the
-- user-deletion cascade (same pattern as 20260711130000_user_deletion_cascade.sql).

DELETE FROM public.analytics_events e
WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = e.user_id);

DELETE FROM public.user_milestones m
WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = m.user_id);

ALTER TABLE public.analytics_events DROP CONSTRAINT IF EXISTS analytics_events_user_fk;
ALTER TABLE public.analytics_events ADD CONSTRAINT analytics_events_user_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_milestones DROP CONSTRAINT IF EXISTS user_milestones_user_fk;
ALTER TABLE public.user_milestones ADD CONSTRAINT user_milestones_user_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
