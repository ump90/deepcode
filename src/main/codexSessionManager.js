const { StdioJsonRpcPeer, WebSocketJsonRpcPeer } = require('./codexJsonRpc');

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const SERVER_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|bearer|password|secret|token)/i;

function getRequestId(payload = {}) {
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
    '3. 复用同一个 Codex app-server 会话连接。',
    '4. 在同一 thread 中连续多轮推进。',
    '5. 需要时支持 interrupt 和 steer。',
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

function getUnsupportedServerRequestResponse(method) {
  if (method === 'item/commandExecution/requestApproval') {
    return { decision: 'cancel' };
  }

  if (method === 'item/fileChange/requestApproval') {
    return { decision: 'cancel' };
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

function isInteractiveServerRequest(method) {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
  ].includes(method);
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:OPENAI_)?API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)(\s*[:=]\s*)(["']?)[^\s"']+/gi, '$1$2$3[redacted]');
}

function sanitizeForRenderer(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeForRenderer);
  }

  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactSensitiveText(value) : value;
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeForRenderer(child);
  }
  return result;
}

function parseWritableRoots(value, cwd) {
  const roots = String(value || '')
    .split(/[\r\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (roots.length) {
    return roots;
  }

  return cwd ? [cwd] : [];
}

function buildApprovalPolicy(settings) {
  const policy = settings.approvalPolicy || 'on-request';
  return ['untrusted', 'on-failure', 'on-request', 'never'].includes(policy) ? policy : 'on-request';
}

function buildSandboxMode(settings) {
  const mode = settings.sandboxPolicy || 'workspace-write';
  return ['read-only', 'workspace-write', 'danger-full-access'].includes(mode) ? mode : 'workspace-write';
}

function isNetworkEnabled(settings) {
  return settings.networkAccess === 'enabled' || settings.networkAccess === true;
}

function buildSandboxPolicy(settings, cwd) {
  const mode = buildSandboxMode(settings);
  if (mode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }

  if (mode === 'read-only') {
    return { type: 'readOnly', networkAccess: isNetworkEnabled(settings) };
  }

  return {
    type: 'workspaceWrite',
    writableRoots: parseWritableRoots(settings.writableRoots, cwd),
    networkAccess: isNetworkEnabled(settings),
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function commandLooksDestructive(command) {
  return /\b(rm\s+-rf|remove-item|del\s+\/[fsq]|rmdir\s+\/s|git\s+reset\s+--hard|git\s+clean\s+-fd|format\s+|diskpart)\b/i.test(command || '');
}

function extractFileChangeLabels(params = {}) {
  const candidates = [params.files, params.fileChanges, params.changes, params.paths].filter(Array.isArray).flat();
  return candidates
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      return entry?.path || entry?.file || entry?.targetPath || entry?.relativePath || '';
    })
    .filter(Boolean)
    .map(redactSensitiveText);
}

function buildApprovalDetails(requestId, method, params = {}) {
  const safeParams = sanitizeForRenderer(params);

  if (method === 'item/commandExecution/requestApproval') {
    const command = redactSensitiveText(params.command || '');
    return {
      id: requestId,
      kind: 'command',
      title: '命令执行审批',
      method,
      command,
      cwd: params.cwd || '',
      reason: params.reason || '',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      destructive: commandLooksDestructive(command),
      rawParams: safeParams,
    };
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      id: requestId,
      kind: 'fileChange',
      title: '文件变更审批',
      method,
      itemId: params.itemId || '',
      grantRoot: params.grantRoot || '',
      files: extractFileChangeLabels(params),
      reason: params.reason || '',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      rawParams: safeParams,
    };
  }

  return {
    id: requestId,
    kind: 'toolInput',
    title: '工具输入',
    method,
    questions: Array.isArray(params.questions) ? sanitizeForRenderer(params.questions) : [],
    availableDecisions: ['submit', 'cancel'],
    rawParams: safeParams,
  };
}

function buildTextInput(text) {
  return { type: 'text', text, text_elements: [] };
}

function buildThreadParams(settings) {
  const cwd = settings.workspacePath || '';
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(cwd ? { cwd } : {}),
    approvalPolicy: buildApprovalPolicy(settings),
    sandbox: buildSandboxMode(settings),
    serviceName: 'deepcode',
  };
}

function buildTurnParams(payload, settings, threadId) {
  const cwd = payload.workspacePath || settings.workspacePath || '';
  return {
    threadId,
    input: [buildTextInput(payload.message)],
    ...(payload.model || settings.model ? { model: payload.model || settings.model } : {}),
    ...(cwd ? { cwd } : {}),
    approvalPolicy: buildApprovalPolicy(settings),
    sandboxPolicy: buildSandboxPolicy(settings, cwd),
  };
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

function getSettingsFingerprint(settings) {
  return JSON.stringify({
    transport: settings.transport,
    appServerCommand: settings.appServerCommand,
    appServerArgs: settings.appServerArgs,
    appServerUrl: settings.appServerUrl,
    apiKeyPresent: Boolean(settings.apiKey),
    workspacePath: settings.workspacePath,
    approvalPolicy: settings.approvalPolicy,
    sandboxPolicy: settings.sandboxPolicy,
    networkAccess: settings.networkAccess,
    writableRoots: settings.writableRoots,
  });
}

function normalizeThread(thread) {
  if (!thread) {
    return null;
  }

  return {
    id: thread.id,
    name: thread.name || '',
    preview: thread.preview || '',
    cwd: thread.cwd || '',
    createdAt: thread.createdAt || null,
    updatedAt: thread.updatedAt || thread.createdAt || null,
    status: formatStatus(thread.status),
    modelProvider: thread.modelProvider || '',
  };
}

class CodexSessionManager {
  constructor() {
    this.peer = null;
    this.peerFingerprint = '';
    this.initializeResult = null;
    this.activeThreadId = null;
    this.activeTurnId = null;
    this.activeTurnState = null;
    this.turnStates = new Map();
    this.pendingServerRequests = new Map();
    this.serverRequestCounter = 1;

    this.onNotification = this.onNotification.bind(this);
    this.onServerRequest = this.onServerRequest.bind(this);
    this.onPeerError = this.onPeerError.bind(this);
    this.onPeerClose = this.onPeerClose.bind(this);
  }

  async ensurePeer(settings) {
    if (settings.transport === 'mock') {
      return null;
    }

    const fingerprint = getSettingsFingerprint(settings);
    if (this.peer && !this.peer.closed && this.peerFingerprint === fingerprint) {
      return this.peer;
    }

    this.closePeer();
    this.peer = await createPeer(settings);
    this.peerFingerprint = fingerprint;
    this.peer.on('notification', this.onNotification);
    this.peer.on('serverRequest', this.onServerRequest);
    this.peer.on('error', this.onPeerError);
    this.peer.on('close', this.onPeerClose);
    this.initializeResult = await initializePeer(this.peer);
    return this.peer;
  }

  closePeer() {
    if (!this.peer) {
      return;
    }

    this.rejectActiveTurns(new Error('Codex session closed.'));
    this.peer.off('notification', this.onNotification);
    this.peer.off('serverRequest', this.onServerRequest);
    this.peer.off('error', this.onPeerError);
    this.peer.off('close', this.onPeerClose);
    this.peer.close();
    this.peer = null;
    this.peerFingerprint = '';
    this.initializeResult = null;
    this.activeTurnId = null;
    this.activeTurnState = null;
    this.turnStates.clear();
    this.cancelPendingServerRequests();
  }

  close() {
    this.closePeer();
  }

  onPeerError(error) {
    this.rejectActiveTurns(error);
  }

  onPeerClose(error) {
    this.rejectActiveTurns(error || new Error('JSON-RPC connection closed.'));
    this.peer = null;
    this.peerFingerprint = '';
    this.initializeResult = null;
  }

  rejectActiveTurns(error) {
    const states = new Set(this.turnStates.values());
    if (this.activeTurnState) {
      states.add(this.activeTurnState);
    }

    for (const state of states) {
      this.cleanupTurnState(state);
      state.reject(error);
    }
  }

  cleanupTurnState(state) {
    clearTimeout(state.timer);
    this.cancelPendingServerRequestsForState(state);
    if (state.turnId) {
      this.turnStates.delete(state.turnId);
    }
    if (this.activeTurnState === state) {
      this.activeTurnState = null;
    }
    if (this.activeTurnId === state.turnId) {
      this.activeTurnId = null;
    }
  }

  registerTurnId(state, turnId) {
    if (!turnId || state.turnId === turnId) {
      return;
    }

    if (state.turnId) {
      this.turnStates.delete(state.turnId);
    }

    state.turnId = turnId;
    this.activeTurnId = turnId;
    this.turnStates.set(turnId, state);
  }

  findTurnState(params = {}) {
    if (params.turnId && this.turnStates.has(params.turnId)) {
      return this.turnStates.get(params.turnId);
    }

    if (this.activeTurnState && (!params.threadId || params.threadId === this.activeTurnState.threadId)) {
      return this.activeTurnState;
    }

    return null;
  }

  createTurnState(payload, threadId, emit) {
    const state = {
      payload,
      emit,
      threadId,
      turnId: null,
      streamedAgentText: '',
      finalAgentText: '',
      streamedPlanText: '',
      finalPlanText: '',
      lastPlanUpdate: '',
      timer: null,
      resolve: null,
      reject: null,
      promise: null,
      pendingServerRequestIds: new Set(),
    };

    state.promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
      state.timer = setTimeout(() => {
        this.cleanupTurnState(state);
        reject(new Error(`turn/start timed out after ${TURN_TIMEOUT_MS}ms.`));
      }, TURN_TIMEOUT_MS);
    });

    this.activeTurnState = state;
    return state;
  }

  emitTurnEvent(state, event) {
    if (!state) {
      return;
    }
    emitEvent(state.emit, state.payload, event);
  }

  onServerRequest(message) {
    const state = this.findTurnState(message.params);

    if (isInteractiveServerRequest(message.method) && state) {
      const approvalRequestId = `approval-${Date.now()}-${this.serverRequestCounter}`;
      this.serverRequestCounter += 1;
      const approval = buildApprovalDetails(approvalRequestId, message.method, message.params);
      const timer = setTimeout(() => {
        this.resolvePendingServerRequest(approvalRequestId, { decision: 'cancel', answers: {} }, true);
      }, SERVER_REQUEST_TIMEOUT_MS);

      this.pendingServerRequests.set(approvalRequestId, {
        id: approvalRequestId,
        rpcId: message.id,
        method: message.method,
        state,
        timer,
      });
      state.pendingServerRequestIds.add(approvalRequestId);

      this.emitTurnEvent(state, {
        type: 'approvalRequired',
        label: summarizeServerRequest(message.method),
        rawMethod: message.method,
        rawParams: approval.rawParams,
        approval,
      });
      return;
    }

    const response = getUnsupportedServerRequestResponse(message.method);
    const decision = response ? '已安全取消' : '暂不支持';

    this.emitTurnEvent(state, {
      type: 'serverRequest',
      label: `${summarizeServerRequest(message.method)}（${decision}）`,
      rawMethod: message.method,
      rawParams: message.params,
    });

    if (response) {
      this.peer.respond(message.id, response);
      return;
    }

    this.peer.respondError(message.id, -32601, 'DeepCode V1 does not handle this server request yet.');
  }

  buildServerRequestResponse(pending, resolution = {}) {
    if (pending.method === 'item/tool/requestUserInput') {
      return { answers: resolution.answers || {} };
    }

    const available = pending.method === 'item/commandExecution/requestApproval'
      ? new Set(['accept', 'acceptForSession', 'decline', 'cancel'])
      : new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    const decision = available.has(resolution.decision) ? resolution.decision : 'cancel';
    return { decision };
  }

  respondToPendingServerRequest(pending, response) {
    clearTimeout(pending.timer);
    this.pendingServerRequests.delete(pending.id);
    pending.state?.pendingServerRequestIds?.delete(pending.id);

    try {
      if (this.peer && !this.peer.closed) {
        this.peer.respond(pending.rpcId, response);
      }
    } catch (error) {
      this.emitTurnEvent(pending.state, { type: 'event', label: `审批响应失败：${error.message}` });
    }
  }

  resolvePendingServerRequest(approvalRequestId, resolution = {}, isTimeout = false) {
    const pending = this.pendingServerRequests.get(approvalRequestId);
    if (!pending) {
      throw new Error('审批请求已结束或不存在。');
    }

    const response = this.buildServerRequestResponse(pending, resolution);
    this.respondToPendingServerRequest(pending, response);
    this.emitTurnEvent(pending.state, {
      type: 'approvalResolved',
      label: isTimeout ? '审批超时，已取消' : `审批已响应：${response.decision || 'submitted'}`,
      approvalId: approvalRequestId,
    });
    return { ok: true, response };
  }

  cancelPendingServerRequestsForState(state) {
    if (!state?.pendingServerRequestIds?.size) {
      return;
    }

    for (const requestId of [...state.pendingServerRequestIds]) {
      const pending = this.pendingServerRequests.get(requestId);
      if (!pending) {
        state.pendingServerRequestIds.delete(requestId);
        continue;
      }
      const response = this.buildServerRequestResponse(pending, { decision: 'cancel', answers: {} });
      this.respondToPendingServerRequest(pending, response);
    }
  }

  cancelPendingServerRequests() {
    for (const pending of [...this.pendingServerRequests.values()]) {
      const response = this.buildServerRequestResponse(pending, { decision: 'cancel', answers: {} });
      this.respondToPendingServerRequest(pending, response);
    }
  }

  onNotification(message) {
    const { method, params } = message;
    const state = this.findTurnState(params);

    if (method === 'turn/started') {
      if (state) {
        this.registerTurnId(state, params?.turn?.id);
      }
      this.emitTurnEvent(state, {
        type: 'turnStarted',
        label: 'Turn started',
        turnId: params?.turn?.id || state?.turnId || null,
      });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const delta = extractDelta(params);
      if (state) {
        state.streamedAgentText += delta;
      }
      this.emitTurnEvent(state, { type: 'delta', delta, content: state?.streamedAgentText || delta });
      return;
    }

    if (method === 'item/plan/delta') {
      const delta = extractDelta(params);
      if (state) {
        state.streamedPlanText += delta;
      }
      this.emitTurnEvent(state, { type: 'planDelta', delta, content: state?.streamedPlanText || delta });
      return;
    }

    if (method === 'turn/plan/updated') {
      if (state) {
        state.lastPlanUpdate = formatPlanUpdate(params?.plan);
      }
      this.emitTurnEvent(state, { type: 'plan', content: state?.lastPlanUpdate || '' });
      return;
    }

    if (method === 'item/started') {
      const itemType = params?.item?.type || 'item';
      this.emitTurnEvent(state, { type: 'event', label: `${itemType} started` });
      return;
    }

    if (method === 'item/completed') {
      const item = params?.item;
      if (state && item?.type === 'agentMessage' && item.text) {
        state.finalAgentText = item.text;
        this.emitTurnEvent(state, { type: 'delta', delta: '', content: state.finalAgentText });
      }
      if (state && item?.type === 'plan' && item.text) {
        state.finalPlanText = item.text;
        this.emitTurnEvent(state, { type: 'plan', content: state.finalPlanText });
      }
      this.emitTurnEvent(state, { type: 'event', label: `${item?.type || 'item'} completed` });
      return;
    }

    if (method === 'item/commandExecution/outputDelta' || method === 'command/exec/outputDelta') {
      this.emitTurnEvent(state, {
        type: 'event',
        label: method === 'command/exec/outputDelta' ? 'Standalone command output streamed' : 'Command output streamed',
      });
      return;
    }

    if (method === 'turn/diff/updated') {
      this.emitTurnEvent(state, { type: 'event', label: 'Diff updated' });
      return;
    }

    if (method === 'thread/status/changed') {
      this.emitTurnEvent(state, { type: 'event', label: `Thread status changed: ${formatStatus(params?.status)}` });
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.emitTurnEvent(state, { type: 'event', label: 'Reasoning streamed' });
      return;
    }

    if (method === 'error') {
      const error = new Error(params?.error?.message || 'Codex app-server emitted an error.');
      if (state) {
        this.cleanupTurnState(state);
        state.reject(error);
      }
      return;
    }

    if (method === 'turn/completed') {
      if (!state) {
        return;
      }

      const turn = params?.turn;
      this.registerTurnId(state, turn?.id);
      this.cleanupTurnState(state);
      if (turn?.status === 'failed') {
        state.reject(new Error(getTurnError(turn)));
        return;
      }

      const content =
        state.finalAgentText ||
        state.streamedAgentText ||
        state.finalPlanText ||
        state.streamedPlanText ||
        state.lastPlanUpdate ||
        '(Codex 没有返回文本内容。)';
      state.resolve({
        turn,
        content,
        plan: state.finalPlanText || state.streamedPlanText || state.lastPlanUpdate || content,
      });
      return;
    }

    this.emitTurnEvent(state, {
      type: 'event',
      label: `Codex event: ${method}`,
      rawMethod: method,
      rawParams: params,
    });
  }

  async startThread(settings, params = {}) {
    const peer = await this.ensurePeer(settings);
    const result = await peer.request('thread/start', {
      ...buildThreadParams(settings),
      ...params,
    });
    this.activeThreadId = result.thread?.id || null;
    return {
      conversationId: this.activeThreadId,
      thread: normalizeThread(result.thread),
      raw: result,
    };
  }

  async startOrResumeThread(peer, payload, settings) {
    const requestedThreadId = payload.conversationId || this.activeThreadId;
    if (requestedThreadId) {
      try {
        const result = await peer.request('thread/resume', {
          threadId: requestedThreadId,
          ...buildThreadParams(settings),
        });
        this.activeThreadId = result.thread?.id || requestedThreadId;
        return this.activeThreadId;
      } catch (error) {
        const result = await peer.request('thread/start', buildThreadParams(settings));
        this.activeThreadId = result.thread?.id || null;
        return this.activeThreadId;
      }
    }

    const result = await peer.request('thread/start', buildThreadParams(settings));
    this.activeThreadId = result.thread?.id || null;
    return this.activeThreadId;
  }

  async sendMessage(payload, settings, emit = () => {}) {
    if (!payload.message || !payload.message.trim()) {
      throw new Error('消息不能为空。');
    }

    if (settings.transport === 'mock') {
      const content = createMockPlan(payload.message, settings);
      emitEvent(emit, payload, { type: 'done', label: 'Mock turn completed' });
      return {
        conversationId: payload.conversationId || `mock-${Date.now()}`,
        content,
        plan: content,
        isMock: true,
        transport: 'mock',
      };
    }

    if (this.activeTurnState) {
      throw new Error('当前会话仍在运行，请先取消或追加输入。');
    }

    const peer = await this.ensurePeer(settings);
    emitEvent(emit, payload, {
      type: 'event',
      label: `Initialized ${this.initializeResult?.platformFamily || 'app-server'}`,
    });

    const threadId = await this.startOrResumeThread(peer, payload, settings);
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id.');
    }

    const state = this.createTurnState(payload, threadId, emit);
    let turnResult;
    try {
      turnResult = await peer.request('turn/start', buildTurnParams(payload, settings, threadId), {
        timeoutMs: 60000,
      });
    } catch (error) {
      this.cleanupTurnState(state);
      throw error;
    }

    this.registerTurnId(state, turnResult.turn?.id);
    emitEvent(emit, payload, {
      type: 'turnQueued',
      label: `Turn queued ${turnResult.turn?.id || ''}`.trim(),
      conversationId: threadId,
      turnId: turnResult.turn?.id || null,
    });

    const completed = await state.promise;
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
  }

  async listThreads(settings, options = {}) {
    if (settings.transport === 'mock') {
      return { threads: [], nextCursor: null, isMock: true };
    }

    const peer = await this.ensurePeer(settings);
    const result = await peer.request('thread/list', {
      cursor: options.cursor || null,
      limit: options.limit || 30,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
      cwd: settings.workspacePath || null,
    });

    return {
      threads: (result.data || []).map(normalizeThread).filter(Boolean),
      nextCursor: result.nextCursor || null,
    };
  }

  async resumeThread(settings, payload = {}) {
    const threadId = payload.threadId || payload.conversationId;
    if (!threadId) {
      throw new Error('threadId 不能为空。');
    }

    if (settings.transport === 'mock') {
      this.activeThreadId = threadId;
      return { conversationId: threadId, isMock: true };
    }

    const peer = await this.ensurePeer(settings);
    const result = await peer.request('thread/resume', {
      threadId,
      ...buildThreadParams(settings),
    });
    this.activeThreadId = result.thread?.id || threadId;

    return {
      conversationId: this.activeThreadId,
      thread: normalizeThread(result.thread),
      raw: result,
    };
  }

  async readThread(settings, payload = {}) {
    const threadId = payload.threadId || payload.conversationId || this.activeThreadId;
    if (!threadId) {
      throw new Error('threadId 不能为空。');
    }

    if (settings.transport === 'mock') {
      return { conversationId: threadId, isMock: true };
    }

    const peer = await this.ensurePeer(settings);
    const result = await peer.request('thread/read', {
      threadId,
      includeTurns: Boolean(payload.includeTurns),
    });

    return {
      conversationId: result.thread?.id || threadId,
      thread: normalizeThread(result.thread),
      raw: result,
    };
  }

  async unsubscribeThread(settings, payload = {}) {
    const threadId = payload.threadId || payload.conversationId || this.activeThreadId;
    if (!threadId) {
      return { ok: true, skipped: true };
    }

    if (settings.transport === 'mock') {
      if (this.activeThreadId === threadId) {
        this.activeThreadId = null;
      }
      return { ok: true, isMock: true };
    }

    const peer = await this.ensurePeer(settings);
    const result = await peer.request('thread/unsubscribe', { threadId });
    if (this.activeThreadId === threadId) {
      this.activeThreadId = null;
    }
    return { ok: true, result };
  }

  async interruptTurn(settings, payload = {}) {
    const peer = await this.ensurePeer(settings);
    const state = this.activeTurnState;
    const threadId = payload.threadId || payload.conversationId || state?.threadId || this.activeThreadId;
    const turnId = payload.turnId || state?.turnId || this.activeTurnId;

    if (!threadId || !turnId) {
      throw new Error('当前没有可取消的 turn。');
    }

    const result = await peer.request('turn/interrupt', { threadId, turnId });
    this.emitTurnEvent(state, { type: 'event', label: 'Turn interrupt requested' });
    return { ok: true, conversationId: threadId, turnId, result };
  }

  async steerTurn(settings, payload = {}) {
    const message = String(payload.message || '').trim();
    if (!message) {
      throw new Error('追加输入不能为空。');
    }

    const peer = await this.ensurePeer(settings);
    const state = this.activeTurnState;
    const threadId = payload.threadId || payload.conversationId || state?.threadId || this.activeThreadId;
    const turnId = payload.turnId || state?.turnId || this.activeTurnId;

    if (!threadId || !turnId) {
      throw new Error('当前没有可追加输入的 turn。');
    }

    const result = await peer.request('turn/steer', {
      threadId,
      input: [buildTextInput(message)],
      expectedTurnId: turnId,
    });
    this.emitTurnEvent(state, { type: 'event', label: 'Steer input sent' });
    return { ok: true, conversationId: threadId, turnId, result };
  }

  async resolveApproval(_settings, payload = {}) {
    const approvalRequestId = payload.approvalId || payload.id;
    if (!approvalRequestId) {
      throw new Error('approvalId 不能为空。');
    }

    return this.resolvePendingServerRequest(approvalRequestId, {
      decision: payload.decision,
      answers: payload.answers,
    });
  }
}

module.exports = {
  CodexSessionManager,
};
