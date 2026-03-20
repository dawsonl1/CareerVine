-- Create a public storage bucket for contact profile photos.
-- Files are stored at: contact-photos/{user_id}/{filename}
-- Public read access; authenticated users can only manage their own folder.

INSERT INTO storage.buckets (id, name, public)
VALUES ('contact-photos', 'contact-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies

CREATE POLICY "contact_photos_bucket_select"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'contact-photos'
  );

CREATE POLICY "contact_photos_bucket_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'contact-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "contact_photos_bucket_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'contact-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
