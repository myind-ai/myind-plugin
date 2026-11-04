// Where a stored file's manifest lives in the repository (storage-format.md, "Big files").
export const manifestPath = (sha) => `files/manifests/${sha.slice(0, 2)}/${sha}.json`
