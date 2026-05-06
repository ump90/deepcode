const { StdioJsonRpcPeer, WebSocketJsonRpcPeer } = require('./codexJsonRpc');
const { CodexSessionManager } = require('./codexSessionManager');

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const sharedSessionManager = new CodexSessionManager();

function getRequestId(payload) {
  return payload.requestId || `request-${Date.now()}`;
}

function createMockPlan(message, settings) {
  return [
    '# DeepCode Mock 实施计划',
    '',
    `模型：${settings.model}`,
    `工作区：${settings.workspacePath}`,
    `Transport：${settings.transport}`,
    '',
    '## 需求理解',
    '',
    message || '未提供需求。',
    '',
    '## 建议步骤',
    '',
    '1. 明确目标范围与验收标准。',
    '2. 检查当前项目结构和关键入口文件。',
    '3. 分阶段实现最小可用闭环。',
    '4. 使用 stdio JSON-RPC 接入 `codex app-server`。',
    '5. 进行启动、设置保存、消息发送和计划保存验证。',
    '',
    '> 当前使用 mock agent。将 Transport 改为 stdio 后，主进程会启动 `codex app-server` 并使用 JSON-RPC 通信。',
  ].join('\n');
}

function emitEvent(emit, payload, event) {
  emit({
    requestId: getRequestId(payload),
    timestamp: Date.now(),
    ...event,
  });
}

function extractDelta(params) {
  if (!params) {
    return '';
  }

  return params.delta || params.text || params.content || params.chunk || '';
}

function formatPlanUpdate(plan) {
  if (!Array.isArray(plan)) {
    return '';
  }

  return plan.map((item) => `- [${item.status || 'pending'}] ${item.step || ''}`).join('\n');
}

function getTurnError(turn) {
  return turn?.error?.message || turn?.error?.codexErrorInfo?.type || 'Codex turn failed.';
}

function formatStatus(status) {
  if (!status) {
    return 'unknown';
  }

  if (typeof status === 'string') {
    return status;
  }

  return status.type || 'unknown';
}

function summarizeServerRequest(method) {
  const labels = {
    'item/commandExecution/requestApproval': '命令执行需要审批',
    'item/fileChange/requestApproval': '文件变更需要审批',
    'item/tool/requestUserInput': '工具需要用户输入',
    'item/permissions/requestApproval': '权限提升需要审批',
    'mcpServer/elicitation/request': 'MCP 工具需要用户确认',
    'item/tool/call': '动态工具调用需要客户端处理',
    applyPatchApproval: '补丁应用需要审批',
    execCommandApproval: '命令执行需要审批',
  };

  return labels[method] || `需要客户端处理：${method}`;
}

function getDefaultServerRequestResponse(method) {
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: 'decline' };
  }

  if (method === 'item/fileChange/requestApproval') {
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
      contentItems: [{ type: 'inputText', text: 'DeepCode V1 does not handle dynamic tool calls yet.' }],
      success: false,
    };
  }

  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return { decision: 'denied' };
  }

  return null;
}

async function initializePeer(peer) {
  const result = await peer.request('initialize', {
    clientInfo: {
      name: 'deepcode',
      title: 'DeepCode',
      version: '0.1.0',
    },
    capabilities: null,
  });
  peer.notify('initialized', {});
  return result;
}

function buildThreadParams(settings) {
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.workspacePath ? { cwd: settings.workspacePath } : {}),
    serviceName: 'deepcode',
  };
}

function buildTurnParams(payload, settings, threadId) {
  return {
    threadId,
    input: [{ type: 'text', text: payload.message, text_elements: [] }],
    ...(payload.model || settings.model ? { model: payload.model || settings.model } : {}),
    ...(payload.workspacePath || settings.workspacePath ? { cwd: payload.workspacePath || settings.workspacePath } : {}),
  };
}

async function createPeer(settings) {
  if (settings.transport === 'websocket') {
    const peer = new WebSocketJsonRpcPeer(settings);
    await peer.connect();
    return peer;
  }

  const peer = new StdioJsonRpcPeer(settings);
  await peer.connect();
  return peer;
}

async function startOrResumeThread(peer, payload, settings) {
  if (payload.conversationId) {
    try {
      const result = await peer.request('thread/resume', {
        threadId: payload.conversationId,
        ...buildThreadParams(settings),
      });
      return result.thread?.id || payload.conversationId;
    } catch (error) {
      const result = await peer.request('thread/start', buildThreadParams(settings));
      return result.thread?.id;
    }
  }

  const result = await peer.request('thread/start', buildThreadParams(settings));
  return result.thread?.id;
}

async function waitForTurn(peer, payload, emit) {
  let activeTurnId = null;
  let streamedAgentText = '';
  let finalAgentText = '';
  let streamedPlanText = '';
  let finalPlanText = '';
  let lastPlanUpdate = '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`turn/start timed out after ${TURN_TIMEOUT_MS}ms.`));
    }, TURN_TIMEOUT_MS);

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
      const response = getDefaultServerRequestResponse(message.method);
      const decision = response ? '已自动拒绝，等待后续审批 UI 接入' : '暂不支持';
      emitEvent(emit, payload, {
        type: 'serverRequest',
        label: `${summarizeServerRequest(message.method)}（${decision}）`,
        rawMethod: message.method,
        rawParams: message.params,
      });

      if (response) {
        peer.respond(message.id, response);
        return;
      }

      peer.respondError(message.id, -32601, 'DeepCode V1 does not handle this server request yet.');
    }

    function onNotification(message) {
      const { method, params } = message;

      if (method === 'turn/started') {
        activeTurnId = params?.turn?.id || activeTurnId;
        emitEvent(emit, payload, { type: 'event', label: 'Turn started' });
        return;
      }

      if (method === 'item/agentMessage/delta') {
        const delta = extractDelta(params);
        streamedAgentText += delta;
        emitEvent(emit, payload, { type: 'delta', delta, content: streamedAgentText });
        return;
      }

      if (method === 'item/plan/delta') {
        const delta = extractDelta(params);
        streamedPlanText += delta;
        emitEvent(emit, payload, { type: 'planDelta', delta, content: streamedPlanText });
        return;
      }

      if (method === 'turn/plan/updated') {
        lastPlanUpdate = formatPlanUpdate(params?.plan);
        emitEvent(emit, payload, { type: 'plan', content: lastPlanUpdate });
        return;
      }

      if (method === 'item/started') {
        const itemType = params?.item?.type || 'item';
        emitEvent(emit, payload, { type: 'event', label: `${itemType} started` });
        return;
      }

      if (method === 'item/completed') {
        const item = params?.item;
        if (item?.type === 'agentMessage' && item.text) {
          finalAgentText = item.text;
          emitEvent(emit, payload, { type: 'delta', delta: '', content: finalAgentText });
        }
        if (item?.type === 'plan' && item.text) {
          finalPlanText = item.text;
          emitEvent(emit, payload, { type: 'plan', content: finalPlanText });
        }
        emitEvent(emit, payload, { type: 'event', label: `${item?.type || 'item'} completed` });
        return;
      }

      if (method === 'item/commandExecution/outputDelta' || method === 'command/exec/outputDelta') {
        emitEvent(emit, payload, {
          type: 'event',
          label: method === 'command/exec/outputDelta' ? 'Standalone command output streamed' : 'Command output streamed',
        });
        return;
      }

      if (method === 'turn/diff/updated') {
        emitEvent(emit, payload, { type: 'event', label: 'Diff updated' });
        return;
      }

      if (method === 'thread/status/changed') {
        emitEvent(emit, payload, { type: 'event', label: `Thread status changed: ${formatStatus(params?.status)}` });
        return;
      }

      if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
        emitEvent(emit, payload, { type: 'event', label: 'Reasoning streamed' });
        return;
      }

      if (method === 'error') {
        cleanup();
        reject(new Error(params?.error?.message || 'Codex app-server emitted an error.'));
        return;
      }

      if (method === 'turn/completed') {
        const turn = params?.turn;
        const completedTurnId = turn?.id;
        if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
          return;
        }

        cleanup();
        if (turn?.status === 'failed') {
          reject(new Error(getTurnError(turn)));
          return;
        }

        const content = finalAgentText || streamedAgentText || finalPlanText || streamedPlanText || lastPlanUpdate || '(Codex 没有返回文本内容。)';
        resolve({
          turn,
          content,
          plan: finalPlanText || streamedPlanText || lastPlanUpdate || content,
        });
        return;
      }

      emitEvent(emit, payload, {
        type: 'event',
        label: `Codex event: ${method}`,
        rawMethod: method,
        rawParams: params,
      });
    }

    peer.on('notification', onNotification);
    peer.on('serverRequest', onServerRequest);
    peer.on('error', onError);
    peer.on('close', onError);
  });
}

async function sendJsonRpcMessage(payload, settings, emit) {
  const peer = await createPeer(settings);

  try {
    const initializeResult = await initializePeer(peer);
    emitEvent(emit, payload, {
      type: 'event',
      label: `Initialized ${initializeResult?.platformFamily || 'app-server'}`,
    });

    const threadId = await startOrResumeThread(peer, payload, settings);
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id.');
    }

    const completionPromise = waitForTurn(peer, payload, emit);
    let turnResult;
    try {
      turnResult = await peer.request('turn/start', buildTurnParams(payload, settings, threadId), {
        timeoutMs: 60000,
      });
    } catch (error) {
      completionPromise.catch(() => {});
      throw error;
    }
    emitEvent(emit, payload, {
      type: 'event',
      label: `Turn queued ${turnResult.turn?.id || ''}`.trim(),
    });

    const completed = await completionPromise;
    emitEvent(emit, payload, { type: 'done', label: 'Turn completed' });

    return {
      conversationId: threadId,
      turnId: completed.turn?.id || turnResult.turn?.id,
      content: completed.content,
      plan: completed.plan,
      transport: settings.transport,
      raw: {
        turn: completed.turn,
      },
    };
  } finally {
    peer.close();
  }
}

async function sendMessage(payload, settings, emit = () => {}) {
  return sharedSessionManager.sendMessage(payload, settings, emit);
}

async function testConnection(settings) {
  if (settings.transport === 'mock') {
    return { ok: true, message: '当前使用 mock agent，可直接联调界面。' };
  }

  let peer;
  try {
    if (settings.transport === 'websocket') {
      const healthUrl = settings.appServerUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/+$/, '');
      const response = await fetch(`${healthUrl}/readyz`);
      if (!response.ok) {
        return { ok: false, message: `WebSocket app-server 未就绪：${response.status} ${response.statusText}` };
      }
    }

    peer = await createPeer(settings);
    await initializePeer(peer);
    return { ok: true, message: `${settings.transport} app-server 初始化成功。` };
  } catch (error) {
    return {
      ok: false,
      message: `连接失败：${error.message}。请确认 Transport、命令、URL 和本机 Codex 权限配置。`,
    };
  } finally {
    if (peer) {
      peer.close();
    }
  }
}

module.exports = {
  sendMessage,
  testConnection,
};
