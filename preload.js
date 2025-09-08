const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.versions.electron
});

console.log('✅ WaypointEdit+ Fixed - Preload script ready');
