# Guía de despliegue — Issabel Call Monitor

Pasos para replicar el monitor en un servidor Issabel diferente.

---

## Requisitos previos

| Requisito | Versión mínima |
|---|---|
| Node.js | 20.x |
| Docker + Docker Compose | Docker 24.x |
| Acceso MySQL al servidor Issabel | Puerto 3306 |
| Acceso AMI al servidor Issabel | Puerto 5038 |

---

## 1. Obtener el código

```bash
git clone <url-del-repositorio> call-monitor
cd call-monitor
```

---

## 2. Crear el archivo de configuración

```bash
cp backend/config.example.json backend/config.json
```

Edita `backend/config.json` con los datos del nuevo servidor:

### 2.1 Base de datos MySQL (Issabel)

```json
"db": {
  "host": "IP_DEL_SERVIDOR_ISSABEL",
  "port": 3306,
  "user": "asterisk",
  "password": "PASSWORD_MYSQL_ASTERISK",
  "database": "asteriskcdrdb",
  "timezone": "-05:00"
}
```

- **host**: IP o hostname del servidor Issabel.
- **timezone**: debe coincidir con la zona horaria configurada en Asterisk. Usa `-05:00` para Colombia/Ecuador, `-06:00` para México Centro, `-04:30` para Venezuela, etc.
- El usuario MySQL solo necesita permisos `SELECT` sobre `asteriskcdrdb`. Nunca uses root.

**Crear usuario MySQL de solo lectura (ejecutar en el servidor Issabel):**

```sql
CREATE USER 'monitor_ro'@'IP_DEL_HOST_MONITOR' IDENTIFIED BY 'password_seguro';
GRANT SELECT ON asteriskcdrdb.* TO 'monitor_ro'@'IP_DEL_HOST_MONITOR';
FLUSH PRIVILEGES;
```

### 2.2 AMI — Asterisk Manager Interface

```json
"ami": {
  "host": "IP_DEL_SERVIDOR_ISSABEL",
  "port": 5038,
  "username": "monitor-readonly",
  "password": "PASSWORD_AMI"
}
```

El usuario AMI se configura en el servidor Issabel en `/etc/asterisk/manager.conf`:

```ini
[monitor-readonly]
secret = PASSWORD_AMI
deny=0.0.0.0/0.0.0.0
permit=IP_DEL_HOST_MONITOR/255.255.255.255
read = system,call,agent,user,reporting
write =
```

> El permiso `reporting` es obligatorio para consultar el estado de extensiones SIP (`SIPpeers`). Sin él, el panel de extensiones aparecerá vacío.

Después de editar `manager.conf`:

```bash
asterisk -rx "module reload manager"
```

### 2.3 Canales de troncal

```json
"channels": {
  "inbound":  ["SIP/NOMBRE_TRONCAL_ENTRANTE"],
  "outbound": ["SIP/NOMBRE_TRONCAL_SALIENTE"]
}
```

Para encontrar los nombres exactos de las troncales, ejecuta en el servidor Issabel:

```bash
asterisk -rx "sip show peers" | grep -v "^Name"
```

El nombre de la troncal es la parte antes del primer `-` en la columna `Name/username`. Por ejemplo, si aparece `tigo-claro/tigo-claro`, el prefijo es `SIP/tigo-claro`.

> Los canales de troncal son los que determinan qué llamadas se muestran como "entrantes" o "salientes" en el dashboard. Las llamadas que no pasen por ninguna troncal configurada se consideran internas y se excluyen automáticamente.

### 2.4 Colas

```json
"queues": ["8000", "8300"]
```

Números de las colas configuradas en Issabel (extensiones de tipo `queue`). Se pueden verificar en la interfaz web de Issabel en **PBX → Cola de llamadas**.

### 2.5 Destinos perdidos

```json
"lostDestinations": ["s", "hang", "hangup"]
```

Extensiones/destinos de Asterisk a los que llegan llamadas que colgaron en el IVR antes de ser atendidas. Los valores por defecto (`s`, `hang`, `hangup`) funcionan en la mayoría de configuraciones estándar de Issabel. Solo cámbialos si tu dialplan usa destinos diferentes.

### 2.6 Seguridad del servidor

```json
"server": {
  "port": 4000,
  "sessionSecret": "CADENA_ALEATORIA_LARGA_Y_UNICA",
  "pollIntervalMs": 30000
}
```

Genera un `sessionSecret` seguro:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 2.7 Usuarios iniciales

```json
"users": [
  { "id": 1, "username": "admin",   "password": "CONTRASEÑA_SEGURA", "role": "admin" },
  { "id": 2, "username": "monitor", "password": "CONTRASEÑA_SEGURA", "role": "operador" }
]
```

Las contraseñas en texto plano se hashean automáticamente con bcrypt al primer arranque. Después del primer arranque puedes gestionar usuarios desde la interfaz web en **Admin → Usuarios**.

### 2.8 SMTP (opcional, para alertas por correo)

```json
"smtp": {
  "host": "smtp.gmail.com",
  "port": 587,
  "secure": false,
  "user": "alertas@tudominio.com",
  "password": "PASSWORD_SMTP",
  "from": "Issabel Monitor <alertas@tudominio.com>"
}
```

Si no necesitas alertas por correo, deja los campos vacíos. El sistema funciona sin SMTP configurado.

---

## 3. Despliegue con Docker (recomendado)

```bash
#Antes de construir la imagen
cd /frontend
npm install esbuild@0.28.1
npm install

# Construir la imagen

docker compose build

# Arrancar en segundo plano
docker compose up -d

# Ver logs
docker compose logs -f
```

La aplicación queda disponible en `http://IP_DEL_HOST:4000`.

Los datos de usuarios y configuración se persisten en volúmenes Docker (`monitor-db`, `monitor-uploads`) y sobreviven a reinicios y recreaciones del contenedor. Solo `config.json` se monta desde el host como archivo de solo lectura.

---

## 4. Despliegue sin Docker

```bash
# Instalar dependencias
npm run install:all

# Compilar el frontend
npm run build

# Arrancar en producción
npm start
```

Para mantener el proceso activo usa `pm2`:

```bash
npm install -g pm2
pm2 start backend/server.js --name call-monitor
pm2 save
pm2 startup
```

---

## 5. Configuración post-arranque (interfaz web)

Una vez que la aplicación esté corriendo, inicia sesión como `admin` y completa la configuración desde la UI:

| Sección | Qué configurar |
|---|---|
| **Admin → Configuración del sistema** | Nombre de la empresa, zona horaria, horario de atención, colores |
| **Admin → Canales y troncales** | Alias de las troncales (nombre amigable para mostrar en el dashboard) |
| **Admin → Reglas de alerta** | Alertas de troncal caída, pico de llamadas perdidas, desconexión PBX |
| **Admin → Usuarios** | Agregar/editar usuarios del monitor |

---

## 6. Verificar que todo funciona

```bash
# Verificar conexión MySQL desde el host del monitor
mysql -h IP_ISSABEL -u monitor_ro -p asteriskcdrdb -e "SELECT COUNT(*) FROM cdr WHERE calldate >= CURDATE();"

# Verificar conexión AMI
telnet IP_ISSABEL 5038
# Debe responder: Asterisk Call Manager/...

# Ver logs del contenedor
docker compose logs call-monitor | tail -50
```

Señales de que todo está bien en los logs:
- `[DB] Conexión exitosa a MySQL.`
- `[AMI] Conectado a ...`
- `Server running on port 4000`

---

## 7. Firewall / red

Puertos que deben estar accesibles **desde el host del monitor** hacia el servidor Issabel:

| Puerto | Protocolo | Para qué |
|---|---|---|
| 3306 | TCP | MySQL (CDR) |
| 5038 | TCP | AMI (estado de extensiones y troncales) |

Puerto que debe estar accesible **hacia los usuarios**:

| Puerto | Protocolo | Para qué |
|---|---|---|
| 4000 | TCP | Interfaz web del monitor |

---

## 8. Checklist de replicación

- [ ] `backend/config.json` creado con los datos del nuevo servidor
- [ ] Usuario MySQL de solo lectura creado en el servidor Issabel
- [ ] Usuario AMI configurado en `/etc/asterisk/manager.conf` con permiso `reporting`
- [ ] Troncales correctamente identificadas (`sip show peers`) y configuradas en `channels`
- [ ] Colas correctamente identificadas y configuradas en `queues`
- [ ] `sessionSecret` generado de forma aleatoria
- [ ] Contraseñas de usuarios iniciales cambiadas
- [ ] `docker compose up -d` sin errores
- [ ] Dashboard muestra datos del día actual
- [ ] Panel de extensiones muestra estado en tiempo real
