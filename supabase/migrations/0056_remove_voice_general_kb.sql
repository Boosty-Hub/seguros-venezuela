-- =============================================================
-- 0056_remove_voice_general_kb.sql
-- Elimina el concepto de "voz" separada (esa identidad ya vive completa en
-- el system prompt principal, ver web/src/lib/agent-prompt-core.mjs) y el de
-- "documento de KB general/sin vertical" (el agente SIEMPRE responde dentro
-- de una vertical, así que un documento sin vertical no tenía a quién
-- servirle — si algo no encaja en ninguna, va a la vertical "general").
-- =============================================================

-- voice_samples: sin filas en producción a la fecha de esta migración (se
-- verificó antes de escribirla) — drop directo, sin backfill necesario.
drop table if exists voice_samples;

-- kb_documents.vertical_id pasa a NOT NULL: todo documento de KB debe estar
-- atado a una vertical. Sin filas nulas en producción a la fecha (verificado).
alter table kb_documents
  alter column vertical_id set not null;

-- search_kb ya no necesita contemplar "documento sin vertical" — el caller
-- (generate-response) siempre pasa la vertical de la conversación.
drop function if exists search_kb(vector(384), text, int, real, uuid);

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
      -- p_vertical_id null (caller viejo/sin vertical) => busca en todo.
      -- p_vertical_id seteado (caso normal hoy) => SOLO esa vertical.
      and (p_vertical_id is null or d.vertical_id = p_vertical_id)
  )
  select * from vec
  where similarity >= p_min_similarity
  order by (similarity * 0.7 + fts_rank * 0.3) desc
  limit p_limit;
$$;
