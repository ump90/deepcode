const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('./settings');

const REQUEST_TIMEOUT_MS = 30000;
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1', ''];
const WINDOWS_SHELL_EXTENSIONS = new Set(['.cmd', '.bat', '']);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stripWrappingQuotes(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function pathExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (error) {
    return false;
  }
}

function unique(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalized = process.platform === 'win32' ? String(value).toLowerCase() : String(value);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(value);
  }

  return result;
}

function getPathKey(env) {
  if (process.platform !== 'win32') {
    return 'PATH';
  }

  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
}

function splitPathEnv(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getWindowsAppCodexDirs(env) {
  if (process.platform !== 'win32') {
    return [];
  }

  const roots = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'WindowsApps') : '',
  ];
  const dirs = [];

  for (const root of roots) {
    if (!dirExists(root)) {
      continue;
    }

    dirs.push(root);

    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith('openai.codex_')) {
          dirs.push(path.join(root, entry.name, 'app', 'resources'));
        }
      }
    } catch (error) {
      // WindowsApps is often access-restricted; PATH aliases above may still work.
    }
  }

  return dirs;
}

function getLikelyExecutableDirs(env, cwd) {
  const cwdRoot = path.parse(cwd || process.cwd()).root;
  const dirs = [
    path.join(cwd || process.cwd(), 'node_modules', '.bin'),
    env.APPDATA ? path.join(env.APPDATA, 'npm') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'pnpm') : '',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs') : '',
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'nodejs') : '',
    cwdRoot ? path.join(cwdRoot, 'SDK', 'npm-global') : '',
    ...getWindowsAppCodexDirs(env),
  ];

  return unique(dirs.filter(dirExists));
}

function getSearchDirs(env, cwd) {
  const pathKey = getPathKey(env);
  return unique([...splitPathEnv(env[pathKey]), ...getLikelyExecutableDirs(env, cwd)]);
}

function buildEnvWithResolvedPath(env, cwd) {
  const nextEnv = { ...env };
  const searchDirs = getSearchDirs(nextEnv, cwd);
  const pathKey = process.platform === 'win32' ? 'Path' : getPathKey(nextEnv);

  if (process.platform === 'win32') {
    for (const key of Object.keys(nextEnv)) {
      if (key.toLowerCase() === 'path') {
        delete nextEnv[key];
      }
    }
  }

  nextEnv[pathKey] = searchDirs.join(path.delimiter);
  return nextEnv;
}

function getExecutableCandidates(command) {
  if (process.platform !== 'win32') {
    return [command];
  }

  if (path.extname(command)) {
    return [command];
  }

  return WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${command}${extension}`);
}

function commandHasPathSeparator(command) {
  return /[\\/]/.test(command) || path.isAbsolute(command);
}

function resolveCommand(command, env, cwd) {
  const rawCommand = stripWrappingQuotes(command || 'codex');
  const searched = [];

  if (commandHasPathSeparator(rawCommand)) {
    const basePath = path.isAbsolute(rawCommand) ? rawCommand : path.resolve(cwd, rawCommand);

    for (const candidate of getExecutableCandidates(basePath)) {
      searched.push(candidate);
      if (pathExists(candidate)) {
        return { command: candidate, found: true, searched };
      }
    }

    return { command: basePath, found: false, searched };
  }

  for (const dir of getSearchDirs(env, cwd)) {
    for (const candidateName of getExecutableCandidates(rawCommand)) {
      const candidate = path.join(dir, candidateName);
      searched.push(candidate);
      if (pathExists(candidate)) {
        return { command: candidate, found: true, searched };
      }
    }
  }

  return { command: rawCommand, found: false, searched };
}

function createCommandNotFoundError(command, resolution) {
  const preview = resolution.searched.slice(0, 10).join('; ');
  const suffix = preview ? ` 已检查：${preview}${resolution.searched.length > 10 ? ' ...' : ''}` : '';
  return new Error(`找不到 Codex CLI 命令 "${command}"。请在设置里填写 codex.exe/codex.cmd 的完整路径，或把 Codex 安装目录加入系统 PATH。${suffix}`);
}

function enrichSpawnError(error, command, resolution) {
  if (!['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(error.code)) {
    return error;
  }

  const searched = resolution?.searched?.length ? ` 已检查：${resolution.searched.slice(0, 10).join('; ')}${resolution.searched.length > 10 ? ' ...' : ''}` : '';
  const message = `无法启动 Codex CLI "${command}"：${error.message}。请确认设置里的 Codex 命令指向可执行文件，例如 D:\\SDK\\npm-global\\codex.cmd 或 codex.exe。${searched}`;
  const nextError = new Error(message);
  nextError.code = error.code;
  nextError.cause = error;
  return nextError;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!text) {
    return '""';
  }

  return `"${text
    .replace(/%/g, '%%')
    .replace(/([&|<>^"])/g, '^$1')}"`;
}

function buildWindowsShellCommand(command, args) {
  return [command, ...args].map(quoteCmdArg).join(' ');
}

function buildLaunchConfig(command, args) {
  if (process.platform !== 'win32') {
    return { command, args, shell: false, displayCommand: command };
  }

  const extension = path.extname(command).toLowerCase();
  if (extension === '.ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
      shell: false,
      displayCommand: command,
    };
  }

  if (WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    return {
      command: buildWindowsShellCommand(command, args),
      args: [],
      shell: true,
      displayCommand: command,
    };
  }

  return {
    command,
    args,
    shell: false,
    displayCommand: command,
  };
}

function isLoopbackWebSocketUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch (error) {
    return false;
  }
}

class JsonRpcPeer extends EventEmitter {
  constructor() {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  request(method, params = {}, options = {}) {
    if (this.closed) {
      return Promise.reject(new Error('JSON-RPC connection is closed.'));
    }

    const id = this.nextId;
    this.nextId += 1;

    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    const payload = { method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });

      try {
        this.writeMessage(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      throw new Error('JSON-RPC connection is closed.');
    }

    this.writeMessage({ method, params });
  }

  respond(id, result = {}) {
    this.writeMessage({ id, result });
  }

  respondError(id, code, message) {
    this.writeMessage({ id, error: { code, message } });
  }

  writeMessage() {
    throw new Error('writeMessage must be implemented by subclasses.');
  }

  emitError(error) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  handleMessage(message) {
    if (hasOwn(message, 'id') && (hasOwn(message, 'result') || hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message || 'Unknown error'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && hasOwn(message, 'id')) {
      this.emit('serverRequest', message);
      return;
    }

    if (message.method) {
      this.emit('notification', message);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.rejectPending(new Error('JSON-RPC connection closed.'));
  }
}

class StdioJsonRpcPeer extends JsonRpcPeer {
  constructor(settings) {
    super();
    this.settings = settings;
    this.proc = null;
    this.stderr = '';
  }

  async connect() {
    const args = parseArgs(this.settings.appServerArgs || 'app-server');
    const cwd = this.settings.workspacePath || process.cwd();
    const env = buildEnvWithResolvedPath({
      ...process.env,
      ...(this.settings.apiKey ? { OPENAI_API_KEY: this.settings.apiKey } : {}),
    }, cwd);
    const requestedCommand = this.settings.appServerCommand || 'codex';
    const resolution = resolveCommand(requestedCommand, env, cwd);

    if (!resolution.found) {
      throw createCommandNotFoundError(requestedCommand, resolution);
    }

    const launch = buildLaunchConfig(resolution.command, args);

    try {
      this.proc = spawn(launch.command, launch.args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: launch.shell,
      });
    } catch (error) {
      throw enrichSpawnError(error, launch.displayCommand, resolution);
    }

    this.proc.on('error', (error) => {
      const launchError = enrichSpawnError(error, launch.displayCommand, resolution);

      this.closed = true;
      this.rejectPending(launchError);
      this.emitError(launchError);
    });

    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      const details = this.stderr.trim();
      const suffix = details ? ` ${details}` : '';
      const error = new Error(`codex app-server exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.${suffix}`);
      this.rejectPending(error);
      this.emit('close', error);
    });

    this.proc.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000);
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.emitError(new Error(`Unable to parse app-server JSON: ${error.message}`));
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      this.proc.once('error', (error) => {
        clearTimeout(timer);
        reject(enrichSpawnError(error, launch.displayCommand, resolution));
      });
      this.proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`codex app-server exited before initialization with code ${code}. ${this.stderr.trim()}`));
      });
    });
  }

  writeMessage(message) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('codex app-server stdin is not writable.');
    }

    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    super.close();

    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
  }
}

class WebSocketJsonRpcPeer extends JsonRpcPeer {
  constructor(settings) {
    super();
    this.settings = settings;
    this.socket = null;
  }

  connect() {
    if (typeof WebSocket !== 'function') {
      return Promise.reject(new Error('当前 Electron/Node 运行时不支持原生 WebSocket。'));
    }

    if (!isLoopbackWebSocketUrl(this.settings.appServerUrl) && !this.settings.apiKey) {
      return Promise.reject(new Error('WebSocket app-server 指向非 loopback 地址时必须配置认证信息。'));
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.settings.appServerUrl);
      this.socket = socket;

      const timer = setTimeout(() => {
        reject(new Error('WebSocket connection timed out.'));
        socket.close();
      }, REQUEST_TIMEOUT_MS);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });

      socket.addEventListener('message', (event) => {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch (error) {
          this.emitError(new Error(`Unable to parse app-server WebSocket JSON: ${error.message}`));
        }
      });

      socket.addEventListener('error', () => {
        const error = new Error('WebSocket connection failed.');
        this.rejectPending(error);
        reject(error);
      });

      socket.addEventListener('close', () => {
        this.closed = true;
        this.rejectPending(new Error('WebSocket connection closed.'));
      });
    });
  }

  writeMessage(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open.');
    }

    this.socket.send(JSON.stringify(message));
  }

  close() {
    super.close();

    if (this.socket) {
      this.socket.close();
    }
  }
}

module.exports = {
  StdioJsonRpcPeer,
  WebSocketJsonRpcPeer,
};
