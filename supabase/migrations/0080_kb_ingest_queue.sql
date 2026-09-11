-- =============================================================
-- 0080_kb_ingest_queue.sql
-- Cola de ingesta de KB: saca la extracción de Netlify y la pone donde hay
-- tiempo de verdad.
--
-- POR QUÉ. La ingesta corría en tres pasos encadenados por el navegador
-- (prepare → verify → ingest) porque una función síncrona de Netlify corta a
-- los 26s. Con flyers de una página alcanzaba. Con un condicionado escaneado
-- de 20-50 páginas NO: transcribir por visión son minutos, no segundos, y no
-- hay forma de partirlo en trozos de 26s que valga la pena mantener. El wall
-- clock de una Edge Function es ~400s (ver 0052), 15× más aire.
--
-- CÓMO. Dos tablas y dos crones INDEPENDIENTES, nunca encadenados: encadenar
-- Edge Functions con `EdgeRuntime.waitUntil` no dejó registro confiable de
-- haber corrido (trampa 16, ver cabecera de la 0060).
--
--   kb_ingest_jobs    un documento a subir. Nace 'pendiente'.
--   kb_ingest_tandas  un rango de páginas de ese documento. El troceo es lo
--                     que hace que cada llamada a la API entre en el wall
--                     clock, en el tope de páginas del modelo y en su ventana
--                     de contexto — y que un fallo de fidelidad reprocese UNA
--                     tanda con el modelo capaz en vez del documento entero.
--
--   kb-transcribe-worker  cada minuto. Trocea los jobs nuevos y transcribe
--                         las tandas pendientes (con su juez de fidelidad).
--   kb-assemble-worker    cada minuto. Toma los jobs con todas sus tandas
--                         listas, junta el texto, juzga la vertical, trocea
--                         semánticamente, embebe e indexa.
--
-- El segundo no depende de que el primero haya corrido recién: mira el estado
-- de la tabla, no un evento. Es la misma forma que `zoho-kommo-push-safety`.
--
-- REAPER. Igual que en la 0052 y por la misma razón: si el worker muere a
-- mitad (wall clock, OOM, 5xx de PostgREST) la fila queda 'procesando' y no la
-- vuelve a mirar nadie. Se recupera a los 10 minutos — por encima de los ~400s
-- de wall clock, así que nada vivo se pisa.
--
-- IDEMPOTENTE.
-- =============================================================

-- ---------- Tablas ----------

create table if not exists kb_ingest_jobs (
  id           uuid primary key default gen_random_uuid(),
  vertical_id  uuid not null references verticals(id) on delete cascade,
  title        text not null,
  -- Archivo en el bucket kb-uploads. NULL = markdown pegado a mano, que viaja
  -- en inline_content y se salta la extracción (pero NO los jueces).
  storage_path text,
  filename     text not null,
  ext          text not null,
  inline_content text,
  total_pages  int,
  -- pendiente → transcribiendo → ensamblando → listo
  --                                         ↘ revision → (humano aprueba) → aprobado → listo
  --                                         ↘ fallido
  status       text not null default 'pendiente',
  document_id  uuid references kb_documents(id) on delete set null,
  -- Texto ya unido de todas las tandas; es lo que el humano ve y puede
  -- corregir cuando el job cae en 'revision'.
  texto        text,
  issues       jsonb not null default '[]'::jsonb,
  attempts     int not null default 0,
  claimed_at   timestamptz,
  last_error   text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists kb_ingest_tandas (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references kb_ingest_jobs(id) on delete cascade,
  idx        int not null,
  -- NULL en los formatos sin páginas (DOCX, TXT, imagen, markdown): esos son
  -- siempre una sola tanda.
  page_from  int,
  page_to    int,
  status     text not null default 'pendiente',  -- pendiente|procesando|listo|fallido
  attempts   int not null default 0,
  claimed_at timestamptz,
  texto      text,
  issues     jsonb not null default '[]'::jsonb,
  via_vision boolean not null default false,
  last_error text,
  created_at timestamptz not null default now(),
  unique (job_id, idx)
);

drop trigger if exists kb_ingest_jobs_updated_at on kb_ingest_jobs;
create trigger kb_ingest_jobs_updated_at before update on kb_ingest_jobs
  for each row execute function set_updated_at();

-- Índices parciales: las consultas del worker solo miran lo que está en vuelo,
-- y la tabla acumula el histórico de cargas, que no hace falta escanear.
create index if not exists kb_ingest_jobs_abiertos_idx
  on kb_ingest_jobs (created_at)
  where status in ('pendiente', 'transcribiendo', 'ensamblando', 'aprobado');
create index if not exists kb_ingest_jobs_vertical_idx
  on kb_ingest_jobs (vertical_id, created_at desc);
create index if not exists kb_ingest_tandas_pendientes_idx
  on kb_ingest_tandas (job_id, idx)
  where status in ('pendiente', 'procesando');
create index if not exists kb_ingest_tandas_stale_idx
  on kb_ingest_tandas (claimed_at)
  where status = 'procesando';

alter table kb_ingest_jobs   enable row level security;
alter table kb_ingest_tandas enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['kb_ingest_jobs', 'kb_ingest_tandas']) loop
    execute format(
      'drop policy if exists authenticated_all on %I;
       create policy authenticated_all on %I
         for all to authenticated using (true) with check (true);',
      t, t
    );
  end loop;
end$$;

-- ---------- Claims ----------

-- Umbrales compartidos por los tres claims. 10 minutos está por encima del
-- wall clock máximo de una Edge Function (~400s), así que un 'procesando' más
-- viejo que eso está muerto con certeza (mismo razonamiento que la 0052).
-- Reprocesar es seguro: una tanda se vuelve a transcribir sin efectos fuera de
-- su propia fila, y un job solo escribe en kb_documents al final del todo.

-- 1) Jobs recién creados: hay que abrir el archivo, contar páginas y crear las
--    tandas. Es trabajo corto; se separa del transcribir para que un PDF
--    ilegible falle rápido y no ocupe un turno de OCR.
create or replace function claim_kb_jobs_para_trocear(p_limit int default 5)
returns table (id uuid, storage_path text, filename text, ext text,
               inline_content text, title text, vertical_id uuid)
language plpgsql as $$
declare
  v_stale constant interval := interval '10 minutes';
  v_max_attempts constant int := 5;
begin
  update kb_ingest_jobs j
     set status     = 'fallido',
         last_error = coalesce(j.last_error, 'reaper: el worker murió troceando tras ' || j.attempts || ' intentos')
   where j.status = 'pendiente'
     and j.claimed_at is not null
     and j.claimed_at < now() - v_stale
     and j.attempts >= v_max_attempts;

  return query
  with claimed as (
    select j.id
      from kb_ingest_jobs j
     where j.status = 'pendiente'
       and (j.claimed_at is null or j.claimed_at < now() - v_stale)
       and j.attempts < v_max_attempts
     order by j.created_at
     limit p_limit
       for update skip locked
  )
  update kb_ingest_jobs j
     set attempts = j.attempts + 1, claimed_at = now()
    from claimed c
   where j.id = c.id
   returning j.id, j.storage_path, j.filename, j.ext,
             j.inline_content, j.title, j.vertical_id;
end;
$$;

-- 2) Tandas a transcribir. Recupera las 'procesando' huérfanas igual que
--    claim_inbound_batch.
create or replace function claim_kb_tandas(p_limit int default 3)
returns table (id uuid, job_id uuid, idx int, page_from int, page_to int,
               storage_path text, filename text, ext text)
language plpgsql as $$
declare
  v_stale constant interval := interval '10 minutes';
  v_max_attempts constant int := 4;
begin
  -- Huérfanas sin reintentos: se marcan fallidas para que el job entero pueda
  -- cerrarse en vez de quedar 'transcribiendo' para siempre.
  update kb_ingest_tandas t
     set status     = 'fallido',
         last_error = coalesce(t.last_error, 'reaper: el worker murió tras ' || t.attempts || ' intentos')
   where t.status = 'procesando'
     and t.claimed_at < now() - v_stale
     and t.attempts >= v_max_attempts;

  -- El JOIN va contra `claimed.job_id`, NO contra la tabla que se actualiza:
  -- referenciar el target del UPDATE desde una condición de JOIN del FROM no
  -- es válido. El CTE ya trae job_id, así que sale gratis.
  --
  -- Solo se toman tandas de jobs vivos: si el job ya se cerró (fallido por
  -- vertical equivocada, o listo), transcribir el resto es gastar tokens en
  -- algo que nadie va a leer.
  return query
  with claimed as (
    select t.id, t.job_id
      from kb_ingest_tandas t
      join kb_ingest_jobs j on j.id = t.job_id
     where j.status in ('pendiente', 'transcribiendo')
       and (
         t.status = 'pendiente'
         or (t.status = 'procesando'
             and t.claimed_at < now() - v_stale
             and t.attempts < v_max_attempts)
       )
     order by t.job_id, t.idx
     limit p_limit
       for update of t skip locked
  )
  update kb_ingest_tandas t
     set status = 'procesando', attempts = t.attempts + 1, claimed_at = now()
    from claimed c
    join kb_ingest_jobs j on j.id = c.job_id
   where t.id = c.id
   returning t.id, t.job_id, t.idx, t.page_from, t.page_to,
             j.storage_path, j.filename, j.ext;
end;
$$;

-- 3) Jobs listos para ensamblar: TODAS sus tandas terminaron (listas o
--    fallidas — una tanda fallida no bloquea, se reporta como reparo). Más los
--    'aprobado', que son los que un humano revisó y confirmó: esos entran
--    saltándose los jueces.
create or replace function claim_kb_jobs_para_ensamblar(p_limit int default 3)
returns table (id uuid, title text, vertical_id uuid, storage_path text,
               filename text, ext text, aprobado boolean)
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
             j.filename, j.ext, c.aprobado;
end;
$$;

-- ---------- Avance para el dashboard ----------

-- Una fila por job abierto o cerrado hace poco, con el conteo de tandas. Es lo
-- que consulta /verticales para pintar la barra sin traerse el texto entero
-- (raw_text de un condicionado son cientos de KB).
create or replace view kb_ingest_avance
with (security_invoker = on) as
select
  j.id,
  j.vertical_id,
  j.title,
  j.filename,
  j.status,
  j.total_pages,
  j.document_id,
  j.issues,
  j.last_error,
  j.created_at,
  j.updated_at,
  count(t.id)                                        as tandas_total,
  count(t.id) filter (where t.status = 'listo')      as tandas_listas,
  count(t.id) filter (where t.status = 'fallido')    as tandas_fallidas
from kb_ingest_jobs j
left join kb_ingest_tandas t on t.job_id = j.id
group by j.id;

-- Vistas sobre datos del operador: nunca `anon` (trampa 33).
revoke all on kb_ingest_avance from anon;

-- ---------- Crones ----------

create or replace function trigger_kb_transcribe()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/kb-transcribe',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

create or replace function trigger_kb_assemble()
returns void language plpgsql as $$
begin
  perform net.http_post(
    url := '${SUPABASE_URL}/functions/v1/kb-assemble',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'kb-transcribe-worker') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'kb-transcribe-worker';
  end if;
  perform cron.schedule(
    'kb-transcribe-worker',
    '* * * * *',
    $cron$select trigger_kb_transcribe();$cron$
  );

  if exists (select 1 from cron.job where jobname = 'kb-assemble-worker') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'kb-assemble-worker';
  end if;
  perform cron.schedule(
    'kb-assemble-worker',
    '* * * * *',
    $cron$select trigger_kb_assemble();$cron$
  );
end$$;

comment on table kb_ingest_jobs is
  'Cola de ingesta de KB. El trabajo pesado corre en las Edge Functions kb-transcribe y kb-assemble, no en Netlify (26s).';
comment on table kb_ingest_tandas is
  'Rangos de páginas de un job. El troceo es lo que mete cada llamada de visión dentro del wall clock, del tope de páginas del modelo y de su contexto.';
