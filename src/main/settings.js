const fs = require('fs/promises');
const path = require('path');

const DEFAULT_SETTINGS = {
  transport: 'mock',
  appServerCommand: 'codex',
  appServerArgs: 'app-server',
  appServerUrl: 'ws://127.0.0.1:4500',
  apiKey: '',
  model: 'gpt-5.4',
  workspacePath: '',
};

function parseArgs(value) {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }

  const source = String(value || '').trim();
  if (!source) {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function argsToString(value) {
  return parseArgs(value)
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(' ');
}

function inferTransport(settings) {
  if (['mock', 'stdio', 'websocket'].includes(settings.transport)) {
    return settings.transport;
  }

  const oldUrl = String(settings.appServerUrl || '');
  if (!oldUrl || oldUrl.startsWith('mock://')) {
    return 'mock';
  }

  return 'websocket';
}

function createSettingsStore({ app, defaultWorkspacePath }) {
  const defaults = {
    ...DEFAULT_SETTINGS,
    workspacePath: defaultWorkspacePath,
  };

  function getSettingsPath() {
    return path.join(app.getPath('userData'), 'settings.json');
  }

  function normalizeSettings(settings = {}) {
    const nextSettings = {
      ...defaults,
      ...settings,
    };

    nextSettings.transport = inferTransport(nextSettings);
    nextSettings.appServerCommand = String(nextSettings.appServerCommand || defaults.appServerCommand).trim();
    nextSettings.appServerArgs = argsToString(nextSettings.appServerArgs || defaults.appServerArgs);
    nextSettings.appServerUrl = String(nextSettings.appServerUrl || defaults.appServerUrl).trim();
    nextSettings.apiKey = String(nextSettings.apiKey || '').trim();
    nextSettings.model = String(nextSettings.model || defaults.model).trim();
    nextSettings.workspacePath = String(nextSettings.workspacePath || defaults.workspacePath).trim();

    return nextSettings;
  }

  async function readSettings() {
    try {
      const raw = await fs.readFile(getSettingsPath(), 'utf8');
      return normalizeSettings(JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Unable to read settings:', error.message);
      }
      return normalizeSettings(defaults);
    }
  }

  async function writeSettings(settings) {
    const nextSettings = normalizeSettings(settings);

    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(getSettingsPath(), JSON.stringify(nextSettings, null, 2), 'utf8');
    return nextSettings;
  }

  return {
    defaults,
    getSettingsPath,
    normalizeSettings,
    readSettings,
    writeSettings,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  argsToString,
  createSettingsStore,
  parseArgs,
};
