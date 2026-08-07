# Auto-actualización del pipeline

El objetivo: que el dashboard refleje un ticket nuevo/modificado **sin intervención manual**.
Hay tres formas; se pueden combinar. El dashboard usa **Supabase Realtime**, así que en
cuanto un ticket cambia en la base, la pantalla se actualiza sola (sin recargar).

Lo único que hay que resolver es **cómo llega el cambio de Zoho a Supabase**. Opciones:

---

## 1) GitHub Actions — cron cada 5 min ✅ (implementado y activo)

`.github/workflows/sync.yml` ejecuta `node sync.mjs incremental` cada 5 minutos.
Trae de Zoho lo modificado desde el último sync (usa un *watermark* por `modified_time`)
y hace *upsert* en Supabase.

- **Ventaja:** funciona ya, con los accesos que tenemos. Nada que configurar en Zoho.
- **Latencia:** hasta ~5 min (mínimo permitido por GitHub; a veces se retrasa bajo carga).
- **Nota:** GitHub pausa los cron si el repo no tiene actividad por 60 días.

**Ejecutar a mano:** pestaña *Actions → Sync Zoho -> Supabase → Run workflow* (elige `full`, `incremental` o `enrich`).

---

## 2) Webhook de Zoho Desk → Edge Function ⚡ (instantáneo)

Actualización en **segundos** al crear/actualizar un ticket. Requiere dos cosas:

**a) Desplegar la Edge Function** (`supabase/functions/zoho-sync`):

```bash
supabase login
supabase link --project-ref lwqqnnefywsjaatuyjma
# cargar secrets de Zoho
supabase secrets set ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_REFRESH_TOKEN=... \
                     ZOHO_ORG_ID=850320350 ZOHO_DEPARTMENT_ID=977937000034750449
supabase functions deploy zoho-sync --no-verify-jwt
```

Queda en: `https://lwqqnnefywsjaatuyjma.supabase.co/functions/v1/zoho-sync`

**b) Configurar el webhook en Zoho Desk** (lo hace un admin de Zoho — p. ej. Jackson):
*Setup → Automation → Workflows* (o *Notify → Webhooks*), regla sobre **Tickets** en
*crear* y *editar* del departamento *Administración de Pólizas*, con:

- URL: la de la función de arriba.
- Método: `POST`, cuerpo JSON incluyendo el id del ticket, p. ej. `{ "ticketId": "${ticketId}" }`.

La función refresca el token de Zoho, trae el detalle del ticket (con `customFields`) y lo
actualiza en Supabase → el dashboard se refresca al instante.

> La función también acepta `{ "mode": "incremental", "minutes": 10 }` para barridos.

---

## 3) pg_cron dentro de Supabase 🕒 (alternativa 100% Supabase)

Si se prefiere no depender de GitHub, Supabase puede auto-invocar la Edge Function con
`pg_cron` + `pg_net` (ambas extensiones disponibles en Supabase). Requiere la función del
punto 2 desplegada. SQL de ejemplo:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'zoho-sync-cada-2min', '*/2 * * * *',
  $$
    select net.http_post(
      url     := 'https://lwqqnnefywsjaatuyjma.supabase.co/functions/v1/zoho-sync',
      headers := jsonb_build_object('Content-Type','application/json',
                                    'Authorization','Bearer <ANON_O_SERVICE_KEY>'),
      body    := jsonb_build_object('mode','incremental','minutes', 10)
    );
  $$
);
```

---

## Recomendación

- **Ahora:** GitHub Actions (opción 1) ya cubre el requerimiento de forma automática.
- **Para “al instante”:** pedir al equipo de Zoho que configure el webhook (opción 2).
  Con eso, cada ticket que entre aparece en el dashboard en segundos.
- GitHub Actions se puede dejar en paralelo como **red de seguridad** aunque haya webhook.
