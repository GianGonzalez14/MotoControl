# MotoControl

MVP funcional académico para la asignatura **Gerencia de Proyectos Informáticos**.

## Funcionalidades incluidas
- Inicio/cierre de sesión con roles de demostración.
- Dashboard con indicadores básicos.
- Registro y consulta de clientes.
- Registro de motocicletas asociadas a clientes.
- Catálogo de servicios.
- Programación y cancelación de citas con validación de disponibilidad.
- Creación y actualización de órdenes de servicio.
- Registro de diagnóstico, actividades realizadas y costos.
- Flujo de estados: Pendiente → En diagnóstico → En reparación → Finalizada → Entregada.
- Historial de mantenimiento por motocicleta.
- Persistencia en SQLite.
- Diseño web responsivo.

## Credenciales de demostración

| Rol | Correo | Contraseña |
|---|---|---|
| Administrador | admin@motocontrol.com | Admin123! |
| Mecánico | mecanico@motocontrol.com | Mecanico123! |
| Cliente | cliente@motocontrol.com | Cliente123! |

## Ejecutar localmente
Requiere Node.js 22 o superior.

```bash
npm start
```

Luego abrir `http://localhost:3000`.

## Despliegue
El repositorio incluye `Dockerfile` y `render.yaml` para publicarlo como Web Service. Consulta `DEPLOY_RENDER.md`.
