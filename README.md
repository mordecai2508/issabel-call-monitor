# Issabel Call Monitor

Panel de estadísticas de llamadas en tiempo real para centrales **Issabel / Asterisk**.
Lee los CDR (Call Detail Records) desde la base de datos MySQL del PBX y muestra
métricas en vivo mediante **Server-Sent Events (SSE)**, además de vistas históricas,
reportes exportables, gestión de usuarios y monitoreo de salud del PBX.

## Características

- **Dashboard en tiempo real** de llamadas entrantes y salientes (SSE, sin polling desde el navegador).
- **Vista histórica** con selector de rango de fechas.
- **Reportes** exportables y módulo de alertas por correo.
- **Estado del PBX** vía AMI (extensiones, colas).
- **Autenticación por sesión** con dos roles: `admin` y `monitor`.

## Arquitectura

Monorepo con dos áreas:

- `backend/` — API en **Express** (`server.js`) + rutas, servicios y plugins. Persistencia auxiliar en SQLite (`better-sqlite3`).
- `frontend/` — SPA en **React + Vite + Tailwind**.

Flujo de datos: pool MySQL (`mysql2/promise`) → consultas al `asteriskcdrdb` → respuesta JSON.
El mismo `fetchData()` alimenta tanto los endpoints REST como el broadcaster SSE
(`/api/events`), que emite un evento `init` al conectar y luego `update` en cada
intervalo de sondeo configurable.

## Requisitos

- Node.js 20+
- Acceso de red a la base de datos `asteriskcdrdb` (MySQL) del servidor Issabel.
- (Opcional) Acceso AMI para el estado de extensiones/colas.

## Configuración

Copia `backend/config.example.json` a `backend/config.json` y completa:

- `db` — conexión MySQL al `asteriskcdrdb` del Issabel. `db.timezone` debe coincidir con la zona horaria del servidor Asterisk (p. ej. `"-05:00"`).
- `ami` — credenciales del usuario AMI (requiere la clase `reporting` en `manager.conf`).
- `server.sessionSecret` — cadena aleatoria larga.
- `server.pollIntervalMs` — intervalo de broadcast SSE en ms (mínimo forzado: 15000).
- `users` — las contraseñas en texto plano se hashean con bcrypt en el primer arranque.

> `config.json` está en `.gitignore`. **Nunca lo subas al repositorio.**

## Desarrollo

```bash
npm run install:all      # instala dependencias de backend y frontend

npm run dev:backend      # nodemon sobre backend/server.js, puerto 4000
npm run dev:frontend     # Vite dev server, puerto 5173
```

En desarrollo Vite hace proxy de `/api/*` hacia `localhost:4000`.

## Producción

```bash
npm run build            # compila frontend/dist/
npm start                # sirve backend + frontend compilado desde el puerto 4000
```

### Docker

```bash
docker compose up -d --build
```

Consulta [DEPLOY.md](DEPLOY.md) para el despliegue detallado y la replicación en otros servidores Issabel.
