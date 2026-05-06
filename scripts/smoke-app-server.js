const { StdioJsonRpcPeer } = require('../src/main/codexJsonRpc');

const DEFAULT_TIMEOUT_MS = 180000;

function parseCliArgs(argv) {
  const options = {
    command: process.env.DEEPCODE_CODEX_COMMAND || process.env.CODEX_COMMAND || 'codex',
    args: process.env.DEEPCODE_CODEX_ARGS || 'app-server',
    cwd: process.env.DEEPCODE_WORKSPACE || process.cwd(),
    model: process.env.DEEPCODE_MODEL || 'gpt-5.4',
    message: 'Reply with exactly: deepcode-smoke-ok. Do not run commands or modify files.',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipTurn: false,
    json: false,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inlineValue] = raw.split(/=(.*)/s, 2);
    const nextValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      index += 1;
      return argv[index];
    };

    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }

    if (flag === '--skip-turn') {
      options.skipTurn = true;
      continue;
    }

    if (flag === '--json') {
      options.json = true;
      continue;
    }

    if (flag === '--verbose') {
      options.verbose = true;
      continue;
    }

    if (flag === '--command' || flag === '--app-server-command') {
      options.command = nextValue();
      continue;
    }

    if (flag === '--args' || flag === '--app-server-args') {
      options.args = nextValue();
      continue;
    }

    if (flag === '--cwd') {
      options.cwd = nextValue();
      continue;
    }

    if (flag === '--model') {
      options.model = nextValue();
      continue;
    }

    if (flag === '--message') {
      options.message = nextValue();
      continue;
    }

    if (flag === '--timeout-ms') {
      options.timeoutMs = Number(nextValue()) || DEFAULT_TIMEOUT_MS;
      continue;
    }

    throw new Error(`Unknown option: ${raw}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/smoke-app-server.js [options]

Options:
  --command <path>       Codex CLI command. Default: codex
  --args <args>          App-server args. Default: app-server
  --cwd <path>           Workspace cwd passed to app-server. Default: current directory
  --model <model>        Model used for thread/start and turn/start. Default: gpt-5.4
  --message <text>       Low-risk smoke prompt.
  --timeout-ms <ms>      Turn completion timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --skip-turn            Stop after initialize/account/read/model/list/thread/start
  --json                 Print machine-readable summary
  --verbose              Print observed notification and server request methods
`);
}

function createSettings(options) {
  return {
    transport: 'stdio',
    appServerCommand: options.command,
    appServerArgs: options.args,
    appServerUrl: 'ws://127.0.0.1:4500',
    apiKey: '',
    model: options.model,
    workspacePath: options.cwd,
  };
}

function accountSummary(response) {
  const account = response?.account;
  if (!account) {
    return response?.requiresOpenaiAuth ? 'not logged in' : 'no account returned';
  }

  if (account.type === 'chatgpt') {
    return `chatgpt ${account.planType || ''}`.trim();
  }

  return account.type || 'unknown account';
}

function modelSummary(response) {
  const models = Array.isArray(response?.data) ? response.data : [];
  const names = models.slice(0, 5).map((model) => model.model || model.id).filter(Boolean);
  return `${models.length} model(s)${names.length ? `: ${names.join(', ')}` : ''}`;
}

function createSafeServerResponse(method) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision: 'decline' };
  }

  if (method === 'item/tool/requestUserInput') {
    return { answers: {} };
  }

  if (method === 'mcpServer/elicitation/request') {
    return { action: 'decline', content: null, _meta: null };
  }

  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' };
  }

  if (method === 'item/tool/call') {
    return {
      contentItems: [{ type: 'inputText', text: 'Smoke test does not handle dynamic tool calls.' }],
      success: false,
    };
  }

  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return { decision: 'denied' };
  }

  return null;
}

function getTurnError(turn) {
  return turn?.error?.message || turn?.error?.codexErrorInfo?.type || 'turn failed';
}

function waitForTurn(peer, state, timeoutMs, observed) {
  let agentText = '';
  let finalText = '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`turn/completed timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      peer.off('notification', onNotification);
      peer.off('serverRequest', onServerRequest);
      peer.off('error', onError);
      peer.off('close', onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onServerRequest(message) {
      observed.serverRequests.push(message.method);
      const response = createSafeServerResponse(message.method);
      if (response) {
        peer.respond(message.id, response);
        return;
      }
      peer.respondError(message.id, -32601, 'Smoke test does not handle this server request.');
    }

    function onNotification(message) {
      observed.notifications.push(message.method);
      const { method, params } = message;

      if (method === 'item/agentMessage/delta') {
        agentText += params?.delta || '';
        return;
      }

      if (method === 'item/completed' && params?.item?.type === 'agentMessage' && params.item.text) {
        finalText = params.item.text;
        return;
      }

      if (method === 'error') {
        cleanup();
        reject(new Error(params?.error?.message || 'app-server emitted error notification'));
        return;
      }

      if (method === 'turn/completed') {
        const turn = params?.turn;
        if (state.turnId && turn?.id && state.turnId !== turn.id) {
          return;
        }

        cleanup();
        if (turn?.status === 'failed') {
          reject(new Error(getTurnError(turn)));
          return;
        }

        resolve({
          turn,
          text: finalText || agentText || '(no assistant text returned)',
        });
      }
    }

    peer.on('notification', onNotification);
    peer.on('serverRequest', onServerRequest);
    peer.on('error', onError);
    peer.on('close', onError);
  });
}

function classifyFailure(step, error) {
  const message = error?.message || String(error);

  if (/找不到 Codex CLI|ENOENT|not found/i.test(message)) {
    return `CLI 不存在或不可启动：${message}`;
  }

  if (/未登录|not logged|requiresOpenaiAuth|authentication|login|auth/i.test(message)) {
    return `Codex 未登录或认证不可用：${message}`;
  }

  if (step === 'initialize') {
    return `初始化失败：${message}`;
  }

  if (step === 'turn/start' || step === 'turn/completed') {
    return `turn 失败：${message}`;
  }

  return `${step} 失败：${message}`;
}

async function runStep(summary, name, action, describe) {
  try {
    const result = await action();
    const details = describe ? describe(result) : '';
    summary.steps.push({ name, ok: true, ...(details ? { details } : {}) });
    if (!summary.json) {
      console.log(`[ok] ${name}${details ? `: ${details}` : ''}`);
    }
    return result;
  } catch (error) {
    const diagnostic = classifyFailure(name, error);
    summary.steps.push({ name, ok: false, error: diagnostic });
    throw new Error(diagnostic);
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const settings = createSettings(options);
  const observed = {
    notifications: [],
    serverRequests: [],
  };
  const summary = {
    ok: false,
    json: options.json,
    command: settings.appServerCommand,
    args: settings.appServerArgs,
    cwd: settings.workspacePath,
    model: settings.model,
    steps: [],
    observed,
  };

  let peer;
  try {
    try {
      peer = new StdioJsonRpcPeer(settings);
      await peer.connect();
      summary.steps.push({ name: 'connect', ok: true });
      if (!options.json) {
        console.log('[ok] connect');
      }
    } catch (error) {
      const diagnostic = classifyFailure('connect', error);
      summary.steps.push({ name: 'connect', ok: false, error: diagnostic });
      throw new Error(diagnostic);
    }

    const initializeResult = await runStep(
      summary,
      'initialize',
      () => peer.request('initialize', {
        clientInfo: {
          name: 'deepcode-smoke',
          title: 'DeepCode Smoke',
          version: '0.1.0',
        },
        capabilities: null,
      }),
      (result) => `${result.userAgent || 'app-server'} · ${result.platformOs || result.platformFamily || 'unknown platform'}`,
    );
    peer.notify('initialized', {});
    summary.initialize = {
      userAgent: initializeResult.userAgent,
      platformFamily: initializeResult.platformFamily,
      platformOs: initializeResult.platformOs,
    };

    const account = await runStep(
      summary,
      'account/read',
      () => peer.request('account/read', { refreshToken: false }),
      accountSummary,
    );
    summary.account = accountSummary(account);
    summary.requiresOpenaiAuth = Boolean(account?.requiresOpenaiAuth);

    if (account?.requiresOpenaiAuth && !account?.account) {
      throw new Error('Codex 未登录或需要 OpenAI 认证。请先运行 `codex login`，或在环境中配置可用认证后重试。');
    }

    const models = await runStep(
      summary,
      'model/list',
      () => peer.request('model/list', { limit: 20, includeHidden: false }),
      modelSummary,
    );
    summary.modelCount = Array.isArray(models?.data) ? models.data.length : 0;

    const threadResult = await runStep(
      summary,
      'thread/start',
      () => peer.request('thread/start', {
        model: settings.model,
        cwd: settings.workspacePath,
        serviceName: 'deepcode-smoke',
        ephemeral: true,
      }),
      (result) => result.thread?.id || '(no thread id)',
    );
    summary.threadId = threadResult.thread?.id || null;

    if (!options.skipTurn) {
      const turnState = { turnId: null };
      const completionPromise = waitForTurn(peer, turnState, options.timeoutMs, observed);
      const turnResult = await runStep(
        summary,
        'turn/start',
        () => peer.request('turn/start', {
          threadId: summary.threadId,
          input: [{ type: 'text', text: options.message, text_elements: [] }],
          cwd: settings.workspacePath,
          model: settings.model,
        }, { timeoutMs: 60000 }),
        (result) => result.turn?.id || '(no turn id)',
      );
      turnState.turnId = turnResult.turn?.id || null;
      summary.turnId = turnState.turnId;

      const completed = await runStep(
        summary,
        'turn/completed',
        () => completionPromise,
        (result) => `${result.turn?.status || 'unknown'} · ${String(result.text || '').slice(0, 80)}`,
      );
      summary.turnStatus = completed.turn?.status || null;
      summary.assistantText = completed.text;
    }

    summary.ok = true;
    if (options.verbose && !options.json) {
      console.log(`[info] notifications: ${observed.notifications.join(', ') || '(none)'}`);
      console.log(`[info] serverRequests: ${observed.serverRequests.join(', ') || '(none)'}`);
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error.message;
    if (!options.json) {
      console.error(`[fail] ${error.message}`);
    }
    process.exitCode = 1;
  } finally {
    if (peer) {
      peer.close();
    }
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
