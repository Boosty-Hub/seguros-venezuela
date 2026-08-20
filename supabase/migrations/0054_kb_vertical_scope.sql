-- =============================================================
-- 0054_kb_vertical_scope.sql
-- KB por vertical: un documento puede quedar "atado" a una vertical
-- (vertical_id) o quedar global (null = todas las verticales lo ven).
-- search_kb filtra por vertical cuando el caller la pasa: devuelve
-- chunks de esa vertical + los globales, nunca los de otra vertical.
-- =============================================================

alter table kb_documents
  add column if not exists vertical_id uuid references verticals(id) on delete set null;

create index if not exists kb_documents_vertical_idx
  on kb_documents(vertical_id);

drop function if exists search_kb(vector(384), text, int, real);

create function search_kb(
  p_query_embedding vector(384),
  p_query_text text,
  p_limit int default 6,
  p_min_similarity real default 0.0,
  p_vertical_id uuid default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  content text,
  metadata jsonb,
  similarity real,
  fts_rank real
) language sql stable as $$
  with vec as (
    select
      c.id as chunk_id,
      c.document_id,
      d.title as document_title,
      c.content,
      c.metadata,
      (1 - (c.embedding <=> p_query_embedding))::real as similarity,
      ts_rank(to_tsvector('spanish', c.content), plainto_tsquery('spanish', p_query_text))::real as fts_rank
    from kb_chunks c
    join kb_documents d on d.id = c.document_id
    where c.embedding is not null
      -- Sin vertical (caller no la pasa) => busca en todo, como antes.
      -- Con vertical => solo docs de ESA vertical + los globales (vertical_id null).
      and (p_vertical_id is null or d.vertical_id is null or d.vertical_id = p_vertical_id)
  )
  select * from vec
  where similarity >= p_min_similarity
  order by (similarity * 0.7 + fts_rank * 0.3) desc
  limit p_limit;
$$;
