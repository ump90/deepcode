const fs = require('fs/promises');
const path = require('path');

function createPlanContent(payload, settings) {
  return [
    '# Agent Plan',
    '',
    `- Time: ${new Date().toLocaleString()}`,
    `- Model: ${payload.model || settings.model}`,
    `- Workspace: ${payload.workspacePath || settings.workspacePath}`,
    `- Transport: ${payload.transport || settings.transport}`,
    `- Thread: ${payload.conversationId || payload.threadId || ''}`,
    `- Turn: ${payload.turnId || ''}`,
    '',
    '## User Request',
    '',
    payload.request || '',
    '',
    '## Agent Plan',
    '',
    payload.plan || '',
    '',
  ].join('\n');
}

async function savePlan(payload, settings) {
  const docsDir = path.join(settings.workspacePath || process.cwd(), 'docs');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const filePath = path.join(docsDir, `agent-plan-${stamp}.md`);

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(filePath, createPlanContent(payload, settings), 'utf8');

  return { filePath };
}

module.exports = {
  savePlan,
};
