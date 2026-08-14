# Security

[← Documentation index](README.md)

This container holds your Claude credentials and runs an agent that can modify
mounted code. Treat it as privileged.

- Compose binds to **`127.0.0.1:3000`**, not `0.0.0.0`. Change that only behind
  auth and TLS.
- Set `UF_AUTH_TOKEN` (`openssl rand -hex 32`) for anything beyond loopback.
- Folder input is resolved and containment-checked **before** filesystem access,
  and again after symlink resolution. `../`, absolute paths, and symlinks out of
  the tree are all rejected.
- With several workspaces mounted, containment is checked against **one mount at
  a time**, never their union. A run is confined to the workspace it started in,
  so a path valid in one workspace is rejected in another.
- The agent is spawned with an argument array and **no shell**, so a prompt
  containing shell metacharacters is inert.
- `bypassPermissions` lets the agent run any command in the mounted folder
  without asking. The UI warns; the default is `acceptEdits`.
- `UF_GITHUB_TOKEN` is handed to the agent's work cycles and to nothing else.
  The reviewer does not get it (it cannot write), and neither does the git this
  app runs itself — `worktree add` and `merge` execute hooks the repository
  controls, and this app's own git never touches the network. The credential
  helper is scoped to `https://github.com`, so another host asking for
  credentials gets none.
- *Which* token a work cycle gets is chosen from the repository it is working
  in. `UF_GITHUB_TOKENS` maps a folder to a credential; a run in that folder
  gets that one and no other, and a folder no entry names falls back to
  `UF_GITHUB_TOKEN` — blank there means no credential rather than a wide one.
  This narrows how far a compromised or badly-instructed agent reaches; it does
  not narrow the helper, which still answers for `github.com` as a whole, so the
  token you name has to be scoped on GitHub's side too. The withholding above is
  by namespace, so `UF_GITHUB_TOKENS` never reaches the reviewer or this app's
  own git either.
