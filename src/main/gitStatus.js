const { execFile } = require('child_process');

const GIT_TIMEOUT_MS = 30000;
const MAX_DIFF_CHARS = 180000;

function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function parseBranch(statusOutput) {
  const firstLine = statusOutput.split(/\r?\n/)[0] || '';
  if (!firstLine.startsWith('## ')) {
    return 'unknown';
  }

  const branch = firstLine.slice(3).split('...')[0].trim();
  return branch || 'HEAD';
}

function parseStatusFiles(statusOutput) {
  return statusOutput
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const indexStatus = line[0] || ' ';
      const worktreeStatus = line[1] || ' ';
      const rawPath = line.slice(3);
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
      return {
        path,
        status: `${indexStatus}${worktreeStatus}`.trim() || 'modified',
        label: describeStatus(indexStatus, worktreeStatus),
      };
    });
}

function describeStatus(indexStatus, worktreeStatus) {
  if (indexStatus === '?' || worktreeStatus === '?') return '未跟踪';
  if (indexStatus === 'A' || worktreeStatus === 'A') return '新增';
  if (indexStatus === 'D' || worktreeStatus === 'D') return '删除';
  if (indexStatus === 'R' || worktreeStatus === 'R') return '重命名';
  if (indexStatus === 'C' || worktreeStatus === 'C') return '复制';
  if (indexStatus === 'M' || worktreeStatus === 'M') return '修改';
  return '变更';
}

function parseNumstat(numstatOutput) {
  const stats = {
    insertions: 0,
    deletions: 0,
    files: 0,
  };

  for (const line of numstatOutput.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted] = line.split(/\t/);
    stats.files += 1;
    stats.insertions += added === '-' ? 0 : Number.parseInt(added, 10) || 0;
    stats.deletions += deleted === '-' ? 0 : Number.parseInt(deleted, 10) || 0;
  }

  return stats;
}

function mergeStats(...entries) {
  return entries.reduce((total, item) => ({
    insertions: total.insertions + item.insertions,
    deletions: total.deletions + item.deletions,
    files: total.files + item.files,
  }), { insertions: 0, deletions: 0, files: 0 });
}

function splitDiffByFile(diff) {
  const chunks = [];
  let current = [];

  for (const line of String(diff || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ') && current.length) {
      chunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }

  if (current.length && current.some((line) => line.startsWith('diff --git '))) {
    chunks.push(current.join('\n'));
  }

  return chunks;
}

async function renderDiffFiles(diff) {
  if (!diff || diff.length > MAX_DIFF_CHARS) {
    return { diffHtml: '', diffFiles: [] };
  }

  try {
    const { preloadPatchFile } = await import('@pierre/diffs/ssr');
    const rendered = await preloadPatchFile({
      patch: diff,
      options: {
        display: 'unified',
        theme: 'pierre-light',
        showLineNumbers: true,
        diffIndicator: 'classic',
        hunkSeparators: 'metadata',
        wrapLines: true,
      },
    });
    const rawFiles = splitDiffByFile(diff);
    const diffFiles = rendered.map((file, index) => ({
      path: file.fileDiff?.name || `file-${index + 1}`,
      insertions: file.fileDiff?.additionLines?.length || 0,
      deletions: file.fileDiff?.deletionLines?.length || 0,
      diff: rawFiles[index] || '',
      diffHtml: file.prerenderedHTML || '',
    }));
    return {
      diffHtml: diffFiles.map((file) => file.diffHtml).join('\n'),
      diffFiles,
    };
  } catch (error) {
    return { diffHtml: '', diffFiles: [] };
  }
}

async function readGitStatus(workspacePath) {
  const cwd = workspacePath || process.cwd();

  try {
    const [root, statusOutput, unstagedNumstat, stagedNumstat, unstagedDiff, stagedDiff] = await Promise.all([
      execGit(cwd, ['rev-parse', '--show-toplevel']),
      execGit(cwd, ['status', '--porcelain=v1', '-b']),
      execGit(cwd, ['diff', '--no-ext-diff', '--numstat', '--']),
      execGit(cwd, ['diff', '--cached', '--no-ext-diff', '--numstat', '--']),
      execGit(cwd, ['diff', '--no-ext-diff', '--']),
      execGit(cwd, ['diff', '--cached', '--no-ext-diff', '--']),
    ]);

    const diff = [stagedDiff.trim(), unstagedDiff.trim()].filter(Boolean).join('\n');
    const statusFiles = parseStatusFiles(statusOutput);
    const stats = mergeStats(parseNumstat(unstagedNumstat), parseNumstat(stagedNumstat));
    const renderedDiff = await renderDiffFiles(diff);

    return {
      ok: true,
      isRepo: true,
      root: root.trim(),
      branch: parseBranch(statusOutput),
      operation: statusFiles.length ? '本地更改' : '干净',
      insertions: stats.insertions,
      deletions: stats.deletions,
      diffFileCount: stats.files,
      fileCount: statusFiles.length,
      files: statusFiles,
      diff,
      diffHtml: renderedDiff.diffHtml,
      diffFiles: renderedDiff.diffFiles,
      diffTruncated: diff.length > MAX_DIFF_CHARS,
    };
  } catch (error) {
    return {
      ok: false,
      isRepo: false,
      branch: '无 Git 仓库',
      operation: error.stderr?.trim() || error.message,
      insertions: 0,
      deletions: 0,
      diffFileCount: 0,
      fileCount: 0,
      files: [],
      diff: '',
      diffHtml: '',
      diffFiles: [],
      diffTruncated: false,
    };
  }
}

module.exports = {
  readGitStatus,
};
