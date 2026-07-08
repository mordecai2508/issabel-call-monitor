'use strict';

// Registro ESTÁTICO de plugins backend (feature plugin_system, R1).
// Añadir un plugin = añadir UNA entrada aquí (requiere redeploy).
// Cada entrada es { name, load } donde `load` es un thunk con require
// estático (ruta literal): permite capturar con try/catch una excepción
// lanzada en el require del plugin (R4) sin escaneo de filesystem.
module.exports = [
  { name: 'minutes-monitor', load: () => require('./minutes-monitor') },
];
