const { CodexSessionManager } = require('../src/main/codexSessionManager');

function parseCliArgs(argv) {
  const options = {
    command: process.env.DEEPCODE_CODEX_COMMAND || process.env.CODEX_COMMAND || 'codex',
    args: process.env.DEEPCODE_CODEX_ARGS || 'app-server',
    cwd: process.env.DEEPCODE_WORKSPACE || process.cwd(),
    model: process.env.DEEPCODE_MODEL || 'gpt-5.4',
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

    throw new Error(`Unknown option: ${raw}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/smoke-session-manager.js [options]

Options:
  --command <path>  Codex CLI command. Default: codex
  --args <args>     App-server args. Default: app-server
  --cwd <path>      Workspace cwd. Default: current directory
  --model <model>   Model used for both turns. Default: gpt-5.4
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

function createRequestId(label) {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const manager = new CodexSessionManager();
  const settings = createSettings(options);
  const events = [];
  const emit = (event) => events.push(event);

  try {
    const first = await manager.sendMessage(
      {
        requestId: createRequestId('first'),
        message: 'Reply with exactly: session-smoke-one. Do not run commands or modify files.',
        model: settings.model,
        workspacePath: settings.workspacePath,
      },
      settings,
      emit,
    );
    console.log(`[ok] first turn: ${first.turnId} · ${String(first.content || '').trim()}`);

    const second = await manager.sendMessage(
      {
        requestId: createRequestId('second'),
        conversationId: first.conversationId,
        message: 'Reply with exactly: session-smoke-two. Do not run commands or modify files.',
        model: settings.model,
        workspacePath: settings.workspacePath,
      },
      settings,
      emit,
    );
    console.log(`[ok] second turn: ${second.turnId} · ${String(second.content || '').trim()}`);

    if (first.conversationId !== second.conversationId) {
      throw new Error(`Expected same thread id, got ${first.conversationId} and ${second.conversationId}`);
    }
    console.log(`[ok] same thread reused: ${second.conversationId}`);

    const threads = await manager.listThreads(settings, { limit: 10 });
    const found = threads.threads.some((thread) => thread.id === second.conversationId);
    console.log(`[ok] thread/list returned ${threads.threads.length} thread(s)${found ? ' and includes smoke thread' : ''}`);
    console.log(`[ok] observed ${events.length} renderer event(s)`);
  } finally {
    manager.close();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error.message}`);
  process.exitCode = 1;
});
