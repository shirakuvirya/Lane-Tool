const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const isDev = process.argv.includes('--dev');

let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1200,
    minHeight: 800,
    fullscreen: !isDev,
    frame: !isDev,
    titleBarStyle: isDev ? 'default' : 'hidden',
    title: 'WaypointEdit+ Fixed - Complete Point Cloud Viewer',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    backgroundColor: '#0b0e14'
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (mainWindow) mainWindow.focus();
    if (isDev) {
      mainWindow.webContents.openDevTools();
      console.log('WaypointEdit+ Fixed started in development mode');
    }
  });

  mainWindow.on('closed', () => { 
    mainWindow = null; 
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
    if (input.key === 'Escape' && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
    if (input.key === 'F12' && isDev) {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const template = [
      { 
        label: 'WaypointEdit+ Fixed', 
        submenu: [
          { role: 'about' }, 
          { type: 'separator' }, 
          { role: 'quit' }
        ] 
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggledevtools' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }

  createMainWindow();

  app.on('activate', () => { 
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); 
  });
});

app.on('window-all-closed', () => { 
  if (process.platform !== 'darwin') app.quit(); 
});

app.setName('WaypointEdit+ Fixed');
