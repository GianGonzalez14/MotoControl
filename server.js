const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'motocontrol.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

function hashPassword(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(v) { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(v || 0)); }
function fmtDate(v) { if (!v) return ''; const d = new Date(v + (String(v).length <= 10 ? 'T12:00:00' : '')); return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleDateString('es-CO'); }
function nowIso() { return new Date().toISOString(); }
function int(v) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      documento TEXT NOT NULL UNIQUE,
      telefono TEXT,
      correo TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS motocicletas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      placa TEXT NOT NULL UNIQUE,
      marca TEXT NOT NULL,
      modelo TEXT NOT NULL,
      anio INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(cliente_id) REFERENCES clientes(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS servicios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      precio REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS citas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      motocicleta_id INTEGER NOT NULL,
      servicio_id INTEGER NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'Programada',
      observaciones TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(motocicleta_id) REFERENCES motocicletas(id) ON DELETE RESTRICT,
      FOREIGN KEY(servicio_id) REFERENCES servicios(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS ordenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      motocicleta_id INTEGER NOT NULL,
      cita_id INTEGER,
      diagnostico TEXT,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      mecanico TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(motocicleta_id) REFERENCES motocicletas(id) ON DELETE RESTRICT,
      FOREIGN KEY(cita_id) REFERENCES citas(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS actividades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id INTEGER NOT NULL,
      descripcion TEXT NOT NULL,
      costo REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(orden_id) REFERENCES ordenes(id) ON DELETE CASCADE
    );
  `);

  const addUser = db.prepare('INSERT OR IGNORE INTO users(name,email,password_hash,role) VALUES(?,?,?,?)');
  addUser.run('Administrador MotoControl', 'admin@motocontrol.com', hashPassword('Admin123!'), 'Administrador');
  addUser.run('Mecánico Demo', 'mecanico@motocontrol.com', hashPassword('Mecanico123!'), 'Mecánico');
  addUser.run('Cliente Demo', 'cliente@motocontrol.com', hashPassword('Cliente123!'), 'Cliente');

  const serviceCount = db.prepare('SELECT COUNT(*) c FROM servicios').get().c;
  if (serviceCount === 0) {
    const add = db.prepare('INSERT INTO servicios(nombre,descripcion,precio) VALUES(?,?,?)');
    add.run('Cambio de aceite', 'Cambio de aceite y revisión de niveles.', 85000);
    add.run('Mantenimiento general', 'Revisión general, ajuste y lubricación.', 180000);
    add.run('Sistema de frenos', 'Inspección y ajuste del sistema de frenos.', 120000);
    add.run('Diagnóstico eléctrico', 'Revisión de batería, luces y sistema eléctrico.', 95000);
  }

  const clientCount = db.prepare('SELECT COUNT(*) c FROM clientes').get().c;
  if (clientCount === 0) {
    const c = db.prepare('INSERT INTO clientes(nombre,documento,telefono,correo,created_at) VALUES(?,?,?,?,?)').run('Carlos Ramírez', '1020304050', '3001234567', 'carlos@example.com', nowIso());
    const m = db.prepare('INSERT INTO motocicletas(cliente_id,placa,marca,modelo,anio,created_at) VALUES(?,?,?,?,?,?)').run(Number(c.lastInsertRowid), 'ABC12D', 'Yamaha', 'FZ 2.0', 2023, nowIso());
    const s = db.prepare('SELECT id FROM servicios ORDER BY id LIMIT 1').get();
    db.prepare('INSERT INTO citas(motocicleta_id,servicio_id,fecha,hora,estado,observaciones,created_at) VALUES(?,?,?,?,?,?,?)').run(Number(m.lastInsertRowid), s.id, new Date(Date.now()+86400000*2).toISOString().slice(0,10), '10:00', 'Programada', 'Revisión preventiva.', nowIso());
  }
}
initDb();

const sessions = new Map();
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function currentUser(req) { const t = parseCookies(req).mc_session; return t ? sessions.get(t) : null; }
function setSession(res, user) { const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, user); res.setHeader('Set-Cookie', `mc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`); }
function clearSession(req, res) { const t = parseCookies(req).mc_session; if (t) sessions.delete(t); res.setHeader('Set-Cookie', 'mc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
function send(res, body, status=200, type='text/html; charset=utf-8') { res.writeHead(status, {'Content-Type': type}); res.end(body); }
function redirect(res, loc) { res.writeHead(303, {Location: loc}); res.end(); }
function bodyForm(req) { return new Promise((resolve, reject) => { let b=''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b)))); req.on('error', reject); }); }
function flash(url, msg, kind='ok') { const u = new URL(url, 'http://local'); u.searchParams.set(kind, msg); return u.pathname + u.search; }
function alertFrom(url) { const ok=url.searchParams.get('ok'), error=url.searchParams.get('error'); return ok ? `<div class="alert ok">${esc(ok)}</div>` : error ? `<div class="alert error">${esc(error)}</div>` : ''; }
function stateBadge(s) { const cls = s==='Entregada'||s==='Finalizada'?'ok':s==='Cancelada'?'danger':s==='En reparación'||s==='En diagnóstico'?'warn':'info'; return `<span class="badge ${cls}">${esc(s)}</span>`; }

function layout(user, title, content) {
  const nav = user ? `<div class="nav">
    <a href="/">Dashboard</a><a href="/clientes">Clientes</a><a href="/motocicletas">Motocicletas</a><a href="/citas">Citas</a><a href="/ordenes">Órdenes</a><a href="/historial">Historial</a><a href="/servicios">Servicios</a>
  </div>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | MotoControl</title><link rel="stylesheet" href="/styles.css"></head><body>
  ${user ? `<header class="topbar"><div class="topbar-inner"><a class="brand" href="/"><span class="brand-mark">🏍️</span><span>MotoControl</span></a>${nav}<div class="userbox"><span class="userpill">${esc(user.role)} · ${esc(user.name)}</span><a href="/logout">Salir</a></div></div></header>` : ''}
  ${content}
  ${user ? `<div class="footer-note">MotoControl · Sistema académico de gestión para taller de motocicletas</div>` : ''}
  </body></html>`;
}

function loginPage(error='') {
  return layout(null,'Iniciar sesión',`<main class="login-shell"><section class="card login-card"><div class="login-side"><div class="kicker">Proyecto universitario</div><h1>MotoControl</h1><p>Sistema web para centralizar clientes, motocicletas, citas, órdenes de servicio e historial de mantenimiento de un taller de motocicletas.</p><p>Versión funcional preparada para demostración y despliegue público.</p></div><div class="login-main"><h2>Iniciar sesión</h2><p class="muted">Ingresa con una cuenta de demostración.</p>${error?`<div class="alert error">${esc(error)}</div>`:''}<form method="post" action="/login"><div class="field"><label>Correo</label><input type="email" name="email" required value="admin@motocontrol.com"></div><div class="field" style="margin-top:14px"><label>Contraseña</label><input type="password" name="password" required value="Admin123!"></div><div class="actions"><button class="btn btn-primary" type="submit">Ingresar a MotoControl</button></div></form><div class="demo-box"><b>Cuenta principal:</b><br>admin@motocontrol.com<br>Admin123!<br><br><b>También disponibles:</b><br>mecanico@motocontrol.com / Mecanico123!<br>cliente@motocontrol.com / Cliente123!</div></div></section></main>`);
}

function dashboard(user, url) {
  const counts = {
    clientes: db.prepare('SELECT COUNT(*) c FROM clientes').get().c,
    motos: db.prepare('SELECT COUNT(*) c FROM motocicletas').get().c,
    citas: db.prepare("SELECT COUNT(*) c FROM citas WHERE estado='Programada'").get().c,
    ordenes: db.prepare("SELECT COUNT(*) c FROM ordenes WHERE estado NOT IN ('Finalizada','Entregada')").get().c,
  };
  const citas = db.prepare(`SELECT c.id,c.fecha,c.hora,c.estado,m.placa,s.nombre servicio,cl.nombre cliente FROM citas c JOIN motocicletas m ON m.id=c.motocicleta_id JOIN clientes cl ON cl.id=m.cliente_id JOIN servicios s ON s.id=c.servicio_id ORDER BY c.fecha,c.hora LIMIT 6`).all();
  const ords = db.prepare(`SELECT o.id,o.estado,o.mecanico,o.updated_at,m.placa,cl.nombre cliente FROM ordenes o JOIN motocicletas m ON m.id=o.motocicleta_id JOIN clientes cl ON cl.id=m.cliente_id ORDER BY o.updated_at DESC LIMIT 6`).all();
  const content = `<main class="container">${alertFrom(url)}<div class="hero"><div><h1>Panel de control</h1><p>Resumen operativo del taller y accesos rápidos.</p></div><a class="btn btn-primary" href="/citas/nueva">+ Programar cita</a></div>
  <section class="grid grid-4">
    <div class="card metric"><div><div class="value">${counts.clientes}</div><div class="label">Clientes registrados</div></div><div class="icon">👤</div></div>
    <div class="card metric"><div><div class="value">${counts.motos}</div><div class="label">Motocicletas</div></div><div class="icon">🏍️</div></div>
    <div class="card metric"><div><div class="value">${counts.citas}</div><div class="label">Citas programadas</div></div><div class="icon">📅</div></div>
    <div class="card metric"><div><div class="value">${counts.ordenes}</div><div class="label">Órdenes activas</div></div><div class="icon">🛠️</div></div>
  </section>
  <section class="grid grid-2 section"><div><div class="section-head"><h2>Próximas citas</h2><a class="btn btn-light" href="/citas">Ver todas</a></div><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Moto</th><th>Servicio</th></tr></thead><tbody>${citas.length?citas.map(x=>`<tr><td>${fmtDate(x.fecha)} · ${esc(x.hora)}</td><td>${esc(x.cliente)}</td><td>${esc(x.placa)}</td><td>${esc(x.servicio)}</td></tr>`).join(''):`<tr><td colspan="4" class="empty">No hay citas.</td></tr>`}</tbody></table></div></div>
  <div><div class="section-head"><h2>Órdenes recientes</h2><a class="btn btn-light" href="/ordenes">Ver todas</a></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Cliente</th><th>Moto</th><th>Estado</th></tr></thead><tbody>${ords.length?ords.map(x=>`<tr><td><a href="/ordenes/${x.id}">#${x.id}</a></td><td>${esc(x.cliente)}</td><td>${esc(x.placa)}</td><td>${stateBadge(x.estado)}</td></tr>`).join(''):`<tr><td colspan="4" class="empty">No hay órdenes.</td></tr>`}</tbody></table></div></div></section></main>`;
  return layout(user,'Dashboard',content);
}

function clientesPage(user, url) {
  const rows = db.prepare('SELECT * FROM clientes ORDER BY id DESC').all();
  return layout(user,'Clientes',`<main class="container">${alertFrom(url)}<div class="hero"><div><h1>Clientes</h1><p>Registro y consulta de clientes del taller.</p></div><a class="btn btn-primary" href="/clientes/nuevo">+ Nuevo cliente</a></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Nombre</th><th>Documento</th><th>Teléfono</th><th>Correo</th></tr></thead><tbody>${rows.map(x=>`<tr><td>#${x.id}</td><td><b>${esc(x.nombre)}</b></td><td>${esc(x.documento)}</td><td>${esc(x.telefono)}</td><td>${esc(x.correo)}</td></tr>`).join('')}</tbody></table></div></main>`);
}
function clienteForm(user, url) { return layout(user,'Nuevo cliente',`<main class="container"><div class="hero"><div><h1>Nuevo cliente</h1><p>Registra la información básica del propietario.</p></div></div>${alertFrom(url)}<section class="card form-card"><form method="post" action="/clientes/nuevo"><div class="form-grid"><div class="field"><label>Nombre completo</label><input name="nombre" required></div><div class="field"><label>Documento</label><input name="documento" required></div><div class="field"><label>Teléfono</label><input name="telefono"></div><div class="field"><label>Correo</label><input type="email" name="correo"></div></div><div class="actions"><button class="btn btn-primary">Guardar cliente</button><a class="btn btn-light" href="/clientes">Cancelar</a></div></form></section></main>`); }

function motosPage(user, url) {
  const rows = db.prepare(`SELECT m.*, c.nombre cliente FROM motocicletas m JOIN clientes c ON c.id=m.cliente_id ORDER BY m.id DESC`).all();
  return layout(user,'Motocicletas',`<main class="container">${alertFrom(url)}<div class="hero"><div><h1>Motocicletas</h1><p>Vehículos asociados a los clientes registrados.</p></div><a class="btn btn-primary" href="/motocicletas/nueva">+ Nueva motocicleta</a></div><div class="table-wrap"><table><thead><tr><th>Placa</th><th>Marca / modelo</th><th>Año</th><th>Propietario</th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.placa)}</b></td><td>${esc(x.marca)} ${esc(x.modelo)}</td><td>${esc(x.anio)}</td><td>${esc(x.cliente)}</td></tr>`).join('')}</tbody></table></div></main>`);
}
function motoForm(user) { const clients=db.prepare('SELECT id,nombre,documento FROM clientes ORDER BY nombre').all(); return layout(user,'Nueva motocicleta',`<main class="container"><div class="hero"><div><h1>Nueva motocicleta</h1><p>Asocia la motocicleta a un cliente existente.</p></div></div><section class="card form-card"><form method="post" action="/motocicletas/nueva"><div class="form-grid"><div class="field full"><label>Propietario</label><select name="cliente_id" required><option value="">Seleccionar...</option>${clients.map(x=>`<option value="${x.id}">${esc(x.nombre)} · ${esc(x.documento)}</option>`).join('')}</select></div><div class="field"><label>Placa</label><input name="placa" required maxlength="10"></div><div class="field"><label>Marca</label><input name="marca" required></div><div class="field"><label>Modelo</label><input name="modelo" required></div><div class="field"><label>Año</label><input type="number" min="1990" max="2030" name="anio"></div></div><div class="actions"><button class="btn btn-primary">Guardar motocicleta</button><a class="btn btn-light" href="/motocicletas">Cancelar</a></div></form></section></main>`); }

function serviciosPage(user, url) { const rows=db.prepare('SELECT * FROM servicios ORDER BY nombre').all(); return layout(user,'Servicios',`<main class="container">${alertFrom(url)}<div class="hero"><div><h1>Catálogo de servicios</h1><p>Servicios disponibles para programar citas.</p></div>${user.role==='Administrador'?'<a class="btn btn-primary" href="/servicios/nuevo">+ Nuevo servicio</a>':''}</div><div class="grid grid-2">${rows.map(x=>`<div class="card"><div class="section-head"><h2>${esc(x.nombre)}</h2><span class="badge info">${money(x.precio)}</span></div><p class="muted">${esc(x.descripcion)}</p></div>`).join('')}</div></main>`); }
function servicioForm(user) { return layout(user,'Nuevo servicio',`<main class="container"><div class="hero"><div><h1>Nuevo servicio</h1><p>Agrega un servicio al catálogo del taller.</p></div></div><section class="card form-card"><form method="post" action="/servicios/nuevo"><div class="form-grid"><div class="field"><label>Nombre</label><input name="nombre" required></div><div class="field"><label>Precio COP</label><input type="number" min="0" name="precio" required></div><div class="field full"><label>Descripción</label><textarea name="descripcion"></textarea></div></div><div class="actions"><button class="btn btn-primary">Guardar servicio</button><a class="btn btn-light" href="/servicios">Cancelar</a></div></form></section></main>`); }

function citasPage(user, url) {
  const rows=db.prepare(`SELECT c.*,m.placa,m.marca,m.modelo,cl.nombre cliente,s.nombre servicio FROM citas c JOIN motocicletas m ON m.id=c.motocicleta_id JOIN clientes cl ON cl.id=m.cliente_id JOIN servicios s ON s.id=c.servicio_id ORDER BY c.fecha DESC,c.hora DESC`).all();
  return layout(user,'Citas',`<main class="container">${alertFrom(url)}<div class="hero"><div><h1>Citas</h1><p>Programación, consulta y cancelación de citas.</p></div><a class="btn btn-primary" href="/citas/nueva">+ Programar cita</a></div><div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Cliente</th><th>Moto</th><th>Servicio</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${fmtDate(x.fecha)}<br><span class="muted">${esc(x.hora)}</span></td><td>${esc(x.cliente)}</td><td><b>${esc(x.placa)}</b><br><span class="muted">${esc(x.marca)} ${esc(x.modelo)}</span></td><td>${esc(x.servicio)}</td><td>${stateBadge(x.estado)}</td><td>${x.estado!=='Cancelada'?`<form class="inline" method="post" action="/citas/${x.id}/cancelar"><button class="btn btn-danger" type="submit">Cancelar</button></form>`:''}</td></tr>`).join('')}</tbody></table></div></main>`);
}
function citaForm(user) { const motos=db.prepare(`SELECT m.id,m.placa,m.marca,m.modelo,c.nombre cliente FROM motocicletas m JOIN clientes c ON c.id=m.cliente_id ORDER BY c.nombre`).all(); const servicios=db.prepare('SELECT * FROM servicios ORDER BY nombre').all(); return layout(user,'Programar cita',`<main class="container"><div class="hero"><div><h1>Programar cita</h1><p>Selecciona motocicleta, servicio, fecha y hora.</p></div></div><section class="card form-card"><form method="post" action="/citas/nueva"><div class="form-grid"><div class="field full"><label>Motocicleta</label><select name="motocicleta_id" required><option value="">Seleccionar...</option>${motos.map(x=>`<option value="${x.id}">${esc(x.placa)} · ${esc(x.marca)} ${esc(x.modelo)} · ${esc(x.cliente)}</option>`).join('')}</select></div><div class="field full"><label>Servicio</label><select name="servicio_id" required><option value="">Seleccionar...</option>${servicios.map(x=>`<option value="${x.id}">${esc(x.nombre)} · ${money(x.precio)}</option>`).join('')}</select></div><div class="field"><label>Fecha</label><input type="date" name="fecha" required></div><div class="field"><label>Hora</label><input type="time" name="hora" required></div><div class="field full"><label>Observaciones</label><textarea name="observaciones"></textarea></div></div><div class="actions"><button class="btn btn-primary">Programar cita</button><a class="btn btn-light" href="/citas">Cancelar</a></div></form></section></main>`); }

function ordenesPage(user, url) {
  const rows=db.prepare(`SELECT o.*,m.placa,m.marca,m.modelo,cl.nombre cliente FROM ordenes o JOIN motocicletas m ON m.id=o.motocicleta_id JOIN clientes cl ON cl.id=m.cliente_id ORDER BY o.id DESC`).all();
  return layout(user,'Órdenes de servicio',`<main class="container">${alertFrom(url)}<div class="hero"><div><h1>Órdenes de servicio</h1><p>Seguimiento del ciclo de atención y mantenimiento.</p></div><a class="btn btn-primary" href="/ordenes/nueva">+ Crear orden</a></div><div class="table-wrap"><table><thead><tr><th>Orden</th><th>Cliente</th><th>Moto</th><th>Mecánico</th><th>Estado</th><th></th></tr></thead><tbody>${rows.length?rows.map(x=>`<tr><td><b>#${x.id}</b><br><span class="muted">${fmtDate(x.created_at.slice(0,10))}</span></td><td>${esc(x.cliente)}</td><td>${esc(x.placa)}<br><span class="muted">${esc(x.marca)} ${esc(x.modelo)}</span></td><td>${esc(x.mecanico||'Sin asignar')}</td><td>${stateBadge(x.estado)}</td><td><a class="btn btn-light" href="/ordenes/${x.id}">Abrir</a></td></tr>`).join(''):`<tr><td colspan="6" class="empty">No hay órdenes registradas.</td></tr>`}</tbody></table></div></main>`);
}
function ordenForm(user) { const motos=db.prepare(`SELECT m.id,m.placa,m.marca,m.modelo,c.nombre cliente FROM motocicletas m JOIN clientes c ON c.id=m.cliente_id ORDER BY c.nombre`).all(); const citas=db.prepare(`SELECT c.id,c.fecha,c.hora,m.placa FROM citas c JOIN motocicletas m ON m.id=c.motocicleta_id WHERE c.estado='Programada' ORDER BY c.fecha`).all(); return layout(user,'Nueva orden',`<main class="container"><div class="hero"><div><h1>Nueva orden de servicio</h1><p>Registra el ingreso de una motocicleta al taller.</p></div></div><section class="card form-card"><form method="post" action="/ordenes/nueva"><div class="form-grid"><div class="field full"><label>Motocicleta</label><select name="motocicleta_id" required><option value="">Seleccionar...</option>${motos.map(x=>`<option value="${x.id}">${esc(x.placa)} · ${esc(x.marca)} ${esc(x.modelo)} · ${esc(x.cliente)}</option>`).join('')}</select></div><div class="field full"><label>Cita asociada (opcional)</label><select name="cita_id"><option value="">Sin cita</option>${citas.map(x=>`<option value="${x.id}">#${x.id} · ${fmtDate(x.fecha)} ${esc(x.hora)} · ${esc(x.placa)}</option>`).join('')}</select></div><div class="field"><label>Mecánico responsable</label><input name="mecanico" value="Mecánico Demo"></div><div class="field"><label>Estado inicial</label><select name="estado"><option>Pendiente</option><option>En diagnóstico</option></select></div><div class="field full"><label>Diagnóstico inicial</label><textarea name="diagnostico"></textarea></div></div><div class="actions"><button class="btn btn-primary">Crear orden</button><a class="btn btn-light" href="/ordenes">Cancelar</a></div></form></section></main>`); }
function ordenDetail(user, url, id) {
  const o=db.prepare(`SELECT o.*,m.placa,m.marca,m.modelo,m.anio,cl.nombre cliente,cl.telefono,cl.correo FROM ordenes o JOIN motocicletas m ON m.id=o.motocicleta_id JOIN clientes cl ON cl.id=m.cliente_id WHERE o.id=?`).get(id);
  if(!o) return null;
  const acts=db.prepare('SELECT * FROM actividades WHERE orden_id=? ORDER BY id DESC').all(id); const total=acts.reduce((a,x)=>a+Number(x.costo||0),0);
  const states=['Pendiente','En diagnóstico','En reparación','Finalizada','Entregada'];
  return layout(user,`Orden #${id}`,`<main class="container">${alertFrom(url)}<div class="hero"><div><h1>Orden #${id}</h1><p>${esc(o.cliente)} · ${esc(o.placa)} · ${esc(o.marca)} ${esc(o.modelo)}</p></div>${stateBadge(o.estado)}</div><div class="order-grid"><section class="card"><div class="section-head"><h2>Detalle del servicio</h2><span class="badge info">${money(total)}</span></div><p><b>Diagnóstico:</b><br>${esc(o.diagnostico||'Pendiente de diagnóstico.')}</p><p><b>Mecánico:</b> ${esc(o.mecanico||'Sin asignar')}</p><div class="section"><h2>Actividades realizadas</h2><div class="timeline" style="margin-top:12px">${acts.length?acts.map(a=>`<div class="timeline-item"><b>${esc(a.descripcion)}</b><div class="muted">${money(a.costo)} · ${fmtDate(a.created_at.slice(0,10))}</div></div>`).join(''):'<div class="empty">Aún no hay actividades registradas.</div>'}</div></div><div class="section"><h2>Agregar actividad</h2><form method="post" action="/ordenes/${id}/actividad"><div class="form-grid" style="margin-top:12px"><div class="field"><label>Descripción</label><input name="descripcion" required></div><div class="field"><label>Costo COP</label><input type="number" min="0" name="costo" value="0"></div></div><div class="actions"><button class="btn btn-primary">Agregar actividad</button></div></form></div></section><aside class="card"><h2>Actualizar orden</h2><form method="post" action="/ordenes/${id}/actualizar"><div class="field" style="margin-top:14px"><label>Estado</label><select name="estado">${states.map(s=>`<option ${s===o.estado?'selected':''}>${s}</option>`).join('')}</select></div><div class="field" style="margin-top:14px"><label>Diagnóstico</label><textarea name="diagnostico">${esc(o.diagnostico||'')}</textarea></div><div class="field" style="margin-top:14px"><label>Mecánico</label><input name="mecanico" value="${esc(o.mecanico||'')}"></div><div class="actions"><button class="btn btn-primary">Guardar cambios</button></div></form><hr style="border:0;border-top:1px solid var(--line);margin:22px 0"><div class="muted"><b>Cliente</b><br>${esc(o.cliente)}<br>${esc(o.telefono||'')}<br>${esc(o.correo||'')}</div></aside></div></main>`);
}

function historialPage(user, url) {
  const motoId=int(url.searchParams.get('moto'));
  const motos=db.prepare(`SELECT m.id,m.placa,m.marca,m.modelo,c.nombre cliente FROM motocicletas m JOIN clientes c ON c.id=m.cliente_id ORDER BY c.nombre`).all();
  const rows = motoId ? db.prepare(`SELECT o.*,m.placa,m.marca,m.modelo,cl.nombre cliente,(SELECT COALESCE(SUM(costo),0) FROM actividades a WHERE a.orden_id=o.id) total FROM ordenes o JOIN motocicletas m ON m.id=o.motocicleta_id JOIN clientes cl ON cl.id=m.cliente_id WHERE m.id=? ORDER BY o.created_at DESC`).all(motoId) : db.prepare(`SELECT o.*,m.placa,m.marca,m.modelo,cl.nombre cliente,(SELECT COALESCE(SUM(costo),0) FROM actividades a WHERE a.orden_id=o.id) total FROM ordenes o JOIN motocicletas m ON m.id=o.motocicleta_id JOIN clientes cl ON cl.id=m.cliente_id ORDER BY o.created_at DESC LIMIT 30`).all();
  return layout(user,'Historial',`<main class="container"><div class="hero"><div><h1>Historial de mantenimiento</h1><p>Consulta cronológica de servicios por motocicleta.</p></div></div><section class="card" style="margin-bottom:16px"><form method="get" action="/historial"><div class="form-grid"><div class="field full"><label>Motocicleta</label><select name="moto" onchange="this.form.submit()"><option value="">Todas</option>${motos.map(x=>`<option value="${x.id}" ${x.id===motoId?'selected':''}>${esc(x.placa)} · ${esc(x.marca)} ${esc(x.modelo)} · ${esc(x.cliente)}</option>`).join('')}</select></div></div></form></section><div class="table-wrap"><table><thead><tr><th>Orden</th><th>Fecha</th><th>Cliente / moto</th><th>Diagnóstico</th><th>Estado</th><th>Total</th></tr></thead><tbody>${rows.length?rows.map(x=>`<tr><td><a href="/ordenes/${x.id}"><b>#${x.id}</b></a></td><td>${fmtDate(x.created_at.slice(0,10))}</td><td>${esc(x.cliente)}<br><span class="muted">${esc(x.placa)} · ${esc(x.marca)} ${esc(x.modelo)}</span></td><td>${esc(x.diagnostico||'Sin diagnóstico')}</td><td>${stateBadge(x.estado)}</td><td>${money(x.total)}</td></tr>`).join(''):`<tr><td colspan="6" class="empty">No hay historial para mostrar.</td></tr>`}</tbody></table></div></main>`);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') return send(res, JSON.stringify({status:'ok'}), 200, 'application/json; charset=utf-8');
  if (url.pathname === '/styles.css') { try { return send(res, fs.readFileSync(path.join(__dirname,'public','styles.css')), 200, 'text/css; charset=utf-8'); } catch { return send(res,'',404,'text/plain'); } }
  if (url.pathname === '/login' && req.method === 'GET') return send(res, loginPage());
  if (url.pathname === '/login' && req.method === 'POST') {
    const f=await bodyForm(req); const u=db.prepare('SELECT id,name,email,role,password_hash FROM users WHERE lower(email)=lower(?)').get(f.email||'');
    if (!u || u.password_hash !== hashPassword(f.password||'')) return send(res, loginPage('Correo o contraseña incorrectos.'), 401);
    setSession(res,{id:u.id,name:u.name,email:u.email,role:u.role}); return redirect(res,'/');
  }
  if (url.pathname === '/logout') { clearSession(req,res); return redirect(res,'/login'); }
  if (url.pathname === '/dev-login' && process.env.NODE_ENV !== 'production') { const u=db.prepare("SELECT id,name,email,role FROM users WHERE email='admin@motocontrol.com'").get(); setSession(res,u); return redirect(res,'/'); }
  const user=currentUser(req); if (!user) return redirect(res,'/login');

  try {
    if (url.pathname === '/' && req.method==='GET') return send(res,dashboard(user,url));
    if (url.pathname === '/clientes' && req.method==='GET') return send(res,clientesPage(user,url));
    if (url.pathname === '/clientes/nuevo' && req.method==='GET') return send(res,clienteForm(user,url));
    if (url.pathname === '/clientes/nuevo' && req.method==='POST') { const f=await bodyForm(req); db.prepare('INSERT INTO clientes(nombre,documento,telefono,correo,created_at) VALUES(?,?,?,?,?)').run(f.nombre.trim(),f.documento.trim(),f.telefono?.trim()||'',f.correo?.trim()||'',nowIso()); return redirect(res,flash('/clientes','Cliente registrado correctamente.')); }

    if (url.pathname === '/motocicletas' && req.method==='GET') return send(res,motosPage(user,url));
    if (url.pathname === '/motocicletas/nueva' && req.method==='GET') return send(res,motoForm(user));
    if (url.pathname === '/motocicletas/nueva' && req.method==='POST') { const f=await bodyForm(req); db.prepare('INSERT INTO motocicletas(cliente_id,placa,marca,modelo,anio,created_at) VALUES(?,?,?,?,?,?)').run(int(f.cliente_id),f.placa.trim().toUpperCase(),f.marca.trim(),f.modelo.trim(),int(f.anio)||null,nowIso()); return redirect(res,flash('/motocicletas','Motocicleta registrada correctamente.')); }

    if (url.pathname === '/servicios' && req.method==='GET') return send(res,serviciosPage(user,url));
    if (url.pathname === '/servicios/nuevo' && req.method==='GET') { if(user.role!=='Administrador') return redirect(res,flash('/servicios','Solo el administrador puede crear servicios.','error')); return send(res,servicioForm(user)); }
    if (url.pathname === '/servicios/nuevo' && req.method==='POST') { if(user.role!=='Administrador') return redirect(res,flash('/servicios','Acceso restringido.','error')); const f=await bodyForm(req); db.prepare('INSERT INTO servicios(nombre,descripcion,precio) VALUES(?,?,?)').run(f.nombre.trim(),f.descripcion?.trim()||'',Number(f.precio||0)); return redirect(res,flash('/servicios','Servicio agregado al catálogo.')); }

    if (url.pathname === '/citas' && req.method==='GET') return send(res,citasPage(user,url));
    if (url.pathname === '/citas/nueva' && req.method==='GET') return send(res,citaForm(user));
    if (url.pathname === '/citas/nueva' && req.method==='POST') { const f=await bodyForm(req); const exists=db.prepare("SELECT id FROM citas WHERE fecha=? AND hora=? AND estado='Programada'").get(f.fecha,f.hora); if(exists) return redirect(res,flash('/citas/nueva','Ya existe una cita programada para esa fecha y hora.','error')); db.prepare('INSERT INTO citas(motocicleta_id,servicio_id,fecha,hora,estado,observaciones,created_at) VALUES(?,?,?,?,?,?,?)').run(int(f.motocicleta_id),int(f.servicio_id),f.fecha,f.hora,'Programada',f.observaciones?.trim()||'',nowIso()); return redirect(res,flash('/citas','Cita programada correctamente.')); }
    let m=url.pathname.match(/^\/citas\/(\d+)\/cancelar$/); if(m && req.method==='POST') { db.prepare("UPDATE citas SET estado='Cancelada' WHERE id=?").run(int(m[1])); return redirect(res,flash('/citas','Cita cancelada.')); }

    if (url.pathname === '/ordenes' && req.method==='GET') return send(res,ordenesPage(user,url));
    if (url.pathname === '/ordenes/nueva' && req.method==='GET') return send(res,ordenForm(user));
    if (url.pathname === '/ordenes/nueva' && req.method==='POST') { const f=await bodyForm(req); const citaId=int(f.cita_id)||null; const r=db.prepare('INSERT INTO ordenes(motocicleta_id,cita_id,diagnostico,estado,mecanico,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(int(f.motocicleta_id),citaId,f.diagnostico?.trim()||'',f.estado||'Pendiente',f.mecanico?.trim()||'',nowIso(),nowIso()); if(citaId) db.prepare("UPDATE citas SET estado='Atendida' WHERE id=?").run(citaId); return redirect(res,flash(`/ordenes/${Number(r.lastInsertRowid)}`,'Orden creada correctamente.')); }
    m=url.pathname.match(/^\/ordenes\/(\d+)$/); if(m && req.method==='GET') { const html=ordenDetail(user,url,int(m[1])); return html?send(res,html):send(res,layout(user,'No encontrada','<main class="container"><div class="alert error">Orden no encontrada.</div></main>'),404); }
    m=url.pathname.match(/^\/ordenes\/(\d+)\/actualizar$/); if(m && req.method==='POST') { const f=await bodyForm(req); db.prepare('UPDATE ordenes SET estado=?,diagnostico=?,mecanico=?,updated_at=? WHERE id=?').run(f.estado,f.diagnostico?.trim()||'',f.mecanico?.trim()||'',nowIso(),int(m[1])); return redirect(res,flash(`/ordenes/${m[1]}`,'Orden actualizada.')); }
    m=url.pathname.match(/^\/ordenes\/(\d+)\/actividad$/); if(m && req.method==='POST') { const f=await bodyForm(req); db.prepare('INSERT INTO actividades(orden_id,descripcion,costo,created_at) VALUES(?,?,?,?)').run(int(m[1]),f.descripcion.trim(),Number(f.costo||0),nowIso()); db.prepare('UPDATE ordenes SET updated_at=? WHERE id=?').run(nowIso(),int(m[1])); return redirect(res,flash(`/ordenes/${m[1]}`,'Actividad registrada.')); }

    if (url.pathname === '/historial' && req.method==='GET') return send(res,historialPage(user,url));
    return send(res,layout(user,'404','<main class="container"><div class="alert error">Página no encontrada.</div></main>'),404);
  } catch (err) {
    console.error(err);
    const msg = String(err.message || err).includes('UNIQUE') ? 'Ya existe un registro con ese dato único.' : 'No fue posible completar la operación. Revisa los datos e inténtalo de nuevo.';
    return send(res,layout(user,'Error',`<main class="container"><div class="alert error">${esc(msg)}</div><a class="btn btn-light" href="javascript:history.back()">Volver</a></main>`),500);
  }
}

const server=http.createServer((req,res)=>{ handler(req,res).catch(err=>{ console.error(err); send(res,'Error interno',500,'text/plain; charset=utf-8'); }); });
server.listen(PORT,'0.0.0.0',()=>console.log(`MotoControl activo en http://localhost:${PORT}`));
