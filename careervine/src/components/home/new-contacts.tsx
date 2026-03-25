export interface NewContact {
  id: number;
  name: string;
  photo_url: string | null;
  emails: string[];
  created_at: string | null;
}
