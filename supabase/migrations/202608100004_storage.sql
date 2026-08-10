-- Creates the private media bucket. Storage object RLS policies should be added
-- after production auth/user-path conventions are finalized.
insert into storage.buckets (id, name, public)
values ('travel-media', 'travel-media', false)
on conflict (id) do nothing;
