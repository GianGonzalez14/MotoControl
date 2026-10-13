# Despliegue público de MotoControl en Render

1. Crea un repositorio nuevo en GitHub llamado `motocontrol`.
2. Sube a ese repositorio todos los archivos de esta carpeta, excepto la carpeta `data` si contiene una base local creada durante pruebas.
3. En Render, elige **New > Web Service** y conecta el repositorio `motocontrol`.
4. Render detectará el `Dockerfile`. Usa la configuración Docker y deja el puerto de la aplicación en `10000` (ya está configurado mediante `PORT`).
5. Crea el servicio y espera a que el estado cambie a **Live**.
6. Abre la URL pública asignada por Render, por ejemplo `https://motocontrol-xxxx.onrender.com`.
7. Ingresa con `admin@motocontrol.com` / `Admin123!` y valida las funciones principales.
8. Copia la URL pública para el punto 5 del documento final y para el anexo del video.

## Nota de persistencia
En un servicio gratuito sin disco persistente, la base SQLite puede reiniciarse después de un nuevo despliegue o reinicio del contenedor. Las credenciales y datos de demostración se vuelven a crear automáticamente para que la aplicación siga siendo demostrable. Para persistencia permanente se debe añadir un disco/volumen al servicio o migrar la base a PostgreSQL.
