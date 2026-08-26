-- Bucket privado para subir archivos de KB (PDF/DOCX/etc.) directo desde el
-- navegador a Supabase Storage, evitando el límite de payload de las
-- funciones serverless de Netlify (~6MB) que impedía subir archivos reales
-- de varios MB. El servidor los lee de acá para parsear/embeber y los borra
-- después — el contenido extraído queda en kb_documents.raw_text.
insert into storage.buckets (id, name, public, file_size_limit)
values ('kb-uploads', 'kb-uploads', false, 52428800) -- 50MB
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "kb_uploads_authenticated_all" on storage.objects;
create policy "kb_uploads_authenticated_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'kb-uploads')
  with check (bucket_id = 'kb-uploads');
