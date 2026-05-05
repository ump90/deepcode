window.addEventListener('DOMContentLoaded', () => {
  const versionMap = {
    chrome: process.versions.chrome,
    node: process.versions.node,
    electron: process.versions.electron,
  };

  for (const [name, version] of Object.entries(versionMap)) {
    const element = document.getElementById(`${name}-version`);

    if (element) {
      element.textContent = version;
    }
  }
});
