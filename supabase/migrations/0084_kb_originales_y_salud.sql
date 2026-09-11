-- =============================================================
-- 0084_kb_originales_y_salud.sql
-- Guardar el ARCHIVO ORIGINAL de cada documento de KB, y saber cuáles
-- quedaron mal.
--
-- POR QUÉ. Hasta ahora el bucket `kb-uploads` era un área de paso: el worker
-- leía el archivo, lo indexaba y lo BORRABA — solo quedaba `raw_text`, el
-- texto ya extraído. Eso se pagó el 11-09: "Flyer RCV" y "Flyer marcotas"
-- están indexados con el texto ilegible que salía del parseo (largo medio de
-- palabra 12,7 y 8,8 contra 5,9 del resto) y NO se pueden reprocesar, porque
-- el PDF del que salieron ya no existe en ningún sitio del sistema. La única
-- salida es pedirle al operador que los busque y los vuelva a subir.
--
-- Con el original guardado, un documento mal extraído se vuelve a procesar sin
-- molestar a nadie: el archivo está, y la lectura por visión de ahora es mejor
-- que el parseo de entonces.
--
--   kb_documents.storage_path  objeto en `kb-uploads` (NULL = markdown pegado
--                              a mano, que no tiene original, o documento
--                              anterior a esta migración).
--   kb_documents.source_bytes  tamaño, para ver de un vistazo lo que ocupa.
--
-- `kb_salud_documentos()` es el otro lado: replica en SQL la heurística de
-- `looksMangled` (largo medio de palabra y proporción de palabras pegadas)
-- sobre los chunks YA INDEXADOS, que es lo que el agente realmente lee. No
-- sirve de nada validar solo en la puerta de entrada si nadie vuelve a mirar
-- lo que entró antes de que la puerta existiera.
--
-- Los umbrales son los medidos sobre esta KB y están en kb-extract.ts:
--   sanos  → largo medio 5,5; ~0% de palabras de más de 25 chars
--   rotos  → largo medio 8,8 y 12,7; ~9% de palabras de más de 25 chars
-- Se juzga con 8 y 3%, lejos de los dos extremos. Menos de 30 palabras no se
-- juzga: la estadística no dice nada.
--
-- IDEMPOTENTE.
-- =============================================================

alter table kb_documents
  add column if not exists storage_path text,
  add column if not exists source_bytes bigint;

comment on column kb_documents.storage_path is
  'Archivo original en el bucket kb-uploads. Se conserva a propósito para poder reprocesar un documento mal extraído sin pedirle el archivo al operador (0084).';

-- ---------------------------------------------------------------
-- Salud de lo indexado, documento por documento.
-- ---------------------------------------------------------------
create or replace function kb_salud_documentos()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with palabras as (
    select c.document_id, w
    from kb_chunks c,
         unnest(regexp_split_to_array(trim(c.content), '\s+')) w
    where w <> ''
  ),
  stats as (
    select document_id,
           count(*)                                                as tokens,
           avg(length(w))                                          as largo_medio,
           100.0 * count(*) filter (where length(w) > 25) / count(*) as pegadas_pct
    from palabras
    group by document_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'document_id',   d.id,
           'vertical_id',   d.vertical_id,
           'title',         d.title,
           'filename',      d.source_filename,
           'chunks',        d.total_chunks,
           'tokens',        coalesce(s.tokens, 0),
           'largo_medio',   round(coalesce(s.largo_medio, 0)::numeric, 1),
           'pegadas_pct',   round(coalesce(s.pegadas_pct, 0)::numeric, 1),
           -- Un marcador de página dentro del texto es ruido del parser, no
           -- contenido: si aparece, el documento entró antes del arreglo de la
           -- trampa 38 y conviene reprocesarlo.
           'marcadores',    (select count(*) from kb_chunks c2
                              where c2.document_id = d.id
                                and c2.content ~ '--\s*\d+\s+of\s+\d+\s*--'),
           'tiene_original', d.storage_path is not null,
           'extraido_por',  coalesce(d.metadata->>'extracted_via', 'parseo'),
           'creado',        d.created_at,
           'veredicto', case
             -- Sin chunks el documento no le sirve de nada al agente.
             when coalesce(d.total_chunks, 0) = 0 then 'vacio'
             -- Mismos umbrales que looksMangled (kb-extract.ts).
             when coalesce(s.tokens, 0) >= 30
              and (s.largo_medio > 8 or s.pegadas_pct > 3) then 'ilegible'
             when (select count(*) from kb_chunks c3
                    where c3.document_id = d.id
                      and c3.content ~ '--\s*\d+\s+of\s+\d+\s*--') > 0 then 'con_ruido'
             else 'ok'
           end
         ) order by d.created_at), '[]'::jsonb)
  from kb_documents d
  left join stats s on s.document_id = d.id;
$fn$;

revoke all on function kb_salud_documentos() from public, anon;
grant execute on function kb_salud_documentos() to authenticated, service_role;
