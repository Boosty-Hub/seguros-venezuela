-- =============================================================
-- 0085_kb_reprocesar.sql
-- Reprocesar un documento de KB desde su archivo original.
--
-- La 0084 guardó el original; esto es lo que lo hace útil sin trabajo manual.
-- Un documento mal extraído se vuelve a encolar apuntando al MISMO objeto del
-- bucket, pasa otra vez por la extracción de hoy (que para un escaneo o un
-- flyer vectorizado usa visión, no el parseo que lo rompió) y, cuando el nuevo
-- entra bien, el viejo se borra.
--
-- `reemplaza_document_id` es lo que ata las dos puntas. Importa que el borrado
-- del viejo lo haga el ENSAMBLADOR y solo tras indexar el nuevo:
--
--   * Borrar primero dejaría la vertical sin ese documento mientras dura el
--     reproceso, y sin nada si el reproceso falla.
--   * Borrar el viejo por la ruta normal (DELETE /api/kb/document/[id])
--     tampoco sirve: esa ruta se lleva también el archivo del bucket, y el
--     archivo es justo el que el documento NUEVO acaba de heredar. Se
--     quedarían los dos sin original.
--
-- `on delete set null`: si alguien borra el documento viejo a mano mientras el
-- reproceso está en vuelo, el job sigue y simplemente no tiene nada que
-- reemplazar al terminar.
--
-- IDEMPOTENTE.
-- =============================================================

alter table kb_ingest_jobs
  add column if not exists reemplaza_document_id uuid
    references kb_documents(id) on delete set null;

comment on column kb_ingest_jobs.reemplaza_document_id is
  'Documento al que sustituye este job. El ensamblador lo borra SOLO cuando el nuevo ya está indexado, y sin tocar el archivo del bucket, que pasa a ser del nuevo (0085).';

create index if not exists kb_ingest_jobs_reemplaza_idx
  on kb_ingest_jobs (reemplaza_document_id)
  where reemplaza_document_id is not null;

-- ---------------------------------------------------------------
-- El claim del cron devuelve una lista FIJA de columnas, así que hay que
-- añadirle la nueva o el ensamblador nunca se enteraría de que el job es un
-- reproceso (la llamada directa sí la veía: hace su propio select). Cuerpo
-- idéntico al de la 0080, solo cambia lo que devuelve.
-- ---------------------------------------------------------------
drop function if exists claim_kb_jobs_para_ensamblar(int);

create or replace function claim_kb_jobs_para_ensamblar(p_limit int default 3)
returns table (id uuid, title text, vertical_id uuid, storage_path text,
               filename text, ext text, aprobado boolean,
               reemplaza_document_id uuid)
language plpgsql as $$
declare
  v_stale constant interval := interval '10 minutes';
begin
  return query
  with candidatos as (
    select j.id, (j.status = 'aprobado') as aprobado
      from kb_ingest_jobs j
     where (
             j.status = 'aprobado'
             or (
               j.status = 'transcribiendo'
               and not exists (
                 select 1 from kb_ingest_tandas t
                  where t.job_id = j.id and t.status in ('pendiente', 'procesando')
               )
             )
             -- Reintento de un ensamblado que murió a mitad.
             or (j.status = 'ensamblando' and j.claimed_at < now() - v_stale)
           )
     order by j.created_at
     limit p_limit
       for update skip locked
  )
  update kb_ingest_jobs j
     set status = 'ensamblando', claimed_at = now()
    from candidatos c
   where j.id = c.id
   returning j.id, j.title, j.vertical_id, j.storage_path,
             j.filename, j.ext, c.aprobado, j.reemplaza_document_id;
end;
$$;

revoke all on function claim_kb_jobs_para_ensamblar(int) from public, anon;
grant execute on function claim_kb_jobs_para_ensamblar(int) to authenticated, service_role;
