const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const appHtml = path.join(__dirname, 'today-bubble.html');
const preload = path.join(__dirname, 'today-bubble-preload.js');
const compactWindowSize = { width: 50, height: 50 };
const defaultExpandedSize = { width: 438, height: 540 };
const minExpandedSize = { width: 392, height: 420 };

let widgetWindow = null;
let mainWindow = null;
let persistedState = null;
let saveTimer = null;
let widgetIsCompact = false;

function statePath() {
  return path.join(app.getPath('userData'), 'today-bubble-state.json');
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function normalizeLabels(labels) {
  const source = labels && typeof labels === 'object' ? labels : {};
  return {
    title: String(source.title || 'Today Bubble').trim() || 'Today Bubble',
    inputPlaceholder: String(source.inputPlaceholder || 'Type a task and press Enter').trim() || 'Type a task and press Enter',
    emptyState: String(source.emptyState || 'No tasks yet. Add your first bubble above.').trim() || 'No tasks yet. Add your first bubble above.',
    completedTitle: String(source.completedTitle || 'Completed').trim() || 'Completed'
  };
}

function normalizeProfile(profile, fallbackName = 'Default User') {
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    id: String(source.id || uid('tbuser')),
    name: String(source.name || fallbackName).trim() || fallbackName,
    themeId: String(source.themeId || 'airy-blue').trim() || 'airy-blue',
    labels: normalizeLabels(source.labels),
    items: Array.isArray(source.items) ? source.items.map(normalizeItem).filter(Boolean) : []
  };
}

function normalizeProfiles(profiles) {
  if (!Array.isArray(profiles) || !profiles.length) {
    return [normalizeProfile(null)];
  }
  return profiles.map((profile, index) => normalizeProfile(profile, `User ${index + 1}`));
}

function normalizeItem(item, index = 0) {
  if (!item || typeof item !== 'object') return null;
  const text = String(item.text || '').trim();
  if (!text) return null;
  return {
    id: String(item.id || uid('tb')),
    text,
    completed: Boolean(item.completed),
    today: Boolean(item.today),
    priority: item.priority === 'high' ? 'high' : 'normal',
    depth: Number.isFinite(item.depth) ? Math.max(0, Math.min(6, Math.round(item.depth))) : 0,
    order: Number.isFinite(item.order) ? item.order : index,
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now()
  };
}

function normalizeBounds(bounds, fallback) {
  const source = bounds && typeof bounds === 'object' ? bounds : {};
  const width = Number.isFinite(source.width) ? Math.round(source.width) : fallback.width;
  const height = Number.isFinite(source.height) ? Math.round(source.height) : fallback.height;
  const x = Number.isFinite(source.x) ? Math.round(source.x) : fallback.x;
  const y = Number.isFinite(source.y) ? Math.round(source.y) : fallback.y;
  return { x, y, width, height };
}

function defaultExpandedBounds() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  return {
    x: Math.round(x + width - defaultExpandedSize.width - 28),
    y: Math.round(y + height - defaultExpandedSize.height - 36),
    width: defaultExpandedSize.width,
    height: defaultExpandedSize.height
  };
}

function defaultState() {
  const widgetBounds = app.isReady() ? defaultExpandedBounds() : { x: 0, y: 0, width: defaultExpandedSize.width, height: defaultExpandedSize.height };
  const profiles = normalizeProfiles([]);
  return {
    profiles,
    activeProfileId: profiles[0].id,
    widgetBounds,
    mainBounds: { width: 620, height: 760 }
  };
}

function normalizeAppState(nextState) {
  const defaults = defaultState();
  const source = nextState && typeof nextState === 'object' ? nextState : {};
  let profiles = [];
  let activeProfileId = '';

  if (Array.isArray(source.profiles) && source.profiles.length) {
    profiles = normalizeProfiles(source.profiles);
    activeProfileId = String(source.activeProfileId || '').trim();
  } else if (source.labels || source.items) {
    const migrated = normalizeProfile({
      id: source.activeProfileId || uid('tbuser'),
      name: source.activeProfileName || 'Default User',
      labels: source.labels,
      items: source.items
    });
    profiles = [migrated];
    activeProfileId = migrated.id;
  } else {
    profiles = defaults.profiles;
    activeProfileId = defaults.activeProfileId;
  }

  if (!profiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = profiles[0].id;
  }

  return {
    profiles,
    activeProfileId,
    widgetBounds: normalizeBounds(source.widgetBounds, defaults.widgetBounds),
    mainBounds: normalizeBounds(source.mainBounds, defaults.mainBounds)
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, '');
    return normalizeAppState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function normalizeArchiveState(nextState) {
  const source = normalizeAppState(nextState);
  const activeProfile = source.profiles.find((profile) => profile.id === source.activeProfileId) || source.profiles[0];
  return {
    profileName: activeProfile.name,
    labels: normalizeLabels(activeProfile.labels),
    items: Array.isArray(activeProfile.items) ? activeProfile.items.map(normalizeItem).filter(Boolean) : []
  };
}

function safeFilePart(text, fallback) {
  const cleaned = String(text || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function formatArchiveStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function escapeMarkdown(text) {
  return String(text || '').replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

function buildArchiveMarkdown(snapshot, archivedAt) {
  const active = snapshot.items
    .filter((item) => !item.completed)
    .sort((a, b) => (a.priority === b.priority ? a.order - b.order : a.priority === 'high' ? -1 : 1));
  const completed = snapshot.items
    .filter((item) => item.completed)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const title = snapshot.labels.title || 'Today Bubble';
  const lines = [
    `# ${escapeMarkdown(title)}`,
    '',
    `- Archived at: ${archivedAt.toLocaleString()}`,
    `- Source: Today Bubble`,
    `- User: ${escapeMarkdown(snapshot.profileName || 'Default User')}`,
    `- Active tasks: ${active.length}`,
    `- Completed tasks: ${completed.length}`,
    ''
  ];

  lines.push('## Active');
  lines.push('');
  if (!active.length) {
    lines.push('- None');
  } else {
    for (const item of active) {
      const tags = [];
      if (item.today) tags.push('today');
      if (item.priority === 'high') tags.push('priority');
      const suffix = tags.length ? ` _( ${tags.join(', ')} )_` : '';
      const indent = '  '.repeat(Math.max(0, item.depth || 0));
      lines.push(`${indent}- [ ] ${escapeMarkdown(item.text)}${suffix}`);
    }
  }

  lines.push('');
  lines.push(`## ${escapeMarkdown(snapshot.labels.completedTitle || 'Completed')}`);
  lines.push('');
  if (!completed.length) {
    lines.push('- None');
  } else {
    for (const item of completed) {
      const tags = [];
      if (item.today) tags.push('today');
      if (item.priority === 'high') tags.push('priority');
      const suffix = tags.length ? ` _( ${tags.join(', ')} )_` : '';
      const indent = '  '.repeat(Math.max(0, item.depth || 0));
      lines.push(`${indent}- [x] ${escapeMarkdown(item.text)}${suffix}`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function scheduleSave(nextState) {
  persistedState = normalizeAppState(nextState);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      atomicWriteJson(statePath(), persistedState);
    } catch {
      // Keep the widget usable even if persistence fails.
    }
  }, 120);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (persistedState) {
    try {
      atomicWriteJson(statePath(), persistedState);
    } catch {
      // Ignore flush failures on shutdown.
    }
  }
}

function clampBounds(bounds, minimum = minExpandedSize) {
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const { x, y, width, height } = display.workArea;
  const nextWidth = Math.max(minimum.width, Math.round(bounds.width));
  const nextHeight = Math.max(minimum.height, Math.round(bounds.height));
  return {
    x: Math.min(Math.max(Math.round(bounds.x), x), x + width - nextWidth),
    y: Math.min(Math.max(Math.round(bounds.y), y), y + height - nextHeight),
    width: Math.min(nextWidth, width),
    height: Math.min(nextHeight, height)
  };
}

function compactBoundsFromExpanded(bounds) {
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const { x, y, width, height } = display.workArea;
  const nextX = Math.min(Math.max(bounds.x + bounds.width - compactWindowSize.width, x), x + width - compactWindowSize.width);
  const nextY = Math.min(Math.max(bounds.y, y), y + height - compactWindowSize.height);
  return {
    x: Math.round(nextX),
    y: Math.round(nextY),
    width: compactWindowSize.width,
    height: compactWindowSize.height
  };
}

function persistWindowBounds() {
  if (!persistedState) return;
  if (widgetWindow && !widgetWindow.isDestroyed() && !widgetIsCompact) {
    persistedState.widgetBounds = clampBounds(widgetWindow.getBounds());
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    persistedState.mainBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    };
  }
  scheduleSave(persistedState);
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow;

  const startBounds = clampBounds(persistedState?.widgetBounds || defaultExpandedBounds());
  widgetWindow = new BrowserWindow({
    ...startBounds,
    minWidth: minExpandedSize.width,
    minHeight: minExpandedSize.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  widgetWindow.setAlwaysOnTop(true, 'screen-saver');
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWindow.loadFile(appHtml, { query: { widget: '1' } });
  widgetWindow.on('moved', persistWindowBounds);
  widgetWindow.on('resized', persistWindowBounds);
  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
  return widgetWindow;
}

function applyWidgetMode(mode) {
  const win = createWidgetWindow();
  if (mode === 'compact') {
    widgetIsCompact = true;
    const sourceBounds = persistedState?.widgetBounds || defaultExpandedBounds();
    win.setResizable(false);
    win.setBounds(compactBoundsFromExpanded(sourceBounds), false);
  } else {
    widgetIsCompact = false;
    const bounds = clampBounds(persistedState?.widgetBounds || defaultExpandedBounds());
    win.setResizable(true);
    win.setBounds(bounds, false);
    win.setMinimumSize(minExpandedSize.width, minExpandedSize.height);
  }
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
}

function showWidgetWindow() {
  const win = createWidgetWindow();
  applyWidgetMode('expanded');
  win.show();
  win.focus();
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const defaults = defaultState().mainBounds;
  const saved = persistedState?.mainBounds || defaults;
  mainWindow = new BrowserWindow({
    width: saved.width || defaults.width,
    height: saved.height || defaults.height,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 520,
    minHeight: 620,
    title: 'Today Bubble',
    backgroundColor: '#eef3ff',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(appHtml);
  mainWindow.on('moved', persistWindowBounds);
  mainWindow.on('resized', persistWindowBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  persistedState = loadState();
  createWidgetWindow().show();

  app.on('activate', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) {
      createWidgetWindow().show();
    }
  });
});

ipcMain.handle('todaybubble:get-state', () => persistedState || loadState());

ipcMain.handle('todaybubble:save-state', (_event, nextState) => {
  scheduleSave(nextState);
  return true;
});

ipcMain.handle('todaybubble:set-widget-mode', (_event, mode) => {
  applyWidgetMode(mode === 'compact' ? 'compact' : 'expanded');
  return true;
});

ipcMain.handle('todaybubble:restore-main', () => {
  const win = createMainWindow();
  win.show();
  win.focus();
  return true;
});

ipcMain.handle('todaybubble:quit-app', () => {
  app.quit();
  return true;
});

ipcMain.handle('todaybubble:archive-current-list', async (_event, nextState) => {
  const snapshot = normalizeArchiveState(nextState);
  if (!snapshot.items.length) {
    throw new Error('There are no tasks to archive yet.');
  }

  const archivedAt = new Date();
  const filename = `${formatArchiveStamp(archivedAt)}-${safeFilePart(snapshot.profileName, 'user')}-${safeFilePart(snapshot.labels.title, 'today-bubble')}.md`;
  const archiveRoot = path.join(app.getPath('documents'), 'TodayBubble', 'Archives');
  const filePath = path.join(archiveRoot, filename);
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(filePath, buildArchiveMarkdown(snapshot, archivedAt), 'utf8');
  return {
    filePath,
    fileName: filename,
    archiveRoot,
    itemCount: snapshot.items.length
  };
});

app.on('before-quit', flushSave);

app.on('window-all-closed', () => {
  flushSave();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
